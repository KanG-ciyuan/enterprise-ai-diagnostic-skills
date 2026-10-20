#!/usr/bin/env node
// R2A F2: pre-write "classification target == wrangler write target" guard tests.
//
// The CLI derives the wrangler target by running a read-only
// `wrangler d1 migrations list DB --local --persist-to <throwaway-dir>` probe.
// These tests use a fake wrangler binary (WRANGLER_BIN) so they are fast and do
// not require a real Cloudflare CLI. The fake only simulates two commands:
//   - `d1 migrations list ... --persist-to <scratch>` creates the D1 data file
//     in <scratch> (exactly like the real command does)
//   - `d1 migrations apply ...` writes a marker instead of migrating
// Real-wrangler end-to-end evidence is kept separately in the task evidence.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertTargetIdentity, DbSafetyError, EXIT_CODES } from "../scripts/lib/db-init.mjs";
import { runRealMigrations } from "../scripts/db-maintenance.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "r2a-target-identity-"));
const TARGET_NAME = "9ba2b04bf514d9facfd57ed57d849e77241a7adc99d1c1545d06688b43d84248.sqlite";
const WRANGLER_TOML = `name = "target-identity-test"
compatibility_date = "2026-08-21"
pages_build_output_dir = "./dist"

[[d1_databases]]
binding = "DB"
database_name = "target-identity-test-local"
database_id = "00000000-0000-0000-0000-000000000000"
`;

let passed = 0;
const failed = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed.push({ name, error });
    console.error(`FAIL ${name}\n${error && error.stack ? error.stack : String(error)}\n`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed.push({ name, error });
    console.error(`FAIL ${name}\n${error && error.stack ? error.stack : String(error)}\n`);
  }
}
function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function mkStateDir(label) {
  const stateDir = join(ROOT, label);
  mkdirSync(join(stateDir, "v3", "d1", "miniflare-D1DatabaseObject"), { recursive: true });
  return stateDir;
}
function createEmptyDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  new DatabaseSync(path).close();
  return path;
}
function writeAppRoot(label) {
  const appRoot = join(ROOT, label);
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(join(appRoot, "wrangler.toml"), WRANGLER_TOML);
  return appRoot;
}
function writeFakeWrangler({ label, targetName = TARGET_NAME, markerPath, failList = false }) {
  const scriptPath = join(ROOT, `${label}-fake-wrangler.mjs`);
  const marker = markerPath || join(ROOT, `${label}-apply-marker.txt`);
  const source = `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const args = process.argv.slice(2);
const persist = args[args.indexOf("--persist-to") + 1];
if (args.includes("list")) {
${failList ? '  process.exit(1);' : `  const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ${JSON.stringify(targetName)}), "");`}
  process.exit(0);
}
if (args.includes("apply")) {
  writeFileSync(${JSON.stringify(marker)}, "apply-spawned");
  process.exit(0);
}
process.exit(2);
`;
  writeFileSync(scriptPath, source);
  chmodSync(scriptPath, 0o755);
  return { scriptPath, markerPath: marker };
}
function expectRefused(fn, expectedKind) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof DbSafetyError, `expected DbSafetyError, got ${error && error.name}`);
    assert.equal(error.exitCode, EXIT_CODES.REFUSED, "identity refusal must be exit 3");
    assert.equal(error.kind, expectedKind, `unexpected refusal kind (${error.kind})`);
    assert.equal(error.details && error.details.invoked, false, "identity refusal must not mark the migration executor as invoked");
    return error;
  }
  throw new Error(`expected refusal ${expectedKind}, but call succeeded`);
}
async function expectRefusedAsync(fn, expectedKind) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof DbSafetyError, `expected DbSafetyError, got ${error && error.name}`);
    assert.equal(error.exitCode, EXIT_CODES.REFUSED, "identity refusal must be exit 3");
    assert.equal(error.kind, expectedKind, `unexpected refusal kind (${error.kind}): ${error.message}`);
    assert.equal(error.details && error.details.invoked, false, "identity refusal must not mark the migration executor as invoked");
    return error;
  }
  throw new Error(`expected reflective refusal ${expectedKind}, but call succeeded`);
}

// ── pure identity guard ─────────────────────────────────────────────────────
test("identity: standard miniflare layout allows the same file", () => {
  const stateDir = "/tmp/r2a-state";
  const expected = join(stateDir, "v3", "d1", "miniflare-D1DatabaseObject", TARGET_NAME);
  const result = assertTargetIdentity({
    classifiedStateDir: stateDir,
    classifiedDbFile: expected,
    expectedRelativePath: `v3/d1/miniflare-D1DatabaseObject/${TARGET_NAME}`,
  });
  assert.equal(result.expectedDbFile, resolve(expected));
});
test("identity: manually named classified file is refused (no write)", () => {
  const stateDir = "/tmp/r2a-state";
  const manual = join(stateDir, "v3", "d1", "miniflare-D1DatabaseObject", "manually-placed.sqlite");
  expectRefused(() => assertTargetIdentity({
    classifiedStateDir: stateDir,
    classifiedDbFile: manual,
    expectedRelativePath: `v3/d1/miniflare-D1DatabaseObject/${TARGET_NAME}`,
  }), "TARGET_IDENTITY_MISMATCH");
});
test("identity: legacy d1/ layout is refused when wrangler would use v3/", () => {
  const stateDir = "/tmp/r2a-state";
  expectRefused(() => assertTargetIdentity({
    classifiedStateDir: stateDir,
    classifiedDbFile: join(stateDir, "d1", "legacy.sqlite"),
    expectedRelativePath: `v3/d1/miniflare-D1DatabaseObject/${TARGET_NAME}`,
  }), "TARGET_IDENTITY_MISMATCH");
});
test("identity: virtual EMPTY allows a not-yet-created wrangler target", () => {
  const stateDir = join(ROOT, "virtual-empty-state");
  rmSync(stateDir, { recursive: true, force: true });
  const result = assertTargetIdentity({
    classifiedStateDir: stateDir,
    classifiedDbFile: null,
    expectedRelativePath: `v3/d1/miniflare-D1DatabaseObject/${TARGET_NAME}`,
  });
  assert.ok(result.expectedDbFile.endsWith(TARGET_NAME));
});
test("identity: virtual EMPTY refuses if the target file appeared before spawn", () => {
  const stateDir = mkStateDir("empty-changed");
  createEmptyDb(join(stateDir, "v3", "d1", "miniflare-D1DatabaseObject", TARGET_NAME));
  expectRefused(() => assertTargetIdentity({
    classifiedStateDir: stateDir,
    classifiedDbFile: null,
    expectedRelativePath: `v3/d1/miniflare-D1DatabaseObject/${TARGET_NAME}`,
  }), "TARGET_IDENTITY_CHANGED");
});
test("identity: path traversal is refused", () => {
  expectRefused(() => assertTargetIdentity({
    classifiedStateDir: "/tmp/r2a-state",
    classifiedDbFile: null,
    expectedRelativePath: "../outside.sqlite",
  }), "TARGET_IDENTITY_UNCONFIRMED");
});

