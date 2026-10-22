/**
 * B2-R2 · 业务写入与审计事件一致性回归测试（修复后）
 *
 * 覆盖三条已复现缺陷的修复：
 *   ① 员工保存草稿（CAS + 审计事件同批）
 *   ② 创建邀请（邀请行 + 审计事件同批）
 *   ③ 撤回邀请（状态更新 + 审计事件同批）
 * 并确认正式提交流程的既有原子性防护不回归。
 *
 * 运行：node tests/b2_r2_audit_consistency.mjs
 */
import { createHash } from "node:crypto";
import { normalizeEmployeeDraft, serializeEmployeeDraft } from "../functions/_shared.js";
import { onRequestPut as saveDraft } from "../functions/api/work-items/[itemId]/employee-draft.js";
import { onRequestPost as submitEmployee } from "../functions/api/work-items/[itemId]/employee-submission.js";
import { onRequestPost as createInvitation } from "../functions/api/projects/[projectId]/invitations.js";
import { onRequestPost as revokeInvitation } from "../functions/api/invitations/[invitationRef]/revoke.js";
import { ANSWER_DIMENSIONS, canonicalJson, normalizeAnswers } from "../functions/api/agent/_evidence.js";
import { appendStatementHistory, buildInferenceRecords, buildInferences } from "../functions/api/agent/_adapter.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

const P = "PRJ-B2R2", ITEM = "WI-B2R2", EMP = "ACC-B2R2-EMP", VER = "ACC-B2R2-VER", BLD = "ACC-B2R2-BLD";
const TOK_EMP = "TOK-B2R2-EMP", TOK_BLD = "TOK-B2R2-BLD";

const ANSWERS = {
  trigger: "每天早上运营同事在群里发来当天的推广需求",
  inputs: "先看昨天的曝光和点击数据，再看库存数量",
  steps: "先选品再写脚本，然后让剪辑同事剪出来",
  judgments: "毛利率低于一成要先找主管确认",
  exceptions: "版权不确定就换同款，审核被拒就先改文案",
  handoff: "剪完的素材交给投放同事小李",
  burden: "一条视频从选题到发布大约需要三个小时",
};
const NEW_EXC = "版权不确定时先冻结发布并请运营主管签字确认";

const LABELS = {
  trigger: "从哪里开始", inputs: "先看什么", steps: "实际怎么做",
  judgments: "哪些情况不能自己决定", exceptions: "卡住后怎么办",
  handoff: "交给谁", burden: "大约多久",
};
const canonicalText = (answers) => ANSWER_DIMENSIONS.map((d) => `${LABELS[d]}：${String(answers[d] || "").trim()}`).join("\n\n");
const cardOf = (answers) => ({ ...answers, materialIndex: "员工已说明有材料，等待登记" });
const sha = (v) => `sha256:${createHash("sha256").update(String(v), "utf8").digest("hex")}`;

function seedEvidence() {
  const inferences = buildInferenceRecords([], [
    ...buildInferences({ statements: ANSWERS }, {}),
    { source: "model", text: "基线推断：素材交给投放同事", basis: "handoff", assumes: "若不是需更正" },
  ]).records.map((entry) => ({ ...entry, evidenceVersion: 0 }));

  let history = [];
  for (const dim of ANSWER_DIMENSIONS) {
    if (ANSWERS[dim]) history = appendStatementHistory({ prior: history, dimension: dim, text: ANSWERS[dim], revision: 0 }).history;
  }
  const dimensions = Object.fromEntries(ANSWER_DIMENSIONS.map((dim) => [
    dim, { digest: ANSWERS[dim] ? sha(normalizeAnswers(ANSWERS)[dim]) : null, seq: ANSWERS[dim] ? 1 : 0 },
  ]));
  const evidence = {
    schemaVersion: 1, seq: 1,
    answersDigest: sha(canonicalJson(normalizeAnswers(ANSWERS))),
    dimensions, revision: 0, source: "interview", legacyInitialized: false, ruleVersion: 1,
  };
  for (const entry of inferences) {
    entry.dependencyRuleVersion = 1;
    entry.dependencySource = entry.source === "server_template" ? "server_template_fixed" : "model_conservative_potential";
    entry.dependencyRuleStatus = entry.dependencySource;
    const basisDigest = entry.basis ? dimensions[entry.basis].digest : null;
    entry.evidenceRefs = entry.source === "server_template"
      ? (entry.basis && basisDigest ? [{ dimension: entry.basis, digest: basisDigest, source: "server_template_fixed", ruleId: null }] : [])
      : ANSWER_DIMENSIONS.filter((dim) => dimensions[dim]?.digest).map((dimension) => ({ dimension, digest: dimensions[dimension].digest, source: "model_conservative_potential", ruleId: null }));
    entry.proposedDependencyDimensions = [];
    entry.dependencyHintsRejected = [];
    entry.invalidations = [];
    entry.dependencyProposalKey = JSON.stringify({ basis: entry.basis || null, hints: [] });
  }
  return { inferences, history, evidence };
}

