// R2A B/C: read-only database classification + init orchestration.
//
// Safety contract:
//   * This module never writes to the target database. Classification opens the
//     database read-only. If a read-only open is impossible (e.g. a WAL database
//     whose -shm cannot be created), classification falls back to an isolated
//     copy under the OS temp directory and opens the copy instead; the original
//     file is never modified.
//   * Decision logic and process spawning are separated: `runInit` accepts an
//     injected `runMigrations(ctx)` function. The CLI injects the real wrangler
//     runner and offers no way to inject a different one.
//   * Historical databases (runtime ensureSchema / historical schema.sql) are
//     recognized by fingerprint and refused. They are never treated as empty and
//     never auto-repaired/adopted.
//
// Authority: migrations/0001..0013. Expected fingerprints are reconstructed by
// replaying the migration chain in an in-memory SQLite database, so this module
// does not depend on generated artifacts.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  BUSINESS_TABLES,
  FINGERPRINT_VERSION,
  INIT_ALLOWED_STATES,
  classifyDatabase,
  deriveContract,
  fingerprintOf,
  listUserTables,
  summarizeClassification,
} from "./schema-fingerprint.mjs";

export const TOOL_VERSION = "1.0.0-r2a";

export const EXIT_CODES = Object.freeze({
  OK: 0,
  ERROR: 1,
  REFUSED: 3,
});

/** Every state the classifier can emit (kept in sync by tests/db_state_matrix_runtime.mjs). */
export const KNOWN_STATES = Object.freeze([
  "EMPTY",
  "MIGRATION_PARTIAL_OK",
  "MIGRATION_COMPLETE",
  "RUNTIME_LEGACY",
  "SCHEMASQL_LEGACY",
  "LEDGER_SCHEMA_CONFLICT",
  "DATA_CONFLICT",
  "COMPLETE_NO_LEDGER",
  "TOO_NEW",
  "UNKNOWN",
]);

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/** apps/enterprise-diagnostic — independent of the caller's current directory. */
export const DEFAULT_APP_ROOT = resolve(MODULE_DIR, "..", "..");
export const DEFAULT_STATE_DIR = join(DEFAULT_APP_ROOT, ".wrangler", "state");
export const MIGRATIONS_DIRNAME = "migrations";
export const KNOWN_LEGACY_FINGERPRINTS_RELATIVE_PATH = join("scripts", "schema", "known-legacy-fingerprints.json");
/** Local-wrangler D1 persistence layouts: current v3 layout first, legacy d1/ second. */
export const D1_STATE_SUBDIRS = Object.freeze([
  Object.freeze(["v3", "d1", "miniflare-D1DatabaseObject"]),
  Object.freeze(["d1"]),
]);
/**
 * Miniflare object-directory bookkeeping databases. A local `wrangler dev` /
 * `wrangler pages dev` run creates `metadata.sqlite` next to each D1 data file
 * (it stores DO bookkeeping such as `_cf_ALARM`); it is NOT a D1 database data
 * file and must never be selected as the migration target.
 */
export const MINIFLARE_INTERNAL_DB_BASENAMES = Object.freeze(["metadata.sqlite"]);

/** True for miniflare internal bookkeeping databases (never migration targets). */
export function isMiniflareInternalDatabase(filePath) {
  const name = basename(String(filePath || "")).toLowerCase();
  return MINIFLARE_INTERNAL_DB_BASENAMES.includes(name);
}

const REQUIRED_LEGACY_SHAPES = Object.freeze(["runtimeV1", "schemaSqlV1", "schemaSqlBooted"]);

/** Structured, exit-code carrying error used by the CLI. */
export class DbSafetyError extends Error {
  constructor(exitCode, kind, message, details = {}) {
    super(message);
    this.name = "DbSafetyError";
    this.exitCode = exitCode;
    this.kind = kind;
    this.details = details;
  }
}

export function asDbSafetyError(error) {
  if (error instanceof DbSafetyError) return error;
  const message = error && error.message ? error.message : String(error);
  return new DbSafetyError(EXIT_CODES.ERROR, "INTERNAL_ERROR", message, { cause: message });
}

