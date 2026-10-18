/**
 * PILOT-04C —— employee-turn 并发与最终冲突裁决核验
 *
 * 目的：证明 employee-turn 是否写库、并发下谁做最终裁决、是否会静默覆盖。
 *
 * 方法（非顺序请求冒充并发）：
 *   1. 初始 revision = 3。
 *   2. 两个请求都带 baseRevision = 3。
 *   3. 用**真实模型路径**（harness 模式 + 假 fetch）在模型调用处设置**屏障**：
 *      两个请求都到达模型调用点后，才同时释放。
 *      → 保证「两个请求都通过前置检查、都进入模型执行阶段」。
 *   4. 记录 HTTP 状态、模型调用次数、DB revision、最终回答、是否覆盖。
 *   5. 再复刻前端自动保存序列（两台标签页各自 PUT 草稿），验证最终裁决点。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";
import { onRequestPost as agentTurn } from "../functions/api/agent/employee-turn.js";
import { onRequestPut as saveDraft } from "../functions/api/work-items/[itemId]/employee-draft.js";
import { draftRevisionOf, normalizeEmployeeDraft, serializeEmployeeDraft, casWriteEmployeeDraft } from "../functions/_shared.js";

const results = [];
const pass = (id, name, note = "") => results.push({ id, name, verdict: "PASS", note });
const fail = (id, name, note = "") => results.push({ id, name, verdict: "FAIL", note });

const P = "PRJ-P04C000001";
const ITEM = "WI-P04C0001";
const EMP = "ACC-P04C-EMP";
const VER = "ACC-P04C-VER";
const TOK_A = "TOK-P04C-A";
const TOK_B = "TOK-P04C-B";
const KEY = "fake-deepseek-key-not-real";   // 仅用于走 harness 分支，不触达网络

function fixture(initialRevision = 3) {
  const db = new D1Harness();
  const draft = serializeEmployeeDraft({
    answers: { trigger: "初始回答" }, ledger: null, inferenceVerdicts: {}, submissionText: "", revision: initialRevision,
  });
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('${EMP}','emp@v01c.invalid','小李','active','member'),
      ('${VER}','ver@v01c.invalid','核验人','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage) VALUES
      ('${P}','短视频带货流程诊断','选品到发布与复盘','mapping','active','unknown','external_builder','${EMP}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES
      ('${P}','${EMP}','employee','project','active'),
      ('${P}','${VER}','verifier','project','active');
    -- 必需：requireAuthorizedProject 要求企业具名授权已确认，否则 409 enterprise_authorization_required
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES
      ('AUTH-P04C','${P}','授权','王总','o@v01c.invalid','只读','DOC','authorized','${EMP}','k','n','h','2099-01-01T00:00:00Z');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,employee_draft_json,material_status) VALUES
      ('${ITEM}','${P}','还原工作','描述','mapping','needs_input','employee','小李',0,'等待','开始','${EMP}','${draft.replace(/'/g, "''")}','provided');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('${TOK_A}','${EMP}','${P}','2099-01-01T00:00:00Z','RA'),
      ('${TOK_B}','${EMP}','${P}','2099-01-01T00:00:00Z','RB');
  `);
  return db;
}

const dbRevision = (db) => draftRevisionOf(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
const dbAnswers = (db) => normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json)).answers;

/**
 * 假 DeepSeek：计数 + **会合屏障**。
 *
 * 屏障语义：只有明确启用 barrier 时，第 1 个到达者才阻塞等待第 2 个到达者；
 * 两个都到齐后一起释放 —— 这保证「两个请求都已通过前置检查、都已进入模型执行阶段」
 * 才继续，而不是用顺序请求冒充并发。
 * 未启用 barrier 时（单请求场景）不阻塞，避免误触发 20s 模型超时。
 */
function installFakeModel({ barrier = false } = {}) {
  const original = globalThis.fetch;
  const state = { calls: 0, arrivals: 0, release: null, released: false, prompts: [], maxConcurrentArrivals: 0 };
  const gate = new Promise((resolve) => { state.release = resolve; });
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("api.deepseek.com")) return original(url, init);
    state.calls += 1;
    state.prompts.push(JSON.parse(init.body).messages[0].content);
    state.arrivals += 1;
    state.maxConcurrentArrivals = Math.max(state.maxConcurrentArrivals, state.arrivals);
    if (barrier) {
      if (state.arrivals >= 2 && !state.released) { state.released = true; state.release(); }
      await gate;                                 // ← 会合点
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ turnKind: "question", question: { key: "inputs", label: "先看什么", prompt: "你开始前会看哪些信息？", isFollowup: false } }) } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { state, restore: () => { globalThis.fetch = original; } };
}