function fixture() {
  const db = new D1Harness();
  const s = seedEvidence();
  const verdicts = Object.fromEntries(s.inferences.map((e) => [e.id, {
    verdict: "agree", correction: "", contentVersion: e.contentVersion,
    templateVersion: e.templateVersion ?? null, evidenceHash: e.evidenceHash || null, evidenceVersion: e.evidenceVersion,
  }]));
  const ledger = {
    statements: {}, covered: [], vagueTerms: [], unresolved: [],
    authoritativeInferences: s.inferences, statementHistory: s.history, burdenAsked: true, evidence: s.evidence,
  };
  const draft = serializeEmployeeDraft({ answers: ANSWERS, ledger, inferenceVerdicts: verdicts, submissionText: "", revision: 0 });
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('${EMP}','emp@b2r2.test','员工甲','active','member'),
      ('${VER}','ver@b2r2.test','核验人乙','active','member'),
      ('${BLD}','builder@b2r2.test','改造方','active','external_builder');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage)
      VALUES ('${P}','B2-R2测试','选品到发布','mapping','active','unknown','external_builder','${BLD}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES
      ('${P}','${EMP}','employee','project','active'),
      ('${P}','${VER}','verifier','project','active'),
      ('${P}','${BLD}','external_builder','project','active');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at)
      VALUES ('AUTH-B2R2','${P}','授权','王总','o@b2r2.test','只读','DOC','authorized','${BLD}','k','n','h','2099-01-01T00:00:00Z');
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,accepted_account_id,idempotency_key)
      VALUES ('INV-B2R2','inv-b2r2','${P}','${BLD}','ver@b2r2.test','verifier','project','accepted','2099-01-01T00:00:00Z','${VER}','IK-B2R2');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,material_status,flow_card_version,evidence_version)
      VALUES ('${ITEM}','${P}','测试任务','d','mapping','needs_input','employee','员工甲',0,'b','n','${EMP}','${VER}','${draft.replace(/'/g, "''")}','provided',1,1);
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('${TOK_EMP}','${EMP}','${P}','2099-01-01T00:00:00Z','R-EMP'),
      ('${TOK_BLD}','${BLD}','${P}','2099-01-01T00:00:00Z','R-BLD');
  `);
  return db;
}

const itemOf = (db) => db.get("SELECT * FROM work_items WHERE id=?", ITEM);
const draftOf = (db) => normalizeEmployeeDraft(JSON.parse(itemOf(db).employee_draft_json || "{}"));
const revOf = (db) => draftOf(db).revision;
const answersOf = (db) => draftOf(db).answers;
const eventsOf = (db) => db.all("SELECT event_id,type,payload FROM events ORDER BY id");
const eventsOfType = (db, type) => eventsOf(db).filter((e) => e.type === type);
const factsOf = (db) => db.all("SELECT id FROM candidate_facts");
const count = (db, table) => db.count(table);
const jsonOf = async (r) => r.clone().json().catch(() => ({}));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const putDraft = (db, body) => saveDraft({
  request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, TOK_EMP, body),
  env: { DB: db }, params: { itemId: ITEM },
});
const submitBody = (db, extra = {}) => ({
  text: canonicalText(ANSWERS),
  workflowCard: cardOf(ANSWERS),
  materialStatus: "provided",
  inferences: [],
  baseRevision: revOf(db),
  ...extra,
});
const postSubmit = (db, body, key = "SUB-KEY-B2R2") => submitEmployee({
  request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-submission`, TOK_EMP, body, { "Idempotency-Key": key }),
  env: { DB: db }, params: { itemId: ITEM },
});
const postInvite = (db, body, key = "INV-KEY-1") => createInvitation({
  request: bearerRequest(`http://127.0.0.1/api/projects/${P}/invitations`, TOK_BLD, body, { "Idempotency-Key": key }),
  env: { DB: db }, params: { projectId: P },
});
const postRevoke = (db, id) => revokeInvitation({
  request: bearerRequest(`http://127.0.0.1/api/invitations/${id}/revoke`, TOK_BLD, {}),
  env: { DB: db }, params: { invitationRef: id },
});

