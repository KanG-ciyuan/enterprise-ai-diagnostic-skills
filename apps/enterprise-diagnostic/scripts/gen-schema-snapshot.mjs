#!/usr/bin/env node
// R2A schema-snapshot generator.
//
// The numbered migrations (migrations/NNNN_*.sql) are the ONLY schema authority.
// This script replays the frozen chain into an isolated in-memory SQLite database
// and derives three deterministic build artifacts from it:
//
//   schema.sql                       offline terminal snapshot (GENERATED — DO NOT EDIT)
//   functions/_schema.generated.js   fingerprint constants + expected contract
//   migrations/MIGRATIONS.lock       append-only SHA-256 lock over the migration bytes
//
// The replay is read-only with respect to the migration files and never touches a
// real database, a wrangler state directory or the network.
//
// Usage:
//   node scripts/gen-schema-snapshot.mjs          # write all three artifacts
//   node scripts/gen-schema-snapshot.mjs --check  # compare in memory, never write
//
// Output contains no timestamps and no environment-dependent values, so running the
// generator twice over the same inputs produces byte-identical files.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  BUSINESS_TABLES,
  FINGERPRINT_VERSION,
  deriveContract,
  fingerprintOf,
  isExcludedTable,
  stableStringify,
} from "./lib/schema-fingerprint.mjs";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(APP_ROOT, "migrations");
const SCHEMA_SQL_PATH = join(APP_ROOT, "schema.sql");
const GENERATED_JS_PATH = join(APP_ROOT, "functions", "_schema.generated.js");
const LOCK_PATH = join(MIGRATIONS_DIR, "MIGRATIONS.lock");
const LEGACY_FINGERPRINTS_PATH = join(APP_ROOT, "scripts", "schema", "known-legacy-fingerprints.json");

const GENERATED_MARKER = "GENERATED — DO NOT EDIT";
const GENERATOR_NAME = "scripts/gen-schema-snapshot.mjs";
const LOCK_VERSION = 1;
const MIGRATION_NAME_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COUNT_KEYS = ["tables", "columns", "fk", "explicitIndexes", "uniqueConstraints", "triggers", "views"];
const LEGACY_SHAPE_KEYS = ["runtimeV1", "schemaSqlV1", "schemaSqlBooted"];

function fail(message) {
  const error = new Error(message);
  error.isGeneratorError = true;
  throw error;
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  let checkOnly = false;
  for (const arg of argv) {
    if (arg === "--check") {
      checkOnly = true;
    } else {
      fail(`unknown argument: ${arg} (expected no arguments or --check)`);
    }
  }
  return { checkOnly };
}

/** Migration file names in ascending order (the replay order). */
function readMigrationFiles() {
  const names = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (names.length === 0) fail(`no migration files found in ${MIGRATIONS_DIR}`);
  for (const name of names) {
    if (!MIGRATION_NAME_PATTERN.test(name)) {
      fail(`migration file does not match NNNN_<name>.sql: ${name}`);
    }
  }
  return names;
}

function shapeOf(fingerprint) {
  return { hash: fingerprint.hash, counts: fingerprint.counts };
}

/**
 * Replay the migration chain, capturing the fingerprint of every honest prefix
 * (k=0 is the empty database, k=13 is the terminal state).
 */
function replayMigrations(files) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const prefixes = [{ k: 0, ...shapeOf(fingerprintOf(db)) }];
  for (const [index, name] of files.entries()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    db.exec(sql);
    prefixes.push({ k: index + 1, ...shapeOf(fingerprintOf(db)) });
  }
  if (prefixes.length !== files.length + 1) {
    fail(`prefix fingerprint count ${prefixes.length} != ${files.length + 1}`);
  }
  const terminal = prefixes[prefixes.length - 1];
  if (terminal.k !== files.length) fail("terminal prefix is not the last migration");
  for (const [index, prefix] of prefixes.entries()) {
    if (prefix.k !== index) fail(`prefix k=${prefix.k} is out of order`);
  }
  return { db, prefixes, terminal };
}

function normalizeStatement(sql) {
  const text = String(sql).trimEnd();
  return text.endsWith(";") ? text : `${text};`;
}

/** schema.sql: header + PRAGMA + CREATE TABLE (creation order) + CREATE INDEX (creation order). */
function renderSchemaSql(db, files) {
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL ORDER BY rowid")
    .all()
    .filter((row) => !isExcludedTable(row.name));
  const indexes = db
    .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY rowid")
    .all()
    .filter((row) => !isExcludedTable(row.name) && !isExcludedTable(row.tbl_name));

  const migrationList = files.map((name) => `--   ${name}`).join("\n");
  const statements = [...tables, ...indexes].map((row) => normalizeStatement(row.sql));
  return [
    `-- ${GENERATED_MARKER}`,
    `-- Generated by ${GENERATOR_NAME} from the numbered migrations; do not edit by hand.`,
    "--",
    "-- Source of truth: the frozen migration chain, replayed in file-name order",
    "-- inside an isolated in-memory SQLite database with foreign key enforcement on.",
    "-- Replayed migrations:",
    migrationList,
    "--",
    "-- This is an offline snapshot of the terminal schema shape: CREATE TABLE",
    "-- statements in creation order, then explicit CREATE INDEX statements. SQLite",
    "-- internal objects, wrangler migration-bookkeeping tables and other excluded",
    "-- runtime objects are omitted on purpose.",
    `-- Regenerate with: node ${GENERATOR_NAME}`,
    "",
    "PRAGMA foreign_keys = ON;",
    "",
    statements.join("\n\n"),
    "",
  ].join("\n");
}

