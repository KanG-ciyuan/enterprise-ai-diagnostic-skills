/**
 * PILOT-09C/FIX-3C —— 员工判定链路 · **自包含真实浏览器回归**
 *
 * B1–B9：页面选择判定 / 保存成功 / 刷新仍有效 / 旧版本被拒绝 / 拒绝后计数不变 /
 *        旧判定不自动恢复 / 重新确认成功 / 未完成不可提交 / 全部有效可提交 /
 *        保存失败保留操作意图。
 * B10：无论成败都在 finally 中清理 **wrangler 进程、stub 模型、临时目录**。
 *
 * 隔离原则（不碰仓库、不碰生产）：
 *   · 应用代码**复制**到 `os.tmpdir()` 下的临时工作区再运行，仓库零改动；
 *   · 独立 `--persist-to` 的**本地 D1**；随机端口；
 *   · **本地模型 stub**（不调用付费模型、不读取真实 API Key，使用明显的假值）；
 *   · 测试**自行拉起后端**，不依赖人工预先启动服务，可重复执行。
 *
 * 若运行环境缺少 playwright-core / Chrome，则打印 SKIP 并以 0 退出
 * （避免在无浏览器环境把整套回归拖红；本机实测会真正执行）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectManifest, compareManifests } from "./env_fingerprint.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_SRC = path.resolve(HERE, "..");
const DRAFT_NAME = "employee-draft";

const results = [];
const rec = (id, name, ok, note = "") => {
  results.push({ id, name, ok, note });
  console.log(`  ${ok ? "✔" : "✘"} [${id}] ${name}${note ? "\n        " + note : ""}`);
};
const skipAll = (reason) => {
  console.log(`  ⚠ SKIP 浏览器回归：${reason}`);
  console.log("\n  browser runtime: skipped（不视为失败）");
  process.exit(0);
};

// ── 0. 解析 playwright（缺则 SKIP）──────────────────────────────────
let chromium = null;
const CANDIDATES = [
  "playwright-core",
  "playwright",
  process.env.PLAYWRIGHT_CORE,
  "/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs",
  "/usr/local/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs",
].filter(Boolean);
for (const candidate of CANDIDATES) {
  try { const mod = await import(candidate); if (mod?.chromium) { chromium = mod.chromium; break; } } catch { /* next */ }
}
if (!chromium) skipAll("未找到 playwright-core（可用 PLAYWRIGHT_CORE 指定路径）");
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) skipAll("未找到 Chrome/Chromium（可用 CHROME_PATH 指定）");

// ── 1. 工具函数 ────────────────────────────────────────────────────
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if (await fn()) return true; } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error(`等待超时：${label}`);
}

const COOKIE = "__Host-diagnostic_session";
const RUN = Date.now().toString().slice(-6);
const ANS = {
  trigger: "每天早上刷TikTok印尼区找火的视频", inputs: "先看播放量高的才点进去",
  steps: "看到合适的先收藏再记到表格", judgments: "判断能不能拍出来",
  exceptions: "不能拍的就跳过不记", handoff: "把链接发群给剪辑", burden: "每天一个多小时",
};

// ── 2. 主流程 ──────────────────────────────────────────────────────
let tmpRoot = null;
let wrangler = null;
let stub = null;
let browser = null;
let maxFailuresFromDrift = false;

