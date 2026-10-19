#!/usr/bin/env node
// R2A C: database state matrix runtime tests.
//
// Covers the read-only classifier + init orchestrator (scripts/lib/db-init.mjs)
// and the CLI (scripts/db-maintenance.mjs / scripts/db.sh) against synthetic
// SQLite databases created in isolated temp dirs. No network, no wrangler and no
// real database are used: the migration executor is a fake injected runner.
//
// Fingerprints are rebuilt inside this test by replaying migrations/0001..0013
// with scripts/lib/schema-fingerprint.mjs (k=0..13, 14 prefixes); the historical
// hashes are read from scripts/schema/known-legacy-fingerprints.json. The test
// does not depend on generated artifacts (functions/_schema.generated.js).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  BUSINESS_TABLES,
  FINGERPRINT_VERSION,
  INIT_ALLOWED_STATES,
  deriveContract,
  fingerprintOf,
} from "../scripts/lib/schema-fingerprint.mjs";
import {
  DEFAULT_APP_ROOT,
  DbSafetyError,
  EXIT_CODES,
  KNOWN_STATES,
  TOOL_VERSION,
  allowedForInit,
  diagnose,
  loadExpectedModel,
  resolveTargets,
  runInit,
} from "../scripts/lib/db-init.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(TEST_DIR, "..");
const CLI_PATH = join(APP_ROOT, "scripts", "db-maintenance.mjs");
const DB_SH_PATH = join(APP_ROOT, "scripts", "db.sh");
const MIGRATIONS_DIR = join(APP_ROOT, "migrations");
const FIXTURES_DIR = join(APP_ROOT, "tests", "fixtures", "legacy");
const LEGACY_CONSTANTS_PATH = join(APP_ROOT, "scripts", "schema", "known-legacy-fingerprints.json");
const V3_D1_SUBDIR = Object.freeze(["v3", "d1", "miniflare-D1DatabaseObject"]);
const LEGACY_D1_SUBDIR = Object.freeze(["d1"]);
const LEDGER_DDL =
  "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function recordPass(name) {
  passed += 1;
  console.log(`PASS ${name}`);
}

function recordFailure(name, error) {
  failed += 1;
  failures.push({ name, error });
  const message = error && error.stack ? error.stack : String(error);
  console.error(`FAIL ${name}\n${message}\n`);
}

function test(name, fn) {
  try {
    fn();
    recordPass(name);
  } catch (error) {
    recordFailure(name, error);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    recordPass(name);
  } catch (error) {
    recordFailure(name, error);
  }
}

const tempRoots = [];

function mkTemp(label) {
  const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]+/g, "-");
  const dir = mkdtempSync(join(tmpdir(), `r2a-db-${safeLabel}-`));
  tempRoots.push(dir);
  return dir;
}

function cleanupTempRoots() {
  for (const dir of tempRoots.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

process.on("exit", cleanupTempRoots);

// ---------------------------------------------------------------------------
// Expected model (independent replay of the frozen migration chain)
// ---------------------------------------------------------------------------

const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const LEGACY_CONSTANTS = JSON.parse(readFileSync(LEGACY_CONSTANTS_PATH, "utf8"));

function readSqlFile(filePath) {
  return readFileSync(filePath, "utf8");
}

/** Dump files contain `CREATE TABLE sqlite_sequence(...)`; SQLite reserves it. */
function stripInternalDumpStatements(sql) {
  return String(sql)
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/^\s*CREATE\s+TABLE\s+sqlite_sequence\b/i.test(line) &&
        !/^\s*INSERT\s+INTO\s+sqlite_sequence\b/i.test(line),
    )
    .join("\n");
}

function applyMigration(db, index) {
  db.exec(readSqlFile(join(MIGRATIONS_DIR, MIGRATION_FILES[index])));
}

function applyMigrations(db, count) {
  for (let index = 0; index < count; index += 1) applyMigration(db, index);
}

function writeLedger(db, names) {
  db.exec(LEDGER_DDL);
  const insert = db.prepare("INSERT INTO d1_migrations (name) VALUES (?)");
  for (const name of names) insert.run(name);
}

const replayDb = new DatabaseSync(":memory:");
const prefixFingerprints = [];
let terminalFingerprint;
let terminalContract;
try {
  const emptyFingerprint = fingerprintOf(replayDb);
  prefixFingerprints.push({ k: 0, hash: emptyFingerprint.hash, counts: emptyFingerprint.counts });
  for (let index = 0; index < MIGRATION_FILES.length; index += 1) {
    applyMigration(replayDb, index);
    const fingerprint = fingerprintOf(replayDb);
    prefixFingerprints.push({ k: index + 1, hash: fingerprint.hash, counts: fingerprint.counts });
  }
  terminalFingerprint = prefixFingerprints[prefixFingerprints.length - 1];
  terminalContract = deriveContract(replayDb);
} finally {
  replayDb.close();
}

function legacyShapeHash(shapeName) {
  const shape = LEGACY_CONSTANTS.shapes[shapeName];
  assert.ok(shape && typeof shape.hash === "string", `known-legacy-fingerprints missing shapes.${shapeName}.hash`);
  return shape.hash;
}

function knownMigrationPrefix(count) {
  assert.ok(count >= 0 && count <= MIGRATION_FILES.length);
  return MIGRATION_FILES.slice(0, count);
}

// ---------------------------------------------------------------------------
// Synthetic database helpers
// ---------------------------------------------------------------------------

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function defaultDbPath(stateDir, fileName = "local-d1.sqlite") {
  return join(stateDir, ...V3_D1_SUBDIR, fileName);
}

function legacyDbPath(stateDir, fileName = "legacy-d1.sqlite") {
  return join(stateDir, ...LEGACY_D1_SUBDIR, fileName);
}

/**
 * Create a synthetic database file.
 * @param {string} filePath absolute database path
 * @param {{fixture?: string, migrations?: number, ledger?: string[], fkOff?: boolean,
 *          callback?: (db: DatabaseSync) => void}} options
 */
function createDatabase(filePath, { fixture = null, migrations = 0, ledger = null, fkOff = false, callback = null } = {}) {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  try {
    if (fkOff) db.exec("PRAGMA foreign_keys = OFF");
    if (fixture) db.exec(stripInternalDumpStatements(readSqlFile(join(FIXTURES_DIR, fixture))));
    if (migrations > 0) applyMigrations(db, migrations);
    if (ledger) writeLedger(db, ledger);
    if (callback) callback(db);
  } finally {
    db.close();
  }
  return filePath;
}

function createDbInStateDir(stateDir, fileName, options) {
  return createDatabase(defaultDbPath(stateDir, fileName), options);
}

/** D1 local data files are named `<sha256>.sqlite` by miniflare. */
function dataFileName(seed) {
  return `${createHash("sha256").update(String(seed)).digest("hex")}.sqlite`;
}

/**
 * Reproduce the real cold-start layout produced by `wrangler pages dev --persist-to`:
 *   <state>/v3/d1/miniflare-D1DatabaseObject/<hash>.sqlite  (D1 data DB, only _cf_METADATA)
 *   <state>/v3/d1/miniflare-D1DatabaseObject/metadata.sqlite (miniflare bookkeeping, only _cf_ALARM)
 * plus WAL/SHM sidecars that must never be database candidates.
 */
function createMiniflareInternalsStateDir(stateDir, { dataSeed = "e2e-d1", metadataOnly = false } = {}) {
  const d1Dir = join(stateDir, ...V3_D1_SUBDIR);
  mkdirSync(d1Dir, { recursive: true });
  const metadataFile = join(d1Dir, "metadata.sqlite");
  createDatabase(metadataFile, {
    callback: (db) => db.exec("CREATE TABLE _cf_ALARM (actor_id TEXT PRIMARY KEY, scheduled_time INTEGER, actor_name TEXT)"),
  });
  let dataFile = null;
  if (!metadataOnly) {
    dataFile = join(d1Dir, dataFileName(dataSeed));
    createDatabase(dataFile, {
      callback: (db) => db.exec("CREATE TABLE _cf_METADATA (key TEXT PRIMARY KEY, value TEXT)"),
    });
  }
  // Sidecars of a decoy base name: scanning must only match the exact ".sqlite" suffix.
  writeFileSync(join(d1Dir, "decoy.sqlite-wal"), "");
  writeFileSync(join(d1Dir, "decoy.sqlite-shm"), "");
  return { d1Dir, dataFile, metadataFile };
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function snapshotTree(root) {
  const entries = [];
  if (!existsSync(root)) return entries;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile()) entries.push(`${relative(root, entryPath)}:${statSync(entryPath).size}`);
    }
  };
  walk(root);
  return entries.sort();
}

