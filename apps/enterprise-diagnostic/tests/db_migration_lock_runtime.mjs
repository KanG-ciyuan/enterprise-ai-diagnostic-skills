#!/usr/bin/env node
// R2A A4: migrations lock integrity / append-only tests.
//
// migrations/MIGRATIONS.lock is the append-only SHA-256 lock over the frozen
// numbered migrations. This test proves:
//   - the lock JSON is well-formed, complete, ascending and hash-accurate;
//   - the lock is append-only relative to git HEAD (entries may only be added
//     at the end; existing names/hashes may never be rewritten);
//   - when the lock is first introduced (or git is unavailable) the test loudly
//     prints FIRST_INTRODUCTION instead of silently skipping the check;
//   - the migration bytes at git HEAD still match the locked hashes.
//
// Only read-only git commands are used: `git rev-parse` and `git show`.
// No git add/commit/checkout, no network, no writes outside the repo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(APP_ROOT, "migrations");
const LOCK_PATH = join(MIGRATIONS_DIR, "MIGRATIONS.lock");
const LOCK_REPO_PATH = "apps/enterprise-diagnostic/migrations/MIGRATIONS.lock";
const MIGRATION_REPO_PREFIX = "apps/enterprise-diagnostic/migrations/";
const GENERATOR_REF = "scripts/gen-schema-snapshot.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MIGRATION_NAME_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;
const GIT_TIMEOUT_MS = 30_000;

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .sort();

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function readRepoFile(ref) {
  // encoding:null keeps the exact bytes so the hash is over the committed blob.
  return spawnSync("git", ["show", ref], {
    cwd: repoRoot,
    encoding: null,
    timeout: GIT_TIMEOUT_MS,
  });
}

/**
 * Classify `git show <ref>` failures without parsing git internals:
 *   NOT_IN_HEAD -> the path is not committed at HEAD (new, uncommitted file)
 *   NO_HEAD     -> the repository/ref does not exist yet (first introduction)
 *   OTHER       -> anything else is a real failure and must not be skipped
 */
function classifyGitShowFailure(stderr) {
  const text = String(stderr || "").toLowerCase();
  if (text.includes("does not exist") || (text.includes("exists on disk") && text.includes("not in"))) {
    return "NOT_IN_HEAD";
  }
  if (
    text.includes("unknown revision") ||
    text.includes("ambiguous argument") ||
    text.includes("not a valid object name") ||
    text.includes("bad revision")
  ) {
    return "NO_HEAD";
  }
  return "OTHER";
}

/** The append-only contract shared by the real check and its self-test. */
function assertAppendOnly(oldLock, newLock) {
  assert.ok(oldLock && Array.isArray(oldLock.files), "old lock is not a {files:[...]} document");
  assert.ok(newLock && Array.isArray(newLock.files), "new lock is not a {files:[...]} document");
  const oldFiles = oldLock.files;
  const newFiles = newLock.files;
  assert.ok(
    newFiles.length >= oldFiles.length,
    `lock shrank: ${oldFiles.length} -> ${newFiles.length} entries (entries may never be removed)`,
  );
  for (let index = 0; index < oldFiles.length; index += 1) {
    assert.equal(
      newFiles[index].name,
      oldFiles[index].name,
      `lock entry #${index} changed name (${oldFiles[index].name} -> ${newFiles[index].name}); existing order is immutable`,
    );
    assert.equal(
      newFiles[index].sha256,
      oldFiles[index].sha256,
      `lock entry ${oldFiles[index].name} was rewritten; historical migration bytes are immutable`,
    );
  }
  const lastOldName = oldFiles.length ? oldFiles[oldFiles.length - 1].name : "";
  const oldNames = new Set(oldFiles.map((entry) => entry.name));
  for (let index = oldFiles.length; index < newFiles.length; index += 1) {
    assert.ok(!oldNames.has(newFiles[index].name), `appended entry ${newFiles[index].name} duplicates an existing lock entry`);
    assert.ok(
      newFiles[index].name > lastOldName,
      `appended entry ${newFiles[index].name} must sort after the previous head ${lastOldName}`,
    );
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertLockShape(lock, label) {
  assert.deepEqual(Object.keys(lock), ["version", "generated_by", "files"], `${label} has unexpected top-level fields`);
  assert.equal(lock.version, 1, `${label} version must be 1`);
  assert.equal(lock.generated_by, GENERATOR_REF, `${label} generated_by must name the generator`);
  assert.ok(Array.isArray(lock.files), `${label} files must be an array`);
}

// ── git availability (read-only) ──────────────────────────────────────────
let repoRoot = null;
let gitUnavailableReason = null;
const revParse = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: APP_ROOT,
  encoding: "utf8",
  timeout: GIT_TIMEOUT_MS,
});
if (revParse.error || revParse.status !== 0) {
  gitUnavailableReason = revParse.error ? revParse.error.message : String(revParse.stderr || "").trim() || "git rev-parse failed";
} else {
  repoRoot = revParse.stdout.trim() || null;
  if (!repoRoot) gitUnavailableReason = "git rev-parse returned an empty repository root";
}

