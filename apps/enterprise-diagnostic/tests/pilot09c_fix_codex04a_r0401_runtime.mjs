/**
 * PILOT-09C/FIX-CODEX-04A —— R04-01 带 receipt 的提交冲突误判 · 定向运行时套件
 *
 * 覆盖：
 *   A. 等待态成功响应的**唯一判定入口** confirmedVerifierNotReadyPayload 的纯逻辑行为：
 *      只有 code=verifier_not_ready + 结构完整 + blocked_draft/waiting_assignment +
 *      revision 保持或恰好 +1 才接受；带 receipt 的 submission_conflict 一律拒绝。
 *   B. app.js 契约：等待态分支必须经该校验器门控；旧 `409 && payload.receipt` 宽泛判据
 *      必须消失；真实冲突分支必须置冲突闩锁且**不得**采用服务端 revision。
 *   C. 源码中不得残留任何测试 hook（本轮动态测试的 instrumentation 只允许存在于临时副本）。
 *
 * 说明：本套件是**补充性**静态/纯逻辑防线，不能替代 dyn-r0401 的真实 Chrome 动态验收。
 *
 * 可用环境变量 P04A_APP_DIR 指向待测应用目录（用于在修复前基线上保留 RED 记录）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.P04A_APP_DIR || path.resolve(HERE, "..");

const results = [];
const pass = (id, name, note = "") => results.push({ id, name, verdict: "PASS", note });
const fail = (id, name, note = "") => results.push({ id, name, verdict: "FAIL", note });
const check = (id, name, ok, note = "") => (ok ? pass(id, name, note) : fail(id, name, note));

const appPath = path.join(APP, "app.js");
const appSrc = readFileSync(appPath, "utf8");

console.log("PILOT-09C/FIX-CODEX-04A · R04-01 带 receipt 的冲突误判 —— 定向套件");
console.log(`  被测 app.js: ${appPath}`);

// ── 0. 从 app.js 提取纯函数（保持与浏览器脚本同一份实现）──────────────────
const BEGIN = "// BEGIN R04-01 VERIFIER-NOT-READY VALIDATOR";
const END = "// END R04-01 VERIFIER-NOT-READY VALIDATOR";
let validator = null;
let extractError = "";
try {
  const begin = appSrc.indexOf(BEGIN);
  const end = appSrc.indexOf(END);
  if (begin < 0 || end < 0 || end <= begin) throw new Error("未找到 R04-01 校验器标记");
  const fnSrc = appSrc.slice(begin + BEGIN.length, end);
  validator = new Function(`"use strict";\n${fnSrc}\nreturn confirmedVerifierNotReadyPayload;`)();
  if (typeof validator !== "function") throw new Error("校验器不是函数");
} catch (error) {
  extractError = String(error && error.message || error);
}

const W = "WI-R04A-001";
const t0 = (over = {}) => ({ id: W, draftRevision: 6, status: "blocked_draft", handoffStatus: "waiting_assignment", ...over });
const r0 = (over = {}) => ({ workItemId: W, handoffStatus: "waiting_assignment", submissionVersion: 1, ...over });
const payload0 = (over = {}) => ({ code: "verifier_not_ready", detail: "项目核验人尚未就绪，完整草稿已保存。", task: t0(), receipt: r0(), ...over });
const accepts = (payload, localRevision = 5) => Boolean(validator && validator(payload, W, localRevision));
const rejects = (payload, localRevision = 5) => Boolean(!accepts(payload, localRevision));

console.log("\n── A. 等待态判定纯逻辑（真实服务端响应形状）──");
check("A0", "校验器可从 app.js 提取（修复后必须存在）", typeof validator === "function", extractError);
if (typeof validator === "function") {
  check("A1", "合法首次等待态提交：verifier_not_ready + blocked_draft + waiting_assignment + revision N→N+1 → 接受",
    accepts(payload0(), 5), "");
  check("A2", "合法幂等重放：同一载荷再次提交 revision 保持不变 → 接受",
    accepts(payload0({ task: t0({ draftRevision: 5 }) }), 5), "");
  check("A3", "带 receipt 的 submission_conflict(stale_base_revision)（真实冲突响应形状）→ 拒绝",
    rejects({
      code: "submission_conflict", reason: "stale_base_revision",
      detail: "提交依据的草稿版本已过期，本次等待态提交未写入。",
      currentRevision: 6, expectedRevision: 5,
      task: { id: W, draftRevision: 6, status: "needs_input", stage: "mapping", handoffStatus: null },
      receipt: r0({ handoffStatus: null }),
    }), "");
  check("A4", "对抗形状：除 code 外与合法等待态完全一致的 submission_conflict → 必须拒绝（code 是判据核心）",
    rejects(payload0({ code: "submission_conflict", reason: "stale_base_revision" })), "");
  check("A5", "带 receipt 的 submission_conflict(verifier_ready) → 拒绝",
    rejects(payload0({ code: "submission_conflict", reason: "verifier_ready" })), "");
  check("A6", "并发 CAS 失败的 submission_conflict（无 reason、带 task+receipt）→ 拒绝",
    rejects(payload0({ code: "submission_conflict" })), "");
  check("A7", "idempotency_key_reuse 409（即使携带 receipt 形状）→ 拒绝",
    rejects(payload0({ code: "idempotency_key_reuse" })), "");
  check("A8", "revision 跳跃 +2 → 拒绝", rejects(payload0({ task: t0({ draftRevision: 7 }) })), "");
  check("A9", "revision 回退 → 拒绝", rejects(payload0({ task: t0({ draftRevision: 4 }) })), "");
  check("A10", "task 状态不是 blocked_draft（assigned/awaiting_verification）→ 拒绝",
    rejects(payload0({ task: t0({ status: "awaiting_verification", handoffStatus: "assigned" }) })), "");
  check("A11", "handoffStatus 不一致（receipt 说 assigned）→ 拒绝",
    rejects(payload0({ receipt: r0({ handoffStatus: "assigned" }) })), "");
  check("A12", "task.id 与本页任务不一致 → 拒绝", rejects(payload0({ task: t0({ id: "WI-OTHER" }) })), "");
  check("A13", "receipt.workItemId 与本页任务不一致 → 拒绝", rejects(payload0({ receipt: r0({ workItemId: "WI-OTHER" }) })), "");
  check("A14", "缺失 task / receipt / 非法 revision → 拒绝",
    rejects({ code: "verifier_not_ready", receipt: r0() })
      && rejects({ code: "verifier_not_ready", task: t0() })
      && rejects(payload0({ task: t0({ draftRevision: "6" }) }))
      && rejects(payload0({ task: t0({ draftRevision: -1 }) })), "");
  check("A15", "本页本地 revision 非法（undefined/null/非整数）→ 拒绝（fail-closed）",
    validator(payload0(), W, undefined) === null
      && validator(payload0(), W, null) === null
      && validator(payload0(), W, "5") === null
      && validator(payload0(), W, -1) === null, "");
}

console.log("\n── B. app.js 契约：错误码门控 / 冲突闩锁 / 不采用服务端 revision ──");
const noBroadReceiptGate = !/error\.status === 409 && error\.payload\?\.receipt/.test(appSrc);
const waitingGatedByValidator = /const waitingPayload = error\.status === 409[\s\S]{0,240}?confirmedVerifierNotReadyPayload\(error\.payload/.test(appSrc);
const waitingSyncsValidatedRevision = /if \(waitingPayload\) \{[\s\S]{0,700}?state\.formalInterviewRevision = waitingPayload\.task\.draftRevision/.test(appSrc);
const waitingSetsWaitingStep = /if \(waitingPayload\) \{[\s\S]{0,900}?state\.formalEmployeeStep = "waiting"/.test(appSrc);
const conflictSetsLatch = appSrc.includes("// PILOT-09C/FIX-CODEX-04A（R04-01）：**只有通过业务错误码")
  && appSrc.includes("confirmedVerifierNotReadyPayload(error.payload, state.formalEmployeeTask?.id, state.formalInterviewRevision)")
  && /state\.formalEmployeeConflict = true;[\s\S]{0,300}?failureNotice = "提交冲突/.test(appSrc);
const noSilentRevisionAdopt = (() => {
  const begin = appSrc.indexOf("// PILOT-09C/FIX-CODEX-04A（R04-01）：**只有通过业务错误码");
  const end = appSrc.indexOf("showMessage(failureNotice", begin);
  if (begin < 0 || end < 0) return false;
  const catchBody = appSrc.slice(begin, end);
  return !/state\.formalInterviewRevision = error\.payload\.task\.draftRevision/.test(catchBody)
    && !/state\.formalInterviewRevision = error\.payload\.task\?\.draftRevision/.test(catchBody);
})();
check("B1", "旧宽泛判据 `409 && payload.receipt` 已不存在", noBroadReceiptGate, "");
check("B2", "等待态分支由 confirmedVerifierNotReadyPayload 门控", waitingGatedByValidator, "");
check("B3", "等待态只采用校验后的 task.draftRevision，并进入 waiting", waitingSyncsValidatedRevision && waitingSetsWaitingStep, "");
check("B4", "真实冲突置冲突闩锁并给出显式冲突提示", conflictSetsLatch, "");
check("B5", "冲突分支不再静默采用服务端 revision", noSilentRevisionAdopt, "");

console.log("\n── C. 源码卫生 ──");
check("C1", "app.js 源码无测试 hook（P9C_HOOK_URL 只允许出现在临时副本）", !appSrc.includes("P9C_HOOK_URL"), "");
check("C2", "app.js 仍保留 receipt 使用（未以删除回执功能换取通过）",
  /state\.formalEmployeeReceipt = waitingPayload\.receipt/.test(appSrc) && /formalEmployeeReceipt = result\.receipt/.test(appSrc), "");

const failed = results.filter((entry) => entry.verdict === "FAIL");
console.log("\n──────────────── 结果明细 ────────────────");
for (const entry of results) {
  console.log(`  ${entry.verdict === "PASS" ? "✔" : "✘"} [${entry.verdict}] ${entry.id} · ${entry.name}${entry.note ? "\n        " + entry.note : ""}`);
}
console.log("\n──────────────── 汇总 ────────────────");
console.log(`  PASS=${results.length - failed.length}  FAIL=${failed.length}`);
if (failed.length) {
  console.error(`\n  R04-01 修复套件失败 ${failed.length} 项：${failed.map((entry) => entry.id).join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("  pilot09c fix-codex-04a r0401 runtime: ok");
}
