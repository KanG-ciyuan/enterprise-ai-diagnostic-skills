import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { D1Harness } from "./d1_harness.mjs";
import { EXPECTED_MIGRATION_HEAD, KNOWN_MIGRATIONS } from "../functions/_schema.generated.js";
import { assertSchemaReady } from "../functions/_shared.js";
import { onRequestGet as readyGet } from "../functions/api/ready.js";
import { onRequestGet as healthGet } from "../functions/api/health.js";
import { onRequestGet as sessionGet } from "../functions/api/auth/session.js";
import { onRequestPost as demoEnterPost } from "../functions/api/demo/enter.js";

// R2A readiness gate: read-only, 503 with codes when not ready, never DDL.
// All databases here are in-memory; no network, no real DB, no writes besides the
// test's own INSERTs into an isolated in-memory schema.

const LEDGER_DDL =
  'CREATE TABLE "d1_migrations" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)';

function readyDb() {
  // D1Harness loads the generated schema.sql and seeds the wrangler-compatible
  // d1_migrations ledger by default (a fully migrated local D1 database).
  return new D1Harness();
}

function unmanagedDb() {
  // Historical 19-table shape without a migration ledger (old ensureSchema/schema.sql).
  return new D1Harness({ withLedger: false });
}

function outdatedDb() {
  const db = new D1Harness({ withLedger: false });
  db.exec(LEDGER_DDL);
  for (const name of KNOWN_MIGRATIONS.slice(0, -1)) {
    db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name).run();
  }
  return db;
}

function unsupportedDb() {
  const db = new D1Harness({ withLedger: false });
  db.exec(LEDGER_DDL);
  db.prepare("INSERT INTO d1_migrations(name) VALUES('0099_future_migration.sql')").run();
  return db;
}

function incompleteDb() {
  const db = new D1Harness({ loadSchema: false });
  const first = KNOWN_MIGRATIONS[0];
  db.exec(readFileSync(new URL(`../migrations/${first}`, import.meta.url), "utf8"));
  return db;
}

function emptyDb() {
  return new D1Harness({ loadSchema: false });
}

function schemaSignature(db) {
  return JSON.stringify(
    db.all("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"),
  );
}

async function expectReadinessError(db, expectedStatus, expectedCode) {
  try {
    await assertSchemaReady(db);
  } catch (error) {
    assert.ok(error instanceof Response, `expected a Response, got ${String(error && error.stack ? error.stack : error)}`);
    assert.equal(error.status, expectedStatus, `unexpected status for ${expectedCode}`);
    const body = await error.json();
    assert.equal(body.code, expectedCode, `unexpected readiness code (detail: ${body.detail})`);
    assert.ok(typeof body.detail === "string" && body.detail.length > 0);
    return body;
  }
  throw new Error(`expected readiness failure with code ${expectedCode}, but assertSchemaReady resolved`);
}

const results = [];
function ok(name) {
  results.push(name);
}

// 1) empty DB -> 503 db_not_initialized, and the probe must not create tables.
{
  const db = emptyDb();
  const before = schemaSignature(db);
  await expectReadinessError(db, 503, "db_not_initialized");
  assert.equal(schemaSignature(db), before, "readiness probe performed DDL on an empty DB");
  assert.equal(db.all("SELECT name FROM sqlite_master WHERE type='table'").length, 0);
  db.close();
  ok("empty -> db_not_initialized, no DDL");
}

// 2) historical 19-table DB with no ledger -> 503 db_schema_unmanaged (no auto migration).
{
  const db = unmanagedDb();
  const before = schemaSignature(db);
  const body = await expectReadinessError(db, 503, "db_schema_unmanaged");
  assert.match(body.detail, /diagnose/);
  assert.equal(schemaSignature(db), before, "readiness probe performed DDL/DML on historical DB");
  db.close();
  ok("unmanaged -> db_schema_unmanaged, no DDL");
}

// 3) honest partial schema (0001 only) -> 503 db_schema_incomplete.
{
  const db = incompleteDb();
  await expectReadinessError(db, 503, "db_schema_incomplete");
  db.close();
  ok("incomplete -> db_schema_incomplete");
}

// 4) ledger head behind expected -> 503 db_schema_outdated.
{
  const db = outdatedDb();
  await expectReadinessError(db, 503, "db_schema_outdated");
  db.close();
  ok("outdated -> db_schema_outdated");
}