const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL  ${name}`);
    console.error(error && error.stack ? error.stack : String(error));
  }
}

check("MIGRATIONS.lock is a well-formed version-1 lock document", () => {
  assertLockShape(lock, "MIGRATIONS.lock");
  assert.ok(lock.files.length > 0);
});

check("lock contains 13 ascending, well-formed entries that mirror the migrations directory", () => {
  assert.equal(lock.files.length, migrationFiles.length);
  assert.equal(lock.files.length, 13);
  const names = lock.files.map((entry) => entry.name);
  assert.deepEqual(names, migrationFiles, "lock entries must mirror migrations/*.sql exactly");
  assert.deepEqual(names, [...names].sort(), "lock entries must be in ascending file-name order");
  for (const entry of lock.files) {
    assert.deepEqual(Object.keys(entry), ["name", "sha256"], `entry ${entry.name} has unexpected fields`);
    assert.match(entry.name, MIGRATION_NAME_PATTERN);
    assert.match(entry.sha256, SHA256_PATTERN, `entry ${entry.name} sha256 is not 64 lowercase hex chars`);
    assert.ok(!entry.name.includes("MIGRATIONS.lock"), "the lock must never include itself");
  }
});

check("lock SHA-256 values match the migration bytes on disk", () => {
  for (const entry of lock.files) {
    assert.equal(sha256File(join(MIGRATIONS_DIR, entry.name)), entry.sha256, `${entry.name} hash mismatch`);
  }
});

check("lock is append-only relative to git HEAD (FIRST_INTRODUCTION when first introduced)", () => {
  if (!repoRoot) {
    console.log(`FIRST_INTRODUCTION: git is unavailable (${gitUnavailableReason}); append-only history check cannot run`);
    return;
  }
  const shown = readRepoFile(`HEAD:${LOCK_REPO_PATH}`);
  if (shown.status !== 0) {
    const kind = classifyGitShowFailure(shown.stderr);
    if (kind === "NOT_IN_HEAD" || kind === "NO_HEAD") {
      console.log(
        `FIRST_INTRODUCTION: ${LOCK_REPO_PATH} does not exist at HEAD (${kind}); first introduction, no previous lock to compare`,
      );
      return;
    }
    assert.fail(`git show HEAD:${LOCK_REPO_PATH} failed unexpectedly: ${String(shown.stderr || "").trim()}`);
  }
  const headLock = JSON.parse(shown.stdout.toString("utf8"));
  assertLockShape(headLock, "HEAD MIGRATIONS.lock");
  assertAppendOnly(headLock, lock);
  console.log(
    `append-only OK: ${headLock.files.length} HEAD entries preserved in order/hash, ${lock.files.length - headLock.files.length} appended`,
  );
});

check("append-only comparator rejects rewritten history (self-test)", () => {
  // This keeps the contract honest even on the FIRST_INTRODUCTION path above.
  assertAppendOnly(lock, cloneJson(lock));

  const appended = cloneJson(lock);
  appended.files.push({ name: "0014_future_migration.sql", sha256: "0".repeat(64) });
  assertAppendOnly(lock, appended);

  const reordered = cloneJson(lock);
  [reordered.files[0], reordered.files[1]] = [reordered.files[1], reordered.files[0]];
  assert.throws(() => assertAppendOnly(lock, reordered), /changed name/);

  const rewritten = cloneJson(lock);
  rewritten.files[0].sha256 = "f".repeat(64);
  assert.throws(() => assertAppendOnly(lock, rewritten), /was rewritten/);

  const truncated = cloneJson(lock);
  truncated.files.pop();
  assert.throws(() => assertAppendOnly(lock, truncated), /lock shrank/);

  const replacedTail = cloneJson(lock);
  replacedTail.files[replacedTail.files.length - 1] = { name: "0013_other.sql", sha256: "a".repeat(64) };
  assert.throws(() => assertAppendOnly(lock, replacedTail), /changed name/);
});

check("migration bytes at git HEAD still match the locked hashes", () => {
  if (!repoRoot) {
    console.log(`SKIP_HEAD_MIGRATION_COMPARE: git is unavailable (${gitUnavailableReason}); disk hashes are still enforced by A3`);
    return;
  }
  let compared = 0;
  let notInHead = 0;
  for (const entry of lock.files) {
    const shown = readRepoFile(`HEAD:${MIGRATION_REPO_PREFIX}${entry.name}`);
    if (shown.status !== 0) {
      const kind = classifyGitShowFailure(shown.stderr);
      if (kind === "NOT_IN_HEAD" || kind === "NO_HEAD") {
        // A migration appended after the last commit is legitimately absent from HEAD.
        console.log(`NOTE: ${entry.name} does not exist at HEAD (new migration); awaiting commit`);
        notInHead += 1;
        continue;
      }
      assert.fail(`git show HEAD:${MIGRATION_REPO_PREFIX}${entry.name} failed unexpectedly: ${String(shown.stderr || "").trim()}`);
    }
    assert.equal(
      sha256(shown.stdout),
      entry.sha256,
      `${entry.name} at git HEAD differs from the locked historical migration`,
    );
    compared += 1;
  }
  console.log(`git HEAD migration comparison OK: ${compared}/${lock.files.length} committed migrations match the lock (${notInHead} new/uncommitted)`);
});

const total = passed + failures.length;
if (failures.length > 0) {
  console.error(`\ndb_migration_lock_runtime: ${passed}/${total} checks passed, ${failures.length} failed`);
  for (const failure of failures) console.error(`  FAILED: ${failure.name}`);
  process.exit(1);
}
console.log(`\ndb_migration_lock_runtime: ${passed}/${total} checks passed`);
