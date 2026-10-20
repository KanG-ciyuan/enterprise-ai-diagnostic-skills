#!/usr/bin/env node
// R2A A3: generated-artifact integrity tests.
//
// Verifies that the three generated artifacts are deterministic, current and
// structurally faithful to the numbered migration chain:
//   - schema.sql                       (offline terminal snapshot)
//   - functions/_schema.generated.js   (fingerprints + expected contract)
//   - migrations/MIGRATIONS.lock       (append-only SHA-256 lock)
//
// Everything here is read-only with respect to the repository: databases are
// in-memory or built inside an isolated /tmp directory and removed afterwards.
// No network, no wrangler, no real/production database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  BUSINESS_TABLES,
  FINGERPRINT_VERSION,
  deriveContract,
  fingerprintOf,
} from "../scripts/lib/schema-fingerprint.mjs";
import {
  BUSINESS_TABLES as GENERATED_BUSINESS_TABLES,
  EXPECTED_FK_RELATIONS,
  EXPECTED_MIGRATION_HEAD,
  EXPECTED_UNIQUE_KEYS,
  GENERATED_FINGERPRINT_VERSION,
  KNOWN_MIGRATIONS,
  SCHEMA_FINGERPRINTS,
} from "../functions/_schema.generated.js";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(APP_ROOT, "migrations");
const SCHEMA_SQL_PATH = join(APP_ROOT, "schema.sql");
const GENERATED_JS_PATH = join(APP_ROOT, "functions", "_schema.generated.js");
const LOCK_PATH = join(MIGRATIONS_DIR, "MIGRATIONS.lock");
const LEGACY_FINGERPRINTS_PATH = join(APP_ROOT, "scripts", "schema", "known-legacy-fingerprints.json");
const LEGACY_FIXTURES_DIR = join(APP_ROOT, "tests", "fixtures", "legacy");
const GENERATOR_PATH = join(APP_ROOT, "scripts", "gen-schema-snapshot.mjs");
const GENERATOR_REF = "scripts/gen-schema-snapshot.mjs";

const TERMINAL_COUNTS = Object.freeze({
  tables: 19,
  columns: 259,
  fk: 16,
  explicitIndexes: 17,
  uniqueConstraints: 12,
  triggers: 0,
  views: 0,
});

// Frozen baseline hashes: the historical migrations are byte-immutable.
const BASELINE_MIGRATION_SHA256 = Object.freeze({
  "0001_core_baseline.sql": "72d8e21245c26e971f197fcb78b098ba0a6381add285c561bfaedb951aace5f1",
  "0002_evidence_registry.sql": "345cb17f3f8b9538d7bfa53e62d91fd902bcc129ea47f887ffd5136c294e2083",
  "0003_evidence_delivery_upgrade.sql": "8c4017743ca8380487a3d39ffb246fd044230b1bcc34b7f4fb8bfd25d1e3ae3b",
  "0004_fact_cas_material_versions.sql": "a4939e5f6576e564891f22c1b30a48b804698a9e24a8f4c1ff4e1bc523e4d456",
  "0005_authorization_capability.sql": "a3cb29ca8520582e829a2d055f73d48f3e3667d4a3845f20bbf7142ae381624a",
  "0006_authorization_notification_outbox.sql": "f69b44537298141692dcf87d05322e67f5abe8295ca4abddb1b8c8aa36177fb7",
  "0007_decision_packet_transition_cas.sql": "0422d678af2d51d20ecae3a82a93c9933d575ecb8832e8cbdcaf12d8edaabf6e",
  "0008_revision_workflow.sql": "43e7b5063ba31656b03fad0fd29c143a46362f2a4b4b0e5416637333f3caaa11",
  "0009_auth_reassignment_project_gate.sql": "d722e76f55ef4c65b12ff01972959e44f235a2094b5ddc8de401634f9ac50dc6",
  "0010_member_login_challenges.sql": "f728022ecc832e2a62156010c45b1fa9f65dcb9f9a832b07ce6405b4acee4950",
  "0011_work_item_assignment_version.sql": "6bab9110e8012a0dc72d892bf8175f0b88fff0ea94205520f8af40ceed56e9da",
  "0012_builder_account_role.sql": "30eb6dcd5ce82be3ee5cf302902f6d67344ceba10f89db86c775f91449a9030e",
  "0013_fact_evidence_level.sql": "11f723c82eccb7f6fab0c9d5a1b765152611d991eefcef71fa75224a605b8766",
});

