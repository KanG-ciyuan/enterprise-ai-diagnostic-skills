/**
 * PILOT-09C/FIX-06A —— 历史审计完整性 + 分配并发守卫 + 旧数据来源标记 · 定向运行时套件
 *
 * H1/H2：evidenceHistory(20) / verdict.history(10) 满额追加 → 明确 409 容量错误、零副作用、旧记录保留
 * H3：容量拒绝时 answers/inferences/verdicts/revision 不变
 * H4：未满额合法追加正常
 * C：提交 batch 前并发修改 assigned_verifier_id → 提交 409、不覆盖分配、无 facts/events
 * L1：旧草稿无访谈 → 409 interview_evidence_missing
 * L2：旧草稿（有 answers+推断+旧 verdict、无 evidence/history/版本）→ 受控初始化 + 显式来源标记 + 旧判定 stale
 * L3：旧数据重新确认后提交 → 审计快照显式 evidenceSource=legacy_controlled_init；正常访谈 → interview
 * L4：客户端伪造 evidence/history/推断/verdict 版本 → 服务端重算/拒绝
 */
import { createHash } from "node:crypto";
import { normalizeEmployeeDraft, serializeEmployeeDraft } from "../functions/_shared.js";
import { onRequestPut as saveDraft } from "../functions/api/work-items/[itemId]/employee-draft.js";
import { onRequestPost as submitEmployee } from "../functions/api/work-items/[itemId]/employee-submission.js";
import { ANSWER_DIMENSIONS, canonicalJson, normalizeAnswers } from "../functions/api/agent/_evidence.js";
import { appendStatementHistory, buildInferenceRecords, buildInferences } from "../functions/api/agent/_adapter.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