function formatCounts(counts) {
  for (const key of COUNT_KEYS) {
    if (!Number.isInteger(counts[key])) fail(`fingerprint counts.${key} is not an integer`);
  }
  return `{ ${COUNT_KEYS.map((key) => `${key}: ${counts[key]}`).join(", ")} }`;
}

function formatShape(shape, indent) {
  return [
    `${indent}{`,
    `${indent}  hash: "${shape.hash}",`,
    `${indent}  counts: ${formatCounts(shape.counts)},`,
    `${indent}},`,
  ].join("\n");
}

function formatFrozenArray(name, items, renderItem) {
  const body = items.map((item) => `  ${renderItem(item)},`).join("\n");
  return `export const ${name} = Object.freeze([\n${body}\n]);\n`;
}

/** functions/_schema.generated.js: ESM constants consumed by runtime, CLI and tests. */
function renderGeneratedJs({ files, prefixes, terminal, contract, legacy }) {
  const head = files[files.length - 1];
  const provenance = legacy.provenance;
  const prefixLines = prefixes
    .map(
      (prefix) =>
        `    { k: ${prefix.k}, hash: "${prefix.hash}", counts: ${formatCounts(prefix.counts)} },`,
    )
    .join("\n");

  return [
    `// ${GENERATED_MARKER}`,
    `// Generated by ${GENERATOR_NAME} from migrations/${files[0]} .. migrations/${head}.`,
    "// Do not edit by hand: the numbered migrations are the only schema authority.",
    "//",
    "// Deterministic constants derived from replaying the frozen migration chain:",
    "//   - fingerprint v1 (scripts/lib/schema-fingerprint.mjs), including every",
    "//     honest prefix k=0..N so a partial migration state can be recognized;",
    "//   - the expected terminal FK relations / unique keys (EXPECTED contract);",
    "//   - migrations lock names/head for the request-time readiness gate.",
    "//",
    "// Legacy recognition shapes below are copied verbatim from",
    "// scripts/schema/known-legacy-fingerprints.json (version 1). They identify",
    "// historical databases only; they are NOT a schema authority.",
    `// Provenance: source_commit=${provenance.source_commit}`,
    `// Provenance: source_schema_sql_sha256=${provenance.source_schema_sql_sha256}`,
    `// Provenance: derived_at=${provenance.derived_at}`,
    "",
    `export const GENERATED_FINGERPRINT_VERSION = ${FINGERPRINT_VERSION};`,
    "",
    `export const EXPECTED_MIGRATION_HEAD = ${JSON.stringify(head)};`,
    "",
    formatFrozenArray("KNOWN_MIGRATIONS", files, (name) => JSON.stringify(name)),
    formatFrozenArray("BUSINESS_TABLES", [...BUSINESS_TABLES], (name) => JSON.stringify(name)),
    "export const SCHEMA_FINGERPRINTS = Object.freeze({",
    `  v: ${FINGERPRINT_VERSION},`,
    "  terminal: {",
    `    hash: "${terminal.hash}",`,
    `    counts: ${formatCounts(terminal.counts)},`,
    "  },",
    "  prefixes: [",
    prefixLines,
    "  ],",
    ...LEGACY_SHAPE_KEYS.map(
      (key) => `  ${key}: { hash: "${legacy.shapes[key].hash}", counts: ${formatCounts(legacy.shapes[key].counts)} },`,
    ),
    "});",
    "",
    formatFrozenArray("EXPECTED_FK_RELATIONS", contract.fkRelations, (item) => stableStringify(item)),
    formatFrozenArray("EXPECTED_UNIQUE_KEYS", contract.uniqueKeys, (item) => stableStringify(item)),
  ].join("\n");
}

/** migrations/MIGRATIONS.lock: append-only SHA-256 lock over the migration bytes. */
function renderLock(files) {
  const entries = files.map((name) => ({
    name,
    sha256: sha256Hex(readFileSync(join(MIGRATIONS_DIR, name))),
  }));
  const lock = {
    version: LOCK_VERSION,
    generated_by: GENERATOR_NAME,
    files: entries,
  };
  return `${JSON.stringify(lock, null, 2)}\n`;
}

function requireCountsObject(counts, label) {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    fail(`${label}.counts must be an object`);
  }
  for (const key of COUNT_KEYS) {
    if (!Number.isInteger(counts[key])) fail(`${label}.counts.${key} must be an integer`);
  }
}

/**
 * Load the legacy recognition shapes. They are inputs only (like the migrations):
 * the generator validates the document and copies the hashes/counts into the
 * generated module, keeping provenance visible.
 */