const LEGACY_SHAPE_FIXTURES = Object.freeze({
  runtimeV1: "runtime-ensureSchema-v1.sql",
  schemaSqlV1: "schema-v1.sql",
  schemaSqlBooted: "schema-v1-booted.sql",
});

const ISO_TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/;

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runGenerator(cwd, args) {
  return spawnSync(process.execPath, [GENERATOR_REF, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
}

function replayMigrationsInto(db) {
  for (const name of migrationFiles) db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  return db;
}

function replayMigrations() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return replayMigrationsInto(db);
}

function loadSchemaSql() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(SCHEMA_SQL_PATH, "utf8"));
  return db;
}

/**
 * Replay a legacy dump. The historical fixtures were captured with the sqlite3
 * shell and contain an explicit `CREATE TABLE sqlite_sequence(name,seq)` line;
 * SQLite reserves that name and creates the table implicitly for AUTOINCREMENT
 * tables, so that internal statement is skipped. Every other statement is
 * executed verbatim. SQLite-internal tables are excluded from fingerprints.
 */
function loadLegacyFixture(db, sqlText, label) {
  const kept = [];
  for (const line of sqlText.split("\n")) {
    if (/^\s*CREATE\s+TABLE\s+sqlite_/i.test(line)) {
      assert.match(
        line,
        /^\s*CREATE\s+TABLE\s+sqlite_sequence\s*\(/i,
        `${label}: only the internal sqlite_sequence object may be skipped, got: ${line}`,
      );
      continue;
    }
    kept.push(line);
  }
  db.exec(kept.join("\n"));
}

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL  ${name}`);
    console.error(error && error.stack ? error.stack : String(error));
  }
}

// The task contract requires the historical fixture databases to be built in /tmp.
const tempRoot = mkdtempSync(join("/tmp", "pilot18b-r2a-generated-"));

try {
  await check("--check exits 0 for the current artifacts", () => {
    const result = runGenerator(APP_ROOT, ["--check"]);
    assert.equal(result.status, 0, `--check failed:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /check OK: 3\/3 generated artifacts are up to date/);
  });

  await check("--check is deterministic and never mutates the artifacts", () => {
    const before = [SCHEMA_SQL_PATH, GENERATED_JS_PATH, LOCK_PATH].map(sha256File);
    const first = runGenerator(APP_ROOT, ["--check"]);
    const second = runGenerator(APP_ROOT, ["--check"]);
    assert.equal(first.status, 0, `first --check failed:\n${first.stdout}\n${first.stderr}`);
    assert.equal(second.status, 0, `second --check failed:\n${second.stdout}\n${second.stderr}`);
    const after = [SCHEMA_SQL_PATH, GENERATED_JS_PATH, LOCK_PATH].map(sha256File);
    assert.deepEqual(after, before, "--check must not write generated artifacts");
  });

  await check("schema.sql replays to the terminal fingerprint 19/259/16/17/12", () => {
    const db = loadSchemaSql();
    const fingerprint = fingerprintOf(db);
    db.close();
    assert.equal(fingerprint.v, FINGERPRINT_VERSION);
    assert.equal(fingerprint.hash, SCHEMA_FINGERPRINTS.terminal.hash);
    assert.deepEqual(fingerprint.counts, TERMINAL_COUNTS);
    assert.deepEqual(SCHEMA_FINGERPRINTS.terminal.counts, TERMINAL_COUNTS);
    assert.equal(SCHEMA_FINGERPRINTS.v, FINGERPRINT_VERSION);
  });

  await check("schema.sql fingerprint equals direct replay of the 13 migrations", () => {
    const schemaDb = loadSchemaSql();
    const schemaFingerprint = fingerprintOf(schemaDb);
    schemaDb.close();
    const replayDb = replayMigrations();
    const replayFingerprint = fingerprintOf(replayDb);
    replayDb.close();
    assert.equal(schemaFingerprint.hash, replayFingerprint.hash);
    assert.deepEqual(schemaFingerprint.counts, replayFingerprint.counts);
    assert.equal(schemaFingerprint.hash, SCHEMA_FINGERPRINTS.terminal.hash);
  });

  await check("schema.sql contains no excluded/internal schema objects", () => {
    const excluded = (name) =>
      /^sqlite_/i.test(name) || /^_cf_/i.test(name) || /^diag_/i.test(name) || name === "d1_migrations";

    // Explicit objects in the replayed database. `sqlite_sequence` and the
    // sqlite_autoindex_* indexes are created implicitly by SQLite itself (for
    // AUTOINCREMENT/UNIQUE) and are never emitted by the generator.
    const db = loadSchemaSql();
    const objects = db
      .prepare("SELECT type, name FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
      .all();
    db.close();
    assert.deepEqual(
      objects.filter((row) => excluded(row.name) && row.name !== "sqlite_sequence"),
      [],
      "schema.sql must not contain sqlite_*/_cf_*/diag_*/d1_migrations objects",
    );

    // And the emitted CREATE statements must not mention excluded object names.
    const text = readFileSync(SCHEMA_SQL_PATH, "utf8");
    const created = [...text.matchAll(/CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi)].map(
      (match) => match[1],
    );
    assert.ok(created.length > 0, "schema.sql must emit CREATE statements");
    assert.deepEqual(
      created.filter((name) => excluded(name)),
      [],
      "schema.sql emits an excluded CREATE statement",
    );
    assert.doesNotMatch(text, /d1_migrations/, "schema.sql must not contain wrangler bookkeeping tables");
  });

  await check("generated constants match the library and the migrations directory", () => {
    assert.equal(GENERATED_FINGERPRINT_VERSION, FINGERPRINT_VERSION);
    assert.equal(GENERATED_FINGERPRINT_VERSION, 1);
    assert.deepEqual([...KNOWN_MIGRATIONS], migrationFiles);
    assert.equal(EXPECTED_MIGRATION_HEAD, migrationFiles.at(-1));
    assert.equal(EXPECTED_MIGRATION_HEAD, "0013_fact_evidence_level.sql");
    assert.deepEqual([...GENERATED_BUSINESS_TABLES], [...BUSINESS_TABLES]);
    assert.equal(GENERATED_BUSINESS_TABLES.length, 19);
    assert.ok(Object.isFrozen(KNOWN_MIGRATIONS), "KNOWN_MIGRATIONS must be frozen");
    assert.ok(Object.isFrozen(GENERATED_BUSINESS_TABLES), "BUSINESS_TABLES must be frozen");
  });

  await check("prefix fingerprints: 14 honest prefixes with terminal == prefixes[13]", () => {
    const prefixes = SCHEMA_FINGERPRINTS.prefixes;
    assert.ok(Array.isArray(prefixes));
    assert.equal(prefixes.length, migrationFiles.length + 1);
    assert.equal(prefixes.length, 14);
    assert.deepEqual(
      prefixes.map((prefix) => prefix.k),
      Array.from({ length: 14 }, (_value, index) => index),
    );
    const terminal = prefixes.at(-1);
    assert.equal(SCHEMA_FINGERPRINTS.terminal.hash, terminal.hash);
    assert.deepEqual(SCHEMA_FINGERPRINTS.terminal.counts, terminal.counts);
    assert.deepEqual(terminal.counts, TERMINAL_COUNTS);

    // Independently replay each prefix and compare with the generated table.
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    for (let k = 0; k <= migrationFiles.length; k += 1) {
      if (k > 0) db.exec(readFileSync(join(MIGRATIONS_DIR, migrationFiles[k - 1]), "utf8"));
      const fingerprint = fingerprintOf(db);
      assert.equal(fingerprint.hash, prefixes[k].hash, `prefix k=${k} hash mismatch`);
      assert.deepEqual(fingerprint.counts, prefixes[k].counts, `prefix k=${k} counts mismatch`);
    }
    db.close();
  });

  await check("expected FK/unique contract is derived from the terminal replay", () => {
    const db = replayMigrations();
    const contract = deriveContract(db);
    db.close();
    assert.equal(EXPECTED_FK_RELATIONS.length, 16);
    assert.equal(EXPECTED_UNIQUE_KEYS.length, 15);
    assert.deepEqual([...EXPECTED_FK_RELATIONS], contract.fkRelations);
    assert.deepEqual([...EXPECTED_UNIQUE_KEYS], contract.uniqueKeys);
  });

  await check("legacy recognition shapes re-computed from /tmp fixture databases", () => {
    const known = JSON.parse(readFileSync(LEGACY_FINGERPRINTS_PATH, "utf8"));
    assert.equal(known.version, 1);
    assert.equal(known.fingerprint.version, FINGERPRINT_VERSION);
    for (const [key, fixtureName] of Object.entries(LEGACY_SHAPE_FIXTURES)) {
      const fixturePath = join(LEGACY_FIXTURES_DIR, fixtureName);
      const dbPath = join(tempRoot, `${key}.db`);
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA foreign_keys = ON;");
      loadLegacyFixture(db, readFileSync(fixturePath, "utf8"), fixtureName);
      const fingerprint = fingerprintOf(db);
      db.close();
      const shape = SCHEMA_FINGERPRINTS[key];
      assert.ok(shape, `SCHEMA_FINGERPRINTS.${key} is missing`);
      assert.equal(fingerprint.hash, shape.hash, `${key}: fixture hash mismatch`);
      assert.deepEqual(fingerprint.counts, shape.counts, `${key}: fixture counts mismatch`);
      assert.equal(known.shapes[key].hash, shape.hash, `${key}: generated shape differs from known-legacy-fingerprints.json`);
      assert.deepEqual(known.shapes[key].counts, shape.counts, `${key}: generated counts differ from known-legacy-fingerprints.json`);
    }
  });

  await check("historical migration bytes match the frozen baseline hashes", () => {
    assert.deepEqual(Object.keys(BASELINE_MIGRATION_SHA256), migrationFiles);
    for (const [name, expected] of Object.entries(BASELINE_MIGRATION_SHA256)) {
      assert.match(expected, /^[0-9a-f]{64}$/);
      assert.equal(sha256File(join(MIGRATIONS_DIR, name)), expected, `${name} is not byte-identical to the baseline`);
    }
  });

  await check("MIGRATIONS.lock is consistent with the migration bytes", () => {
    const raw = readFileSync(LOCK_PATH, "utf8");
    const lock = JSON.parse(raw);
    assert.deepEqual(Object.keys(lock), ["version", "generated_by", "files"]);
    assert.equal(lock.version, 1);
    assert.equal(lock.generated_by, GENERATOR_REF);
    assert.ok(Array.isArray(lock.files));
    assert.equal(lock.files.length, migrationFiles.length);
    assert.equal(lock.files.length, 13);
    assert.deepEqual(
      lock.files.map((entry) => entry.name),
      migrationFiles,
    );
    const names = lock.files.map((entry) => entry.name);
    assert.deepEqual(names, [...names].sort(), "lock entries must be in ascending file-name order");
    for (const entry of lock.files) {
      assert.deepEqual(Object.keys(entry), ["name", "sha256"]);
      assert.match(entry.sha256, /^[0-9a-f]{64}$/);
      assert.equal(entry.sha256, sha256File(join(MIGRATIONS_DIR, entry.name)), `${entry.name} lock hash mismatch`);
    }
  });

  await check("generated artifacts contain no volatile timestamps", () => {
    const artifacts = [
      ["schema.sql", readFileSync(SCHEMA_SQL_PATH, "utf8")],
      ["functions/_schema.generated.js", readFileSync(GENERATED_JS_PATH, "utf8")],
      ["migrations/MIGRATIONS.lock", readFileSync(LOCK_PATH, "utf8")],
    ];
    for (const [label, text] of artifacts) {
      assert.doesNotMatch(text, /generated_at/i, `${label} must not contain generated_at`);
      assert.doesNotMatch(text, /generatedAt/, `${label} must not contain generatedAt`);
      assert.doesNotMatch(text, ISO_TIMESTAMP_PATTERN, `${label} must not contain an ISO timestamp`);
    }
  });

  await check("generator output is byte-deterministic across isolated runs", () => {
    const isolatedApp = join(tempRoot, "app");
    mkdirSync(join(isolatedApp, "migrations"), { recursive: true });
    cpSync(join(APP_ROOT, "scripts"), join(isolatedApp, "scripts"), { recursive: true });
    for (const name of migrationFiles) {
      cpSync(join(MIGRATIONS_DIR, name), join(isolatedApp, "migrations", name));
    }

    const first = runGenerator(isolatedApp, []);
    assert.equal(first.status, 0, `isolated generation failed:\n${first.stdout}\n${first.stderr}`);
    const isolatedPaths = [
      join(isolatedApp, "schema.sql"),
      join(isolatedApp, "functions", "_schema.generated.js"),
      join(isolatedApp, "migrations", "MIGRATIONS.lock"),
    ];
    const firstShas = isolatedPaths.map(sha256File);

    const second = runGenerator(isolatedApp, []);
    assert.equal(second.status, 0, `second isolated generation failed:\n${second.stdout}\n${second.stderr}`);
    const secondShas = isolatedPaths.map(sha256File);
    assert.deepEqual(secondShas, firstShas, "two runs over the same inputs must be byte-identical");

    const worktreePaths = [SCHEMA_SQL_PATH, GENERATED_JS_PATH, LOCK_PATH];
    for (const [index, isolatedPath] of isolatedPaths.entries()) {
      assert.equal(
        sha256Bytes(readFileSync(isolatedPath)),
        sha256Bytes(readFileSync(worktreePaths[index])),
        `${isolatedPath} differs from the checked-in generated artifact`,
      );
    }
  });

  await check("--check detects drift, exits non-zero and never rewrites files", () => {
    const driftApp = join(tempRoot, "drift-app");
    mkdirSync(join(driftApp, "migrations"), { recursive: true });
    cpSync(join(APP_ROOT, "scripts"), join(driftApp, "scripts"), { recursive: true });
    for (const name of migrationFiles) {
      cpSync(join(MIGRATIONS_DIR, name), join(driftApp, "migrations", name));
    }
    const generated = runGenerator(driftApp, []);
    assert.equal(generated.status, 0, `isolated generation failed:\n${generated.stdout}\n${generated.stderr}`);

    const driftedPath = join(driftApp, "schema.sql");
    const drifted = `${readFileSync(driftedPath, "utf8")}\n-- hand edit that must be reported\n`;
    writeFileSync(driftedPath, drifted);

    const checkResult = runGenerator(driftApp, ["--check"]);
    assert.equal(checkResult.status, 1, "--check must exit non-zero when an artifact drifted");
    assert.match(checkResult.stderr, /check FAILED/);
    assert.match(checkResult.stderr, /schema\.sql/);
    assert.equal(readFileSync(driftedPath, "utf8"), drifted, "--check must not rewrite drifted files");

    const regenerated = runGenerator(driftApp, []);
    assert.equal(regenerated.status, 0, `regeneration failed:\n${regenerated.stdout}\n${regenerated.stderr}`);
    assert.doesNotMatch(readFileSync(driftedPath, "utf8"), /hand edit that must be reported/);
  });
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`\ndb_generated_artifacts_runtime: ${passed}/${total} checks passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  FAILED: ${failure.name}`);
  process.exit(1);
}
console.log(`\ndb_generated_artifacts_runtime: ${passed}/${total} checks passed`);