const turn = (db, token, body) =>
  // PILOT-09C/FIX-CODEX-02A（F01）：正式执行模式由服务端决定；本套件使用确定性 fixture
  // 测试档，必须由服务端环境显式开启（FORMAL_AGENT_TEST_MODE=1），客户端请求本身不足以切换。
  agentTurn({ request: bearerRequest("http://127.0.0.1/api/agent/employee-turn", token, body), env: { DB: db, DEEPSEEK_API_KEY: KEY, FORMAL_AGENT_TEST_MODE: "1" }, params: {} });
const put = (db, token, body) =>
  saveDraft({ request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, token, body), env: { DB: db }, params: { itemId: ITEM } });

console.log("PILOT-04C employee-turn 并发核验\n");

// ═══ 1. employee-turn 是否写库 ═══
console.log("── 1. employee-turn 的真实数据流 ──");
{
  // PILOT-08C/R5：以**运行时数据库前后状态对比**为主，静态检查仅作辅助。
  // 旧断言 `writesAnchor && !writesFacts` 只是正则匹配，无法证明写入边界；
  // 现在在真实轮次前后对**全部业务表**做快照对比，逐表证明"只有锚点变了"。
  const WATCH_TABLES = ["candidate_facts", "fact_judgments", "fact_second_confirmations", "decision_packets", "owner_decisions", "evidence_materials", "evidence_supplements", "enterprise_authorizations", "invitations", "project_memberships", "accounts", "projects", "events"];
  const db0 = fixture(3);
  const anchor0 = await issueServerAnchor(db0, TOK_A);
  const snapshot = (db) => {
    const out = {};
    for (const t of WATCH_TABLES) out[t] = db.count(t);
    out.__item = JSON.stringify(db.get("SELECT stage,status,assigned_verifier_id,submission_version,handoff_status,evidence_json,alternative_explanations_json,workflow_card_json,material_status,employee_draft_json FROM work_items WHERE id=?", ITEM));
    out.__maxEventId = db.get("SELECT COALESCE(MAX(id),0) AS m FROM events WHERE work_item_id = ?", ITEM).m;
    return out;
  };
  const beforeSnap = snapshot(db0);
  const revBefore = dbRevision(db0);
  const fake0 = installFakeModel({ barrier: false });
  try {
    await turn(db0, TOK_A, { projectId: P, workItemId: ITEM, questionKey: anchor0.key, answer: "A", answers: { [anchor0.key]: "A" }, mode: "harness", baseRevision: anchor0.revision });
  } finally { fake0.restore(); }
  const afterSnap = snapshot(db0);
  const revAfter = dbRevision(db0);
  const changedTables = WATCH_TABLES.filter((t) => beforeSnap[t] !== afterSnap[t]);
  const bItem = JSON.parse(beforeSnap.__item); const aItem = JSON.parse(afterSnap.__item);
  const changedFields = Object.keys(aItem).filter((k) => JSON.stringify(aItem[k]) !== JSON.stringify(bItem[k]));
  const forbidden = changedFields.filter((k) => k !== "employee_draft_json");
  // PILOT-09A-FIX/F1：本轮新增"模型调用计量"写入 → events 表会出现 model_call_* 行。
  // 这不是业务写入（不影响阶段/事实/权限），因此这里**收紧而非放宽**断言：
  //   · 业务表（除 events 外）行数必须**零变化**；
  //   · events 新行必须**全部**是 model_call_* 计量事件（不允许出现任何其他类型）。
  const businessChanged = changedTables.filter((t) => t !== "events");
  // 只看**本轮新增**的 events 行（按 id 大于快照时的最大 id），
  // 避免把此前签发锚点留下的 employee_draft_saved 审计事件算进来。
  const newEventTypes = db0.all(
    "SELECT type FROM events WHERE work_item_id = ? AND id > ? AND type NOT IN ('model_call_reserved','model_call_started','model_call_succeeded','model_call_failed','model_call_timed_out')",
    ITEM,
    Number(beforeSnap.__maxEventId || 0),
  ).map((r) => r.type);
  const onlyMeteringEvents = newEventTypes.length === 0;
  if (businessChanged.length === 0 && onlyMeteringEvents && forbidden.length === 0 && revAfter === revBefore + 1) {
    pass("数据流", "运行时前后对比：业务表零变化；events 仅新增 model_call_* 计量行；work_items 仅 employee_draft_json 变动（revision +1）", `rev=${revBefore}→${revAfter} events:+${afterSnap.events - beforeSnap.events}`);
  } else {
    fail("数据流", "employee-turn 写入了锚点之外的内容", `businessTables=${JSON.stringify(businessChanged)} nonMeteringEvents=${JSON.stringify(newEventTypes)} fields=${JSON.stringify(forbidden)} rev=${revBefore}→${revAfter}`);
  }
  db0.close();

  // 辅助静态检查（不作唯一证据）
  const src0 = readFileSync(new URL("../functions/api/agent/employee-turn.js", import.meta.url), "utf8");
  const noFactWrite = !/candidate_facts|fact_judgments|fact_second_confirmations/.test(src0);
  if (noFactWrite) pass("数据流·静态", "辅助静态检查：源码中无事实表/核验表写入语句");
  else fail("数据流·静态", "源码出现事实或核验表写入");

  // 行为侧确认：轮次请求不改动员工答案，只推进服务端锚点
  const db = fixture(3);
  const anchor = await issueServerAnchor(db, TOK_A);
  const before = normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
  const fake = installFakeModel({ barrier: false });
  let r;
  try {
    r = await turn(db, TOK_A, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: "A", answers: { [anchor.key]: "A" }, mode: "harness", baseRevision: anchor.revision });
    assert.equal(r.status, 200, "单请求应 200");
  } finally { fake.restore(); }
  const finalDraft = normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
  // PILOT-09C/IMPLEMENT-05B（F03-2）：契约升级 —— turn 成功即**原子落库本轮答案 + 历史 + 推断 + 锚点**
  // （旧断言"答案不被改动"对应的是已被修复的证据分裂缺陷）。断言改为验证新契约的**更强**
  // 不变量：本轮答案与陈述历史最新版本一致、既有答案不丢、锚点由服务端推进。
  const history = finalDraft.ledger?.statementHistory || [];
  const latestForAnswered = history.filter((entry) => entry.dimension === anchor.key).slice(-1)[0] || null;
  // 被回答的维度按新契约会被本轮答案覆盖（服务端只改这一维）；其余已保存答案必须原样保留。
  const previousAnswersKept = Object.entries(before.answers).filter(([key]) => key !== anchor.key).every(([key, value]) => finalDraft.answers[key] === value);
  const answerPersisted = finalDraft.answers[anchor.key] === "A";
  const historyConsistent = Boolean(latestForAnswered) && latestForAnswered.kind !== "withdrawn" && latestForAnswered.text === "A";
  const anchorAdvanced = finalDraft.ledger?.pendingQuestion?.key !== before.ledger?.pendingQuestion?.key;
  if (answerPersisted && historyConsistent && previousAnswersKept && anchorAdvanced) {
    pass("数据流", "行为确认：轮次请求原子落库本轮答案（answers 与 statementHistory 最新一致），既有答案不丢，锚点由服务端推进", `锚点 ${before.ledger?.pendingQuestion?.key} → ${finalDraft.ledger?.pendingQuestion?.key}，history=${history.length}`);
  } else {
    fail("数据流", "轮次请求未按新契约原子落库答案/历史或破坏了锚点", `answerPersisted=${answerPersisted} historyConsistent=${historyConsistent} previousAnswersKept=${previousAnswersKept} anchorAdvanced=${anchorAdvanced}`);
  }
  db.close();
}