function countRows(db, table) {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdent(table)}`).get();
  return Number(row ? row.count : 0);
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function readLedgerNames(db) {
  if (!tableExists(db, "d1_migrations")) return [];
  return db.prepare("SELECT name FROM d1_migrations ORDER BY id").all().map((row) => row.name);
}

/** Fake wrangler runner: applies pending migrations with a per-file atomic ledger. */
function applyPendingMigrationsWithLedger(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(LEDGER_DDL);
    const applied = new Set(readLedgerNames(db));
    for (const name of MIGRATION_FILES) {
      if (applied.has(name)) continue;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(readSqlFile(join(MIGRATIONS_DIR, name)));
        db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  } finally {
    db.close();
  }
}

function makeFakeRunner() {
  const calls = [];
  const runner = async (context) => {
    calls.push({ ...context });
    const dbPath = context.dbFile || defaultDbPath(context.stateDir, "fake-wrangler-d1.sqlite");
    applyPendingMigrationsWithLedger(dbPath);
    return { exitCode: 0 };
  };
  return { calls, runner };
}

function assertInitResultShape(result) {
  for (const key of ["code", "stateBefore", "stateAfter", "applied", "wranglerInvoked", "message", "classification"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(result, key), `runInit result missing key: ${key}`);
  }
}

/** Assert classification + refusal + strict zero-write for a rejection state. */
async function assertRefusal({ stateDir, dbFile = null, expectedState, expectedUnderlyingState = null, label = "" }) {
  const before = diagnose({ stateDir, dbFile, appRoot: APP_ROOT });
  assert.equal(before.classification.state, expectedState, `${label}: classification.state`);
  if (expectedUnderlyingState) {
    assert.equal(before.classification.underlyingState, expectedUnderlyingState, `${label}: underlyingState`);
  }
  assert.equal(before.allowedForInit, false, `${label}: allowedForInit`);

  const effectiveDbFile = dbFile || before.target.dbFile;
  const treeBefore = snapshotTree(stateDir);
  const hashBefore = effectiveDbFile ? sha256File(effectiveDbFile) : null;

  const fake = makeFakeRunner();
  const result = await runInit({ stateDir, dbFile, appRoot: APP_ROOT, runMigrations: fake.runner });
  assertInitResultShape(result);
  assert.equal(result.code, EXIT_CODES.REFUSED, `${label}: exit code 3`);
  assert.equal(result.stateBefore, expectedState, `${label}: stateBefore`);
  assert.equal(result.stateAfter, null, `${label}: stateAfter must be null on refusal`);
  assert.equal(result.applied, false, `${label}: applied`);
  assert.equal(result.wranglerInvoked, false, `${label}: wranglerInvoked`);
  assert.equal(fake.calls.length, 0, `${label}: migrations runner must not be called`);
  assert.ok(typeof result.message === "string" && result.message.length > 0, `${label}: actionable message`);
  assert.equal(result.classification.state, expectedState, `${label}: refusal classification`);

  assert.deepEqual(snapshotTree(stateDir), treeBefore, `${label}: state dir must not change`);
  if (effectiveDbFile) {
    assert.equal(sha256File(effectiveDbFile), hashBefore, `${label}: database sha256 must not change`);
  }
  return { before, result };
}

function runCli(args, { cwd = mkTemp("cli-cwd"), env = {} } = {}) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...env },
  });
  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function runDbSh(args, { cwd = mkTemp("dbsh-cwd"), env = {} } = {}) {
  const result = spawnSync(DB_SH_PATH, args, {
    cwd,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...env },
  });
  return {
    code: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function parseJsonOutput(label, result) {
  assert.ok(result.stdout.trim().length > 0, `${label}: stdout must contain JSON`);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label}: stdout is not valid JSON (${error.message}): ${result.stdout.slice(0, 800)}`);
  }
}

// ---------------------------------------------------------------------------
// Reference-graph seeding (complete cross-table chain for the F case)
// ---------------------------------------------------------------------------

function valueForColumn(table, column) {
  const type = String(column.type || "").toUpperCase();
  const name = String(column.name);
  if (Number(column.pk) === 1) return `${table}_row`;
  if (type.includes("INT") || type.includes("NUM") || type.includes("REAL") || type.includes("DEC")) return 1;
  if (name === "email") return "r2a-chain@example.invalid";
  return `${table}.${name}`;
}

/**
 * Insert one row into every business table and then wire every expected FK
 * relation to an existing parent row. Foreign key enforcement is off while
 * seeding (the caller opens the database accordingly); the resulting database
 * satisfies all declared and expected relations.
 */