const P = "PRJ-FIX06A", ITEM = "WI-FIX06A", EMP = "ACC-FIX06A-EMP", VER = "ACC-FIX06A-VER", TOK = "TOK-FIX06A";
const ANSWERS = {
  trigger: "每天早上运营同事在群里发来当天的推广需求，我看到消息后开始处理",
  inputs: "先看昨天的曝光和点击数据，再看库存数量，然后确认投放预算还剩多少",
  steps: "先选品再写脚本，然后让剪辑同事剪出来，最后在后台提交审核并发布",
  judgments: "毛利率低于一成要先找主管确认，其他价格我自己按历史数据定",
  exceptions: "版权不确定就换同款，审核被拒就先改文案再重新提交",
  handoff: "剪完的素材交给投放同事小李，由他挂车和设置出价",
  burden: "一条视频从选题到发布大约需要三个小时，一周做五条左右",
};
const NEW_EXC = "版权不确定时先冻结发布并请运营主管签字确认，再换同款素材";
const LABELS = { trigger: "从哪里开始", inputs: "先看什么", steps: "实际怎么做", judgments: "哪些情况不能自己决定", exceptions: "卡住后怎么办", handoff: "交给谁", burden: "大约多久" };
const MAT = { provided: "员工已说明有材料，等待登记", none_available: "目前没有可提供的材料", undecided: "尚未选择" };
const sha = (v) => `sha256:${createHash("sha256").update(String(v), "utf8").digest("hex")}`;
const card = (answers) => ({ ...Object.fromEntries(ANSWER_DIMENSIONS.map((k) => [k, String(answers[k] || "").trim()])), materialIndex: MAT.provided });
const text = (answers) => ANSWER_DIMENSIONS.map((k) => `${LABELS[k]}：${String(answers[k] || "").trim()}`).join("\n\n");
function baseline(answers) {
  return buildInferenceRecords([], [
    ...buildInferences({ statements: answers }, {}),
    { source: "model", text: "访谈基线推断：素材剪完交给投放同事挂车发布", basis: "handoff", assumes: "若实际不是这样需更正" },
  ]).records;
}
function seed({ answers = ANSWERS, inferences = null, revision = 0, withEvidence = true } = {}) {
  const infs = (inferences === null ? baseline(answers) : inferences).map((entry) => ({ ...entry, evidenceVersion: Number.isInteger(entry.evidenceVersion) ? entry.evidenceVersion : 0 }));
  let history = [];
  for (const dim of ANSWER_DIMENSIONS) if (answers[dim]) history = appendStatementHistory({ prior: history, dimension: dim, text: answers[dim], revision }).history;
  const dimensions = Object.fromEntries(ANSWER_DIMENSIONS.map((dim) => [dim, { digest: answers[dim] ? sha(normalizeAnswers(answers)[dim]) : null, seq: answers[dim] ? 1 : 0 }]));
  const evidence = { schemaVersion: 1, seq: 1, answersDigest: sha(canonicalJson(normalizeAnswers(answers))), dimensions, revision, source: "interview", legacyInitialized: false };
  if (withEvidence) evidence.ruleVersion = 1;
  for (const entry of infs) {
    const isTemplate = entry.source === "server_template";
    const basisDigest = entry.basis ? dimensions[entry.basis].digest : null;
    if (withEvidence) {
      // PILOT-09C/G14：为当前格式 fixture 生成服务端同构依赖元数据；旧数据用例
      // （withEvidence=false）故意保持缺失，交给服务端受控重建路径（不得一律补齐）。
      entry.dependencyRuleVersion = 1;
      entry.dependencySource = isTemplate ? "server_template_fixed" : "model_conservative_potential";
      entry.dependencyRuleStatus = isTemplate ? "server_template_fixed" : "model_conservative_potential";
      entry.evidenceRefs = isTemplate
        ? (entry.basis && basisDigest ? [{ dimension: entry.basis, digest: basisDigest, source: "server_template_fixed", ruleId: null }] : [])
        : ANSWER_DIMENSIONS.filter((dim) => dimensions[dim]?.digest)
          .map((dimension) => ({ dimension, digest: dimensions[dimension].digest, source: "model_conservative_potential", ruleId: null }));
      entry.proposedDependencyDimensions = [];
      entry.dependencyHintsRejected = [];
      entry.invalidations = [];
      // G14-FIX-CODEX-01：当前格式 fixture 必须带依赖提议指纹；旧数据（withEvidence=false）保持缺失。
      entry.dependencyProposalKey = JSON.stringify({ basis: entry.basis || null, hints: [] });
    } else {
      entry.evidenceRefs = entry.basis ? [{ dimension: entry.basis, digest: basisDigest }] : [];
    }
  }
  return { infs, history, evidence, withEvidence };
}
function fixture(opts = {}) {
  const { answers = ANSWERS, inferences = null, revision = 0, verifierReady = true, withEvidence = true } = opts;
  const db = new D1Harness();
  const s = seed({ answers, inferences, revision, withEvidence });
  const verdicts = Object.fromEntries(s.infs.map((e) => [e.id, { verdict: "agree", correction: "", contentVersion: e.contentVersion, templateVersion: e.templateVersion === undefined ? null : e.templateVersion, evidenceHash: e.evidenceHash || null, evidenceVersion: e.evidenceVersion }]));
  const ledger = { statements: {}, covered: [], vagueTerms: [], unresolved: [], authoritativeInferences: s.infs, statementHistory: s.history, burdenAsked: true };
  if (withEvidence) ledger.evidence = s.evidence;
  const draft = serializeEmployeeDraft({ answers, ledger, inferenceVerdicts: verdicts, submissionText: "", revision });
  const inv = verifierReady
    ? `('INV-FIX06A','inv-fix06a','${P}','${EMP}','ver@fix06a.invalid','verifier','project','accepted','2099-01-01T00:00:00Z','${VER}','IK-FIX06A')`
    : `('INV-FIX06A','inv-fix06a','${P}','${EMP}','ver@fix06a.invalid','verifier','project','pending','2099-01-01T00:00:00Z',NULL,'IK-FIX06A')`;
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('${EMP}','emp@fix06a.invalid','员工甲','active','member'),('${VER}','ver@fix06a.invalid','核验人乙','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage)
      VALUES ('${P}','FIX-06A','选品到发布','mapping','active','unknown','external_builder','${EMP}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES ('${P}','${EMP}','employee','project','active');
    ${verifierReady ? `INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES ('${P}','${VER}','verifier','project','active');` : ""}
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at)
      VALUES ('AUTH-FIX06A','${P}','授权','王总','o@fix06a.invalid','只读','DOC','authorized','${EMP}','k','n','h','2099-01-01T00:00:00Z');
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,accepted_account_id,idempotency_key) VALUES ${inv};
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,material_status,flow_card_version,evidence_version)
      VALUES ('${ITEM}','${P}','还原工作','d','mapping','needs_input','employee','员工甲',0,'b','n','${EMP}',${verifierReady ? `'${VER}'` : "NULL"},'${draft.replace(/'/g, "''")}','provided',1,1);
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('${TOK}','${EMP}','${P}','2099-01-01T00:00:00Z','R-FIX06A');
  `);
  return db;
}
const itemOf = (db) => db.get("SELECT * FROM work_items WHERE id=?", ITEM);
const draftOf = (db) => normalizeEmployeeDraft(JSON.parse(itemOf(db).employee_draft_json || "{}"));
const revOf = (db) => draftOf(db).revision;
const infsOf = (db) => draftOf(db).ledger?.authoritativeInferences || [];
const factsOf = (db) => db.count("candidate_facts");
const eventsOf = (db) => db.all("SELECT type,payload FROM events WHERE work_item_id=? ORDER BY id", ITEM);
const jsonOf = async (r) => r.clone().json().catch(() => ({}));
const put = (db, body) => saveDraft({ request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, TOK, body), env: { DB: db }, params: { itemId: ITEM } });
const submit = (db, body, key = `K-${Math.random()}`, envDb = db) => submitEmployee({ request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-submission`, TOK, { ...body, baseRevision: body.baseRevision ?? revOf(db) }, { "Idempotency-Key": key }), env: { DB: envDb }, params: { itemId: ITEM } });
const subBody = (answers, extra = {}) => ({ text: text(answers), workflowCard: card(answers), materialStatus: "provided", inferences: [], inferenceVerdicts: {}, ...extra });
const echo = (infs) => Object.fromEntries(infs.map((e) => [e.id, { verdict: "agree", correction: "", contentVersion: e.contentVersion, templateVersion: e.templateVersion ?? null, evidenceHash: e.evidenceHash || null, evidenceVersion: e.evidenceVersion }]));
function tamper(db, mutate) { const d = JSON.parse(itemOf(db).employee_draft_json || "{}"); mutate(d); db.prepare("UPDATE work_items SET employee_draft_json=? WHERE id=?").bind(JSON.stringify(d), ITEM).run(); }
const results = [];
const check = (id, name, ok, note = "") => { results.push({ id, ok, note }); console.log(`${ok ? "✔ PASS" : "✘ FAIL"} [${id}] ${name}${note ? " | " + note : ""}`); };
console.log("PILOT-09C/FIX-06A · 历史完整性/分配守卫/旧数据来源 —— 定向运行时套件\n");