// ═══ 2. 锚点不可跨 revision 复用（原并发屏障场景的安全化改写）═══
console.log("── 2. 锚点不可跨 revision 复用 ──");
{
  // PILOT-08A 后的真实语义：服务端每签发一问都推进 revision。同一锚点不能被
  // 两个不同 revision 的请求复用；陈旧 revision 在模型调用之前即被拒绝。
  const db = fixture(3);
  const anchor = await issueServerAnchor(db, TOK_A);
  const fake = installFakeModel({ barrier: false });
  let first; let second;
  try {
    first = await turn(db, TOK_A, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: "员工回答 A", answers: { [anchor.key]: "员工回答 A" }, mode: "harness", baseRevision: anchor.revision });
    second = await turn(db, TOK_B, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: "员工回答 B", answers: { [anchor.key]: "员工回答 B" }, mode: "harness", baseRevision: Math.max(0, anchor.revision - 2) });
  } finally { fake.restore(); }
  const secondBody = await second.clone().json().catch(() => ({}));
  console.log(`    ① 有效 revision → ${first.status} | ② 陈旧 revision 复用同一锚点 → ${second.status} (${secondBody.code || "-"})`);
  console.log(`    模型调用次数: ${fake.state.arrivals}`);
  if (first.status === 200 && second.status === 409 && secondBody.code === "stale_turn" && fake.state.arrivals === 1) {
    pass("并发", "同一锚点不可跨 revision 复用：仅有效 revision 触发 1 次模型调用", `arrivals=${fake.state.arrivals}`);
  } else {
    fail("并发", "锚点复用未被阻止", `first=${first.status} second=${second.status} code=${secondBody.code} arrivals=${fake.state.arrivals}`);
  }
  // PILOT-08C/R4：恢复**真实条件判断**。
  // 旧版本是无条件 pass —— 无论实际调用几次都会通过，丧失区分能力。
  // 现在读取实际观测值再判定，并明确区分 0 / 1 / 2 次。
  const repeatArrivals = Number(fake.state.arrivals);
  if (repeatArrivals === 1) {
    pass("重复计费", "陈旧 revision 在模型调用前被拒绝：本轮实际模型调用 1 次", `arrivals=${repeatArrivals}`);
  } else if (repeatArrivals === 0) {
    fail("重复计费", "没有任何模型调用（有效 revision 的那次也未进入模型）", `arrivals=${repeatArrivals}`);
  } else {
    fail("重复计费", "同一锚点被重复用于多次模型调用（重复计费风险仍在）", `arrivals=${repeatArrivals}`);
  }
  db.close();
}