const results = [];
const record = (id, name, ok, note = "") => {
  results.push({ id, name, ok, note });
  console.log(`${ok ? "✔ PASS" : "✘ FAIL"} [${id}] ${name}${note ? " | " + note : ""}`);
};

console.log("B2-R2 · 原子性修复回归测试\n");

// ── 1. 草稿：审计失败整体回滚 ─────────────────────────────────────────
{
  console.log("=== 1. 员工保存草稿 + 审计失败 ===");
  const db = fixture();
  const beforeRev = revOf(db), beforeAnswers = answersOf(db), beforeEvents = count(db, "events");
  db.failOnEvent = true;
  const res = await putDraft(db, { answers: { exceptions: NEW_EXC + "（回滚）" }, materialStatus: "provided", baseRevision: 0 });
  const body = await jsonOf(res);
  record("D1-rollback",
    "审计写入失败：HTTP 失败、revision 不推进、答案不变、无事件",
    res.status === 500 && revOf(db) === beforeRev && same(answersOf(db), beforeAnswers) && count(db, "events") === beforeEvents,
    `status=${res.status} rev=${beforeRev}→${revOf(db)} events=${count(db, "events")} detail=${body.detail || ""}`);

  db.failOnEvent = false;
  const retry = await putDraft(db, { answers: { exceptions: NEW_EXC + "（回滚）" }, materialStatus: "provided", baseRevision: 0 });
  const retryBody = await jsonOf(retry);
  record("D2-retry-no-false-conflict",
    "失败后同 baseRevision 重试：直接成功，无虚假版本冲突",
    retry.status === 200 && revOf(db) === 1 && count(db, "events") === 1 && retryBody.task?.draftRevision === 1,
    `status=${retry.status} rev=${revOf(db)} events=${count(db, "events")} code=${retryBody.code || "-"}`);
}

// ── 2. 草稿：CAS 未命中不写事件 ───────────────────────────────────────
{
  console.log("\n=== 2. 草稿 CAS 未命中 ===");
  const db = fixture();
  await putDraft(db, { answers: { exceptions: NEW_EXC + "（v1）" }, materialStatus: "provided", baseRevision: 0 });
  const eventsAfterFirst = count(db, "events");
  const stale = await putDraft(db, { answers: { exceptions: NEW_EXC + "（v2）" }, materialStatus: "provided", baseRevision: 0 });
  const body = await jsonOf(stale);
  record("D3-cas-miss",
    "过期 baseRevision：409 冲突且不产生审计事件",
    stale.status === 409 && body.code === "draft_conflict" && count(db, "events") === eventsAfterFirst && revOf(db) === 1,
    `status=${stale.status} code=${body.code || "-"} reason=${body.reason || "-"} events=${count(db, "events")}`);
}

// ── 3. 草稿：并发重复保存 ────────────────────────────────────────────
{
  console.log("\n=== 3. 草稿并发重复保存 ===");
  const db = fixture();
  const [a, b] = await Promise.all([
    putDraft(db, { answers: { exceptions: NEW_EXC + "（并发）" }, materialStatus: "provided", baseRevision: 0 }),
    putDraft(db, { answers: { exceptions: NEW_EXC + "（并发）" }, materialStatus: "provided", baseRevision: 0 }),
  ]);
  const statuses = [a.status, b.status].sort().join("/");
  record("D4-concurrent",
    "同一 baseRevision 并发保存：仅一次推进、仅一条事件",
    statuses === "200/409" && revOf(db) === 1 && count(db, "events") === 1,
    `statuses=${statuses} rev=${revOf(db)} events=${count(db, "events")}`);
}

// ── 4. 创建邀请：审计失败整体回滚 ────────────────────────────────────
{
  console.log("\n=== 4. 创建邀请 + 审计失败 ===");
  const db = fixture();
  const before = count(db, "invitations");
  db.failOnEvent = true;
  const res = await postInvite(db, { email: "new@b2r2.test", role: "employee" });
  const body = await jsonOf(res);
  record("I1-rollback",
    "审计写入失败：邀请未创建、无事件、HTTP 失败",
    res.status === 500 && count(db, "invitations") === before && count(db, "events") === 0,
    `status=${res.status} invitations=${count(db, "invitations")} events=${count(db, "events")} detail=${body.detail || ""}`);

  db.failOnEvent = false;
  const retry = await postInvite(db, { email: "new@b2r2.test", role: "employee" });
  record("I2-retry",
    "重试正常创建：一条邀请 + 一条事件",
    retry.status === 201 && count(db, "invitations") === before + 1 && count(db, "events") === 1 && eventsOf(db)[0].type === "invitation_created",
    `status=${retry.status} invitations=${count(db, "invitations")} events=${count(db, "events")}`);

  const again = await postInvite(db, { email: "new@b2r2.test", role: "employee" });
  record("I3-idempotent",
    "同一幂等键重复请求：返回既有邀请，不重复写入/重复事件",
    again.status === 201 && count(db, "invitations") === before + 1 && count(db, "events") === 1,
    `status=${again.status} invitations=${count(db, "invitations")} events=${count(db, "events")}`);
}