/** True only for the three states in which an automatic init/migration is permitted. */
export function allowedForInit(state) {
  return INIT_ALLOWED_STATES.includes(state);
}

/** Actionable, state-specific guidance included in refusal messages. */
export function stateHintFor(state) {
  switch (state) {
    case "EMPTY":
    case "MIGRATION_PARTIAL_OK":
    case "MIGRATION_COMPLETE":
      return "该状态允许 init：EMPTY / MIGRATION_PARTIAL_OK 会执行编号迁移，MIGRATION_COMPLETE 为 no-op。";
    case "RUNTIME_LEGACY":
      return "历史 runtime 建表库（functions/_shared.js ensureSchema）：需要单独批准的数据保持迁移方案，本工具不提供自动修复/采纳。请先用 scripts/db.sh diagnose 保留现场。";
    case "SCHEMASQL_LEGACY":
      return "历史 schema.sql 建库：该形态不在迁移权威链上，需要单独批准的数据保持迁移方案；不得当作空库重建。请先用 scripts/db.sh diagnose 保留现场。";
    case "LEDGER_SCHEMA_CONFLICT":
      return "迁移账本（d1_migrations）与库结构不一致：必须人工核对账本与库的实际状态后再决定，禁止自动写入。";
    case "DATA_CONFLICT":
      return "数据完整性冲突（孤儿行/重复唯一键/损坏）：自动迁移会放大数据风险，必须人工处理原始数据后再重试。";
    case "COMPLETE_NO_LEDGER":
      return "库结构已是迁移终态但缺少 d1_migrations 账本：补账本属于人工授权操作，本工具不自动写账本。";
    case "TOO_NEW":
      return "迁移账本包含本工具不认识的更新迁移（数据库比工具新）：禁止自动执行，请升级工具/代码后再处理。";
    case "UNKNOWN":
    default:
      return "结构无法识别：无法证明可以安全自动迁移。请保留现场并用 scripts/db.sh diagnose --json 输出完整分类，交由项目负责人判断。";
  }
}

// ---------------------------------------------------------------------------
// Read-only database opening
// ---------------------------------------------------------------------------

function openIsolatedCopy(dbPath) {
  const tempDir = mkdtempSync(join(tmpdir(), "r2a-classify-copy-"));
  const copyPath = join(tempDir, "classify.sqlite");
  copyFileSync(dbPath, copyPath);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(dbPath + suffix)) {
      try {
        copyFileSync(dbPath + suffix, copyPath + suffix);
      } catch {
        // A missing sidecar only means the copy may see less data; it never
        // affects the original file.
      }
    }
  }
  const db = new DatabaseSync(copyPath);
  return {
    db,
    copied: true,
    cleanup() {
      try {
        db.close();
      } catch {
        // ignore
      }
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Open a database strictly for reading. Returns {db, cleanup, copied}.
 * The original file is never opened in read-write mode.
 */
export function openDatabaseForClassification(dbPath) {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    return {
      db,
      copied: false,
      cleanup() {
        try {
          db.close();
        } catch {
          // ignore
        }
      },
    };
  } catch (readOnlyError) {
    try {
      return openIsolatedCopy(dbPath);
    } catch (copyError) {
      throw new DbSafetyError(
        EXIT_CODES.ERROR,
        "DB_UNREADABLE",
        `无法读取数据库 ${dbPath}：只读打开失败（${readOnlyError.message}），隔离副本回退也失败（${copyError.message}）。`,
        { dbFile: dbPath },
      );
    }
  }
}

function inspectDatabaseFile(dbPath) {
  const { db, cleanup, copied } = openDatabaseForClassification(dbPath);
  try {
    const businessTables = listUserTables(db).filter((name) => BUSINESS_TABLES.includes(name));
    return {
      path: dbPath,
      readable: true,
      copied,
      hasBusinessTables: businessTables.length > 0,
      businessTables,
    };
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Target resolution (read-only)
// ---------------------------------------------------------------------------

function scanStateDir(stateDir) {
  const candidates = new Set();
  const ignoredInternal = new Set();
  if (!stateDir || !existsSync(stateDir)) return { candidates: [], ignoredInternal: [] };
  for (const subdirParts of D1_STATE_SUBDIRS) {
    const dir = join(stateDir, ...subdirParts);
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".sqlite")) continue;
      const filePath = join(dir, entry.name);
      // Miniflare creates its own bookkeeping DBs (e.g. metadata.sqlite) inside
      // the object directory. They are not D1 data files and must not count as
      // candidates, otherwise a cold-start state dir looks ambiguous.
      if (isMiniflareInternalDatabase(filePath)) ignoredInternal.add(filePath);
      else candidates.add(filePath);
    }
  }
  return { candidates: [...candidates].sort(), ignoredInternal: [...ignoredInternal].sort() };
}

