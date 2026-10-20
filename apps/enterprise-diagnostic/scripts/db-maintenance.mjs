#!/usr/bin/env node
// R2A B: read-only database maintenance CLI.
//
//   diagnose   read-only classification of the local D1 database
//   init       safe init/continue of the numbered migration chain
//   version    tool / Node / expected migration head / terminal fingerprint
//
// Safety boundary:
//   * No write entry point exists except `init`, and `init` only invokes the
//     real `wrangler d1 migrations apply ... --local` for the three allowed
//     states. There is no repair/adopt command and no hidden write flag.
//   * `diagnose` and every refusal path are strictly read-only.
//   * This CLI is cwd-independent: the application root comes from the module
//     location, and the real wrangler runner always executes with cwd=app root.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "./lib/schema-fingerprint.mjs";
import {
  DEFAULT_APP_ROOT,
  DEFAULT_STATE_DIR,
  DbSafetyError,
  EXIT_CODES,
  KNOWN_STATES,
  TOOL_VERSION,
  asDbSafetyError,
  assertTargetIdentity,
  diagnose,
  expectedSummary,
  loadExpectedModel,
  resolveTargets,
  runInit,
} from "./lib/db-init.mjs";

const COMMANDS = Object.freeze(["diagnose", "init", "version", "help"]);
const WRANGLER_CONFIG_FILES = Object.freeze(["wrangler.toml", "wrangler.jsonc", "wrangler.json"]);
const MIGRATION_TIMEOUT_MS = 10 * 60 * 1000;
/** R2A F2: the read-only target-identity probe must not hang. */
const TARGET_PROBE_TIMEOUT_MS = 2 * 60 * 1000;
const CHILD_OUTPUT_TAIL_BYTES = 256 * 1024;

// Environment variables passed through to the wrangler child process. Deliberately
// minimal: no Cloudflare credentials/tokens are forwarded, wrangler may only touch
// local state under --persist-to, and no env VALUE is ever printed.
const CHILD_ENV_PASSTHROUGH = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "SYSTEMROOT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "COMSPEC",
  "PATHEXT",
]);

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(canonicalize(value), null, 2)}\n`);
}

function writeLines(lines) {
  process.stdout.write(`${lines.filter((line) => line !== undefined).join("\n")}\n`);
}

function appendTail(current, chunk) {
  const next = current + chunk;
  return next.length <= CHILD_OUTPUT_TAIL_BYTES ? next : next.slice(next.length - CHILD_OUTPUT_TAIL_BYTES);
}

function tail(text, maxLines = 20) {
  const lines = String(text || "").trim().split("\n");
  return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}

function countSummary(counts) {
  if (!counts) return "（未计算）";
  return `表 ${counts.tables} / 列 ${counts.columns} / FK ${counts.fk} / 显式索引 ${counts.explicitIndexes} / 唯一约束 ${counts.uniqueConstraints}`;
}

function ledgerSummary(ledger) {
  if (!ledger) return "（无账本信息）";
  if (!ledger.present) return "无 d1_migrations 表";
  const head = ledger.head ? `，头部 ${ledger.head}` : "";
  const unknown = ledger.unknown && ledger.unknown.length ? `，未知迁移 ${ledger.unknown.join(", ")}` : "";
  return `${ledger.rowCount} 行${head}${unknown}`;
}

function dataSummary(data) {
  if (!data) return "（无数据检查信息）";
  if (data.ok) return "ok";
  return `冲突：${data.issues.join("; ")}`;
}

function targetForOutput(target) {
  if (!target) return null;
  return {
    state_dir: target.stateDir,
    state_dir_exists: target.stateDirExists,
    db_file: target.dbFile,
    db_file_source: target.dbFileSource,
    candidates: target.candidates,
    ignored_internal_files: target.ignoredInternalFiles || [],
    inspected: Array.isArray(target.inspected)
      ? target.inspected.map((item) => ({
          path: item.path,
          readable: item.readable,
          has_business_tables: item.hasBusinessTables,
          copied_for_read: item.copied === true,
        }))
      : [],
  };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const USAGE = `db-maintenance (R2A) ${TOOL_VERSION} — 企业诊断数据库只读诊断 / 安全初始化入口

用法:
  scripts/db.sh <command> [options]
  node scripts/db-maintenance.mjs <command> [options]