function loadLegacyFingerprints() {
  const raw = JSON.parse(readFileSync(LEGACY_FINGERPRINTS_PATH, "utf8"));
  if (raw.version !== 1) fail(`known-legacy-fingerprints.json version must be 1, got ${raw.version}`);
  if (!raw.fingerprint || raw.fingerprint.version !== FINGERPRINT_VERSION) {
    fail(`known-legacy-fingerprints.json fingerprint.version must be ${FINGERPRINT_VERSION}`);
  }
  const shapes = {};
  for (const key of LEGACY_SHAPE_KEYS) {
    const shape = raw.shapes && raw.shapes[key];
    if (!shape) fail(`known-legacy-fingerprints.json is missing shapes.${key}`);
    if (!SHA256_PATTERN.test(String(shape.hash))) {
      fail(`known-legacy-fingerprints.json shapes.${key}.hash is not a sha256 hex digest`);
    }
    requireCountsObject(shape.counts, `shapes.${key}`);
    shapes[key] = { hash: shape.hash, counts: shape.counts };
  }
  const provenance = raw.provenance || {};
  for (const field of ["source_commit", "source_schema_sql_sha256", "derived_at"]) {
    if (typeof provenance[field] !== "string" || !provenance[field]) {
      fail(`known-legacy-fingerprints.json provenance.${field} must be a non-empty string`);
    }
  }
  return { shapes, provenance };
}

function firstDifference(diskText, generatedText) {
  const diskLines = diskText.split("\n");
  const generatedLines = generatedText.split("\n");
  const max = Math.max(diskLines.length, generatedLines.length);
  for (let index = 0; index < max; index += 1) {
    if (diskLines[index] !== generatedLines[index]) {
      return {
        line: index + 1,
        disk: diskLines[index] === undefined ? "<eof>" : diskLines[index],
        generated: generatedLines[index] === undefined ? "<eof>" : generatedLines[index],
      };
    }
  }
  return null;
}

function buildArtifacts(files) {
  const replay = replayMigrations(files);
  try {
    const contract = deriveContract(replay.db);
    const legacy = loadLegacyFingerprints();
    return [
      {
        label: "schema.sql",
        path: SCHEMA_SQL_PATH,
        content: renderSchemaSql(replay.db, files),
      },
      {
        label: "functions/_schema.generated.js",
        path: GENERATED_JS_PATH,
        content: renderGeneratedJs({
          files,
          prefixes: replay.prefixes,
          terminal: replay.terminal,
          contract,
          legacy,
        }),
      },
      {
        label: "migrations/MIGRATIONS.lock",
        path: LOCK_PATH,
        content: renderLock(files),
      },
    ];
  } finally {
    replay.db.close();
  }
}

function writeArtifacts(artifacts) {
  for (const artifact of artifacts) {
    mkdirSync(dirname(artifact.path), { recursive: true });
    writeFileSync(artifact.path, artifact.content, "utf8");
    const bytes = Buffer.byteLength(artifact.content, "utf8");
    console.log(`wrote ${artifact.label} (${bytes} bytes, sha256 ${sha256Hex(artifact.content)})`);
  }
}

function checkArtifacts(artifacts) {
  const mismatches = [];
  for (const artifact of artifacts) {
    let disk;
    try {
      disk = readFileSync(artifact.path);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        mismatches.push({ artifact, reason: "file is missing on disk" });
        continue;
      }
      throw error;
    }
    const generated = Buffer.from(artifact.content, "utf8");
    if (disk.equals(generated)) continue;
    const detail = firstDifference(disk.toString("utf8"), artifact.content);
    mismatches.push({
      artifact,
      reason: `bytes differ (disk ${disk.length} bytes, generated ${generated.length} bytes)`,
      detail,
    });
  }
  if (mismatches.length === 0) {
    console.log(`check OK: ${artifacts.length}/${artifacts.length} generated artifacts are up to date`);
    return;
  }
  console.error(`check FAILED: ${mismatches.length}/${artifacts.length} generated artifacts are out of date`);
  for (const mismatch of mismatches) {
    console.error(`  - ${mismatch.artifact.label}: ${mismatch.reason}`);
    if (mismatch.detail) {
      console.error(`    first difference at line ${mismatch.detail.line}`);
      console.error(`    disk:      ${mismatch.detail.disk}`);
      console.error(`    generated: ${mismatch.detail.generated}`);
    }
  }
  console.error(`run: node ${GENERATOR_NAME}`);
  process.exitCode = 1;
}

function main() {
  const { checkOnly } = parseArgs(process.argv.slice(2));
  const files = readMigrationFiles();
  const artifacts = buildArtifacts(files);
  if (checkOnly) {
    checkArtifacts(artifacts);
    return;
  }
  writeArtifacts(artifacts);
  console.log(`generated ${artifacts.length} artifacts from ${files.length} migrations (fingerprint v${FINGERPRINT_VERSION})`);
}

try {
  main();
} catch (error) {
  if (error && error.isGeneratorError) {
    console.error(`gen-schema-snapshot: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