// 5) ledger head unknown/future -> 503 db_schema_unsupported.
{
  const db = unsupportedDb();
  await expectReadinessError(db, 503, "db_schema_unsupported");
  db.close();
  ok("too new -> db_schema_unsupported");
}

// 6) fully migrated DB -> ready; cached per database object; no DDL.
{
  const db = readyDb();
  const before = schemaSignature(db);
  const first = await assertSchemaReady(db);
  const second = await assertSchemaReady(db);
  assert.equal(first.head, EXPECTED_MIGRATION_HEAD);
  assert.equal(first.tables, 19);
  assert.equal(second, first, "readiness result must be cached per database object");
  assert.equal(schemaSignature(db), before, "readiness probe performed DDL on a ready DB");
  db.close();
  ok("complete -> ready (cached), no DDL");
}

// 7) GET /api/ready maps the same contract to 200/503.
{
  const empty = emptyDb();
  const notReady = await readyGet({ env: { DB: empty } }).then(async (res) => ({
    status: res.status,
    body: await res.json(),
  }));
  assert.equal(notReady.status, 503);
  assert.equal(notReady.body.code, "db_not_initialized");
  empty.close();

  const ready = readyDb();
  const res = await readyGet({ env: { DB: ready } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ready, true);
  assert.equal(body.schema, EXPECTED_MIGRATION_HEAD);
  assert.equal(body.tables, 19);
  ready.close();
  ok("GET /api/ready -> 200 ready / 503 with code");
}

// 8) GET /api/health stays liveness-only (200 on an uninitialized DB).
{
  const empty = emptyDb();
  const res = await healthGet({ env: { DB: empty } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  empty.close();
  ok("GET /api/health remains liveness (200 before init)");
}

// 9) demo entry never auto-creates tables: it fails closed with 503 and no DDL.
{
  const env = { FORMAL_AUTH_MODE: "development", FORMAL_AUTH_TEST_MODE: "1" };
  const empty = emptyDb();
  const before = schemaSignature(empty);
  const request = new Request("http://127.0.0.1/api/demo/enter", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "employee" }),
  });
  const res = await demoEnterPost({ request, env: { ...env, DB: empty } });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, "db_not_initialized");
  assert.equal(schemaSignature(empty), before, "demo entry performed DDL on a cold DB");
  assert.equal(empty.all("SELECT name FROM sqlite_master WHERE type='table'").length, 0);
  empty.close();

  // On a ready DB the demo entry works and must not execute DDL.
  const ready = readyDb();
  const beforeReady = schemaSignature(ready);
  const readyRes = await demoEnterPost({ request, env: { ...env, DB: ready } });
  assert.equal(readyRes.status, 200);
  assert.equal(schemaSignature(ready), beforeReady, "demo entry performed DDL on a ready DB");
  assert.ok(ready.all("SELECT COUNT(*) AS n FROM accounts").at(0).n >= 4);
  ready.close();
  ok("demo/enter -> 503 on cold DB (no DDL) / 200 on ready DB (no DDL)");
}

// 10) formal routes return 503 before auth on a cold DB, 401 after init; no DDL.
{
  const empty = emptyDb();
  const before = schemaSignature(empty);
  const coldReq = new Request("http://127.0.0.1/api/auth/session");
  const coldRes = await sessionGet({ request: coldReq, env: { DB: empty } });
  assert.equal(coldRes.status, 503);
  assert.equal((await coldRes.json()).code, "db_not_initialized");
  assert.equal(schemaSignature(empty), before, "formal route performed DDL on a cold DB");
  empty.close();

  const ready = readyDb();
  const beforeReady = schemaSignature(ready);
  const readyRes = await sessionGet({
    request: new Request("http://127.0.0.1/api/auth/session"),
    env: { DB: ready },
  });
  assert.equal(readyRes.status, 401, "auth gate must be preserved");
  assert.equal(schemaSignature(ready), beforeReady, "formal route performed DDL on a ready DB");
  ready.close();
  ok("formal route -> 503 before auth on cold DB / 401 after init, no DDL");
}

console.log(`readiness gate: ok (${results.length} groups)`);
for (const name of results) console.log(`  PASS ${name}`);