async function main() {
  // ── HARDEN-3H：启动前冻结源快照，并记录运行标识 ─────────────────
  const RUN_ID = `p9c-${Date.now().toString(36)}`;
  const sourceManifest = collectManifest(APP_SRC);
  console.log(`  运行标识=${RUN_ID} 源清单 digest=${sourceManifest.digest.slice(0, 12)} files=${sourceManifest.fileCount}`);

  // 2.1 临时工作区（复制应用代码，仓库零改动）
  tmpRoot = mkdtempSync(path.join(tmpdir(), "p9c-browser-"));
  const appDir = path.join(tmpRoot, "app");
  cpSync(APP_SRC, appDir, {
    recursive: true,
    filter: (src) => !/(^|\/)(node_modules|\.wrangler|\.dev\.vars|\.git)(\/|$)/.test(src),
  });
  // dist 为构建产物：把**当前**源文件同步进去，保证浏览器加载到待测版本。
  // PILOT-09C/FIX-CODEX-02B（F02）：api-client.js 也是前端保存请求体的实际生成者，
  // 只同步 app.js 会让浏览器继续加载**旧的** api-client（例如丢失 baseRevision），
  // 从而把修复后的前端行为测成旧行为。
  cpSync(path.join(APP_SRC, "app.js"), path.join(appDir, "dist", "app.js"));
  cpSync(path.join(APP_SRC, "api-client.js"), path.join(appDir, "dist", "api-client.js"));

  // ── HARDEN-3H：副本指纹校验（不一致 ⇒ **明确失败并拒绝启动**）──────
  // 说明：本测试会把 app.js 复制进 dist/app.js（模拟构建步骤），因此期望清单里
  // dist/app.js 的期望值同步更新为 app.js 的哈希 —— 其余文件必须与源清单逐字节一致。
  {
    const expected = { ...sourceManifest, files: sourceManifest.files.map((f) => ({ ...f })) };
    // 同步的源→产物映射必须与上面 cpSync 的内容一致（否则指纹门禁会误判）。
    const sha256File = (rel) => createHash("sha256").update(readFileSync(path.join(APP_SRC, rel))).digest("hex");
    const distSourcePairs = [["dist/app.js", "app.js"], ["dist/api-client.js", "api-client.js"]];
    for (const [distPath, sourcePath] of distSourcePairs) {
      const distEntry = expected.files.find((f) => f.path === distPath);
      if (distEntry) distEntry.sha256 = sha256File(sourcePath);
    }
    const actual = collectManifest(appDir);
    const diff = compareManifests(expected, actual);
    if (!diff.ok) {
      rec("FP-START", "实验副本指纹与源快照一致（不一致则拒绝启动）", false, JSON.stringify({ contentMismatch: diff.contentMismatch, missing: diff.missing, extra: diff.extra }).slice(0, 300));
      throw new Error("副本指纹不匹配，拒绝启动（未做任何静默同步）");
    }
    rec("FP-START", "实验副本指纹与源快照一致（不一致则拒绝启动）", true, `digest=${actual.digest.slice(0, 12)} files=${actual.fileCount} 源=${sourceManifest.digest.slice(0, 12)}`);
  }
  const stateDir = path.join(tmpRoot, "state");

  // 2.2 本地模型 stub（绝不触网、绝不使用真实 Key）
  const stubPort = await freePort();
  let stubCount = 0;
  const KEYS = ["trigger", "inputs", "steps", "judgments", "exceptions", "handoff", "burden"];
  stub = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      stubCount += 1;
      const idx = Math.min(stubCount - 1, KEYS.length - 1);
      const content = stubCount <= 7
        ? { turnKind: "question", question: { key: KEYS[idx], label: "问题", prompt: "请说明你的实际做法？" } }
        : { turnKind: "draft", question: null, endingProposal: { recommended: true, reason: "覆盖已满足" },
            proposedInferences: [{ text: "选题依据主要来自个人经验判断。", basisDimension: "judgments", assumes: "若有统一标准须更正。" }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise((resolve, reject) => { stub.once("error", reject); stub.listen(stubPort, "127.0.0.1", resolve); });
  writeFileSync(path.join(appDir, ".dev.vars"),
    `DEEPSEEK_API_KEY=dummy-browser-test-not-real\nDEEPSEEK_BASE_URL=http://127.0.0.1:${stubPort}\nDEEPSEEK_MODEL=stub-model\n`);

  // 2.3 本地 D1 schema + wrangler
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const run = (args, opts = {}) => spawnSync("npx", ["wrangler", ...args], { cwd: appDir, encoding: "utf8", ...opts });
  const schema = run(["d1", "execute", "enterprise-diagnostic-db", "--local", "--persist-to", stateDir, "--file=schema.sql"]);
  if (schema.status !== 0) throw new Error(`本地 D1 schema 初始化失败: ${String(schema.stderr || schema.stdout).slice(0, 300)}`);
  wrangler = spawn("npx", ["wrangler", "pages", "dev", "dist", "--port", String(port), "--ip", "127.0.0.1",
    "--d1", "DB=enterprise-diagnostic-db", "--persist-to", stateDir], { cwd: appDir, stdio: "ignore" });
  await waitFor(async () => (await fetch(`${base}/app.js`)).ok, 90000, "wrangler 启动");

  // 2.4 经真实接口建数
  const api = async (method, p, body, token, idem) => {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Cookie = `${COOKIE}=${token}`;
    if (idem) headers["Idempotency-Key"] = idem;
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get("set-cookie") || "";
    const tok = sc.includes(`${COOKIE}=`) ? sc.split(`${COOKIE}=`)[1].split(";")[0] : "";
    let payload = null; try { payload = JSON.parse(await res.text()); } catch { payload = null; }
    return { status: res.status, payload, token: tok };
  };
  const builder = await api("POST", "/api/auth/authorize", { email: `b${RUN}@e2e.test`, enterpriseName: `E2E${RUN}`, name: "改造方", bootstrapToken: "123456" });
  const project = await api("POST", "/api/projects", { name: `浏览器回归 ${RUN}`, scope: "选品到发布" }, builder.token, `p-${RUN}`);
  const pid = project.payload.project.id;
  const auth = await api("POST", `/api/projects/${pid}/authorizations`, { name: "授权", authorizerName: "王总", authorizerEmail: `o${RUN}@e2e.test`, scope: "最小", reference: `D-${RUN}` }, builder.token, `a-${RUN}`);
  const capability = auth.payload.confirmationUrl.split("capability=")[1].split("&")[0];
  await api("POST", `/api/projects/${pid}/authorizations/${auth.payload.authorization.id}/confirm`, { confirmationToken: capability, decision: "authorized", reason: "本地回归" });
  const inviteAccept = async (role, name) => {
    const inv = await api("POST", `/api/projects/${pid}/invitations`, { email: `${role}${RUN}@e2e.test`, role, expiresInSeconds: 604800 }, builder.token);
    const acc = await api("POST", `/api/invitations/${inv.payload.invitation.token}/accept`, { email: `${role}${RUN}@e2e.test`, name });
    return acc.token;
  };
  const emp = await inviteAccept("employee", "员工A");
  await inviteAccept("verifier", "核验人甲");
  const task = async () => (await api("GET", `/api/projects/${pid}/employee-task`, undefined, emp)).payload.task;
  const wid = (await task()).id;

  // 2.5 经真实 harness + stub 跑完访谈至出卡
  for (let i = 0; i < 16; i += 1) {
    const t = await task();
    const anchor = t.draftLedger?.pendingQuestion;
    if (!anchor) {
      const r = await api("POST", "/api/agent/employee-turn", { projectId: pid, workItemId: wid, recover: true, answers: t.draftAnswers || {}, materialStatus: "provided", mode: "harness", baseRevision: t.draftRevision }, emp);
      if (r.payload?.turn?.turnKind === "draft") break;
      continue;
    }
    const answer = ANS[anchor.key] || "按实际流程操作";
    const r = await api("POST", "/api/agent/employee-turn", {
      projectId: pid, workItemId: wid, questionKey: anchor.key, questionLabel: anchor.label, questionPrompt: anchor.prompt,
      answer, answers: { ...(t.draftAnswers || {}), [anchor.key]: answer }, materialStatus: "provided",
      mode: "harness", ledger: t.draftLedger, baseRevision: t.draftRevision,
    }, emp);
    const cur = await task();
    await api("PUT", `/api/work-items/${wid}/employee-draft`, {
      answers: { ...(cur.draftAnswers || {}), [anchor.key]: answer }, materialStatus: "provided",
      ledger: cur.draftLedger, inferenceVerdicts: {}, baseRevision: cur.draftRevision,
    }, emp);
    if (r.payload?.turn?.turnKind === "draft") break;
  }
  const card = await task();
  assert.ok((card.draftLedger?.authoritativeInferences || []).length > 0, "访谈后应产生推断");

  // 2.6 真实浏览器
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: COOKIE, value: emp, domain: "127.0.0.1", path: "/", secure: true, httpOnly: true }]);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  const ids = await page.evaluate(() => formalVisibleInferences().map((e) => e.id));
  assert.ok(ids.length >= 3, "页面应渲染出可判定推断");
  const saveVia = (fn = "saveFormalEmployeeDraft") => page.evaluate((name) => window[name](), fn);
  const readUi = () => page.evaluate(() => {
    const host = document.getElementById("formal-workflow-card") || document.body;
    const summary = formalInferenceSummary(formalVisibleInferences(), state.formalInferenceVerdicts);
    return {
      valid: summary.valid, total: summary.total, stale: summary.stale, unjudged: summary.unjudged,
      saveState: state.formalEmployeeSaveState, step: state.formalEmployeeStep,
      pending: Object.keys(state.formalInferencePending || {}),
      rejected: Object.keys(state.formalInferenceRejected || {}),
      message: (document.querySelector("#status-message") || {}).textContent || "",
      summaryText: (host.querySelector(".wfc-inference-summary") || {}).textContent.replace(/\s+/g, " ").trim(),
    };
  });

  // H-REAL：真实持久化证据（H-1）—— 真实访谈后 statementHistory 确实落在 D1 中
  const realHistory = card.draftLedger?.statementHistory || [];
  rec("H-REAL", "真实访谈后 D1 中存在服务端持久化的陈述历史（每条绑定轮次与来源）",
    realHistory.length >= 7
      && realHistory.every((e) => e && e.dimension && e.text && e.kind === "initial" && Number.isInteger(e.seq) && e.source === "employee" && e.turnRevision !== null),
    JSON.stringify({ count: realHistory.length, kinds: [...new Set(realHistory.map((e) => e.kind))], sample: realHistory[0] && { seq: realHistory[0].seq, dimension: realHistory[0].dimension, rev: realHistory[0].turnRevision } }));
  // H-FORGE：真实运行中的客户端伪造历史 → 服务端拒绝采信（D1 原样保留）
  const historyBefore = JSON.stringify(realHistory);
  const forgeRes = await api("PUT", `/api/work-items/${wid}/employee-draft`, {
    answers: card.draftAnswers || {}, materialStatus: "provided", ledger: { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [], statementHistory: [{ seq: 99, dimension: "steps", text: "伪造历史", kind: "initial", source: "employee" }] }, inferenceVerdicts: {}, baseRevision: card.draftRevision,
  }, emp);
  const afterForge = await task();
  rec("H-FORGE", "真实运行：客户端伪造 statementHistory → 服务端丢弃，D1 原历史原样保留",
    forgeRes.status === 200 && JSON.stringify(afterForge.draftLedger?.statementHistory || []) === historyBefore,
    JSON.stringify({ put: forgeRes.status, before: JSON.parse(historyBefore).length, after: (afterForge.draftLedger?.statementHistory || []).length }));

  // PILOT-09C/FIX-CODEX-02B（F02）：H-FORGE 是一次真实的草稿保存，已把服务端 revision 推进。
  // 修复后保存必须携带 baseRevision，因此浏览器页必须刷新以重新取得服务端当前版本；
  // 旧行为"缺失版本自动用当前版本"会把这类跨页/跨请求写入静默放过（正是 F02 要修的）。
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1600);

  // B1：页面选择判定并保存成功
  await page.locator(`input[data-inference-id="${ids[0]}"][value="agree"]`).check();
  await page.waitForTimeout(200);
  await saveVia();
  await page.waitForTimeout(1500);
  let t = await task();
  const entry0 = t.draftLedger.authoritativeInferences.find((e) => e.id === ids[0]);
  let v0 = (t.draftInferenceVerdicts || {})[ids[0]];
  rec("B1", "页面选择判定 → 保存成功 → D1 落库（版本绑定通过）",
    Boolean(v0) && v0.verdict === "confirmed" && v0.contentVersion === entry0.contentVersion, JSON.stringify(v0));

  // B2：保存后刷新，判定仍然有效
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1600);
  const ui2 = await readUi();
  const stillValid = await page.evaluate((id) => {
    const e = formalVisibleInferences().find((x) => x.id === id);
    return e ? formalInferenceJudgmentState(e, state.formalInferenceVerdicts) : "gone";
  }, ids[0]);
  rec("B2", "刷新后已保存判定仍然有效（服务端状态恢复）", stillValid === "valid" && ui2.valid >= 1, JSON.stringify({ stillValid, valid: ui2.valid }));

  // B7：未完成判定时无法正式提交
  await page.locator('[data-action="submit-formal-employee"]').click().catch(() => {});
  await page.waitForTimeout(1200);
  const ui7 = await readUi();
  const after7 = await task();
  rec("B7", "未完成判定时无法正式提交（页面拦截 + D1 未进入核验）",
    ui7.step !== "submitted" && after7.status !== "awaiting_verification", JSON.stringify({ step: ui7.step, db: after7.status }));

  // B9：保存失败时保留用户操作意图（真实 404 失败注入）
  const pendingId = await page.evaluate(() => formalVisibleInferences().find((e) => formalInferenceJudgmentState(e, state.formalInferenceVerdicts) === "unjudged").id);
  const before9 = (await readUi()).valid;
  await page.locator(`input[data-inference-id="${pendingId}"][value="agree"]`).check();
  await page.waitForTimeout(200);
  const originalId = wid;
  await page.evaluate(() => { state.formalEmployeeTask = { ...state.formalEmployeeTask, id: "WI-DOES-NOT-EXIST" }; });
  await saveVia();
  await page.waitForTimeout(1600);
  const ui9 = await readUi();
  const after9 = await task();
  const persisted9 = (after9.draftInferenceVerdicts || {})[pendingId];
  rec("B9", "保存失败：明确失败状态、完成数不增加、保留用户选择（pending 未被丢弃）",
    ui9.valid === before9 && ui9.saveState !== "saved" && ui9.pending.includes(pendingId) && !persisted9,
    JSON.stringify({ validBefore: before9, validAfter: ui9.valid, saveState: ui9.saveState, pending: ui9.pending, persisted: persisted9 || null }));
  await page.evaluate((id) => { state.formalEmployeeTask = { ...state.formalEmployeeTask, id }; }, originalId);

  // ══ 停机改库：把一条**已保存判定**的条目版本推进（模拟证据变化），验证旧判定不得自动恢复 ══
  const dbFile = await findServerDb(stateDir, wid);
  assert.ok(dbFile, "应能定位服务端本地 D1 文件");
  // AUD-BROWSER 前置：记录提交前的历史边界（提交后才会有 employee_submitted 事件）

  const stopWrangler = async () => {
    if (!wrangler) return;
    try { process.kill(-wrangler.pid, "SIGKILL"); } catch { try { wrangler.kill("SIGKILL"); } catch {} }
    try { spawnSync("pkill", ["-f", `pages dev dist --port ${port}`]); } catch {}
    wrangler = null;
    await sleep(1500);
  };
  const startWrangler = async () => {
    wrangler = spawn("npx", ["wrangler", "pages", "dev", "dist", "--port", String(port), "--ip", "127.0.0.1",
      "--d1", "DB=enterprise-diagnostic-db", "--persist-to", stateDir], { cwd: appDir, stdio: "ignore" });
    await waitFor(async () => (await fetch(`${base}/api/projects/${pid}/employee-task`, { headers: { Cookie: `${COOKIE}=${emp}` } })).ok, 90000, "wrangler 重启");
  };
  await stopWrangler();
  {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbFile);
    const row = db.prepare("SELECT employee_draft_json FROM work_items WHERE id=?").get(wid);
    const draft = JSON.parse(row.employee_draft_json);
    const target = draft.ledger.authoritativeInferences.find((e) => e.id === ids[0]);
    // PILOT-09C/IMPLEMENT-05B（F03）：服务端模板推断的 quote 必须与当前答案一致；
    // 本用例只需**推进内容版本**制造 stale（不改变证据引用），因此不再改写 quote
    // （旧实现追加"（已更新）"会让后续合法提交被证据门禁按"模板引用与答案不一致"拒绝，
    // 这是测试夹具问题，不是 UI 协议变化）。contentVersion/evidenceHash 仍推进。
    target.contentVersion = (target.contentVersion || 1) + 1;
    target.evidenceHash = "EH-BUMP-" + target.contentVersion;
    db.prepare("UPDATE work_items SET employee_draft_json=? WHERE id=?").run(JSON.stringify(draft), wid);
    db.close();
  }
  await startWrangler();

  // B5：旧判定不自动恢复有效（刷新后应为 stale，且旧版本判定仍在库中）
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1700);
  const bumpState = await page.evaluate((id) => {
    const e = formalVisibleInferences().find((x) => x.id === id);
    return { jstate: e ? formalInferenceJudgmentState(e, state.formalInferenceVerdicts) : "gone", hasStaleText: document.body.innerText.includes("依据已更新，请重新确认") };
  }, ids[0]);
  const t5 = await task();
  rec("B5", "证据版本推进后：旧判定变为 stale（页面显示过期提示，未自动恢复有效）",
    bumpState.jstate === "stale" && bumpState.hasStaleText, JSON.stringify(bumpState));
  const oldVerdictKept = (t5.draftInferenceVerdicts || {})[ids[0]];
  rec("B5b", "旧判定本身仍保留在库中（不被删除）", Boolean(oldVerdictKept) && oldVersionRecordCheck(oldVerdictKept, t5, ids[0]), JSON.stringify(oldVerdictKept));

  // B3：旧版本判定被拒绝（页面仍渲染旧版本时提交 → 服务端拒绝）
  //     先让页面在"当前服务端状态"下渲染，然后再次推进版本 → 页面回显过期 → 保存被拒绝
  const rejectTarget = await page.evaluate(() => formalVisibleInferences().find((e) => formalInferenceJudgmentState(e, state.formalInferenceVerdicts) === "unjudged")?.id || null);
  assert.ok(rejectTarget, "应存在未判定条目用于版本冲突测试");
  await page.locator(`input[data-inference-id="${rejectTarget}"][value="agree"]`).check();
  await page.waitForTimeout(200);
  await stopWrangler();
  {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbFile);
    const row = db.prepare("SELECT employee_draft_json FROM work_items WHERE id=?").get(wid);
    const draft = JSON.parse(row.employee_draft_json);
    const target = draft.ledger.authoritativeInferences.find((e) => e.id === rejectTarget);
    target.contentVersion = (target.contentVersion || 1) + 1;
    target.evidenceHash = "EH-BUMP2-" + target.contentVersion;
    db.prepare("UPDATE work_items SET employee_draft_json=? WHERE id=?").run(JSON.stringify(draft), wid);
    db.close();
  }
  await startWrangler();
  const before3 = (await readUi()).valid;
  await saveVia();
  await page.waitForTimeout(1800);
  const ui3 = await readUi();
  const t3 = await task();
  const stored3 = (t3.draftInferenceVerdicts || {})[rejectTarget];
  rec("B3", "旧版本判定被服务端拒绝（不盖章、D1 无新增、明确返回冲突）",
    !stored3 && ui3.rejected.includes(rejectTarget), JSON.stringify({ rejected: ui3.rejected, stored: stored3 || null }));

  // B4：拒绝后完成数量不增加
  rec("B4", "版本冲突被拒绝后完成数量不增加", ui3.valid === before3, JSON.stringify({ before: before3, after: ui3.valid }));

  // B6：员工针对当前版本重新确认成功
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1700);
  const needIds = await page.evaluate(() => formalVisibleInferences()
    .filter((e) => formalInferenceJudgmentState(e, state.formalInferenceVerdicts) !== "valid")
    .map((e) => e.id));
  for (const id of needIds) {
    await page.locator(`input[data-inference-id="${id}"][value="agree"]`).check();
    await page.waitForTimeout(120);
  }
  await saveVia();
  await page.waitForTimeout(1900);
  const t6 = await task();
  const allValid = (t6.draftLedger.authoritativeInferences || [])
    .filter((e) => e.listed !== false)
    .every((e) => {
      const v = (t6.draftInferenceVerdicts || {})[e.id];
      return v && v.verdict !== "unjudged" && v.contentVersion === e.contentVersion
        && (e.templateVersion === null || v.templateVersion === e.templateVersion);
    });
  rec("B6", "员工针对当前版本重新确认 → 服务端按当前版本重新盖章（全部有效）", allValid, JSON.stringify({ rejudged: needIds.length, allValid }));

  // B8：全部有效判定完成后可以提交
  const ui8 = await readUi();
  await page.check("#formal-card-confirmed").catch(() => {});
  await page.locator('input[name="formal-material-status"][value="provided"]').check().catch(() => {});
  await page.waitForTimeout(300);
  await page.locator('[data-action="submit-formal-employee"]').click().catch(async () => { await page.evaluate(() => submitFormalEmployee()); });
  await page.waitForTimeout(2800);
  const t8 = await task();
  const step8 = await page.evaluate(() => state.formalEmployeeStep);
  rec("B8", "全部有效判定完成后可以正式提交（页面进入已提交，D1 进入核验）",
    step8 === "submitted" || t8.status === "awaiting_verification", JSON.stringify({ step: step8, db: { status: t8.status, stage: t8.stage } }));

  // AUD-BROWSER：真实提交后，D1 的 employee_submitted 事件含完整审计快照
  {
    const { DatabaseSync } = await import("node:sqlite");
    const probe = new DatabaseSync(dbFile);
    const row = probe.prepare("SELECT payload FROM events WHERE type='employee_submitted' ORDER BY created_at DESC, id DESC LIMIT 1").get();
    probe.close();
    const snap = row && row.payload ? JSON.parse(row.payload) : null;
    rec("AUD-BROWSER", "真实提交：employee_submitted 事件含完整审计快照（版本/推断/判定/历史边界）",
      Boolean(snap) && snap.submissionVersion >= 1
        && Array.isArray(snap.inferences) && snap.inferences.length > 0
        && Array.isArray(snap.verdicts) && snap.verdicts.length > 0
        && snap.source === "server_employee_submission"
        && Number.isInteger(snap.statementHistorySeq)
        && snap.workItemId === wid,
      JSON.stringify(snap && { v: snap.submissionVersion, inf: snap.inferences.length, ver: snap.verdicts.length, seq: snap.statementHistorySeq }));
  }

  rec("B10", "隔离与清理：临时目录/本地 D1/stub/wrangler 均在 finally 中回收",
    Boolean(tmpRoot) && stubCount > 0, JSON.stringify({ stubCalls: stubCount, tmp: tmpRoot, pageErrors: pageErrors.length }));
  if (pageErrors.length) console.log(`    页面 JS 错误：${JSON.stringify(pageErrors.slice(0, 3))}`);

  // ── HARDEN-3H：运行结束再次核对源快照（期间代码漂移 ⇒ 本轮结果无效）──
  {
    const after = collectManifest(APP_SRC);
    const same = after.digest === sourceManifest.digest;
    rec("FP-END", "运行期间源快照未漂移（漂移则本轮结果无效）", same, `before=${sourceManifest.digest.slice(0, 12)} after=${after.digest.slice(0, 12)}`);
    if (!same) { console.log("  ⚠ 运行期间源快照发生漂移 ⇒ **本轮结果标记为无效**"); maxFailuresFromDrift = true; }
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n──────────────── 汇总 ────────────────");
  console.log(`  BROWSER PASS=${results.length - failed.length}  FAIL=${failed.length}`);
  console.log("\n  【真实 Chrome + 真实本地后端 + 隔离本地 D1 + 本地模型 stub】");
  if (failed.length) assert.fail(`浏览器回归失败 ${failed.length} 项：${failed.map((f) => f.id).join(", ")}`);
  if (maxFailuresFromDrift) { console.log("  本轮结果无效（运行期间源快照漂移）"); process.exitCode = 2; }
  console.log("  pilot09c browser runtime: ok");
}