// ── 5. 创建邀请：并发同一幂等键 ──────────────────────────────────────
{
  console.log("\n=== 5. 创建邀请并发（同一幂等键）===");
  const db = fixture();
  const before = count(db, "invitations");
  const [a, b] = await Promise.all([
    postInvite(db, { email: "race@b2r2.test", role: "employee" }, "INV-RACE"),
    postInvite(db, { email: "race@b2r2.test", role: "employee" }, "INV-RACE"),
  ]);
  record("I4-concurrent",
    "并发同键：只创建一条邀请、只产生一条事件",
    [a.status, b.status].every((s) => s === 201) && count(db, "invitations") === before + 1 && count(db, "events") === 1,
    `statuses=${a.status}/${b.status} invitations=${count(db, "invitations")} events=${count(db, "events")}`);
}

// ── 6. 撤回邀请：审计失败整体回滚 ────────────────────────────────────
{
  console.log("\n=== 6. 撤回邀请 + 审计失败 ===");
  const db = fixture();
  db.exec(`INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,idempotency_key)
           VALUES ('INV-B2R2-2','inv-b2r2-2','${P}','${BLD}','other@b2r2.test','employee','project','pending','2099-01-01T00:00:00Z','IK-B2R2-2')`);
  db.failOnEvent = true;
  const res = await postRevoke(db, "INV-B2R2-2");
  const row = db.get("SELECT status FROM invitations WHERE id='INV-B2R2-2'");
  record("V1-rollback",
    "审计写入失败：邀请保持 pending、无事件、HTTP 失败",
    res.status === 500 && row.status === "pending" && count(db, "events") === 0,
    `status=${res.status} invitationStatus=${row.status} events=${count(db, "events")}`);

  db.failOnEvent = false;
  const retry = await postRevoke(db, "INV-B2R2-2");
  const after = db.get("SELECT status FROM invitations WHERE id='INV-B2R2-2'");
  record("V2-retry",
    "重试正常撤回：状态 revoked + 一条事件",
    retry.status === 200 && after.status === "revoked" && count(db, "events") === 1 && eventsOf(db)[0].type === "invitation_revoked",
    `status=${retry.status} invitationStatus=${after.status} events=${count(db, "events")}`);
}

// ── 7. 撤回邀请：并发重复撤回 ────────────────────────────────────────
{
  console.log("\n=== 7. 撤回邀请并发 ===");
  const db = fixture();
  db.exec(`INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,idempotency_key)
           VALUES ('INV-B2R2-3','inv-b2r2-3','${P}','${BLD}','race@b2r2.test','employee','project','pending','2099-01-01T00:00:00Z','IK-B2R2-3')`);
  const [a, b] = await Promise.all([postRevoke(db, "INV-B2R2-3"), postRevoke(db, "INV-B2R2-3")]);
  const statuses = [a.status, b.status].sort().join("/");
  record("V3-concurrent",
    "并发重复撤回：仅一条撤回事件",
    statuses === "200/409" && count(db, "events") === 1 && db.get("SELECT status FROM invitations WHERE id='INV-B2R2-3'").status === "revoked",
    `statuses=${statuses} events=${count(db, "events")}`);
}