/**
 * Scan a wrangler state directory for D1 local database data files.
 * Supports the current `v3/d1/miniflare-D1DatabaseObject/*.sqlite` layout and the
 * legacy `d1/*.sqlite` layout. Miniflare internal bookkeeping files
 * (`metadata.sqlite`) are excluded. Sorted for deterministic diagnostics.
 */
export function scanDatabaseFiles(stateDir) {
  return scanStateDir(stateDir).candidates;
}

/**
 * R2A F2: pre-write target identity guard.
 *
 * The classification target and the file wrangler will migrate must be the same
 * file. The CLI derives the wrangler target by running a read-only
 * `wrangler d1 migrations list DB --local --persist-to <fresh-temp-dir>` probe in
 * an isolated scratch directory (never the real state dir), then passes the
 * relative D1 object path here. This function maps that relative path into the
 * classified state dir and requires it to equal the classified target.
 *
 * Rules (all failures throw exit-3 DbSafetyError, so no migration executor is
 * spawned and no file is created/deleted/renamed):
 *   * the probe path must be a relative path inside the state dir (no traversal);
 *   * if a database was classified, the expected wrangler path must equal it;
 *   * if the classification is virtual EMPTY (dbFile=null), the expected wrangler
 *     path must not already exist (it will be created by wrangler);
 *   * otherwise the target identity cannot be confirmed -> refuse.
 *
 * @param {{ classifiedStateDir?: string, classifiedDbFile?: string|null,
 *           expectedRelativePath?: string }} options
 * @returns {{ expectedDbFile: string, relativePath: string }}
 */
export function assertTargetIdentity({ classifiedStateDir, classifiedDbFile, expectedRelativePath } = {}) {
  const stateDir = resolve(String(classifiedStateDir || ""));
  const rel = String(expectedRelativePath || "");
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  if (!rel || isAbsolute(rel) || segments.length === 0 || segments.includes("..")) {
    throw new DbSafetyError(
      EXIT_CODES.REFUSED,
      "TARGET_IDENTITY_UNCONFIRMED",
      `无法确认 wrangler 将写入哪个数据库文件：探针返回的路径不合法（${rel || "(empty)"}）。已拒绝初始化，未启动迁移执行器。`,
      { classifiedStateDir: stateDir, classifiedDbFile: classifiedDbFile || null, expectedRelativePath: rel, invoked: false },
    );
  }
  const expectedDbFile = resolve(stateDir, ...segments);
  const inside = relative(stateDir, expectedDbFile);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
    throw new DbSafetyError(
      EXIT_CODES.REFUSED,
      "TARGET_IDENTITY_UNCONFIRMED",
      `无法确认 wrangler 将写入哪个数据库文件：探针路径会逃出 state 目录（${rel}）。已拒绝初始化，未启动迁移执行器。`,
      { classifiedStateDir: stateDir, classifiedDbFile: classifiedDbFile || null, expectedRelativePath: rel, invoked: false },
    );
  }
  if (classifiedDbFile) {
    const classified = resolve(String(classifiedDbFile));
    if (classified !== expectedDbFile) {
      throw new DbSafetyError(
        EXIT_CODES.REFUSED,
        "TARGET_IDENTITY_MISMATCH",
        `分类目标与 wrangler 迁移目标不一致：分类目标=${classified}，wrangler 将写入=${expectedDbFile}。` +
          "已拒绝初始化，未启动迁移执行器；不会创建第二个数据库文件，也不会移动/删除任何数据库。请先用 scripts/db.sh diagnose 检查 state 布局。",
        {
          classifiedStateDir: stateDir,
          classifiedDbFile: classified,
          expected_wrangler_target: expectedDbFile,
          expectedRelativePath: segments.join("/"),
          invoked: false,
        },
      );
    }
  } else if (existsSync(expectedDbFile)) {
    throw new DbSafetyError(
      EXIT_CODES.REFUSED,
      "TARGET_IDENTITY_CHANGED",
      `分类为 EMPTY 后，在初始化前出现了 wrangler 目标文件：${expectedDbFile}。已拒绝初始化，未启动迁移执行器，未覆盖任何文件。`,
      { classifiedStateDir: stateDir, expected_wrangler_target: expectedDbFile, expectedRelativePath: segments.join("/"), invoked: false },
    );
  }
  return { expectedDbFile, relativePath: segments.join("/") };
}

