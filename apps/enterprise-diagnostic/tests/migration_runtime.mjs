import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { BUSINESS_TABLES, fingerprintOf } from "../scripts/lib/schema-fingerprint.mjs";
import {
  EXPECTED_MIGRATION_HEAD,
  KNOWN_MIGRATIONS,
  SCHEMA_FINGERPRINTS,
} from "../functions/_schema.generated.js";

// R2A: migrations/0001..0013 are the ONLY schema authority. schema.sql is a
// generated snapshot and must be structurally identical to the migration chain.
// This test is read-only (in-memory databases only).

const migrationsDir = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

assert.deepEqual(files, [...KNOWN_MIGRATIONS], "migrations directory and generated KNOWN_MIGRATIONS differ");
assert.equal(files.at(-1), EXPECTED_MIGRATION_HEAD, "generated EXPECTED_MIGRATION_HEAD is stale");

function replayMigrations() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of files) db.exec(readFileSync(new URL(file, migrationsDir), "utf8"));
  return db;
}

const migrated = replayMigrations();
const migratedFingerprint = fingerprintOf(migrated);

const schemaDb = new DatabaseSync(":memory:");
schemaDb.exec("PRAGMA foreign_keys = ON");
schemaDb.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
const schemaFingerprint = fingerprintOf(schemaDb);

assert.equal(
  migratedFingerprint.hash,
  schemaFingerprint.hash,
  "numbered migrations and generated schema.sql are not structurally equivalent",
);
assert.equal(
  migratedFingerprint.hash,
  SCHEMA_FINGERPRINTS.terminal.hash,
  "migration chain fingerprint differs from generated SCHEMA_FINGERPRINTS.terminal",
);
assert.deepEqual(
  migratedFingerprint.counts,
  { tables: 19, columns: 259, fk: 16, explicitIndexes: 17, uniqueConstraints: 12, triggers: 0, views: 0 },
  "unexpected terminal schema counts",
);
assert.equal(migratedFingerprint.counts.tables, BUSINESS_TABLES.length);

// Deterministic replay: same SQL input must produce the same fingerprint.
const replayAgain = replayMigrations();
assert.equal(fingerprintOf(replayAgain).hash, migratedFingerprint.hash, "migration replay is not deterministic");
replayAgain.close();

// Generated schema.sql must be marked generated and carry the FK pragma.
const schemaSql = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
assert.match(schemaSql, /GENERATED[\s\S]*DO NOT EDIT/i, "schema.sql is missing the GENERATED header");
assert.match(schemaSql, /PRAGMA foreign_keys = ON;/i, "schema.sql must enable foreign keys for CLI/test execution");
assert.doesNotMatch(schemaSql, /d1_migrations/, "schema.sql must not contain wrangler bookkeeping tables");

// Foreign keys are enforced within the test connection: an orphan row is rejected.
assert.throws(
  () =>
    migrated
      .prepare(
        "INSERT INTO events(event_id,project_id,type,actor_role,actor_id,payload) VALUES('e_orphan','missing-project','t','system','s','{}')",
      )
      .run(),
  /FOREIGN KEY/i,
  "foreign keys are not enforced on the migrated schema",
);

// Unique constraints are enforced: duplicate account email is rejected.
migrated.prepare("INSERT INTO accounts(id,email) VALUES('acct-1','dup@example.test')").run();
assert.throws(
  () => migrated.prepare("INSERT INTO accounts(id,email) VALUES('acct-2','dup@example.test')").run(),
  /UNIQUE/i,
  "unique constraints are not enforced on the migrated schema",
);

// The request-time DDL escape hatch must be gone: no ensureSchema export remains,
// and the ready gate must not perform DDL.
const shared = await import("../functions/_shared.js");
assert.equal(typeof shared.assertSchemaReady, "function", "_shared.js must export assertSchemaReady");
assert.equal(shared.ensureSchema, undefined, "request-time ensureSchema must be removed");
assert.equal(shared.ensureSchemaInternal, undefined, "request-time ensureSchemaInternal must be removed");
const sharedSource = readFileSync(new URL("../functions/_shared.js", import.meta.url), "utf8");
assert.doesNotMatch(sharedSource, /CREATE\s+TABLE/i, "_shared.js must not contain request-time CREATE TABLE DDL");
assert.doesNotMatch(sharedSource, /ALTER\s+TABLE/i, "_shared.js must not contain request-time ALTER TABLE DDL");
assert.doesNotMatch(sharedSource, /CREATE\s+(UNIQUE\s+)?INDEX/i, "_shared.js must not contain request-time CREATE INDEX DDL");

migrated.close();
schemaDb.close();
console.log(
  `raw migration chain and generated schema.sql are equivalent: ok (fingerprint ${migratedFingerprint.hash.slice(0, 12)}…)`,
);