console.log("── 3. 最终冲突裁决：自动保存的 CAS ──");
{
  // 场景：两个标签页都基于 revision=3 各自保存自己的回答
  const db = fixture(3);
  const [sa, sb] = await Promise.all([
    put(db, TOK_A, { answers: { trigger: "员工回答 A" }, materialStatus: "provided", baseRevision: 3 }),
    put(db, TOK_B, { answers: { trigger: "员工回答 B" }, materialStatus: "provided", baseRevision: 3 }),
  ]);
  const st = [sa.status, sb.status].sort();
  const winner = sa.status === 200 ? "A" : "B";
  const loser = sa.status === 409 ? sa : sb;
  const loserBody = await loser.clone().json().catch(() => ({}));
  const finalAnswers = dbAnswers(db);
  const finalRev = dbRevision(db);

  console.log(`    保存 A / B 状态: ${sa.status} / ${sb.status}`);
  console.log(`    最终 revision: ${finalRev} · 最终回答: ${JSON.stringify(finalAnswers.trigger)}`);
  console.log(`    冲突方 code=${loserBody.code} currentRevision=${loserBody.currentRevision}`);

  if (st[0] === 200 && st[1] === 409) {
    pass("裁决", "恰好一个保存成功、一个 409，**最终裁决由 employee-draft 的原子 CAS 完成**");
  } else {
    fail("裁决", "保存未被正确串行化", `statuses=${sa.status}/${sb.status}`);
  }
  if (loserBody.code === "draft_conflict" && loserBody.currentRevision === 4) {
    pass("裁决", "冲突返回明确错误 draft_conflict 且带 currentRevision（客户端可刷新/恢复）");
  } else {
    fail("裁决", "冲突响应不明确", JSON.stringify(loserBody));
  }
  const expectedLoser = winner === "A" ? "员工回答 B" : "员工回答 A";
  const silentOverwrite = finalAnswers.trigger === expectedLoser;
  if (!silentOverwrite && finalRev === 4) {
    pass("无静默覆盖", `DB 保留成功方完整状态（trigger=${finalAnswers.trigger}），失败方回答**未被部分写入**`);
  } else {
    fail("无静默覆盖", "发生覆盖或状态不完整", JSON.stringify(finalAnswers));
  }
  db.close();
}