// ── real runner with fake wrangler (pre-write guard) ────────────────────────
await testAsync("runner: abnormal manual target -> refused before apply; zero writes, no second DB", async () => {
  const stateDir = mkStateDir("abnormal-state");
  const manual = createEmptyDb(join(stateDir, "v3", "d1", "miniflare-D1DatabaseObject", "manually-placed.sqlite"));
  const beforeHash = sha256File(manual);
  const beforeFiles = readdirSync(join(stateDir, "v3", "d1", "miniflare-D1DatabaseObject")).sort();
  const appRoot = writeAppRoot("abnormal-app");
  const fake = writeFakeWrangler({ label: "abnormal", markerPath: join(ROOT, "abnormal-marker.txt") });
  process.env.WRANGLER_BIN = fake.scriptPath;
  try {
    await expectRefusedAsync(() => runRealMigrations({ appRoot, stateDir, dbFile: manual }), "TARGET_IDENTITY_MISMATCH");
  } finally {
    delete process.env.WRANGLER_BIN;
  }
  assert.equal(existsSync(fake.markerPath), false, "migration apply must not be spawned");
  assert.equal(sha256File(manual), beforeHash, "classified file must be untouched");
  assert.deepEqual(readdirSync(join(stateDir, "v3", "d1", "miniflare-D1DatabaseObject")).sort(), beforeFiles, "no second DB may be created");
});

await testAsync("runner: standard hash-named target -> probe passes and apply is spawned", async () => {
  const stateDir = mkStateDir("standard-state");
  const target = createEmptyDb(join(stateDir, "v3", "d1", "miniflare-D1DatabaseObject", TARGET_NAME));
  const beforeHash = sha256File(target);
  const appRoot = writeAppRoot("standard-app");
  const fake = writeFakeWrangler({ label: "standard", markerPath: join(ROOT, "standard-marker.txt") });
  process.env.WRANGLER_BIN = fake.scriptPath;
  try {
    await runRealMigrations({ appRoot, stateDir, dbFile: target });
  } finally {
    delete process.env.WRANGLER_BIN;
  }
  assert.equal(existsSync(fake.markerPath), true, "apply must be spawned for a confirmed standard target");
  assert.equal(sha256File(target), beforeHash, "fake apply must not modify the classified DB");
});

await testAsync("runner: virtual EMPTY -> probe passes and apply is spawned", async () => {
  const stateDir = join(ROOT, "virtual-empty-runner");
  rmSync(stateDir, { recursive: true, force: true });
  const appRoot = writeAppRoot("virtual-empty-app");
  const fake = writeFakeWrangler({ label: "virtual-empty", markerPath: join(ROOT, "virtual-empty-marker.txt") });
  process.env.WRANGLER_BIN = fake.scriptPath;
  try {
    await runRealMigrations({ appRoot, stateDir, dbFile: null });
  } finally {
    delete process.env.WRANGLER_BIN;
  }
  assert.equal(existsSync(fake.markerPath), true, "apply must be spawned for a genuine EMPTY state");
});

await testAsync("runner: probe failure -> refused before apply, no marker", async () => {
  const stateDir = mkStateDir("probe-fail-state");
  const target = createEmptyDb(join(stateDir, "v3", "d1", "miniflare-D1DatabaseObject", TARGET_NAME));
  const appRoot = writeAppRoot("probe-fail-app");
  const fake = writeFakeWrangler({ label: "probe-fail", markerPath: join(ROOT, "probe-fail-marker.txt"), failList: true });
  process.env.WRANGLER_BIN = fake.scriptPath;
  try {
    await expectRefusedAsync(() => runRealMigrations({ appRoot, stateDir, dbFile: target }), "TARGET_PROBE_FAILED");
  } finally {
    delete process.env.WRANGLER_BIN;
  }
  assert.equal(existsSync(fake.markerPath), false, "apply must not be spawned when target cannot be confirmed");
});

rmSync(ROOT, { recursive: true, force: true });
console.log("");
console.log(`RESULT: ${passed} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.error(`FAILED CASES: ${failed.map((item) => item.name).join(" | ")}`);
  process.exitCode = 1;
} else {
  console.log("ALL PASS: pure target identity + fake-wrangler pre-write guard (abnormal refused, standard/empty allowed, probe failure refused)");
  process.exitCode = 0;
}