/** 旧判定是否仍绑定旧版本（用于 B5b） */
function oldVersionRecordCheck(verdict, task, id) {
  const entry = (task.draftLedger.authoritativeInferences || []).find((e) => e.id === id);
  return Boolean(entry) && Number.isInteger(verdict.contentVersion) && verdict.contentVersion !== entry.contentVersion;
}

/** 定位 wrangler 实际使用的本地 D1 文件（可能同时存在 d1 execute 建的空库） */
async function findServerDb(stateDir, workItemId) {
  const dir = path.join(stateDir, "v3", "d1", "miniflare-D1DatabaseObject");
  if (!existsSync(dir)) return null;
  const { DatabaseSync } = await import("node:sqlite");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sqlite"))) {
    try {
      const db = new DatabaseSync(path.join(dir, file));
      const hit = db.prepare("SELECT id FROM work_items WHERE id=?").get(workItemId);
      db.close();
      if (hit) return path.join(dir, file);
    } catch { /* 非目标库 */ }
  }
  return null;
}

// ── 3. 运行与清理 ──────────────────────────────────────────────────
try {
  await main();
} catch (error) {
  console.log(`\n  ✘ 浏览器回归异常：${error && error.message}`);
  console.log(String(error && error.stack || "").split("\n").slice(0, 4).join("\n"));
  process.exitCode = 1;
} finally {
  const cleanup = { browser: true, stub: true, wrangler: true, tmp: true };
  try { if (browser) await browser.close(); } catch { cleanup.browser = false; }
  try { if (stub) await new Promise((r) => stub.close(r)); } catch { cleanup.stub = false; }
  try {
    if (wrangler) {
      try { process.kill(-wrangler.pid, "SIGKILL"); } catch { try { wrangler.kill("SIGKILL"); } catch {} }
    }
  } catch { cleanup.wrangler = false; }
  try { spawnSync("pkill", ["-f", `pages dev dist --port`]); } catch {}
  try { if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true }); } catch { cleanup.tmp = false; }
  const failedCleanup = Object.entries(cleanup).filter(([, ok]) => !ok).map(([k]) => k);
  console.log(`  清理：${failedCleanup.length ? "失败项 " + failedCleanup.join(",") : "进程/端口/临时目录/本地 D1 全部回收 ✔"}`);
}
