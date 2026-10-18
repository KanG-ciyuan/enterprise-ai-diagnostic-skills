#!/usr/bin/env node
/**
 * PILOT-09C/HARDEN-3H —— 测试环境**指纹校验**工具（零依赖，纯 Node 标准库）
 *
 * 目的：防止"测试跑在陈旧副本上"（PILOT-09C-VERIFY-3G 的 409 就是 `/tmp` 副本未同步所致）。
 * 做法：对**实际工作树文件**（含未提交 / 未跟踪的运行相关文件）建立按相对路径排序的
 *       SHA-256 清单；启动前与实验副本逐项比对，不一致即**明确失败并拒绝启动**。
 *
 * 用法：
 *   node tests/env_fingerprint.mjs build  <root> <out.json>
 *   node tests/env_fingerprint.mjs verify <root> <manifest.json>     # 不一致 → 退出码 1
 *   node tests/env_fingerprint.mjs selftest                          # 反向验证（篡改/删除/新增/正常）
 *
 * 覆盖范围（运行相关）：
 *   · functions/**            服务端运行时（全部）
 *   · app.js / styles.css / index.html   静态入口
 *   · dist/**                 构建产物（记录 derived 来源，不与源文件直接比较）
 *   · schema.sql / wrangler.* 运行配置
 *   · tests/d1_harness.mjs    跨目录运行时依赖
 * **排除**：.env / .dev.vars / *.key / *.pem / .wrangler / node_modules / .git
 *   —— 报告只记录**变量名与位置**，绝不收录内容。
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");

/** 运行相关路径（相对 root）。目录递归，文件直取。 */
const INCLUDE = [
  "functions",
  "dist",
  "app.js",
  "styles.css",
  "index.html",
  "schema.sql",
  "wrangler.toml",
  "wrangler.jsonc",
  "wrangler.json",
  "tests/d1_harness.mjs",
];
/** 明确排除（敏感/无关） */
const EXCLUDE_PATTERNS = [
  /(^|\/)\.env(\.|$)/, /(^|\/)\.dev\.vars$/, /\.(key|pem|crt|p12)$/i,
  /(^|\/)\.wrangler(\/|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.git(\/|$)/,
  /(^|\/)\.DS_Store$/,
];
/** 构建产物：记录来源，用于"输入→产物"一致性检查，不与源文件直接比较 */
const DERIVED = { "dist/app.js": "app.js" };

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const isExcluded = (rel) => EXCLUDE_PATTERNS.some((re) => re.test(rel));

function walk(root, rel, out) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return;
  const st = statSync(abs);
  if (st.isDirectory()) {
    for (const name of readdirSync(abs).sort()) {
      const childRel = `${rel}/${name}`;
      if (isExcluded(childRel)) continue;
      walk(root, childRel, out);
    }
    return;
  }
  if (isExcluded(rel)) return;
  const content = readFileSync(abs);
  const entry = { path: rel, sha256: sha256(content), bytes: content.length };
  if (DERIVED[rel]) entry.derivedFrom = DERIVED[rel];
  out.push(entry);
}