// ── 8. 正式提交：既有防护不回归 ──────────────────────────────────────
{
  console.log("\n=== 8. 正式提交流程回归 ===");
  const db = fixture();
  const before = {
    status: itemOf(db).status, stage: itemOf(db).stage,
    submissionVersion: Number(itemOf(db).submission_version || 0),
    revision: revOf(db), events: count(db, "events"), facts: count(db, "candidate_facts"),
    idempotency: count(db, "idempotency_records"),
  };
  db.failOnEvent = true;
  const failed = await postSubmit(db, submitBody(db), "SUB-KEY-B2R2");
  const after = {
    status: itemOf(db).status, stage: itemOf(db).stage,
    submissionVersion: Number(itemOf(db).submission_version || 0),
    revision: revOf(db), events: count(db, "events"), facts: count(db, "candidate_facts"),
    idempotency: count(db, "idempotency_records"),
  };
  record("S1-atomic", "提交审计失败：整批回滚、业务零变更", failed.status === 500 && same(before, after), `status=${failed.status} ${JSON.stringify(after)}`);

  db.failOnEvent = false;
  const ok = await postSubmit(db, submitBody(db), "SUB-KEY-B2R2");
  const ev = eventsOf(db);
  record("S2-retry", "同键重试：成功且事件不重复", ok.status === 200 && ev.filter((e) => e.type === "employee_submitted").length === 1 && ev.length === 2 && factsOf(db).length === 5 && Number(itemOf(db).submission_version) === 1,
    `status=${ok.status} events=${ev.map((e) => e.type).join(",")} facts=${factsOf(db).length}`);

  const submitted = JSON.parse(ev.find((e) => e.type === "employee_submitted").payload);
  record("S3-payload", "审计载荷与业务版本一致（提交版本/证据 seq/判定投影/服务端来源）",
    Number(submitted.submissionVersion) === Number(itemOf(db).submission_version)
      && Number(submitted.evidenceSeq) === Number(draftOf(db).ledger?.evidence?.seq)
      && submitted.source === "server_employee_submission"
      && submitted.verdicts.length === submitted.inferences.length,
    `submissionVersion=${submitted.submissionVersion} evidenceSeq=${submitted.evidenceSeq}`);

  const replay = await postSubmit(db, submitBody(db), "SUB-KEY-B2R2");
  record("S4-replay", "成功后重放：403 且无新增事件", replay.status === 403 && count(db, "events") === 2,
    `status=${replay.status} events=${count(db, "events")}`);

  const db2 = fixture();
  db2.failOnEvent = true;
  db2.simulateOldSplitWrites = true;
  const split = await postSubmit(db2, submitBody(db2), "SUB-KEY-SPLIT");
  record("S5-split-guard", "（对照）无事务分步写入会复现旧风险，说明同批不是偶然",
    split.status === 500 && itemOf(db2).status === "awaiting_verification" && count(db2, "events") === 0,
    `status=${split.status} itemStatus=${itemOf(db2).status} events=${count(db2, "events")}`);
}

// ── 9. 在途旧保存（提交完成之后恢复执行）──────────────────────────────
{
  console.log("\n=== 9. 提交后在途旧保存（R04-02 防护）===");
  const db = fixture();
  const originalBatch = db.batch.bind(db);
  let fired = false;
  // 新的写入路径把 CAS 放进 batch：在第一次 batch 真正执行前完成正式提交，
  // 等价于"保存请求已通过前置检查、恢复执行时提交已完成"的在途窗口。
  db.batch = async (statements) => {
    if (!fired) {
      fired = true;
      await postSubmit(db, submitBody(db), "K-INFLIGHT");
    }
    return originalBatch(statements);
  };
  const stale = await putDraft(db, { answers: { trigger: "在途旧保存写入的答案" }, materialStatus: "provided", baseRevision: 0 });
  db.batch = originalBatch;
  const staleBody = await jsonOf(stale);
  const ev = eventsOf(db);
  record("S6-inflight",
    "提交后在途旧保存：409 not_editable，不写草稿、不写审计事件",
    stale.status === 409 && staleBody.reason === "not_editable"
      && itemOf(db).stage === "facts" && revOf(db) === 0
      && !String(itemOf(db).employee_draft_json).includes("在途旧保存写入的答案")
      && ev.filter((e) => e.type === "employee_draft_saved").length === 0,
    `status=${stale.status} reason=${staleBody.reason || "-"} stage=${itemOf(db).stage} rev=${revOf(db)} draftEvents=${ev.filter((e) => e.type === "employee_draft_saved").length}`);
}

// ── 汇总 ──────────────────────────────────────────────────────────────
console.log("\n──────────────── 汇总 ────────────────");
const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok).length;
console.log(`  PASS=${pass}  FAIL=${fail}`);
if (fail) {
  console.log("\n失败详情：");
  results.filter((r) => !r.ok).forEach((r) => console.log(`  [${r.id}] ${r.note}`));
}
console.log(`  b2-r2 audit consistency: ${fail === 0 ? "ok" : "FAILED"}`);
process.exit(fail === 0 ? 0 : 1);