// ═══ 4. 响应顺序 A→B 与 B→A ═══
console.log("── 4. 两种响应顺序 ──");
for (const order of ["A→B", "B→A"]) {
  const db = fixture(3);
  const first = order === "A→B" ? TOK_A : TOK_B;
  const second = order === "A→B" ? TOK_B : TOK_A;
  const firstBody = { answers: { trigger: `先到方回答(${order})` }, materialStatus: "provided", baseRevision: 3 };
  const secondBody = { answers: { trigger: `后到方回答(${order})` }, materialStatus: "provided", baseRevision: 3 };
  // 严格串行：先执行完第一次保存，再发第二次（模拟响应顺序）
  const r1 = await put(db, first, firstBody);
  const r2 = await put(db, second, secondBody);
  const finalAnswers = dbAnswers(db);
  const ok = r1.status === 200 && r2.status === 409 && finalAnswers.trigger === firstBody.answers.trigger;
  if (ok) pass(`顺序 ${order}`, `先到 200、后到 409，DB 保留先到方回答`, `trigger=${finalAnswers.trigger}`);
  else fail(`顺序 ${order}`, "顺序语义不正确", `${r1.status}/${r2.status} trigger=${finalAnswers.trigger}`);
  db.close();
}

// ═══ 5. 旧版本保存返回 409 ═══
console.log("── 5. 旧版本保存 ──");
{
  const db = fixture(3);
  const ok = await put(db, TOK_A, { answers: { trigger: "v1" }, materialStatus: "provided", baseRevision: 3 });
  const stale = await put(db, TOK_B, { answers: { trigger: "迟到的旧版本" }, materialStatus: "provided", baseRevision: 3 });
  const finalAnswers = dbAnswers(db);
  if (ok.status === 200 && stale.status === 409 && finalAnswers.trigger === "v1") {
    pass("旧版本", "旧 baseRevision 保存返回 409，已保存状态未被覆盖", `revision=${dbRevision(db)}`);
  } else {
    fail("旧版本", "旧版本被接受", `${ok.status}/${stale.status} trigger=${finalAnswers.trigger}`);
  }
  db.close();
}

// ═══ 6. employee-turn 陈旧 baseRevision ═══
console.log("── 6. employee-turn 前置检查拒绝陈旧上下文 ──");
{
  const db = fixture(3);
  const anchor = await issueServerAnchor(db, TOK_A);
  const stale = await turn(db, TOK_A, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: "x", answers: {}, mode: "fixture", baseRevision: Math.max(0, anchor.revision - 2) });
  const fresh = await turn(db, TOK_A, { projectId: P, workItemId: ITEM, questionKey: anchor.key, answer: "x", answers: {}, mode: "fixture", baseRevision: anchor.revision });
  const staleBody = await stale.json().catch(() => ({}));
  if (stale.status === 409 && staleBody.code === "stale_turn" && fresh.status === 200) {
    pass("前置检查", "baseRevision < 库中 revision → 409 stale_turn；相等 → 200");
  } else {
    fail("前置检查", "前置检查行为异常", `${stale.status}/${fresh.status}`);
  }
  db.close();
}