/** 收集清单（按相对路径排序；确定性 JSON，无时间戳/访问次数） */
export function collectManifest(root = APP_ROOT) {
  const files = [];
  for (const rel of INCLUDE) {
    if (isExcluded(rel)) continue;
    walk(root, rel, files);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const digest = sha256(JSON.stringify(files.map((f) => [f.path, f.sha256])));
  // 构建产物：**只记录输入来源与产物哈希**，不与源文件内容直接比较
  // （产物可能经过打包/压缩，与源文件属不同类型）。产物哈希由清单本身保证可追溯。
  const derivedChecks = [];
  for (const [outRel, inRel] of Object.entries(DERIVED)) {
    const outEntry = files.find((f) => f.path === outRel);
    const inEntry = files.find((f) => f.path === inRel);
    derivedChecks.push({
      outRel, inRel,
      ok: Boolean(outEntry && inEntry),
      reason: !outEntry ? "output_missing" : (!inEntry ? "input_missing" : (outEntry.sha256 === inEntry.sha256 ? "identical_copy" : "transformed_build")),
      outputSha: outEntry ? outEntry.sha256.slice(0, 12) : null,
      inputSha: inEntry ? inEntry.sha256.slice(0, 12) : null,
      note: "产物按自身哈希纳入清单；来源关系仅作审计记录",
    });
  }
  // 敏感文件**存在性**记录（只记路径，不记内容）
  const sensitivePresent = [".dev.vars", ".env", ".env.local"].filter((n) => existsSync(path.join(root, n)));
  return {
    schemaVersion: 1,
    root: path.basename(root),                 // 只记目录名，不泄漏绝对路径
    fileCount: files.length,
    digest,
    files,
    derivedChecks,
    sensitivePresent,
    sensitiveNote: sensitivePresent.length
      ? "存在本地密钥文件（.dev.vars/.env），已**排除**在清单外；测试副本必须使用明显假值，真实 Key 不得复制"
      : "未发现本地密钥文件",
  };
}

/** 比对：返回 { ok, contentMismatch[], missing[], extra[], derivedFailures[] } */
export function compareManifests(expected, actual) {
  const expMap = new Map(expected.files.map((f) => [f.path, f]));
  const actMap = new Map(actual.files.map((f) => [f.path, f]));
  const contentMismatch = [];
  const missing = [];
  const extra = [];
  for (const [rel, exp] of expMap) {
    const act = actMap.get(rel);
    if (!act) { missing.push(rel); continue; }
    if (act.sha256 !== exp.sha256) contentMismatch.push({ path: rel, expected: exp.sha256.slice(0, 12), actual: act.sha256.slice(0, 12) });
  }
  for (const rel of actMap.keys()) if (!expMap.has(rel)) extra.push(rel);
  const derivedFailures = (actual.derivedChecks || []).filter((c) => !c.ok);
  return {
    ok: contentMismatch.length === 0 && missing.length === 0 && extra.length === 0 && derivedFailures.length === 0,
    digestMatch: expected.digest === actual.digest,
    contentMismatch, missing, extra, derivedFailures,
  };
}

/** 供测试脚本调用：校验失败即抛出（拒绝启动） */
export function assertCopyMatches(sourceManifest, copyRoot, label = "实验副本") {
  const actual = collectManifest(copyRoot);
  const diff = compareManifests(sourceManifest, actual);
  if (!diff.ok) {
    const error = new Error(`${label}指纹不匹配，拒绝启动：` + JSON.stringify({
      contentMismatch: diff.contentMismatch, missing: diff.missing, extra: diff.extra, derivedFailures: diff.derivedFailures,
    }));
    error.fingerprintDiff = diff;
    throw error;
  }
  return { ok: true, digest: actual.digest, fileCount: actual.fileCount };
}

// ── CLI（仅直接运行本文件时执行；被 import 时不执行）────────────────
const IS_MAIN = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const [, , cmd, a1, a2] = IS_MAIN ? process.argv : [];
if (!IS_MAIN) { /* imported as helper */ } else
if (cmd === "build") {
  const root = path.resolve(a1 || APP_ROOT);
  const manifest = collectManifest(root);
  if (a2) writeFileSync(path.resolve(a2), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ digest: manifest.digest, fileCount: manifest.fileCount, derivedChecks: manifest.derivedChecks, sensitive: manifest.sensitivePresent }, null, 2));
  process.exit(manifest.derivedChecks.every((c) => c.ok) ? 0 : 2);
} else if (cmd === "verify") {
  const root = path.resolve(a1 || APP_ROOT);
  const expected = JSON.parse(readFileSync(path.resolve(a2), "utf8"));
  const actual = collectManifest(root);
  const diff = compareManifests(expected, actual);
  console.log(JSON.stringify(diff, null, 2));
  process.exit(diff.ok ? 0 : 1);
} else if (cmd === "selftest") {
  // 反向验证：正确副本通过；改内容（保留时间戳）/ 删文件 / 增文件 → 全部被拒
  const base = mkdtempSync(path.join(tmpdir(), "p9c-fp-selftest-"));
  const results = [];
  const rec = (id, name, ok, note = "") => { results.push({ id, name, ok, note }); console.log(`  ${ok ? "✔" : "✘"} [${id}] ${name}${note ? "\n        " + note : ""}`); };
  try {
    const manifest = collectManifest(APP_ROOT);
    rec("FP-0", "源清单可生成且构建产物来源一致", manifest.fileCount > 0 && manifest.derivedChecks.every((c) => c.ok), `files=${manifest.fileCount} digest=${manifest.digest.slice(0, 12)}`);

    const copyTo = (dir) => {
      mkdirSync(dir, { recursive: true });
      for (const rel of INCLUDE) {
        const src = path.join(APP_ROOT, rel);
        if (!existsSync(src)) continue;
        const dst = path.join(dir, rel);
        mkdirSync(path.dirname(dst), { recursive: true });
        cpSync(src, dst, { recursive: true });
      }
      return dir;
    };

    const good = copyTo(path.join(base, "good"));
    let okGood = true; let noteGood = "";
    try { const r = assertCopyMatches(manifest, good, "正常副本"); noteGood = `digest=${r.digest.slice(0, 12)} files=${r.fileCount}`; } catch (e) { okGood = false; noteGood = e.message.slice(0, 160); }
    rec("FP-1", "正确副本可通过校验", okGood, noteGood);

    const tampered = copyTo(path.join(base, "tampered"));
    const target = path.join(tampered, "functions/api/agent/employee-turn.js");
    if (existsSync(target)) {
      const before = statSync(target).mtimeMs;
      writeFileSync(target, readFileSync(target, "utf8") + "\n// tampered\n");
      // 即使把时间戳改回去也不应通过
      const { utimesSync } = await import("node:fs");
      utimesSync(target, before / 1000, before / 1000);
    }
    let okT = false; let noteT = "";
    try { assertCopyMatches(manifest, tampered, "篡改副本"); } catch (e) { okT = true; noteT = JSON.stringify((e.fingerprintDiff || {}).contentMismatch || []).slice(0, 120); }
    rec("FP-2", "修改副本内容（保留时间戳）→ 拒绝", okT, noteT);

    const deleted = copyTo(path.join(base, "deleted"));
    if (existsSync(path.join(deleted, "functions/api/agent/employee-turn.js"))) rmSync(path.join(deleted, "functions/api/agent/employee-turn.js"));
    let okD = false; let noteD = "";
    try { assertCopyMatches(manifest, deleted, "缺文件副本"); } catch (e) { okD = true; noteD = JSON.stringify((e.fingerprintDiff || {}).missing || []).slice(0, 120); }
    rec("FP-3", "删除运行相关文件 → 拒绝", okD, noteD);

    const added = copyTo(path.join(base, "added"));
    writeFileSync(path.join(added, "functions/api/agent/extra.js"), "export const x = 1;\n");
    let okA = false; let noteA = "";
    try { assertCopyMatches(manifest, added, "多文件副本"); } catch (e) { okA = true; noteA = JSON.stringify((e.fingerprintDiff || {}).extra || []).slice(0, 120); }
    rec("FP-4", "新增运行相关文件 → 拒绝", okA, noteA);

    rec("FP-5", "敏感文件不入清单（只记路径与变量名）", manifest.files.every((f) => !/\.env|dev\.vars|\.key$|\.pem$/.test(f.path)), `sensitivePresent=${JSON.stringify(manifest.sensitivePresent)}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n  FP PASS=${results.length - failed.length}/${results.length}`);
  process.exit(failed.length ? 1 : 0);
} else {
  // 无参数调用 = 仅打印用法（helper 不是测试套件，退出码 0）
  console.log("env_fingerprint helper: node tests/env_fingerprint.mjs build|verify|selftest [args]");
  process.exit(0);
}