/**
 * Resolve the single read-only target database.
 *
 * Resolution rules (no guessing):
 *   * explicit --db-file  -> must exist, must not be miniflare bookkeeping; used as-is
 *   * 0 data candidates   -> EMPTY target (dbFile=null); init may create it
 *   * exactly 1 data file -> used, even if it contains no business tables
 *                            (cold-start D1 state: EMPTY, and the file itself is the
 *                            migration target; it is never deleted or recreated)
 *   * >1 data candidates  -> the only file containing business tables wins;
 *                            otherwise exit 3 and ask for --db-file
 *
 * Miniflare internal bookkeeping databases (at least `metadata.sqlite`) are never
 * candidates: `wrangler dev/pages dev` creates one next to every D1 data file.
 *
 * @throws {DbSafetyError} exitCode 3 when the target is missing/ambiguous/unreadable
 */
export function resolveTargets({ stateDir, dbFile, appRoot = DEFAULT_APP_ROOT } = {}) {
  const resolvedAppRoot = resolve(appRoot);
  const resolvedStateDir = stateDir ? resolve(process.cwd(), stateDir) : join(resolvedAppRoot, ".wrangler", "state");
  const stateDirExists = existsSync(resolvedStateDir);

  if (stateDirExists && !statSync(resolvedStateDir).isDirectory()) {
    throw new DbSafetyError(
      EXIT_CODES.REFUSED,
      "STATE_DIR_NOT_DIRECTORY",
      `--state-dir 不是目录：${resolvedStateDir}`,
      { stateDir: resolvedStateDir },
    );
  }

  if (dbFile) {
    const explicitPath = isAbsolute(dbFile) ? dbFile : resolve(process.cwd(), dbFile);
    if (!existsSync(explicitPath)) {
      throw new DbSafetyError(
        EXIT_CODES.REFUSED,
        "TARGET_NOT_FOUND",
        `--db-file 指定的数据库文件不存在：${explicitPath}（工具不会创建它）`,
        { dbFile: explicitPath },
      );
    }
    if (!statSync(explicitPath).isFile()) {
      throw new DbSafetyError(
        EXIT_CODES.REFUSED,
        "TARGET_NOT_FILE",
        `--db-file 不是普通文件：${explicitPath}`,
        { dbFile: explicitPath },
      );
    }
    if (isMiniflareInternalDatabase(explicitPath)) {
      throw new DbSafetyError(
        EXIT_CODES.REFUSED,
        "TARGET_INTERNAL_FILE",
        `--db-file 指向 miniflare 内部簿记数据库（${basename(explicitPath)}），它不是 D1 数据库数据文件。请指定同目录下的 <hash>.sqlite 数据文件，或直接使用 --state-dir 让工具自动识别。`,
        { dbFile: explicitPath },
      );
    }
    return {
      appRoot: resolvedAppRoot,
      stateDir: resolvedStateDir,
      stateDirExists,
      candidates: [],
      inspected: [],
      ignoredInternalFiles: [],
      dbFile: explicitPath,
      dbFileSource: "explicit",
    };
  }

  const { candidates, ignoredInternal } = scanStateDir(resolvedStateDir);
  const internalNote = ignoredInternal.length
    ? `（已排除 miniflare 内部簿记 ${ignoredInternal.map((item) => basename(item)).join(", ")}）`
    : "";
  if (candidates.length === 0) {
    return {
      appRoot: resolvedAppRoot,
      stateDir: resolvedStateDir,
      stateDirExists,
      candidates: [],
      inspected: [],
      ignoredInternalFiles: ignoredInternal,
      dbFile: null,
      dbFileSource: null,
    };
  }
  if (candidates.length === 1) {
    return {
      appRoot: resolvedAppRoot,
      stateDir: resolvedStateDir,
      stateDirExists,
      candidates,
      inspected: [],
      ignoredInternalFiles: ignoredInternal,
      dbFile: candidates[0],
      dbFileSource: "single",
    };
  }

  const inspected = candidates.map((candidate) => {
    try {
      return inspectDatabaseFile(candidate);
    } catch (error) {
      return {
        path: candidate,
        readable: false,
        copied: false,
        hasBusinessTables: false,
        businessTables: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const unreadable = inspected.filter((item) => !item.readable);
  if (unreadable.length > 0) {
    throw new DbSafetyError(
      EXIT_CODES.REFUSED,
      "TARGET_AMBIGUOUS_UNREADABLE",
      `state 目录下存在 ${candidates.length} 个 D1 数据文件候选${internalNote}，其中 ${unreadable.length} 个无法读取；无法安全推断目标。请用 --db-file 明确指定数据库文件。工具不会猜测。`,
      {
        stateDir: resolvedStateDir,
        candidates,
        ignoredInternalFiles: ignoredInternal,
        unreadable: unreadable.map((item) => item.path),
      },
    );
  }
  const business = inspected.filter((item) => item.hasBusinessTables);
  if (business.length === 1) {
    return {
      appRoot: resolvedAppRoot,
      stateDir: resolvedStateDir,
      stateDirExists,
      candidates,
      inspected,
      ignoredInternalFiles: ignoredInternal,
      dbFile: business[0].path,
      dbFileSource: "multiple-unique-business",
    };
  }
  throw new DbSafetyError(
    EXIT_CODES.REFUSED,
    "TARGET_AMBIGUOUS",
    `state 目录下存在 ${candidates.length} 个 D1 数据文件候选${internalNote}，其中含业务表的库 ${business.length} 个，无法唯一确定目标。请用 --db-file 明确指定数据库文件；工具不会猜测。`,
    { stateDir: resolvedStateDir, candidates, ignoredInternalFiles: ignoredInternal },
  );
}

// ---------------------------------------------------------------------------
// Expected model reconstructed from the migration chain
// ---------------------------------------------------------------------------

const expectedModelCache = new Map();

function readKnownLegacyFingerprints(appRoot) {
  const constantsPath = join(appRoot, KNOWN_LEGACY_FINGERPRINTS_RELATIVE_PATH);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(constantsPath, "utf8"));
  } catch (error) {
    throw new DbSafetyError(
      EXIT_CODES.ERROR,
      "LEGACY_CONSTANTS_UNREADABLE",
      `无法读取历史指纹常量 ${constantsPath}：${error.message}`,
      { path: constantsPath },
    );
  }
  const shapes = parsed && parsed.shapes ? parsed.shapes : {};
  const out = {};
  for (const name of REQUIRED_LEGACY_SHAPES) {
    const shape = shapes[name];
    if (!shape || typeof shape.hash !== "string" || !shape.hash) {
      throw new DbSafetyError(
        EXIT_CODES.ERROR,
        "LEGACY_CONSTANTS_INVALID",
        `历史指纹常量 ${constantsPath} 缺少 shapes.${name}.hash`,
        { path: constantsPath },
      );
    }
    out[name] = { hash: shape.hash, counts: shape.counts || null };
  }
  return out;
}

function buildExpectedModel(appRoot) {
  const migrationsDir = join(appRoot, MIGRATIONS_DIRNAME);
  let knownMigrations;
  try {
    knownMigrations = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  } catch (error) {
    throw new DbSafetyError(
      EXIT_CODES.ERROR,
      "MIGRATIONS_DIR_UNREADABLE",
      `无法读取迁移目录 ${migrationsDir}：${error.message}`,
      { path: migrationsDir },
    );
  }
  if (knownMigrations.length === 0) {
    throw new DbSafetyError(EXIT_CODES.ERROR, "MIGRATIONS_EMPTY", `迁移目录为空：${migrationsDir}`, { path: migrationsDir });
  }
  const legacyFingerprints = readKnownLegacyFingerprints(appRoot);

  const db = new DatabaseSync(":memory:");
  try {
    const prefixes = [];
    const emptyFingerprint = fingerprintOf(db);
    prefixes.push({ k: 0, hash: emptyFingerprint.hash, counts: emptyFingerprint.counts, name: null });
    for (let index = 0; index < knownMigrations.length; index += 1) {
      const name = knownMigrations[index];
      let sql;
      try {
        sql = readFileSync(join(migrationsDir, name), "utf8");
      } catch (error) {
        throw new DbSafetyError(EXIT_CODES.ERROR, "MIGRATION_UNREADABLE", `无法读取迁移 ${name}：${error.message}`, { name });
      }
      db.exec(sql);
      const fingerprint = fingerprintOf(db);
      prefixes.push({ k: index + 1, hash: fingerprint.hash, counts: fingerprint.counts, name });
    }
    const terminal = prefixes[prefixes.length - 1];
    const contract = deriveContract(db);
    return {
      appRoot: resolve(appRoot),
      migrationsDir,
      knownMigrations: Object.freeze([...knownMigrations]),
      terminal: Object.freeze({ hash: terminal.hash, counts: terminal.counts }),
      empty: Object.freeze({ hash: prefixes[0].hash, counts: prefixes[0].counts }),
      prefixes: Object.freeze(prefixes),
      contract,
      legacyFingerprints,
      fingerprintVersion: FINGERPRINT_VERSION,
    };
  } finally {
    db.close();
  }
}

/**
 * Load (and cache) the expected model: terminal + per-prefix fingerprints
 * (k=0..N, N+1 entries), the terminal FK/unique contract, and the recognized
 * historical shapes. Replays migrations in an in-memory database, so it never
 * touches the target database and does not depend on generated artifacts.
 */
export function loadExpectedModel({ appRoot = DEFAULT_APP_ROOT } = {}) {
  const resolvedAppRoot = resolve(appRoot);
  const cached = expectedModelCache.get(resolvedAppRoot);
  if (cached) return cached;
  const model = buildExpectedModel(resolvedAppRoot);
  expectedModelCache.set(resolvedAppRoot, model);
  return model;
}

function fingerprintsFor(model) {
  return {
    terminal: { hash: model.terminal.hash, counts: model.terminal.counts },
    prefixes: model.prefixes.map((prefix) => ({ k: prefix.k, hash: prefix.hash })),
    runtimeV1: model.legacyFingerprints.runtimeV1,
    schemaSqlV1: model.legacyFingerprints.schemaSqlV1,
    schemaSqlBooted: model.legacyFingerprints.schemaSqlBooted,
  };
}

/** Compact expected-constants block for CLI output. */
export function expectedSummary(model = loadExpectedModel()) {
  return {
    migrations_count: model.knownMigrations.length,
    migrations_head: model.knownMigrations[model.knownMigrations.length - 1] || null,
    migrations: [...model.knownMigrations],
    terminal_fingerprint: model.terminal.hash,
    terminal_counts: model.terminal.counts,
    empty_fingerprint: model.empty.hash,
    legacy_fingerprints: {
      runtime_v1: model.legacyFingerprints.runtimeV1.hash,
      schema_sql_v1: model.legacyFingerprints.schemaSqlV1.hash,
      schema_sql_booted: model.legacyFingerprints.schemaSqlBooted.hash,
    },
    fingerprint_version: model.fingerprintVersion,
    init_allowed_states: [...INIT_ALLOWED_STATES],
  };
}

/** Flatten a classifier result into a stable, compact JSON-friendly summary. */
export function summarizeForOutput(classification) {
  if (!classification) return null;
  const summary = summarizeClassification(classification);
  return {
    ...summary,
    underlying_state: classification.underlyingState ?? null,
    virtual_empty: classification.virtualEmpty === true,
    extra_tables: classification.extraTables || [],
    issues: classification.data && Array.isArray(classification.data.issues) ? classification.data.issues : [],
  };
}

// ---------------------------------------------------------------------------
// Read-only classification / diagnose
// ---------------------------------------------------------------------------

/**
 * Classify one resolved target without writing anything.
 * A state dir with no SQLite file is a virtual EMPTY database.
 */
export function classifyTarget({ model = loadExpectedModel(), target } = {}) {
  if (!target) throw new DbSafetyError(EXIT_CODES.ERROR, "INTERNAL_ERROR", "classifyTarget 缺少 target");
  if (!target.dbFile) {
    return {
      state: "EMPTY",
      reason: "state 目录下没有任何 .sqlite 数据库文件（尚未初始化）",
      virtualEmpty: true,
    };
  }
  const { db, cleanup } = openDatabaseForClassification(target.dbFile);
  try {
    return classifyDatabase(db, {
      contract: model.contract,
      fingerprints: fingerprintsFor(model),
      knownMigrations: model.knownMigrations,
    });
  } finally {
    cleanup();
  }
}

/**
 * Read-only diagnose: resolve the target, fingerprint/classify it and report the
 * expected authority constants. Never writes to the database.
 *
 * @throws {DbSafetyError} exitCode 3 for missing/ambiguous/unreadable targets,
 *                          exitCode 1 for execution errors.
 */
export function diagnose({ stateDir, dbFile, appRoot = DEFAULT_APP_ROOT } = {}) {
  const model = loadExpectedModel({ appRoot });
  const target = resolveTargets({ stateDir, dbFile, appRoot });
  const classification = classifyTarget({ model, target });
  const summary = summarizeForOutput(classification);
  return {
    code: EXIT_CODES.OK,
    ok: true,
    tool_version: TOOL_VERSION,
    target,
    classification,
    summary,
    allowedForInit: allowedForInit(classification.state),
    hint: stateHintFor(classification.state),
    expected: expectedSummary(model),
  };
}

// ---------------------------------------------------------------------------
// Init orchestration (decision logic; migrations runner injected)
// ---------------------------------------------------------------------------

function buildInitResult(overrides = {}) {
  return {
    code: EXIT_CODES.OK,
    stateBefore: null,
    stateAfter: null,
    applied: false,
    wranglerInvoked: false,
    message: "",
    classification: null,
    ...overrides,
  };
}

/**
 * Orchestrate an init/migration decision.
 *
 * @param options.stateDir  wrangler local state dir (default <app>/.wrangler/state)
 * @param options.dbFile    explicit database file (otherwise resolved read-only)
 * @param options.appRoot   application root (default: this package)
 * @param options.runMigrations injected async executor, called only when the
 *                              classified state allows init and is not already
 *                              complete. The CLI injects the real wrangler runner.
 * @returns {Promise<{code:number,stateBefore:string|null,stateAfter:string|null,
 *   applied:boolean,wranglerInvoked:boolean,message:string,classification:object|null}>}
 *
 * Exit codes: 0 success/no-op, 1 execution/internal failure, 3 refused (state not
 * allowed / target ambiguous / environment not ready). Refusal and no-op paths
 * never call the migrations runner and never write to the database.
 */
export async function runInit({ stateDir, dbFile, appRoot = DEFAULT_APP_ROOT, runMigrations } = {}) {
  const model = loadExpectedModel({ appRoot });

  let before;
  try {
    before = diagnose({ stateDir, dbFile, appRoot });
  } catch (error) {
    const safety = asDbSafetyError(error);
    return buildInitResult({
      code: safety.exitCode,
      message: safety.message,
      error: { kind: safety.kind, exit_code: safety.exitCode, details: safety.details ?? null },
      expected: expectedSummary(model),
    });
  }

  const result = buildInitResult({
    stateBefore: before.classification.state,
    classification: summarizeForOutput(before.classification),
    target: before.target,
    hint: before.hint,
    expected: before.expected,
  });

  if (result.stateBefore === "MIGRATION_COMPLETE") {
    return {
      ...result,
      code: EXIT_CODES.OK,
      stateAfter: "MIGRATION_COMPLETE",
      message: `数据库已处于迁移终态（MIGRATION_COMPLETE，${before.expected.migrations_count} 个迁移均已记账），无需操作。`,
    };
  }

  if (!allowedForInit(result.stateBefore)) {
    return {
      ...result,
      code: EXIT_CODES.REFUSED,
      message:
        `拒绝自动初始化：当前数据库分类为 ${result.stateBefore}，不在允许列表（${INIT_ALLOWED_STATES.join(" / ")}）内，零写入。${before.hint}` +
        " 可用 scripts/db.sh diagnose --json 查看完整分类、结构指纹与账本状态。",
    };
  }

  if (typeof runMigrations !== "function") {
    return {
      ...result,
      code: EXIT_CODES.ERROR,
      message: "内部错误：init 编排没有可用的迁移执行器（runMigrations 缺失）。",
    };
  }

  try {
    await runMigrations({
      appRoot: before.target.appRoot,
      stateDir: before.target.stateDir,
      dbFile: before.target.dbFile,
      stateBefore: result.stateBefore,
      migrations: [...model.knownMigrations],
    });
    result.wranglerInvoked = true;
  } catch (error) {
    const safety = asDbSafetyError(error);
    // The runner reports whether a child process was actually spawned: false for
    // environment preconditions (exit 3), true for execution failures (exit 1).
    const invoked = Boolean(
      error && (error.invoked === true || (error.details && error.details.invoked === true)),
    );
    return {
      ...result,
      code: safety.exitCode === EXIT_CODES.REFUSED ? EXIT_CODES.REFUSED : EXIT_CODES.ERROR,
      wranglerInvoked: invoked,
      message: safety.message,
      error: { kind: safety.kind, exit_code: safety.exitCode, details: safety.details ?? null },
    };
  }

  // Re-classify after execution. The target file must be the same resolved file
  // (never delete/recreate the database to force a state).
  let after;
  try {
    after = diagnose({ stateDir: before.target.stateDir, dbFile: before.target.dbFile, appRoot });
  } catch (error) {
    const safety = asDbSafetyError(error);
    return {
      ...result,
      code: EXIT_CODES.ERROR,
      stateAfter: null,
      message: `迁移执行后无法完成只读复核：${safety.message}。已保留现场，未删除/重建数据库。请运行 scripts/db.sh diagnose --json 检查。`,
      error: { kind: safety.kind, exit_code: safety.exitCode, details: safety.details ?? null },
    };
  }

  result.stateAfter = after.classification.state;
  result.classification = summarizeForOutput(after.classification);
  result.target = after.target;
  result.hint = after.hint;

  if (result.stateAfter !== "MIGRATION_COMPLETE") {
    return {
      ...result,
      code: EXIT_CODES.ERROR,
      message: `迁移执行后数据库状态为 ${result.stateAfter}（要求 MIGRATION_COMPLETE）。已保留现场，未删除/重建数据库。请运行 scripts/db.sh diagnose --json 查看诊断。`,
    };
  }

  result.code = EXIT_CODES.OK;
  result.applied = true;
  result.message = `迁移完成：${result.stateBefore} → MIGRATION_COMPLETE（${model.knownMigrations.length} 个迁移全部记账）。`;
  return result;
}