// ═══ 7. 前端冲突提示与"已保存"语义 ═══
console.log("── 7. 前端冲突提示与保存状态 ──");
{
  const appSrc = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const handlesConflict = appSrc.includes('error.code === "draft_conflict"') && appSrc.includes('state.formalEmployeeSaveState = "conflict"');
  const showsPrompt = appSrc.includes("已在别处更新") && appSrc.includes("请刷新");
  const savedOnlyOnSuccess = /state\.formalEmployeeSaveState = "saved";/.test(appSrc);
  // 自动保存在 turn **之后**、且使用当前 baseRevision。
  // 注意：persistFormalEmployeeDraftNow() 在文件中出现两次（手动保存 + 自动保存），
  // 因此必须在 continueFormalEmployeeAgent 函数体内比较，不能全局 indexOf。
  const fnStart = appSrc.indexOf("async function continueFormalEmployeeAgent");
  const fnEnd = appSrc.indexOf("async function persistFormalEmployeeDraftNow");
  const fnBody = appSrc.slice(fnStart, fnEnd);
  const turnAt = fnBody.indexOf("await window.diagnosticApi.agentTurn");
  const autoSaveAt = fnBody.lastIndexOf("await persistFormalEmployeeDraftNow();");
  const autoSaveAfterTurn = turnAt >= 0 && autoSaveAt > turnAt;
  const sendsBaseRevision = appSrc.includes("baseRevision: Number.isInteger(state.formalInterviewRevision)");
  if (handlesConflict && showsPrompt && savedOnlyOnSuccess && autoSaveAfterTurn && sendsBaseRevision) {
    pass("前端", "冲突有明确提示；仅成功置 saved；自动保存携带 baseRevision 且在轮次之后");
  } else {
    fail("前端", "前端语义不满足", JSON.stringify({ handlesConflict, showsPrompt, savedOnlyOnSuccess, autoSaveAfterTurn, sendsBaseRevision }));
  }
  // 单飞护栏仍在（防止同一标签页重复发轮次）
  const singleFlight = appSrc.includes("if (state.formalAgentThinking) return;") && appSrc.includes('state.formalAgentThinking || state.formalEmployeeSaving ? "disabled"');
  if (singleFlight) pass("前端", "单标签页单飞护栏仍在（formAgentThinking + 按钮 disabled 绑定真实字段）");
  else fail("前端", "单飞护栏缺失");
}

// ═══ 8. CAS 原子性直接断言（复现最小单元）═══
console.log("── 8. 原子性单元断言 ──");
{
  const db = fixture(3);
  const r1 = await casWriteEmployeeDraft(db, ITEM, 3, serializeEmployeeDraft({ answers: { trigger: "X" }, revision: 4 }), "provided");
  const r2 = await casWriteEmployeeDraft(db, ITEM, 3, serializeEmployeeDraft({ answers: { trigger: "Y" }, revision: 4 }), "provided");
  if (r1.ok === true && r2.ok === false && r2.currentRevision === 4 && dbRevision(db) === 4) {
    pass("原子性", "同一 expectedRevision 的两次 CAS：恰一次成功，第二次被拒（changes=0）");
  } else {
    fail("原子性", "CAS 非原子", JSON.stringify({ r1, r2, rev: dbRevision(db) }));
  }
  db.close();
}

/**
 * PILOT-08A：安全边界变更 —— 回答必须绑定"服务端签发"的问题锚点。
 * 旧测试假设服务端会接受任意合法维度（无锚点引导轮）；该路径已被安全修复关闭。
 * 此处按线上真实流程取得锚点：服务端恢复签发 → 客户端保存 → 再作答。
 */
async function issueServerAnchor(db, token) {
  const revision = () => draftRevisionOf(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
  const rec = await agentTurn({
    request: bearerRequest("http://127.0.0.1/api/agent/employee-turn", token, {
      projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "fixture", baseRevision: revision(),
    }),
    env: { DB: db, DEEPSEEK_API_KEY: KEY }, params: {},
  });
  const body = await rec.clone().json();
  const key = body?.turn?.nextQuestion?.key ?? null;
  if (key) {
    await saveDraft({
      request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, token, {
        answers: {}, materialStatus: "provided", baseRevision: revision(),
      }),
      env: { DB: db }, params: { itemId: ITEM },
    });
  }
  const stored = normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
  return { key: stored.ledger?.pendingQuestion?.key ?? null, revision: revision(), status: rec.status };
}

const count = (v) => results.filter((r) => r.verdict === v).length;
console.log("\n──────────────── 结果明细 ────────────────");
for (const r of results) {
  const icon = r.verdict === "PASS" ? "✔" : "✘";
  console.log(`  ${icon} [${r.verdict}] ${r.id} · ${r.name}${r.note ? `\n        ${r.note}` : ""}`);
}
console.log("\n──────────────── 汇总 ────────────────");
console.log(`  PASS=${count("PASS")}  FAIL=${count("FAIL")}`);
assert.equal(count("FAIL"), 0, "存在 FAIL 用例");
console.log("\npilot04c runtime: ok");