function seedCompleteReferenceGraph(db, contract) {
  db.exec("PRAGMA foreign_keys = OFF");
  const inserted = [];
  for (const table of [...BUSINESS_TABLES].sort()) {
    const columns = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
    if (columns.length === 0) continue;
    const names = [];
    const values = [];
    for (const column of columns) {
      const singleTextPk =
        Number(column.pk) === 1 && !String(column.type || "").toUpperCase().includes("INT");
      const requiredNotNull = Number(column.notnull) === 1 && column.dflt_value === null;
      if (!singleTextPk && !requiredNotNull) continue;
      names.push(column.name);
      values.push(valueForColumn(table, column));
    }
    assert.ok(names.length > 0, `seed: no insertable columns for ${table}`);
    db.prepare(
      `INSERT INTO ${quoteIdent(table)} (${names.map(quoteIdent).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    ).run(...values);
    inserted.push(table);
  }
  for (const relation of contract.fkRelations) {
    const { child, childColumn, parent, parentColumn } = relation;
    if (!tableExists(db, child) || !tableExists(db, parent)) continue;
    try {
      db.prepare(
        `UPDATE ${quoteIdent(child)} SET ${quoteIdent(childColumn)} = ` +
          `(SELECT ${quoteIdent(parentColumn)} FROM ${quoteIdent(parent)} LIMIT 1)`,
      ).run();
    } catch {
      // Legacy shapes may lack the column; the orphan scan skips absent columns.
    }
  }
  return inserted;
}

// ===========================================================================
// 0. Expected model / constants
// ===========================================================================

test("0 expected model: 13 migrations, 14 prefix fingerprints, terminal counts, legacy constants", () => {
  assert.equal(MIGRATION_FILES.length, 13, "frozen migration count");
  assert.equal(prefixFingerprints.length, 14, "k=0..13 prefix fingerprints");
  assert.deepEqual(
    prefixFingerprints.map((item) => item.k),
    Array.from({ length: 14 }, (_, index) => index),
  );
  assert.equal(terminalFingerprint.hash, prefixFingerprints[13].hash);
  assert.equal(terminalFingerprint.counts.tables, 19, "terminal tables");
  assert.equal(terminalFingerprint.counts.columns, 259, "terminal columns");
  assert.equal(terminalFingerprint.counts.fk, 16, "terminal foreign keys");
  assert.equal(terminalFingerprint.counts.explicitIndexes, 17, "terminal explicit indexes");
  assert.equal(terminalFingerprint.counts.uniqueConstraints, 12, "terminal table-level uniques");
  assert.equal(terminalContract.fkRelations.length, 16);
  assert.equal(terminalContract.uniqueKeys.length, 15);
  assert.equal(FINGERPRINT_VERSION, 1);
  assert.equal(DEFAULT_APP_ROOT, APP_ROOT);
  assert.ok(TOOL_VERSION.length > 0);

  // Historical constants must be reproducible from the historical fixtures.
  const fixtures = [
    ["runtime-ensureSchema-v1.sql", "runtimeV1"],
    ["schema-v1.sql", "schemaSqlV1"],
    ["schema-v1-booted.sql", "schemaSqlBooted"],
  ];
  for (const [fixture, shapeName] of fixtures) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(stripInternalDumpStatements(readSqlFile(join(FIXTURES_DIR, fixture))));
      const fingerprint = fingerprintOf(db);
      assert.equal(fingerprint.hash, legacyShapeHash(shapeName), `${shapeName} fixture hash`);
      for (const [key, value] of Object.entries(LEGACY_CONSTANTS.shapes[shapeName].counts || {})) {
        assert.equal(fingerprint.counts[key], value, `${shapeName} fixture counts.${key}`);
      }
    } finally {
      db.close();
    }
  }
  const legacyHashes = new Set(Object.values(LEGACY_CONSTANTS.shapes).map((shape) => shape.hash));
  assert.equal(legacyHashes.has(terminalFingerprint.hash), false, "terminal fingerprint must differ from legacy hashes");

  // db-init reconstructs exactly the same model without generated artifacts.
  const model = loadExpectedModel({ appRoot: APP_ROOT });
  assert.equal(model.terminal.hash, terminalFingerprint.hash);
  assert.deepEqual(
    model.prefixes.map((item) => item.hash),
    prefixFingerprints.map((item) => item.hash),
  );
  assert.deepEqual([...model.knownMigrations], MIGRATION_FILES);
  assert.equal(model.empty.hash, prefixFingerprints[0].hash);

  // Allowed states contract.
  assert.deepEqual([...INIT_ALLOWED_STATES], ["EMPTY", "MIGRATION_PARTIAL_OK", "MIGRATION_COMPLETE"]);
  assert.deepEqual(
    [...KNOWN_STATES].sort(),
    [
      "COMPLETE_NO_LEDGER",
      "DATA_CONFLICT",
      "EMPTY",
      "LEDGER_SCHEMA_CONFLICT",
      "MIGRATION_COMPLETE",
      "MIGRATION_PARTIAL_OK",
      "RUNTIME_LEGACY",
      "SCHEMASQL_LEGACY",
      "TOO_NEW",
      "UNKNOWN",
    ].sort(),
  );
  for (const state of KNOWN_STATES) {
    assert.equal(allowedForInit(state), INIT_ALLOWED_STATES.includes(state), `allowedForInit(${state})`);
  }
});

test("0b classify does not depend on table count: runtime and schema.sql-booted are both 19 tables", () => {
  const runtimeDir = mkTemp("count-runtime");
  createDbInStateDir(runtimeDir, "runtime.sqlite", { fixture: "runtime-ensureSchema-v1.sql" });
  const bootedDir = mkTemp("count-booted");
  createDbInStateDir(bootedDir, "booted.sqlite", { fixture: "schema-v1-booted.sql" });

  const runtime = diagnose({ stateDir: runtimeDir, appRoot: APP_ROOT });
  const booted = diagnose({ stateDir: bootedDir, appRoot: APP_ROOT });
  assert.equal(runtime.classification.counts.tables, 19);
  assert.equal(booted.classification.counts.tables, 19);
  assert.equal(runtime.classification.state, "RUNTIME_LEGACY");
  assert.equal(booted.classification.state, "SCHEMASQL_LEGACY");
  assert.notEqual(runtime.classification.fingerprint, booted.classification.fingerprint);
});

// ===========================================================================
// A. No database file / empty database -> EMPTY; init converges; idempotent
// ===========================================================================

await testAsync("A no database file -> EMPTY, init allowed -> MIGRATION_COMPLETE, second init is a no-op", async () => {
  const stateDir = mkTemp("A-no-file");
  const before = diagnose({ stateDir, appRoot: APP_ROOT });
  assert.equal(before.classification.state, "EMPTY");
  assert.equal(before.classification.virtualEmpty, true);
  assert.equal(before.target.dbFile, null);
  assert.equal(before.allowedForInit, true);

  const first = makeFakeRunner();
  const firstResult = await runInit({ stateDir, appRoot: APP_ROOT, runMigrations: first.runner });
  assertInitResultShape(firstResult);
  assert.equal(firstResult.code, EXIT_CODES.OK);
  assert.equal(firstResult.stateBefore, "EMPTY");
  assert.equal(firstResult.stateAfter, "MIGRATION_COMPLETE");
  assert.equal(firstResult.applied, true);
  assert.equal(firstResult.wranglerInvoked, true);
  assert.equal(first.calls.length, 1);
  assert.equal(first.calls[0].stateBefore, "EMPTY");

  const dbFile = defaultDbPath(stateDir, "fake-wrangler-d1.sqlite");
  assert.ok(existsSync(dbFile), "fake runner created the local D1 database");
  const after = diagnose({ stateDir, appRoot: APP_ROOT });
  assert.equal(after.classification.state, "MIGRATION_COMPLETE");
  assert.equal(after.classification.ledger.rowCount, 13);
  assert.equal(after.classification.fingerprint, terminalFingerprint.hash);

  const hashBeforeNoop = sha256File(dbFile);
  const second = makeFakeRunner();
  const secondResult = await runInit({ stateDir, appRoot: APP_ROOT, runMigrations: second.runner });
  assert.equal(secondResult.code, EXIT_CODES.OK);
  assert.equal(secondResult.stateBefore, "MIGRATION_COMPLETE");
  assert.equal(secondResult.stateAfter, "MIGRATION_COMPLETE");
  assert.equal(secondResult.applied, false);
  assert.equal(secondResult.wranglerInvoked, false);
  assert.equal(second.calls.length, 0, "no-op init must not call the migrations runner");
  assert.equal(sha256File(dbFile), hashBeforeNoop, "no-op init must not write");
});

await testAsync("A2 empty database file -> EMPTY, init allowed -> MIGRATION_COMPLETE", async () => {
  const stateDir = mkTemp("A-empty-db");
  const dbFile = createDbInStateDir(stateDir, "empty.sqlite", {
    callback: (db) => {
      db.exec("CREATE TABLE placeholder (id TEXT); DROP TABLE placeholder;");
    },
  });
  const before = diagnose({ stateDir, appRoot: APP_ROOT });
  assert.equal(before.classification.state, "EMPTY");
  assert.equal(before.classification.virtualEmpty, undefined);
  assert.equal(before.target.dbFile, dbFile);
  assert.equal(before.allowedForInit, true);

  const fake = makeFakeRunner();
  const result = await runInit({ stateDir, appRoot: APP_ROOT, runMigrations: fake.runner });
  assert.equal(result.code, EXIT_CODES.OK);
  assert.equal(result.stateBefore, "EMPTY");
  assert.equal(result.stateAfter, "MIGRATION_COMPLETE");
  assert.equal(result.applied, true);
  assert.equal(fake.calls.length, 1);
  const after = diagnose({ stateDir, appRoot: APP_ROOT });
  assert.equal(after.classification.state, "MIGRATION_COMPLETE");
});

// ===========================================================================
// A3/A4. Real cold-start layout from `wrangler pages dev` (data DB + metadata.sqlite)
// ===========================================================================

await testAsync("A3 cold-start layout (empty data DB + metadata.sqlite) -> EMPTY, init allowed -> COMPLETE; metadata untouched", async () => {
  const stateDir = mkTemp("A3-cold-start");
  const { dataFile, metadataFile } = createMiniflareInternalsStateDir(stateDir);
  const dataInode = statSync(dataFile).ino;
  const metadataInode = statSync(metadataFile).ino;
  const metadataHash = sha256File(metadataFile);

  const before = diagnose({ stateDir, appRoot: APP_ROOT });
  assert.equal(before.classification.state, "EMPTY", "cold-start data DB has no business tables");
  assert.equal(before.classification.virtualEmpty, undefined, "the data DB file really exists");
  assert.equal(before.target.dbFile, dataFile, "the D1 data file is the target");
  assert.deepEqual(before.target.ignoredInternalFiles, [metadataFile], "metadata.sqlite is excluded");
  assert.equal(before.target.candidates.length, 1, "WAL/SHM sidecars are not candidates");
  assert.equal(before.allowedForInit, true, "cold start must allow init (regression: used to be TARGET_AMBIGUOUS)");

  const fake = makeFakeRunner();
  const result = await runInit({ stateDir, appRoot: APP_ROOT, runMigrations: fake.runner });
  assert.equal(result.code, EXIT_CODES.OK);
  assert.equal(result.stateBefore, "EMPTY");
  assert.equal(result.stateAfter, "MIGRATION_COMPLETE");
  assert.equal(result.applied, true);
  assert.equal(result.wranglerInvoked, true);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].dbFile, dataFile, "migrations must run against the existing data DB file");

  assert.ok(existsSync(dataFile), "data DB must not be deleted");
  assert.equal(statSync(dataFile).ino, dataInode, "data DB must not be recreated (same inode)");
  assert.ok(existsSync(metadataFile), "metadata.sqlite must be kept");
  assert.equal(statSync(metadataFile).ino, metadataInode, "metadata.sqlite must not be recreated");
  assert.equal(sha256File(metadataFile), metadataHash, "metadata.sqlite must not be written");

  const after = diagnose({ stateDir, appRoot: APP_ROOT });
  assert.equal(after.classification.state, "MIGRATION_COMPLETE");
  assert.equal(after.target.dbFile, dataFile);
  assert.deepEqual(after.target.ignoredInternalFiles, [metadataFile]);
});

await testAsync("A4 only metadata.sqlite -> EMPTY virtual, init allowed -> COMPLETE; metadata untouched", async () => {
  const stateDir = mkTemp("A4-metadata-only");
  const { metadataFile } = createMiniflareInternalsStateDir(stateDir, { metadataOnly: true });
  const metadataHash = sha256File(metadataFile);

  const before = diagnose({ stateDir, appRoot: APP_ROOT });
  assert.equal(before.classification.state, "EMPTY");
  assert.equal(before.classification.virtualEmpty, true, "no D1 data file yet");
  assert.equal(before.target.dbFile, null);
  assert.deepEqual(before.target.ignoredInternalFiles, [metadataFile]);
  assert.equal(before.allowedForInit, true);

  const fake = makeFakeRunner();
  const result = await runInit({ stateDir, appRoot: APP_ROOT, runMigrations: fake.runner });
  assert.equal(result.code, EXIT_CODES.OK);
  assert.equal(result.stateBefore, "EMPTY");
  assert.equal(result.stateAfter, "MIGRATION_COMPLETE");
  assert.equal(result.applied, true);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].dbFile, null, "virtual empty state has no pre-existing data file");

  const after = diagnose({ stateDir, appRoot: APP_ROOT });
  assert.equal(after.classification.state, "MIGRATION_COMPLETE");
  assert.equal(after.target.dbFile, defaultDbPath(stateDir, "fake-wrangler-d1.sqlite"));
  assert.equal(sha256File(metadataFile), metadataHash, "metadata.sqlite must not be written");
});

// ===========================================================================
// D. Fully migrated + complete ledger -> MIGRATION_COMPLETE; repeat init no-op
// ===========================================================================

await testAsync("D 13 migrations + 13 ledger rows -> MIGRATION_COMPLETE; repeated init is a no-op", async () => {
  const stateDir = mkTemp("D-complete");
  const dbFile = createDbInStateDir(stateDir, "complete.sqlite", {
    migrations: MIGRATION_FILES.length,
    ledger: MIGRATION_FILES,
  });
  const before = diagnose({ stateDir, appRoot: APP_ROOT });
  assert.equal(before.classification.state, "MIGRATION_COMPLETE");
  assert.equal(before.classification.underlyingState, "MIGRATION_COMPLETE");
  assert.equal(before.classification.ledger.rowCount, 13);
  assert.equal(before.classification.fingerprint, terminalFingerprint.hash);
  assert.equal(before.allowedForInit, true);

  const hashBefore = sha256File(dbFile);
  const fake = makeFakeRunner();
  const result = await runInit({ stateDir, appRoot: APP_ROOT, runMigrations: fake.runner });
  assert.equal(result.code, EXIT_CODES.OK);
  assert.equal(result.stateBefore, "MIGRATION_COMPLETE");
  assert.equal(result.stateAfter, "MIGRATION_COMPLETE");
  assert.equal(result.applied, false);
  assert.equal(result.wranglerInvoked, false);
  assert.equal(fake.calls.length, 0);
  assert.equal(sha256File(dbFile), hashBefore);
});

// ===========================================================================
// Legal partial migration prefixes (k=2 / 5 / 12) -> MIGRATION_PARTIAL_OK
// ===========================================================================

for (const k of [2, 5, 12]) {
  await testAsync(`PARTIAL k=${k}: MIGRATION_PARTIAL_OK -> init allowed -> MIGRATION_COMPLETE; second init no-op`, async () => {
    const stateDir = mkTemp(`partial-${k}`);
    const dbFile = createDbInStateDir(stateDir, `partial-${k}.sqlite`, {
      migrations: k,
      ledger: knownMigrationPrefix(k),
    });
    const before = diagnose({ stateDir, appRoot: APP_ROOT });
    assert.equal(before.classification.state, "MIGRATION_PARTIAL_OK");
    assert.equal(before.classification.ledger.rowCount, k);
    assert.equal(before.classification.fingerprint, prefixFingerprints[k].hash);
    assert.equal(before.allowedForInit, true);

    const fake = makeFakeRunner();
    const result = await runInit({ stateDir, appRoot: APP_ROOT, runMigrations: fake.runner });
    assert.equal(result.code, EXIT_CODES.OK);
    assert.equal(result.stateBefore, "MIGRATION_PARTIAL_OK");
    assert.equal(result.stateAfter, "MIGRATION_COMPLETE");
    assert.equal(result.applied, true);
    assert.equal(result.wranglerInvoked, true);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].dbFile, dbFile);
    assert.equal(fake.calls[0].stateBefore, "MIGRATION_PARTIAL_OK");

    const readDb = new DatabaseSync(dbFile, { readOnly: true });
    try {
      assert.equal(fingerprintOf(readDb).hash, terminalFingerprint.hash, "database reached terminal fingerprint");
      assert.deepEqual(readLedgerNames(readDb), MIGRATION_FILES, "ledger completed to 13 rows");
    } finally {
      readDb.close();
    }
    assert.equal(diagnose({ stateDir, appRoot: APP_ROOT }).classification.state, "MIGRATION_COMPLETE");

    const hashBeforeNoop = sha256File(dbFile);
    const second = makeFakeRunner();
    const secondResult = await runInit({ stateDir, appRoot: APP_ROOT, runMigrations: second.runner });
    assert.equal(secondResult.code, EXIT_CODES.OK);
    assert.equal(secondResult.applied, false);
    assert.equal(secondResult.wranglerInvoked, false);
    assert.equal(second.calls.length, 0);
    assert.equal(sha256File(dbFile), hashBeforeNoop);
  });
}

// ===========================================================================
// B. Historical runtime ensureSchema database -> RUNTIME_LEGACY, refused
// ===========================================================================

await testAsync("B runtime ensureSchema database -> RUNTIME_LEGACY, init refused with zero writes", async () => {
  const stateDir = mkTemp("B-runtime");
  createDbInStateDir(stateDir, "runtime.sqlite", { fixture: "runtime-ensureSchema-v1.sql" });
  const { before, result } = await assertRefusal({
    stateDir,
    expectedState: "RUNTIME_LEGACY",
    expectedUnderlyingState: "RUNTIME_LEGACY",
    label: "B",
  });
  assert.equal(before.classification.counts.tables, 19);
  assert.equal(before.classification.counts.fk, 1);
  assert.equal(before.classification.fingerprint, legacyShapeHash("runtimeV1"));
  assert.ok(result.message.includes("RUNTIME_LEGACY"));
});

// ===========================================================================
// C. Historical schema.sql databases -> SCHEMASQL_LEGACY, refused
// ===========================================================================

for (const [fixture, shapeName] of [
  ["schema-v1.sql", "schemaSqlV1"],
  ["schema-v1-booted.sql", "schemaSqlBooted"],
]) {
  await testAsync(`C ${fixture} -> SCHEMASQL_LEGACY, init refused with zero writes`, async () => {
    const stateDir = mkTemp(`C-${shapeName}`);
    createDbInStateDir(stateDir, "schemasql.sqlite", { fixture });
    const { before } = await assertRefusal({
      stateDir,
      expectedState: "SCHEMASQL_LEGACY",
      expectedUnderlyingState: "SCHEMASQL_LEGACY",
      label: `C:${fixture}`,
    });
    assert.equal(before.classification.fingerprint, legacyShapeHash(shapeName));
  });
}

// ===========================================================================
// E. Runtime shape + hand-written ledger 0001/0002 -> LEDGER_SCHEMA_CONFLICT
// ===========================================================================

await testAsync("E runtime shape + ledger 0001/0002 -> LEDGER_SCHEMA_CONFLICT, refused with zero writes", async () => {
  const stateDir = mkTemp("E-ledger-conflict");
  createDbInStateDir(stateDir, "conflict.sqlite", {
    fixture: "runtime-ensureSchema-v1.sql",
    ledger: knownMigrationPrefix(2),
  });
  const { before } = await assertRefusal({
    stateDir,
    expectedState: "LEDGER_SCHEMA_CONFLICT",
    expectedUnderlyingState: "LEDGER_SCHEMA_CONFLICT",
    label: "E",
  });
  assert.equal(before.classification.ledger.rowCount, 2);
  assert.equal(before.classification.ledger.head, MIGRATION_FILES[1]);
});

// ===========================================================================
// F. Runtime shape + complete cross-table data chain -> RUNTIME_LEGACY (not DATA_CONFLICT)
// ===========================================================================

await testAsync("F runtime shape + complete reference chain data -> RUNTIME_LEGACY, refused with zero writes", async () => {
  const stateDir = mkTemp("F-runtime-data");
  const dbFile = createDbInStateDir(stateDir, "runtime-data.sqlite", {
    fixture: "runtime-ensureSchema-v1.sql",
    fkOff: true,
    callback: (db) => {
      const inserted = seedCompleteReferenceGraph(db, terminalContract);
      assert.equal(inserted.length, BUSINESS_TABLES.length, "every business table received a reference-chain row");
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [], "seeded reference chain has no orphan rows");
      // Spot-check a long chain: enterprise -> account -> project -> work item -> fact -> decision packet -> owner decision.
      const chain = [
        ["enterprises", "id"],
        ["accounts", "enterprise_id"],
        ["projects", "created_by_account_id"],
        ["work_items", "project_id"],
        ["candidate_facts", "work_item_id"],
        ["decision_packets", "project_id"],
        ["owner_decisions", "packet_id"],
      ];
      for (const [table, column] of chain) {
        assert.ok(countRows(db, table) >= 1, `F: ${table} has rows`);
        assert.ok(
          db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().some((row) => row.name === column),
          `F: ${table}.${column} exists`,
        );
      }
      assert.ok(countRows(db, "owner_decisions") >= 1);
      assert.ok(countRows(db, "fact_second_confirmations") >= 1);
      assert.ok(countRows(db, "authorization_notification_outbox") >= 1);
    },
  });

  const before = diagnose({ stateDir, appRoot: APP_ROOT });
  assert.equal(before.classification.state, "RUNTIME_LEGACY", "legacy shape with sound data is RUNTIME_LEGACY");
  assert.equal(before.classification.underlyingState, "RUNTIME_LEGACY");
  assert.equal(before.classification.data.ok, true, "complete cross-table chain is data-clean");
  assert.deepEqual(before.classification.data.issues, []);

  await assertRefusal({
    stateDir,
    dbFile,
    expectedState: "RUNTIME_LEGACY",
    expectedUnderlyingState: "RUNTIME_LEGACY",
    label: "F",
  });
});

// ===========================================================================
// G. Terminal database + FK-off injected orphan row -> DATA_CONFLICT, refused
// ===========================================================================

await testAsync("G terminal database + FK-off orphan row -> DATA_CONFLICT, refused with zero writes", async () => {
  const stateDir = mkTemp("G-orphan");
  createDbInStateDir(stateDir, "orphan.sqlite", {
    migrations: MIGRATION_FILES.length,
    ledger: MIGRATION_FILES,
    callback: (db) => {
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare(
        "INSERT INTO events (event_id, project_id, type, actor_role, actor_id, payload) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("evt-orphan", "ghost-project", "test", "role", "actor", "{}");
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM projects WHERE id = 'ghost-project'").get().count, 0);
    },
  });
  const before = diagnose({ stateDir, appRoot: APP_ROOT });
  assert.equal(before.classification.state, "DATA_CONFLICT");
  assert.equal(before.classification.underlyingState, "MIGRATION_COMPLETE");
  assert.equal(before.classification.data.ok, false);
  assert.ok(before.classification.data.orphanViolations.length >= 1, "orphan scan found the injected row");
  assert.ok(
    before.classification.data.issues.some((issue) => issue.startsWith("orphan_rows=")),
    `issues mention orphan_rows: ${before.classification.data.issues.join("; ")}`,
  );
  await assertRefusal({
    stateDir,
    expectedState: "DATA_CONFLICT",
    expectedUnderlyingState: "MIGRATION_COMPLETE",
    label: "G",
  });
});

// ===========================================================================
// G2. Weak-constraint synthetic databases with duplicates -> DATA_CONFLICT
// ===========================================================================

await testAsync("G2a weak accounts table with duplicate email -> DATA_CONFLICT, refused with zero writes", async () => {
  const stateDir = mkTemp("G2a-duplicate-email");
  createDbInStateDir(stateDir, "weak-accounts.sqlite", {
    callback: (db) => {
      // Weak/legacy-like hands-off table: email has no UNIQUE constraint here,
      // but the authority contract requires it to be unique.
      db.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '')");
      db.prepare("INSERT INTO accounts (id, email) VALUES (?, ?)").run("acct-1", "dup@example.invalid");
      db.prepare("INSERT INTO accounts (id, email) VALUES (?, ?)").run("acct-2", "dup@example.invalid");
    },
  });
  const before = diagnose({ stateDir, appRoot: APP_ROOT });
  assert.equal(before.classification.state, "DATA_CONFLICT");
  assert.equal(before.classification.underlyingState, "UNKNOWN");
  assert.ok(before.classification.data.duplicateViolations.length >= 1, "duplicate email detected");
  await assertRefusal({
    stateDir,
    expectedState: "DATA_CONFLICT",
    expectedUnderlyingState: "UNKNOWN",
    label: "G2a",
  });
});

await testAsync("G2b weak evidence_materials with duplicate (project_id, material_key, version) -> DATA_CONFLICT", async () => {
  const stateDir = mkTemp("G2b-duplicate-material-version");
  createDbInStateDir(stateDir, "weak-materials.sqlite", {
    callback: (db) => {
      db.exec(
        "CREATE TABLE evidence_materials (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, " +
          "material_key TEXT NOT NULL, version INTEGER NOT NULL)",
      );
      const insert = db.prepare(
        "INSERT INTO evidence_materials (id, project_id, material_key, version) VALUES (?, ?, ?, ?)",
      );
      insert.run("mat-1", "project-1", "material-key-1", 1);
      insert.run("mat-2", "project-1", "material-key-1", 1);
    },
  });
  const before = diagnose({ stateDir, appRoot: APP_ROOT });
  assert.equal(before.classification.state, "DATA_CONFLICT");
  assert.equal(before.classification.underlyingState, "UNKNOWN");
  assert.ok(
    before.classification.data.duplicateViolations.some(
      (item) => item.kind === "unique-index" && item.columns.join(",") === "project_id,material_key,version",
    ),
    `duplicate (project_id, material_key, version) detected: ${JSON.stringify(before.classification.data.duplicateViolations)}`,
  );
  await assertRefusal({
    stateDir,
    expectedState: "DATA_CONFLICT",
    expectedUnderlyingState: "UNKNOWN",
    label: "G2b",
  });
});

// ===========================================================================
// H. Terminal shape without ledger -> COMPLETE_NO_LEDGER, refused
// ===========================================================================

await testAsync("H terminal schema without ledger -> COMPLETE_NO_LEDGER, refused with zero writes", async () => {
  const stateDir = mkTemp("H-no-ledger");
  createDbInStateDir(stateDir, "terminal-no-ledger.sqlite", { migrations: MIGRATION_FILES.length });
  const { before } = await assertRefusal({
    stateDir,
    expectedState: "COMPLETE_NO_LEDGER",
    expectedUnderlyingState: "COMPLETE_NO_LEDGER",
    label: "H",
  });
  assert.equal(before.classification.fingerprint, terminalFingerprint.hash);
  assert.equal(before.classification.ledger.present, false);
});

// ===========================================================================
// I. TOO_NEW ledger / fully unknown schema -> refused
// ===========================================================================

await testAsync("I1 terminal schema + ledger with an unknown future migration -> TOO_NEW, refused", async () => {
  const stateDir = mkTemp("I1-too-new");
  createDbInStateDir(stateDir, "too-new.sqlite", {
    migrations: MIGRATION_FILES.length,
    ledger: [...MIGRATION_FILES, "0014_future_unknown.sql"],
  });
  const { before } = await assertRefusal({
    stateDir,
    expectedState: "TOO_NEW",
    expectedUnderlyingState: "TOO_NEW",
    label: "I1",
  });
  assert.ok(before.classification.ledger.unknown.includes("0014_future_unknown.sql"));
});

await testAsync("I2 completely unknown schema -> UNKNOWN, refused", async () => {
  const stateDir = mkTemp("I2-unknown");
  createDbInStateDir(stateDir, "unknown.sqlite", {
    callback: (db) => {
      db.exec("CREATE TABLE projects (unexpected_column TEXT)");
      db.prepare("INSERT INTO projects (unexpected_column) VALUES (?)").run("value");
    },
  });
  const { before } = await assertRefusal({
    stateDir,
    expectedState: "UNKNOWN",
    expectedUnderlyingState: "UNKNOWN",
    label: "I2",
  });
  assert.notEqual(before.classification.fingerprint, terminalFingerprint.hash);
});

// ===========================================================================
// J. Cold start D1 state (only _cf_METADATA) -> EMPTY, init allowed
// ===========================================================================

await testAsync("J cold start D1 state with only _cf_METADATA -> EMPTY, init allowed -> MIGRATION_COMPLETE", async () => {
  const stateDir = mkTemp("J-cold-start");
  const dbFile = createDbInStateDir(stateDir, "cold-start.sqlite", {
    callback: (db) => {
      db.exec("CREATE TABLE _cf_METADATA (key TEXT PRIMARY KEY, value TEXT)");
      db.prepare("INSERT INTO _cf_METADATA (key, value) VALUES (?, ?)").run("d1_version", "1");
    },
  });
  const before = diagnose({ stateDir, appRoot: APP_ROOT });
  assert.equal(before.classification.state, "EMPTY");
  assert.equal(before.target.dbFile, dbFile);
  assert.equal(before.allowedForInit, true);

  const fake = makeFakeRunner();
  const result = await runInit({ stateDir, appRoot: APP_ROOT, runMigrations: fake.runner });
  assert.equal(result.code, EXIT_CODES.OK);
  assert.equal(result.stateBefore, "EMPTY");
  assert.equal(result.stateAfter, "MIGRATION_COMPLETE");
  assert.equal(result.applied, true);
  assert.equal(fake.calls.length, 1);
  const after = diagnose({ stateDir, appRoot: APP_ROOT });
  assert.equal(after.classification.state, "MIGRATION_COMPLETE");
});

// ===========================================================================
// Target resolution: multiple databases (no guessing, exit 3)
// ===========================================================================

await testAsync("TARGET multiple business databases -> ambiguous exit 3; one business + one cold start resolves", async () => {
  const ambiguousDir = mkTemp("target-ambiguous");
  const terminalDir = mkTemp("target-terminal");
  createDbInStateDir(terminalDir, "terminal.sqlite", { migrations: MIGRATION_FILES.length, ledger: MIGRATION_FILES });
  createDbInStateDir(ambiguousDir, "runtime.sqlite", { fixture: "runtime-ensureSchema-v1.sql" });
  createDatabase(legacyDbPath(ambiguousDir, "schemasql.sqlite"), { fixture: "schema-v1.sql" });

  assert.throws(
    () => resolveTargets({ stateDir: ambiguousDir, appRoot: APP_ROOT }),
    (error) => {
      assert.equal(error.name, "DbSafetyError");
      assert.equal(error.exitCode, EXIT_CODES.REFUSED);
      assert.equal(error.kind, "TARGET_AMBIGUOUS");
      return true;
    },
  );
  assert.throws(() => diagnose({ stateDir: ambiguousDir, appRoot: APP_ROOT }), (error) => error.exitCode === 3);

  // init must also refuse (exit 3, zero writes) instead of guessing a target.
  const ambiguousRunner = makeFakeRunner();
  const ambiguousInit = await runInit({
    stateDir: ambiguousDir,
    appRoot: APP_ROOT,
    runMigrations: ambiguousRunner.runner,
  });
  assert.equal(ambiguousInit.code, EXIT_CODES.REFUSED);
  assert.equal(ambiguousInit.stateBefore, null);
  assert.equal(ambiguousInit.stateAfter, null);
  assert.equal(ambiguousInit.applied, false);
  assert.equal(ambiguousInit.wranglerInvoked, false);
  assert.equal(ambiguousRunner.calls.length, 0);
  assert.ok(ambiguousInit.message.includes("--db-file"), `init refusal must explain --db-file: ${ambiguousInit.message}`);

  // Explicit --db-file resolves an otherwise ambiguous state dir.
  const explicitFile = join(ambiguousDir, ...V3_D1_SUBDIR, "runtime.sqlite");
  const explicit = diagnose({ stateDir: ambiguousDir, dbFile: explicitFile, appRoot: APP_ROOT });
  assert.equal(explicit.classification.state, "RUNTIME_LEGACY");
  assert.equal(explicit.target.dbFile, explicitFile);
  assert.equal(explicit.target.dbFileSource, "explicit");

  // Multiple files, only one with business tables -> deterministic pick.
  const mixedDir = mkTemp("target-mixed");
  createDbInStateDir(mixedDir, "cold.sqlite", {
    callback: (db) => db.exec("CREATE TABLE _cf_METADATA (key TEXT PRIMARY KEY, value TEXT)"),
  });
  const terminalFile = createDbInStateDir(mixedDir, "terminal.sqlite", {
    migrations: MIGRATION_FILES.length,
    ledger: MIGRATION_FILES,
  });
  const mixed = diagnose({ stateDir: mixedDir, appRoot: APP_ROOT });
  assert.equal(mixed.classification.state, "MIGRATION_COMPLETE");
  assert.equal(mixed.target.dbFile, terminalFile);
  assert.equal(mixed.target.dbFileSource, "multiple-unique-business");

  // Multiple cold-start files with no business tables -> ambiguous exit 3.
  const coldDir = mkTemp("target-cold-only");
  for (const name of ["cold-a.sqlite", "cold-b.sqlite"]) {
    createDbInStateDir(coldDir, name, {
      callback: (db) => db.exec("CREATE TABLE _cf_METADATA (key TEXT PRIMARY KEY, value TEXT)"),
    });
  }
  assert.throws(() => resolveTargets({ stateDir: coldDir, appRoot: APP_ROOT }), (error) => error.exitCode === 3);

  // Cold-start layout (empty data DB + miniflare metadata.sqlite) resolves to the data file.
  const coldStartDir = mkTemp("target-cold-start-metadata");
  const coldStartLayout = createMiniflareInternalsStateDir(coldStartDir, { dataSeed: "cold-start" });
  const coldStartDiagnosis = diagnose({ stateDir: coldStartDir, appRoot: APP_ROOT });
  assert.equal(coldStartDiagnosis.classification.state, "EMPTY");
  assert.equal(coldStartDiagnosis.target.dbFile, coldStartLayout.dataFile);
  assert.deepEqual(coldStartDiagnosis.target.ignoredInternalFiles, [coldStartLayout.metadataFile]);
  assert.equal(coldStartDiagnosis.allowedForInit, true);

  // Two non-business data files + metadata.sqlite -> still ambiguous exit 3
  // (excluding metadata.sqlite must not silently collapse this dir to one candidate).
  const twoDataDir = mkTemp("target-two-data-metadata");
  const twoDataD1 = join(twoDataDir, ...V3_D1_SUBDIR);
  mkdirSync(twoDataD1, { recursive: true });
  for (const seed of ["data-a", "data-b"]) {
    createDatabase(join(twoDataD1, dataFileName(seed)), {
      callback: (db) => db.exec("CREATE TABLE _cf_METADATA (key TEXT PRIMARY KEY, value TEXT)"),
    });
  }
  createDatabase(join(twoDataD1, "metadata.sqlite"), {
    callback: (db) => db.exec("CREATE TABLE _cf_ALARM (actor_id TEXT PRIMARY KEY)"),
  });
  assert.throws(
    () => resolveTargets({ stateDir: twoDataDir, appRoot: APP_ROOT }),
    (error) => error.exitCode === 3 && error.kind === "TARGET_AMBIGUOUS",
  );

  // One data file with business tables but an unknown fingerprint + metadata.sqlite
  // must still be UNKNOWN (never EMPTY) and refuse automatic init.
  const unknownPlusMetadataDir = mkTemp("target-unknown-metadata");
  const unknownD1 = join(unknownPlusMetadataDir, ...V3_D1_SUBDIR);
  mkdirSync(unknownD1, { recursive: true });
  createDatabase(join(unknownD1, dataFileName("unknown-shape")), {
    callback: (db) => db.exec("CREATE TABLE projects (unexpected_column TEXT)"),
  });
  createDatabase(join(unknownD1, "metadata.sqlite"), {
    callback: (db) => db.exec("CREATE TABLE _cf_ALARM (actor_id TEXT PRIMARY KEY)"),
  });
  const unknownDiagnosis = diagnose({ stateDir: unknownPlusMetadataDir, appRoot: APP_ROOT });
  assert.equal(unknownDiagnosis.classification.state, "UNKNOWN");
  assert.equal(unknownDiagnosis.allowedForInit, false);

  // Explicit --db-file pointing at miniflare bookkeeping is refused (not a D1 data file).
  assert.throws(
    () => resolveTargets({ dbFile: coldStartLayout.metadataFile, appRoot: APP_ROOT }),
    (error) => error.exitCode === 3 && error.kind === "TARGET_INTERNAL_FILE",
  );

  // Explicit --db-file must exist.
  assert.throws(
    () => resolveTargets({ dbFile: join(ambiguousDir, "missing.sqlite"), appRoot: APP_ROOT }),
    (error) => error.exitCode === 3 && error.kind === "TARGET_NOT_FOUND",
  );
});

// ===========================================================================
// diagnose is strictly read-only
// ===========================================================================

test("READ-ONLY diagnose never mutates the database (runtime + terminal)", () => {
  const runtimeDir = mkTemp("readonly-runtime");
  const runtimeFile = createDbInStateDir(runtimeDir, "runtime.sqlite", {
    fixture: "runtime-ensureSchema-v1.sql",
  });
  const runtimeHash = sha256File(runtimeFile);
  const runtimeTree = snapshotTree(runtimeDir);
  const runtimeDiagnosis = diagnose({ stateDir: runtimeDir, appRoot: APP_ROOT });
  assert.equal(runtimeDiagnosis.classification.state, "RUNTIME_LEGACY");
  assert.equal(sha256File(runtimeFile), runtimeHash);
  assert.deepEqual(snapshotTree(runtimeDir), runtimeTree);

  const terminalDir = mkTemp("readonly-terminal");
  const terminalFile = createDbInStateDir(terminalDir, "terminal.sqlite", {
    migrations: MIGRATION_FILES.length,
    ledger: MIGRATION_FILES,
  });
  const terminalHash = sha256File(terminalFile);
  const terminalTree = snapshotTree(terminalDir);
  const terminalDiagnosis = diagnose({ stateDir: terminalDir, appRoot: APP_ROOT });
  assert.equal(terminalDiagnosis.classification.state, "MIGRATION_COMPLETE");
  assert.equal(sha256File(terminalFile), terminalHash);
  assert.deepEqual(snapshotTree(terminalDir), terminalTree);
});

// ===========================================================================
// CLI: diagnose / init / version, JSON on all init outcomes, cwd independence
// ===========================================================================

test("CLI version --json from an arbitrary cwd reports migrations head and terminal fingerprint", () => {
  const cwd = mkTemp("cli-version-cwd");
  const result = runCli(["version", "--json"], { cwd });
  assert.equal(result.code, EXIT_CODES.OK, `stderr: ${result.stderr}`);
  const payload = parseJsonOutput("version", result);
  assert.equal(payload.command, "version");
  assert.equal(payload.ok, true);
  assert.equal(payload.code, 0);
  assert.equal(payload.cmd, undefined);
  assert.equal(payload.expected.migrations_count, 13);
  assert.equal(payload.expected.migrations_head, MIGRATION_FILES[MIGRATION_FILES.length - 1]);
  assert.equal(payload.expected.terminal_fingerprint, terminalFingerprint.hash);
  assert.equal(payload.node_version, process.version);
  assert.equal(payload.tool_version, TOOL_VERSION);
});

test("CLI diagnose --json/human on terminal + runtime databases; JSON is stable and clean", () => {
  const stateDir = mkTemp("cli-diagnose");
  const dbFile = createDbInStateDir(stateDir, "complete.sqlite", {
    migrations: MIGRATION_FILES.length,
    ledger: MIGRATION_FILES,
  });
  const hashBefore = sha256File(dbFile);
  const cwd = mkTemp("cli-diagnose-cwd");

  const jsonResult = runCli(["diagnose", "--state-dir", stateDir, "--json"], { cwd });
  assert.equal(jsonResult.code, EXIT_CODES.OK, `stderr: ${jsonResult.stderr}`);
  const json = parseJsonOutput("diagnose --json", jsonResult);
  assert.equal(json.command, "diagnose");
  assert.equal(json.ok, true);
  assert.equal(json.state, "MIGRATION_COMPLETE");
  assert.equal(json.allowed_for_init, true);
  assert.equal(json.classification.state, "MIGRATION_COMPLETE");
  assert.equal(json.classification.ledger.rowCount, 13);
  assert.equal(json.target.db_file, dbFile);

  const humanResult = runCli(["diagnose", "--state-dir", stateDir], { cwd });
  assert.equal(humanResult.code, EXIT_CODES.OK, `stderr: ${humanResult.stderr}`);
  assert.ok(humanResult.stdout.includes("MIGRATION_COMPLETE"), "human output contains the state token");
  assert.ok(humanResult.stdout.includes("迁移账本"));
  assert.equal(sha256File(dbFile), hashBefore, "CLI diagnose must be read-only");
});

test("CLI init --json succeeds as a no-op on a complete database (exit 0) from an arbitrary cwd", () => {
  const stateDir = mkTemp("cli-init-complete");
  const dbFile = createDbInStateDir(stateDir, "complete.sqlite", {
    migrations: MIGRATION_FILES.length,
    ledger: MIGRATION_FILES,
  });
  const hashBefore = sha256File(dbFile);
  const cwd = mkTemp("cli-init-complete-cwd");
  const result = runCli(["init", "--state-dir", stateDir, "--json"], { cwd });
  assert.equal(result.code, EXIT_CODES.OK, `stderr: ${result.stderr}`);
  const payload = parseJsonOutput("init --json (complete)", result);
  assert.equal(payload.command, "init");
  assert.equal(payload.ok, true);
  assert.equal(payload.code, 0);
  assert.equal(payload.state_before, "MIGRATION_COMPLETE");
  assert.equal(payload.state_after, "MIGRATION_COMPLETE");
  assert.equal(payload.applied, false);
  assert.equal(payload.wrangler_invoked, false);
  assert.ok(typeof payload.message === "string" && payload.message.length > 0);
  assert.equal(sha256File(dbFile), hashBefore);
});

test("CLI init --json on a historical runtime database: exit 3, stable JSON, zero writes", () => {
  const stateDir = mkTemp("cli-init-legacy");
  const dbFile = createDbInStateDir(stateDir, "runtime.sqlite", { fixture: "runtime-ensureSchema-v1.sql" });
  const hashBefore = sha256File(dbFile);
  const treeBefore = snapshotTree(stateDir);
  const cwd = mkTemp("cli-init-legacy-cwd");
  const result = runCli(["init", "--state-dir", stateDir, "--json"], { cwd });
  assert.equal(result.code, EXIT_CODES.REFUSED, `expected exit 3 (--json must not be treated as unknown); stderr: ${result.stderr}`);
  const payload = parseJsonOutput("init --json (legacy)", result);
  assert.equal(payload.command, "init");
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 3);
  for (const key of ["state_before", "state_after", "applied", "wrangler_invoked", "message", "classification", "state", "reason"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(payload, key), `init --json refusal missing key: ${key}`);
  }
  assert.equal(payload.state_before, "RUNTIME_LEGACY");
  assert.equal(payload.state_after, null);
  assert.equal(payload.applied, false);
  assert.equal(payload.wrangler_invoked, false);
  assert.equal(payload.state, "RUNTIME_LEGACY");
  assert.equal(payload.classification.state, "RUNTIME_LEGACY");
  assert.ok(
    payload.message.includes("scripts/db.sh diagnose"),
    `refusal message must suggest scripts/db.sh diagnose: ${payload.message}`,
  );
  assert.ok(typeof payload.reason === "string" && payload.reason.length > 0);
  assert.equal(sha256File(dbFile), hashBefore);
  assert.deepEqual(snapshotTree(stateDir), treeBefore);
});

test("CLI init --json on an EMPTY state dir without usable wrangler: exit 3 (environment), zero writes", () => {
  const stateDir = mkTemp("cli-init-empty-no-wrangler");
  const treeBefore = snapshotTree(stateDir);
  const cwd = mkTemp("cli-init-empty-cwd");
  const result = runCli(["init", "--state-dir", stateDir, "--json"], {
    cwd,
    env: { WRANGLER_BIN: join(tmpdir(), "definitely-not-a-wrangler-binary-r2a") },
  });
  assert.equal(result.code, EXIT_CODES.REFUSED, `expected exit 3; stdout: ${result.stdout}; stderr: ${result.stderr}`);
  const payload = parseJsonOutput("init --json (env not ready)", result);
  assert.equal(payload.code, 3);
  assert.equal(payload.state_before, "EMPTY");
  assert.equal(payload.applied, false);
  assert.equal(payload.wrangler_invoked, false);
  assert.ok(
    /wrangler|配置/i.test(payload.message),
    `message must mention wrangler/config: ${payload.message}`,
  );
  assert.deepEqual(snapshotTree(stateDir), treeBefore, "environment refusal must not create a database");
});

test("CLI diagnose --json on an ambiguous state dir: exit 3, JSON error; human mode exit 3", () => {
  const stateDir = mkTemp("cli-ambiguous");
  createDbInStateDir(stateDir, "runtime.sqlite", { fixture: "runtime-ensureSchema-v1.sql" });
  createDatabase(legacyDbPath(stateDir, "schemasql.sqlite"), { fixture: "schema-v1.sql" });
  const cwd = mkTemp("cli-ambiguous-cwd");

  const jsonResult = runCli(["diagnose", "--state-dir", stateDir, "--json"], { cwd });
  assert.equal(jsonResult.code, EXIT_CODES.REFUSED);
  const payload = parseJsonOutput("diagnose --json (ambiguous)", jsonResult);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 3);
  assert.ok(typeof payload.message === "string" && payload.message.includes("--db-file"));
  assert.equal(payload.error.kind, "TARGET_AMBIGUOUS");

  const humanResult = runCli(["diagnose", "--state-dir", stateDir], { cwd });
  assert.equal(humanResult.code, EXIT_CODES.REFUSED);
  assert.ok(humanResult.stderr.includes("--db-file"));

  const initResult = runCli(["init", "--state-dir", stateDir, "--json"], { cwd });
  assert.equal(initResult.code, EXIT_CODES.REFUSED, "ambiguous init must exit 3");
  const initPayload = parseJsonOutput("init --json (ambiguous)", initResult);
  assert.equal(initPayload.code, 3);
  assert.equal(initPayload.state_before, null);
  assert.equal(initPayload.state_after, null);
  assert.equal(initPayload.applied, false);
  assert.equal(initPayload.wrangler_invoked, false);
  assert.ok(initPayload.message.includes("--db-file"));
});

test("CLI diagnose on the real cold-start layout: EMPTY, metadata.sqlite excluded, data file picked", () => {
  const stateDir = mkTemp("cli-cold-start");
  const layout = createMiniflareInternalsStateDir(stateDir, { dataSeed: "cli-cold-start" });
  const cwd = mkTemp("cli-cold-start-cwd");
  const dataHash = sha256File(layout.dataFile);
  const metadataHash = sha256File(layout.metadataFile);

  const result = runCli(["diagnose", "--state-dir", stateDir, "--json"], { cwd });
  assert.equal(result.code, EXIT_CODES.OK, `stderr: ${result.stderr}`);
  const payload = parseJsonOutput("diagnose --json (cold start)", result);
  assert.equal(payload.state, "EMPTY");
  assert.equal(payload.allowed_for_init, true);
  assert.equal(payload.target.db_file, layout.dataFile);
  assert.deepEqual(payload.target.ignored_internal_files, [layout.metadataFile]);
  assert.equal(payload.target.candidates.length, 1);
  assert.equal(sha256File(layout.dataFile), dataHash, "diagnose must be read-only");
  assert.equal(sha256File(layout.metadataFile), metadataHash, "diagnose must not touch metadata.sqlite");

  const initRefusal = runCli(
    ["init", "--state-dir", stateDir, "--json", "--db-file", layout.metadataFile],
    { cwd },
  );
  assert.equal(initRefusal.code, EXIT_CODES.REFUSED, "explicit metadata.sqlite must be refused");
  const initPayload = parseJsonOutput("init --json (metadata target)", initRefusal);
  assert.equal(initPayload.error.kind, "TARGET_INTERNAL_FILE");
});

test("CLI init refuses --db-file so the classified target is always the wrangler write target", () => {
  // Safety invariant (R2A independent review R1): classification must never point at
  // a different file than the one wrangler will migrate. The real runner always
  // targets the D1 binding under --state-dir, so init rejects --db-file outright.
  const stateDir = mkTemp("cli-init-dbfile-state");
  const legacyFile = createDbInStateDir(stateDir, "runtime.sqlite", { fixture: "runtime-ensureSchema-v1.sql" });
  const outsideDir = mkTemp("cli-init-dbfile-outside");
  const outsideFile = join(outsideDir, "outside-empty.sqlite");
  createDatabase(outsideFile, {});
  const cwd = mkTemp("cli-init-dbfile-cwd");
  const legacyHash = sha256File(legacyFile);

  const refused = runCli(["init", "--state-dir", stateDir, "--db-file", outsideFile, "--json"], { cwd });
  assert.equal(refused.code, EXIT_CODES.REFUSED, `stderr: ${refused.stderr}`);
  const payload = parseJsonOutput("init --json (refused --db-file)", refused);
  assert.equal(payload.code, EXIT_CODES.REFUSED);
  assert.equal(payload.error.kind, "TARGET_DBFILE_UNSUPPORTED_FOR_INIT");
  assert.equal(payload.wrangler_invoked, false);
  assert.ok(payload.message.includes("--state-dir"));
  assert.equal(sha256File(legacyFile), legacyHash, "a refused init must not touch the state-dir database");
  const legacyDb = new DatabaseSync(legacyFile);
  try {
    assert.equal(tableExists(legacyDb, "d1_migrations"), false, "a refused init must not add a migration ledger");
  } finally {
    legacyDb.close();
  }

  // diagnose keeps --db-file for strictly read-only classification.
  const diagnosed = runCli(["diagnose", "--db-file", outsideFile, "--json"], { cwd });
  assert.equal(diagnosed.code, EXIT_CODES.OK, `diagnose stderr: ${diagnosed.stderr}`);
  assert.equal(parseJsonOutput("diagnose --db-file (read-only)", diagnosed).state, "EMPTY");
  assert.equal(sha256File(legacyFile), legacyHash, "diagnose --db-file must remain read-only");
});

test("CLI db.sh wrapper is executable, cwd-independent and supports --json (init no-op and diagnose)", () => {
  assert.ok(existsSync(DB_SH_PATH), "scripts/db.sh exists");
  assert.notEqual(statSync(DB_SH_PATH).mode & 0o111, 0, "scripts/db.sh is executable");

  const stateDir = mkTemp("dbsh-state");
  const dbFile = createDbInStateDir(stateDir, "complete.sqlite", {
    migrations: MIGRATION_FILES.length,
    ledger: MIGRATION_FILES,
  });
  const cwd = mkTemp("dbsh-other-cwd");
  const version = runDbSh(["version", "--json"], { cwd });
  assert.equal(version.code, EXIT_CODES.OK, `db.sh version stderr: ${version.stderr}`);
  assert.equal(parseJsonOutput("db.sh version", version).expected.migrations_count, 13);

  const diagnosis = runDbSh(["diagnose", "--state-dir", stateDir, "--json"], { cwd });
  assert.equal(diagnosis.code, EXIT_CODES.OK, `db.sh diagnose stderr: ${diagnosis.stderr}`);
  assert.equal(parseJsonOutput("db.sh diagnose", diagnosis).state, "MIGRATION_COMPLETE");

  const hashBeforeInit = sha256File(dbFile);
  const noop = runDbSh(["init", "--state-dir", stateDir, "--json"], { cwd });
  assert.equal(noop.code, EXIT_CODES.OK, `db.sh init stderr: ${noop.stderr}`);
  const initPayload = parseJsonOutput("db.sh init", noop);
  assert.equal(initPayload.state_before, "MIGRATION_COMPLETE");
  assert.equal(initPayload.applied, false);
  assert.equal(sha256File(dbFile), hashBeforeInit, "no-op init through db.sh must not write");

  // db.sh must resolve the app root even when called via a relative path from a
  // different cwd.
  // /var is a symlink to /private/var on macOS, so a relative invocation must be
  // computed from real paths or the kernel resolves it to the wrong parent.
  const relativeWrapper = relative(realpathSync(cwd), realpathSync(DB_SH_PATH));
  const relativeResult = spawnSync(relativeWrapper, ["version", "--json"], {
    cwd,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  assert.equal(
    relativeResult.status,
    EXIT_CODES.OK,
    `relative db.sh status=${relativeResult.status} error=${
      relativeResult.error ? `${relativeResult.error.code}:${relativeResult.error.message}` : "none"
    } signal=${relativeResult.signal} stderr: ${relativeResult.stderr}`,
  );
});

test("CLI usage errors and help", () => {
  const cwd = mkTemp("cli-usage-cwd");
  const help = runCli(["--help"], { cwd });
  assert.equal(help.code, EXIT_CODES.OK);
  assert.ok(help.stdout.includes("diagnose"));

  const helpCommand = runCli(["help"], { cwd });
  assert.equal(helpCommand.code, EXIT_CODES.OK);

  const unknownCommand = runCli(["repair"], { cwd });
  assert.equal(unknownCommand.code, EXIT_CODES.ERROR, "repair is not a command (no repair/adopt entry point)");

  const unknownFlag = runCli(["version", "--adopt"], { cwd });
  assert.equal(unknownFlag.code, EXIT_CODES.ERROR, "unknown flags are rejected");

  const unknownFlagJson = runCli(["init", "--state-dir", cwd, "--adopt", "--json"], { cwd });
  assert.equal(unknownFlagJson.code, EXIT_CODES.ERROR);
  const payload = parseJsonOutput("unknown flag json", unknownFlagJson);
  assert.equal(payload.code, 1);
  assert.equal(payload.error.kind, "USAGE_ERROR");

  const noCommand = runCli([], { cwd });
  assert.equal(noCommand.code, EXIT_CODES.ERROR);
});

test("CLI exposes no repair/adopt/hidden write command", () => {
  const cwd = mkTemp("cli-no-write-entry");
  for (const verb of ["repair", "adopt", "fix", "rebuild", "migrate", "apply", "restore"]) {
    const result = runCli([verb, "--state-dir", cwd], { cwd });
    assert.equal(result.code, EXIT_CODES.ERROR, `${verb} must not be an accepted command`);
  }
});

// ===========================================================================
// Execution failures: runner error mapping and post-condition enforcement
// ===========================================================================

await testAsync("EXEC partial database + environment-not-ready runner -> exit 3, no DB deletion", async () => {
  const stateDir = mkTemp("exec-env-not-ready");
  const dbFile = createDbInStateDir(stateDir, "partial.sqlite", {
    migrations: 5,
    ledger: knownMigrationPrefix(5),
  });
  const hashBefore = sha256File(dbFile);
  const calls = [];
  const runner = async (context) => {
    calls.push(context);
    throw new DbSafetyError(EXIT_CODES.REFUSED, "ENV_NOT_READY", "缺少 wrangler 本地配置（测试注入）", {
      invoked: false,
    });
  };
  const result = await runInit({ stateDir, appRoot: APP_ROOT, runMigrations: runner });
  assertInitResultShape(result);
  assert.equal(result.code, EXIT_CODES.REFUSED);
  assert.equal(result.stateBefore, "MIGRATION_PARTIAL_OK");
  assert.equal(result.stateAfter, null);
  assert.equal(result.applied, false);
  assert.equal(result.wranglerInvoked, false, "environment precondition means wrangler was not invoked");
  assert.equal(calls.length, 1);
  assert.equal(result.error.kind, "ENV_NOT_READY");
  assert.ok(existsSync(dbFile), "execution failure must not delete the database");
  assert.equal(sha256File(dbFile), hashBefore, "execution failure must not modify the database");
});

await testAsync("EXEC runner execution failure (spawned) -> exit 1 with wrangler_invoked=true, DB preserved", async () => {
  const stateDir = mkTemp("exec-failed");
  const dbFile = createDbInStateDir(stateDir, "partial.sqlite", {
    migrations: 5,
    ledger: knownMigrationPrefix(5),
  });
  const hashBefore = sha256File(dbFile);
  const runner = async () => {
    throw new DbSafetyError(EXIT_CODES.ERROR, "MIGRATION_FAILED", "wrangler d1 migrations apply 失败（测试注入）", {
      invoked: true,
    });
  };
  const result = await runInit({ stateDir, appRoot: APP_ROOT, runMigrations: runner });
  assert.equal(result.code, EXIT_CODES.ERROR);
  assert.equal(result.stateBefore, "MIGRATION_PARTIAL_OK");
  assert.equal(result.stateAfter, null);
  assert.equal(result.applied, false);
  assert.equal(result.wranglerInvoked, true, "spawned execution failure reports wrangler_invoked=true");
  assert.equal(result.error.kind, "MIGRATION_FAILED");
  assert.ok(existsSync(dbFile));
  assert.equal(sha256File(dbFile), hashBefore);
});

await testAsync("EXEC runner that does nothing -> exit 1 because the post-state is not MIGRATION_COMPLETE", async () => {
  const stateDir = mkTemp("exec-noop-runner");
  const dbFile = createDbInStateDir(stateDir, "partial.sqlite", {
    migrations: 5,
    ledger: knownMigrationPrefix(5),
  });
  const hashBefore = sha256File(dbFile);
  const runner = async () => ({ exitCode: 0 });
  const result = await runInit({ stateDir, appRoot: APP_ROOT, runMigrations: runner });
  assert.equal(result.code, EXIT_CODES.ERROR);
  assert.equal(result.stateBefore, "MIGRATION_PARTIAL_OK");
  assert.equal(result.stateAfter, "MIGRATION_PARTIAL_OK", "post-condition is re-classified, not assumed");
  assert.equal(result.applied, false);
  assert.equal(result.wranglerInvoked, true);
  assert.ok(result.message.includes("MIGRATION_PARTIAL_OK"), `message must print the diagnosis: ${result.message}`);
  assert.ok(existsSync(dbFile), "failed post-condition must not delete the database");
  assert.equal(sha256File(dbFile), hashBefore);
});

// ===========================================================================
// Summary
// ===========================================================================

test("all state matrix outcomes use the documented exit-code contract", () => {
  assert.deepEqual(
    Object.entries(EXIT_CODES).sort((a, b) => a[1] - b[1]),
    [
      ["OK", 0],
      ["ERROR", 1],
      ["REFUSED", 3],
    ],
  );
});

cleanupTempRoots();

console.log("");
console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`FAILED CASES: ${failures.map((item) => item.name).join(" | ")}`);
  process.exitCode = 1;
} else {
  console.log("ALL PASS: A/A2/A3/A4(cold-start metadata)/D/partial(2,5,12)/B/C/E/F/G/G2/H/I/J + EXEC, legacy+partial init, idempotent init, refusal zero-write, CLI JSON (0/3/1-shaped)/--json, ambiguous targets, no write entry points");
  process.exitCode = 0;
}