// H1/H3 evidenceHistory 满额
{
  const db = fixture(); const target = infsOf(db).find((e) => e.basis === "exceptions");
  tamper(db, (d) => { const e = (d.ledger.authoritativeInferences || []).find((x) => x.id === target.id); e.evidenceHistory = Array.from({ length: 20 }, (_, i) => ({ contentVersion: i + 1, quote: "h" + i, evidenceHash: "EH-H" + i })); e.contentVersion = 20; });
  const revBefore = revOf(db); const answersBefore = JSON.stringify(draftOf(db).answers); const firstBefore = infsOf(db).find((e) => e.id === target.id).evidenceHistory[0];
  const res = await put(db, { answers: { exceptions: NEW_EXC }, materialStatus: "provided", baseRevision: revBefore });
  const body = await jsonOf(res); const after = infsOf(db).find((e) => e.id === target.id);
  check("H1", "evidenceHistory 满 20 后再追加 → 409 evidence_history_overflow，零副作用且最早记录保留",
    res.status === 409 && body.code === "evidence_history_overflow" && body.limit === 20 && revOf(db) === revBefore && JSON.stringify(draftOf(db).answers) === answersBefore && after.evidenceHistory.length === 20 && after.evidenceHistory[0].contentVersion === firstBefore.contentVersion && factsOf(db) === 0,
    `status=${res.status} code=${body.code || ""} len=${after.evidenceHistory.length} rev=${revBefore}->${revOf(db)}`);
}
// H2/H3 verdict.history 满额
{
  const db = fixture(); const target = infsOf(db)[0];
  tamper(db, (d) => { const v = d.inferenceVerdicts[target.id]; v.history = Array.from({ length: 10 }, (_, i) => ({ verdict: "confirmed", correction: "", contentVersion: 1, evidenceHash: "EH-V" + i, supersededAt: "2026-01-01T00:00:00Z" })); });
  const revBefore = revOf(db); const verdictBefore = JSON.stringify(draftOf(db).inferenceVerdicts[target.id].verdict);
  const cur = infsOf(db).find((e) => e.id === target.id);
  const res = await put(db, { answers: draftOf(db).answers, materialStatus: "provided", inferenceVerdicts: { [target.id]: { verdict: "correct", correction: "更正", contentVersion: cur.contentVersion, templateVersion: cur.templateVersion ?? null, evidenceHash: cur.evidenceHash || null, evidenceVersion: cur.evidenceVersion } }, baseRevision: revBefore });
  const body = await jsonOf(res); const after = draftOf(db).inferenceVerdicts[target.id];
  check("H2", "verdict.history 满 10 后再改判定 → 409 verdict_history_overflow，零副作用且最早记录保留",
    res.status === 409 && body.code === "verdict_history_overflow" && body.limit === 10 && revOf(db) === revBefore && JSON.stringify(draftOf(db).inferenceVerdicts[target.id].verdict) === verdictBefore && after.history.length === 10 && after.history[0].evidenceHash === "EH-V0",
    `status=${res.status} code=${body.code || ""} len=${after.history.length}`);
}
// H4 合法追加
{
  const db = fixture(); const target = infsOf(db).find((e) => e.basis === "exceptions"); const beforeLen = target.evidenceHistory.length;
  const res = await put(db, { answers: { exceptions: NEW_EXC }, materialStatus: "provided", baseRevision: revOf(db) });
  const after = infsOf(db).find((e) => e.id === target.id);
  check("H4", "未满额合法追加 evidenceHistory 且最早记录保留",
    res.status === 200 && after.evidenceHistory.length === beforeLen + 1 && after.evidenceHistory[0].contentVersion === target.evidenceHistory[0].contentVersion,
    `status=${res.status} len=${beforeLen}->${after.evidenceHistory.length}`);
  const cur = infsOf(db).find((e) => e.id === target.id);
  const res2 = await put(db, { answers: draftOf(db).answers, materialStatus: "provided", inferenceVerdicts: { [target.id]: { verdict: "correct", correction: "补充更正", contentVersion: cur.contentVersion, templateVersion: cur.templateVersion ?? null, evidenceHash: cur.evidenceHash || null, evidenceVersion: cur.evidenceVersion } }, baseRevision: revOf(db) });
  const v = draftOf(db).inferenceVerdicts[target.id];
  check("H4b", "未满额合法追加 verdict.history", res2.status === 200 && v.history.length === 1, `status=${res2.status} hist=${v.history.length}`);
}
// C：提交 batch 前并发修改 assigned_verifier_id
{
  const db = fixture();
  const wrapped = Object.create(db);
  wrapped.batch = (statements) => { db.prepare("UPDATE work_items SET assigned_verifier_id='ACC-CONCURRENT' WHERE id=?").bind(ITEM).run(); return db.batch(statements); };
  const res = await submit(db, subBody(ANSWERS), "K-C-guard", wrapped);
  const body = await jsonOf(res); const item = itemOf(db); const subEvents = eventsOf(db).filter((e) => e.type === "employee_submitted").length;
  check("C", "提交 batch 前 assigned_verifier_id 被并发修改 → 409，不覆盖分配、无 facts/submitted 事件",
    res.status === 409 && item.assigned_verifier_id === "ACC-CONCURRENT" && factsOf(db) === 0 && subEvents === 0 && item.submission_version === 0,
    `status=${res.status} code=${body.code || ""} verifier=${item.assigned_verifier_id} facts=${factsOf(db)}`);
}
// L1 无访谈
{
  const db = fixture({ inferences: [] });
  const res = await submit(db, subBody(ANSWERS), "K-L1");
  const body = await jsonOf(res);
  check("L1", "旧草稿无访谈证据 → 409 interview_evidence_missing、零写入",
    res.status === 409 && body.code === "interview_evidence_missing" && factsOf(db) === 0 && itemOf(db).submission_version === 0,
    `status=${res.status} code=${body.code || ""}`);
}
// L2/L3 受控初始化 + 来源标记 + 重新确认提交
{
  const db = fixture();
  tamper(db, (d) => {
    delete d.ledger.evidence; d.ledger.statementHistory = [];
    for (const e of d.ledger.authoritativeInferences || []) { delete e.evidenceVersion; delete e.evidenceRefs; delete e.evidenceHistory; }
    for (const v of Object.values(d.inferenceVerdicts || {})) { delete v.evidenceVersion; delete v.history; }
  });
  const direct = await submit(db, subBody(ANSWERS), "K-L2-direct"); const directBody = await jsonOf(direct);
  check("L2a", "旧草稿无 evidence 元数据 → 直接提交被拒", direct.status === 409 && ["evidence_metadata_missing", "evidence_history_mismatch"].includes(directBody.code) && factsOf(db) === 0, `status=${direct.status} code=${directBody.code || ""}`);
  const initRes = await put(db, { answers: ANSWERS, materialStatus: "provided", baseRevision: revOf(db) });
  const draft = draftOf(db); const ev = draft.ledger.evidence || {};
  check("L2b", "首次保存受控初始化：legacyInitialized/source 标记 + 7 条 initial 历史",
    initRes.status === 200 && ev.legacyInitialized === true && ev.source === "legacy_controlled_init" && draft.ledger.statementHistory.filter((e) => e.kind === "initial").length === 7,
    `status=${initRes.status} source=${ev.source} hist=${draft.ledger.statementHistory.length}`);
  const noJudge = await submit(db, subBody(ANSWERS), "K-L2-stale"); const noJudgeBody = await jsonOf(noJudge);
  check("L2c", "初始化后旧判定 stale → 未重判提交 422 inferences_unjudged", noJudge.status === 422 && noJudgeBody.code === "inferences_unjudged", `status=${noJudge.status} code=${noJudgeBody.code || ""}`);
  const saved = await put(db, { answers: ANSWERS, materialStatus: "provided", inferenceVerdicts: echo(infsOf(db)), baseRevision: revOf(db) });
  const sub = await submit(db, subBody(ANSWERS), "K-L3");
  const sub2 = await submit(db, subBody(ANSWERS), "K-L3b");
  const evt = eventsOf(db).find((e) => e.type === "employee_submitted");
  const payload = evt ? JSON.parse(evt.payload) : {};
  check("L3", "重新确认后提交 200，审计快照显式 evidenceSource=legacy_controlled_init",
    saved.status === 200 && [200].includes(sub.status) && payload.evidenceSource === "legacy_controlled_init" && payload.evidenceLegacyInitialized === true && payload.evidenceInitialHistoryEntries === 7,
    `saved=${saved.status} sub=${sub.status} source=${payload.evidenceSource} init=${payload.evidenceInitialHistoryEntries}`);
}
// L3b 正常项目来源 interview
{
  const db = fixture();
  const sub = await submit(db, subBody(ANSWERS), "K-NORMAL");
  const evt = eventsOf(db).find((e) => e.type === "employee_submitted"); const payload = evt ? JSON.parse(evt.payload) : {};
  check("L3b", "正常访谈提交快照 evidenceSource=interview / legacy=false", sub.status === 200 && payload.evidenceSource === "interview" && payload.evidenceLegacyInitialized === false, `status=${sub.status} source=${payload.evidenceSource}`);
}
// L4 客户端伪造
{
  const db = fixture();
  const forged = { answers: ANSWERS, materialStatus: "provided", baseRevision: revOf(db), ledger: { statements: { trigger: "伪造" }, covered: ["trigger"], statementHistory: [{ seq: 1, dimension: "trigger", text: "伪造历史" }], authoritativeInferences: [{ id: "INF-FAKE", text: "伪造推断" }], evidence: { schemaVersion: 1, seq: 999, answersDigest: "sha256:fake", dimensions: {}, legacyInitialized: true, source: "legacy_controlled_init" } }, inferenceVerdicts: { [infsOf(db)[0].id]: { verdict: "agree", contentVersion: 999, templateVersion: 99, evidenceHash: "EH-FAKE", evidenceVersion: 999 } } };
  const res = await put(db, forged); const body = await jsonOf(res); const draft = draftOf(db); const ev = draft.ledger.evidence || {}; const rejected = body.verdictResult?.rejected || [];
  check("L4", "客户端伪造 evidence/history/推断/verdict 版本 → 服务端重算/拒绝（不保留伪造）",
    res.status === 200 && ev.sequence !== 999 && ev.answersDigest !== "sha256:fake" && ev.legacyInitialized !== true && ev.source !== "legacy_controlled_init" && draft.ledger.statementHistory.some((e) => String(e.text).includes("伪造")) === false && rejected.some((r) => r.reason === "version_mismatch"),
    `status=${res.status} source=${ev.source} legacy=${ev.legacyInitialized} rejected=${rejected.map((r) => r.reason).join(",")}`);
}
const failed = results.filter((r) => !r.ok);
console.log("\n──────────────── 汇总 ────────────────");
console.log(`  PASS=${results.length - failed.length}  FAIL=${failed.length}`);
if (failed.length) { console.error("  FIX-06A 定向套件失败:", failed.map((r) => r.id).join(", ")); process.exitCode = 1; }
else console.log("  pilot09c fix-06a runtime: ok");