命令:
  diagnose   只读分类当前本地 D1 数据库（默认 <app>/.wrangler/state）
  init       安全初始化/续跑编号迁移；仅 EMPTY / MIGRATION_PARTIAL_OK / MIGRATION_COMPLETE
  version    打印工具版本、Node 版本、期望迁移头与终态指纹
  help       打印本帮助

选项:
  --state-dir <dir>   wrangler 本地状态目录（默认 <app>/.wrangler/state）
  --db-file <file>    仅 diagnose：只读分类指定的数据库文件（init 不接受，
                      以保证"分类目标"等于 wrangler 实际迁移写入目标）
  --json              输出稳定 JSON（init 在成功/拒绝/错误三种情况都输出）
  -h, --help          显示帮助

退出码:
  0  成功 / 无需操作
  1  内部或执行错误
  3  拒绝（状态不允许 / 目标不唯一 / 环境不满足），零写入

安全边界:
  * 只读分类；diagnose 与所有拒绝路径绝不写数据库。
  * 不提供 repair / adopt 或任何隐藏写入入口。
  * 历史 runtime / schema.sql 库、数据冲突、账本冲突、未知/更新结构一律拒绝。
  * init 只执行真实命令: wrangler d1 migrations apply DB --local --persist-to <state-dir>`;

function parseArgs(argv) {
  const flags = { json: false, help: false, stateDir: null, dbFile: null };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--state-dir" || arg === "--db-file") {
      const value = argv[index + 1];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new UsageError(`${arg} 需要一个值。`);
      }
      index += 1;
      if (arg === "--state-dir") flags.stateDir = value;
      else flags.dbFile = value;
    } else if (arg.startsWith("--state-dir=")) {
      flags.stateDir = arg.slice("--state-dir=".length);
      if (!flags.stateDir) throw new UsageError("--state-dir 需要一个非空值。");
    } else if (arg.startsWith("--db-file=")) {
      flags.dbFile = arg.slice("--db-file=".length);
      if (!flags.dbFile) throw new UsageError("--db-file 需要一个非空值。");
    } else if (arg.startsWith("-")) {
      throw new UsageError(`未知参数：${arg}（可用参数：--json --state-dir --db-file --help）`);
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

// ---------------------------------------------------------------------------
// Real wrangler migration runner (the only runner the CLI ever injects)
// ---------------------------------------------------------------------------

function findWranglerConfig(appRoot) {
  for (const name of WRANGLER_CONFIG_FILES) {
    const candidate = join(appRoot, name);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function buildChildEnvironment() {
  const env = {};
  for (const key of CHILD_ENV_PASSTHROUGH) {
    if (typeof process.env[key] === "string" && process.env[key] !== "") env[key] = process.env[key];
  }
  // Privacy / determinism: no telemetry, no color codes. No Cloudflare tokens
  // are forwarded, so wrangler cannot perform remote operations.
  env.WRANGLER_SEND_METRICS = "false";
  env.NO_COLOR = "1";
  return env;
}

/** Recursively list D1 data SQLite files (miniflare bookkeeping metadata.sqlite is not data). */
function listSqliteDataFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".sqlite") && entry.name !== "metadata.sqlite") out.push(entryPath);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * R2A F2: ask wrangler itself which local D1 file it will migrate, without
 * touching the real state directory.
 *
 * `wrangler d1 migrations list DB --local --persist-to <fresh-temp-dir>` opens
 * the same D1 binding in a throwaway state dir and creates that binding's data
 * file there. That file name/layout is exactly what `migrations apply` will use
 * for the real state dir. The probe never runs the migration executor, never
 * passes `--remote`, and uses the same minimal child environment. The scratch
 * directory is always removed.
 *
 * @returns {Promise<{relativePath:string, probedFile:string}>}
 */
async function probeWranglerDatabaseTarget({ appRoot, wranglerBin }) {
  const scratch = mkdtempSync(join(tmpdir(), "r2a-wrangler-target-"));
  try {
    const args = ["d1", "migrations", "list", "DB", "--local", "--persist-to", scratch];
    let child;
    try {
      child = spawn(wranglerBin, args, {
        cwd: appRoot,
        env: buildChildEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw new DbSafetyError(
        EXIT_CODES.REFUSED,
        "WRANGLER_NOT_FOUND",
        `无法启动 wrangler 进行目标识别探针（${wranglerBin}）：${error.message}。已拒绝初始化，未启动迁移执行器。`,
        { invoked: false, wranglerBin },
      );
    }

    const stdout = { value: "" };
    const stderr = { value: "" };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout.value = appendTail(stdout.value, chunk); });
    child.stderr.on("data", (chunk) => { stderr.value = appendTail(stderr.value, chunk); });

    await new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 2000).unref?.();
        finish(() => rejectPromise(new DbSafetyError(
          EXIT_CODES.REFUSED,
          "TARGET_PROBE_TIMEOUT",
          `wrangler 目标识别探针超时（${TARGET_PROBE_TIMEOUT_MS} ms）。已拒绝初始化，未启动迁移执行器。`,
          { invoked: false },
        )));
      }, TARGET_PROBE_TIMEOUT_MS);

      child.on("error", (error) => {
        if (error && error.code === "ENOENT") {
          finish(() => rejectPromise(new DbSafetyError(
            EXIT_CODES.REFUSED,
            "WRANGLER_NOT_FOUND",
            `找不到 wrangler 可执行文件（${wranglerBin}），无法在写入前确认迁移目标。已拒绝初始化，未启动迁移执行器。请安装 wrangler 或用 WRANGLER_BIN 指定路径后重试。`,
            { invoked: false, wranglerBin },
          )));
          return;
        }
        finish(() => rejectPromise(new DbSafetyError(
          EXIT_CODES.REFUSED,
          "TARGET_PROBE_FAILED",
          `wrangler 目标识别探针启动失败：${error.message}。已拒绝初始化，未启动迁移执行器。`,
          { invoked: false },
        )));
      });

      child.on("close", (code, signal) => {
        if (code === 0) {
          finish(() => resolvePromise());
          return;
        }
        const outputTail = tail(stderr.value) || tail(stdout.value);
        finish(() => rejectPromise(new DbSafetyError(
          EXIT_CODES.REFUSED,
          "TARGET_PROBE_FAILED",
          `wrangler 目标识别探针失败（exit=${code}${signal ? `，signal=${signal}` : ""}），无法在写入前确认迁移目标。已拒绝初始化，未启动迁移执行器。${outputTail ? `输出尾部：${outputTail}` : ""}`,
          { invoked: false },
        )));
      });
    });

    const files = listSqliteDataFiles(scratch);
    if (files.length !== 1) {
      throw new DbSafetyError(
        EXIT_CODES.REFUSED,
        "TARGET_IDENTITY_UNCONFIRMED",
        `wrangler 目标识别探针未返回唯一 D1 数据文件（实际 ${files.length} 个：${files.map((file) => relative(scratch, file)).join(", ") || "无"}）。` +
          "已拒绝初始化，未启动迁移执行器，未创建/移动/删除任何数据库。",
        { invoked: false, probeFiles: files.map((file) => relative(scratch, file)) },
      );
    }
    return { relativePath: relative(scratch, files[0]), probedFile: files[0] };
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Run the real local migration command:
 *   wrangler d1 migrations apply DB --local --persist-to <stateDir>
 * with cwd=app root, stdin ignored (non-interactive) and a minimal environment.
 * Never passes --remote/--preview. Throws DbSafetyError with `invoked` set so the
 * orchestrator can distinguish "environment not ready" (exit 3) from execution
 * failures (exit 1).
 */
async function runRealMigrations({ appRoot, stateDir, dbFile }) {
  const configPath = findWranglerConfig(appRoot);
  if (!configPath) {
    throw new DbSafetyError(
      EXIT_CODES.REFUSED,
      "ENV_NOT_READY",
      `缺少 wrangler 本地配置：${appRoot} 下没有 ${WRANGLER_CONFIG_FILES.join(" / ")}。请按 README 复制 wrangler.toml.example 为 wrangler.toml 后重试；本工具不会自动创建或修改配置。`,
      { invoked: false, appRoot, configFiles: [...WRANGLER_CONFIG_FILES] },
    );
  }

  const wranglerBin = process.env.WRANGLER_BIN && process.env.WRANGLER_BIN.trim() ? process.env.WRANGLER_BIN.trim() : "wrangler";

  // R2A F2: before spawning any migration write, prove that the classified
  // database is the same file wrangler will migrate. The probe runs against a
  // fresh scratch state dir only; the real state dir is not touched.
  const probed = await probeWranglerDatabaseTarget({ appRoot, wranglerBin });
  assertTargetIdentity({
    classifiedStateDir: stateDir,
    classifiedDbFile: dbFile,
    expectedRelativePath: probed.relativePath,
  });

  const args = ["d1", "migrations", "apply", "DB", "--local", "--persist-to", stateDir];
  let child;
  try {
    child = spawn(wranglerBin, args, {
      cwd: appRoot,
      env: buildChildEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    throw new DbSafetyError(EXIT_CODES.ERROR, "WRANGLER_SPAWN_FAILED", `启动 wrangler 失败：${error.message}`, {
      invoked: false,
    });
  }

  const stdout = { value: "" };
  const stderr = { value: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout.value = appendTail(stdout.value, chunk);
    // Progress never goes to stdout in --json mode; stderr keeps stdout a clean JSON document.
    process.stderr.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr.value = appendTail(stderr.value, chunk);
    process.stderr.write(chunk);
  });

  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 2000).unref?.();
      finish(() =>
        rejectPromise(
          new DbSafetyError(
            EXIT_CODES.ERROR,
            "MIGRATION_TIMEOUT",
            `wrangler d1 migrations apply 超时（${MIGRATION_TIMEOUT_MS} ms）。已保留现场，未删除/重建数据库。输出尾部：${tail(stderr.value) || tail(stdout.value)}`,
            { invoked: true },
          ),
        ),
      );
    }, MIGRATION_TIMEOUT_MS);

    child.on("error", (error) => {
      if (error && error.code === "ENOENT") {
        finish(() =>
          rejectPromise(
            new DbSafetyError(
              EXIT_CODES.REFUSED,
              "WRANGLER_NOT_FOUND",
              `找不到 wrangler 可执行文件（${wranglerBin}）。请安装 wrangler，或用环境变量 WRANGLER_BIN 指定可执行文件路径后重试。`,
              { invoked: false },
            ),
          ),
        );
        return;
      }
      finish(() =>
        rejectPromise(
          new DbSafetyError(EXIT_CODES.ERROR, "WRANGLER_SPAWN_FAILED", `启动 wrangler 失败：${error.message}`, {
            invoked: false,
          }),
        ),
      );
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(() => resolvePromise({ exitCode: 0 }));
        return;
      }
      const outputTail = tail(stderr.value) || tail(stdout.value);
      finish(() =>
        rejectPromise(
          new DbSafetyError(
            EXIT_CODES.ERROR,
            "MIGRATION_FAILED",
            `wrangler d1 migrations apply 失败（exit=${code}${signal ? `，signal=${signal}` : ""}）。已保留现场，未删除/重建数据库。${outputTail ? `输出尾部：${outputTail}` : ""}`,
            { invoked: true },
          ),
        ),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function humanDiagnose(result) {
  const classification = result.classification || {};
  const target = result.target || {};
  const expected = result.expected || {};
  return [
    `数据库分类: ${classification.state}`,
    `判定原因: ${classification.reason}`,
    `状态目录: ${target.stateDir}${target.stateDirExists ? "" : "（不存在）"}`,
    `数据库文件: ${target.dbFile || "（无：state 目录下没有 D1 数据文件，视为 EMPTY）"}`,
    Array.isArray(target.ignoredInternalFiles) && target.ignoredInternalFiles.length
      ? `已排除内部簿记: ${[...new Set(target.ignoredInternalFiles.map((item) => basename(item)))].join(", ")}（miniflare 内部文件，不是 D1 数据文件）`
      : undefined,
    target.dbFileSource ? `目标来源: ${target.dbFileSource}${target.candidates && target.candidates.length > 1 ? `（候选 ${target.candidates.length} 个）` : ""}` : undefined,
    classification.fingerprint ? `结构指纹: ${classification.fingerprint}` : undefined,
    classification.counts ? `结构规模: ${countSummary(classification.counts)}` : undefined,
    classification.ledger ? `迁移账本: ${ledgerSummary(classification.ledger)}` : undefined,
    classification.data ? `数据完整性: ${dataSummary(classification.data)}` : undefined,
    `期望迁移: ${expected.migrations_count} 个，头部 ${expected.migrations_head}`,
    `终态指纹: ${expected.terminal_fingerprint}`,
    `允许自动 init: ${result.allowedForInit ? "是" : "否"}`,
    `建议: ${result.hint}`,
  ];
}

function humanInit(result) {
  const verdict = result.code === EXIT_CODES.OK ? "成功" : result.code === EXIT_CODES.REFUSED ? "拒绝" : "失败";
  const lines = [
    `init 结果: ${verdict}（exit ${result.code}）`,
    `执行前状态: ${result.stateBefore || "（未分类）"}`,
    `执行后状态: ${result.stateAfter || "（未执行复核）"}`,
    `wrangler 调用: ${result.wranglerInvoked ? "是" : "否"}`,
    `迁移实际应用: ${result.applied ? "是" : "否"}`,
    `目标: ${result.target ? result.target.dbFile || "（EMPTY：初始化后将创建本地 D1 数据库）" : "（未解析）"}`,
    `消息: ${result.message}`,
  ];
  if (result.hint) lines.push(`建议: ${result.hint}`);
  lines.push("退出码约定: 0 成功/无需操作；1 内部/执行错误；3 拒绝（零写入）。");
  return lines;
}

function handleDiagnose(flags) {
  try {
    const result = diagnose({ stateDir: flags.stateDir, dbFile: flags.dbFile, appRoot: DEFAULT_APP_ROOT });
    if (flags.json) {
      writeJson({
        command: "diagnose",
        ok: true,
        code: EXIT_CODES.OK,
        tool_version: TOOL_VERSION,
        target: targetForOutput(result.target),
        state: result.classification.state,
        reason: result.classification.reason,
        classification: result.summary,
        allowed_for_init: result.allowedForInit,
        hint: result.hint,
        expected: result.expected,
      });
    } else {
      writeLines(humanDiagnose(result));
    }
    return EXIT_CODES.OK;
  } catch (error) {
    const safety = asDbSafetyError(error);
    if (flags.json) {
      writeJson({
        command: "diagnose",
        ok: false,
        code: safety.exitCode,
        tool_version: TOOL_VERSION,
        message: safety.message,
        error: { kind: safety.kind, exit_code: safety.exitCode },
      });
    } else {
      process.stderr.write(`诊断失败: ${safety.message}\n`);
    }
    return safety.exitCode;
  }
}

async function handleInit(flags) {
  try {
    if (flags.dbFile) {
      // Safety invariant: the classified database must be the same database that
      // wrangler will migrate. The real runner targets the D1 binding under
      // --state-dir; an arbitrary --db-file cannot be guaranteed to be that file,
      // so init refuses it outright (diagnose keeps --db-file for read-only use).
      // Resolve first so precise target errors (e.g. internal metadata.sqlite)
      // are still reported.
      resolveTargets({ stateDir: flags.stateDir, dbFile: flags.dbFile, appRoot: DEFAULT_APP_ROOT });
      throw new DbSafetyError(
        EXIT_CODES.REFUSED,
        "TARGET_DBFILE_UNSUPPORTED_FOR_INIT",
        "init 不接受 --db-file：安全初始化只能作用于 --state-dir 下 wrangler 绑定的本地 D1 数据库，" +
          "以保证分类目标与迁移写入目标完全一致。请使用 --state-dir；只读查看其它文件请用 diagnose --db-file。",
      );
    }
    const result = await runInit({
      stateDir: flags.stateDir,
      dbFile: flags.dbFile,
      appRoot: DEFAULT_APP_ROOT,
      // The CLI only ever injects the real wrangler runner. There is no flag/env
      // that lets a caller substitute it.
      runMigrations: runRealMigrations,
    });
    if (flags.json) {
      const classification = result.classification || null;
      writeJson({
        command: "init",
        ok: result.code === EXIT_CODES.OK,
        code: result.code,
        tool_version: TOOL_VERSION,
        state_before: result.stateBefore,
        state_after: result.stateAfter,
        applied: result.applied,
        wrangler_invoked: result.wranglerInvoked,
        message: result.message,
        state: classification ? classification.state : result.stateBefore || result.stateAfter || null,
        reason: classification ? classification.reason : result.message,
        classification,
        target: targetForOutput(result.target),
        hint: result.hint ?? null,
        expected: result.expected
          ? {
              migrations_count: result.expected.migrations_count,
              migrations_head: result.expected.migrations_head,
              terminal_fingerprint: result.expected.terminal_fingerprint,
            }
          : null,
        error: result.error ?? null,
      });
    } else if (result.code === EXIT_CODES.OK) {
      writeLines(humanInit(result));
    } else {
      process.stderr.write(`${humanInit(result).join("\n")}\n`);
    }
    return result.code;
  } catch (error) {
    const safety = asDbSafetyError(error);
    if (flags.json) {
      writeJson({
        command: "init",
        ok: false,
        code: safety.exitCode,
        tool_version: TOOL_VERSION,
        state_before: null,
        state_after: null,
        applied: false,
        wrangler_invoked: false,
        message: safety.message,
        state: null,
        reason: safety.message,
        classification: null,
        error: { kind: safety.kind, exit_code: safety.exitCode },
      });
    } else {
      process.stderr.write(`init 失败: ${safety.message}\n`);
    }
    return safety.exitCode;
  }
}

function handleVersion(flags) {
  let model;
  try {
    model = loadExpectedModel({ appRoot: DEFAULT_APP_ROOT });
  } catch (error) {
    const safety = asDbSafetyError(error);
    if (flags.json) {
      writeJson({
        command: "version",
        ok: false,
        code: safety.exitCode,
        tool_version: TOOL_VERSION,
        message: safety.message,
        error: { kind: safety.kind, exit_code: safety.exitCode },
      });
    } else {
      process.stderr.write(`无法读取迁移权威链: ${safety.message}\n`);
    }
    return safety.exitCode;
  }
  const expected = expectedSummary(model);
  if (flags.json) {
    writeJson({
      command: "version",
      ok: true,
      code: EXIT_CODES.OK,
      tool: "db-maintenance",
      tool_version: TOOL_VERSION,
      node_version: process.version,
      node_sqlite: true,
      app_root: DEFAULT_APP_ROOT,
      default_state_dir: DEFAULT_STATE_DIR,
      expected,
      allowed_states: [...expected.init_allowed_states],
      known_states: [...KNOWN_STATES],
    });
    return EXIT_CODES.OK;
  }
  writeLines([
    `db-maintenance (R2A) ${TOOL_VERSION}`,
    `node: ${process.version}（node:sqlite 可用）`,
    `app_root: ${DEFAULT_APP_ROOT}`,
    `默认状态目录: ${DEFAULT_STATE_DIR}`,
    `迁移权威链: ${expected.migrations_count} 个，头部 ${expected.migrations_head}`,
    `终态指纹: ${expected.terminal_fingerprint}`,
    `允许 init 的状态: ${expected.init_allowed_states.join(" / ")}`,
    `识别状态全集: ${KNOWN_STATES.join(" / ")}`,
  ]);
  return EXIT_CODES.OK;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (argv.includes("--json")) {
      writeJson({
        command: null,
        ok: false,
        code: EXIT_CODES.ERROR,
        tool_version: TOOL_VERSION,
        message,
        error: { kind: "USAGE_ERROR", exit_code: EXIT_CODES.ERROR },
      });
    } else {
      process.stderr.write(`${message}\n\n${USAGE}\n`);
    }
    return EXIT_CODES.ERROR;
  }

  const command = parsed.positional[0] || (parsed.flags.help ? "help" : null);
  if (parsed.flags.help || command === "help") {
    writeLines([USAGE]);
    return EXIT_CODES.OK;
  }
  if (!command) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT_CODES.ERROR;
  }
  if (!COMMANDS.includes(command)) {
    process.stderr.write(`未知命令：${command}\n\n${USAGE}\n`);
    return EXIT_CODES.ERROR;
  }
  if (parsed.positional.length > 1) {
    process.stderr.write(`命令 ${command} 不接受位置参数：${parsed.positional.slice(1).join(" ")}\n`);
    return EXIT_CODES.ERROR;
  }

  if (command === "diagnose") return handleDiagnose(parsed.flags);
  if (command === "init") return handleInit(parsed.flags);
  return handleVersion(parsed.flags);
}

export { probeWranglerDatabaseTarget, runRealMigrations };

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
const invokedAsScript = isMainModule();
if (invokedAsScript) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`db-maintenance 内部错误: ${error && error.stack ? error.stack : String(error)}\n`);
      process.exitCode = EXIT_CODES.ERROR;
    });
}
