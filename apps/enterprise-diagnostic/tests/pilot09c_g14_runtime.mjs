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
  const evidence = { schemaVersion: 1, seq: 1, answersDigest: sha(canonicalJson(normalizeAnswers(answers))), dimensions, revision, source: "interview", legacyInitialized: false, ruleVersion: 1 };
  for (const entry of infs) {
    const basisDigest = entry.basis ? dimensions[entry.basis].digest : null;
    const isTemplate = entry.source === "server_template";
    entry.evidenceRefs = isTemplate
      ? (entry.basis ? [{ dimension: entry.basis, digest: basisDigest, source: "server_template_fixed", ruleId: null }] : [])
      : Object.fromEntries(ANSWER_DIMENSIONS.map((dim) => [dim, dimensions[dim] && dimensions[dim].digest])),
    // 模型推断默认保守潜在依赖集合（全部可验证维度），避免测试默认漏失效
    entry.evidenceRefs = isTemplate
      ? (entry.basis ? [{ dimension: entry.basis, digest: basisDigest, source: "server_template_fixed", ruleId: null }] : [])
      : ANSWER_DIMENSIONS.filter((dim) => dimensions[dim] && dimensions[dim].digest).map((dim) => ({ dimension: dim, digest: dimensions[dim].digest, source: "model_conservative_potential", ruleId: null }));
    entry.evidenceVersion = Number.isInteger(entry.evidenceVersion) ? entry.evidenceVersion : 0;
    entry.dependencyRuleVersion = 1;
    entry.dependencySource = isTemplate ? "server_template_fixed" : "model_conservative_potential";
    entry.dependencyRuleStatus = isTemplate ? "server_template_fixed" : "model_conservative_potential";
    entry.proposedDependencyDimensions = [];
    entry.dependencyHintsRejected = [];
    entry.invalidations = [];
    entry.dependencyProposalKey = JSON.stringify({ basis: entry.basis || null, hints: [] });
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
const check = (id, name, ok, note = "") => { results.push({ id, name, ok, note }); console.log(`${ok ? "✔ PASS" : "✘ FAIL"} [${id}] ${name}${note ? " | " + note : ""}`); };
const entryOfBasis = (db, basis, source = null) => infsOf(db).find((e) => e.basis === basis && (source ? e.source === source : true));
function patchInference(db, id, fields) {
  tamper(db, (d) => { const e = (d.ledger.authoritativeInferences || []).find((x) => x.id === id); if (!e) throw new Error("missing inference " + id); Object.assign(e, fields); });
}
function depRefs(db, dimensions) {
  const evidence = draftOf(db).ledger.evidence;
  return dimensions.map((dim) => ({ dimension: dim, digest: evidence.dimensions[dim].digest, source: dim === dimensions[0] ? "basis" : "server_rule", ruleId: dim === dimensions[0] ? null : "G14-R-INPUTS-JUDGMENTS" }));
}
const submitBody = (task) => ({ text: text(task.draftAnswers), workflowCard: card(task.draftAnswers), materialStatus: task.materialStatus || "provided", inferences: [], inferenceVerdicts: {}, baseRevision: task.draftRevision });
async function submitTask(db, key = `K-${Math.random()}`) {
  const task = await getTaskFromDb(db);
  return submit(db, submitBody(task), key);
}
async function getTaskFromDb(db) {
  const item = itemOf(db); const draft = draftOf(db);
  return { draftAnswers: draft.answers, materialStatus: item.material_status, draftRevision: draft.revision, draftLedger: draft.ledger, draftInferenceVerdicts: draft.inferenceVerdicts, id: ITEM };
}
console.log("PILOT-09C/G14 · 跨维度依赖与精准失效 —— 定向运行时套件\n");

// G14-01：inputs 修改 → judgments 推断（依赖 inputs）精确失效；无关推断不受影响
{
  const db = fixture();
  const target = entryOfBasis(db, "judgments");
  const unrelated = entryOfBasis(db, "steps");
  const inputsDigest = draftOf(db).ledger.evidence.dimensions.inputs.digest;
  patchInference(db, target.id, { evidenceRefs: [
    { dimension: "judgments", digest: draftOf(db).ledger.evidence.dimensions.judgments.digest, source: "basis", ruleId: null },
    { dimension: "inputs", digest: inputsDigest, source: "server_rule", ruleId: "G14-R-INPUTS-JUDGMENTS" },
  ], proposedDependencyDimensions: ["inputs"], dependencyProposalKey: JSON.stringify({ basis: "judgments", hints: ["inputs"] }), dependencySource: "server_rule", dependencyRuleStatus: "model_rule_validated", dependencyRuleVersion: 1, evidenceVersion: 0, invalidations: [] });
  const res = await put(db, { answers: { inputs: "【G14-01】供应商数据已修复，输入改为内部报表" }, materialStatus: "provided", baseRevision: revOf(db) });
  const after = entryOfBasis(db, "judgments");
  const stepsAfter = entryOfBasis(db, "steps");
  const audit = (after.invalidations || [])[after.invalidations.length - 1] || null;
  check("G14-01a", "改 inputs：依赖 inputs 的 judgments 推断 EV+1、refs 重绑、失效审计含 inputs/digest/规则版本",
    res.status === 200 && after.evidenceVersion === 1 && audit && audit.reason === "dependency_changed" && audit.changed.some((c) => c.dimension === "inputs") && audit.ruleVersion === 1 && audit.previousEvidenceVersion === 0 && audit.newEvidenceVersion === 1,
    `ev=${after.evidenceVersion} audit=${JSON.stringify(audit?.changed || [])}`);
  check("G14-01b", "无关 steps 推断 EV 不变", stepsAfter.evidenceVersion === 0, `stepsEv=${stepsAfter.evidenceVersion}`);
  const early = await submitTask(db, "K-G1401-unjudged");
  check("G14-01c", "未重新判定提交被 422 inferences_unjudged、零事实", early.status === 422 && factsOf(db) === 0 && itemOf(db).submission_version === 0, `status=${early.status}`);
  const task = await getTaskFromDb(db);
  await put(db, { answers: task.draftAnswers, materialStatus: "provided", inferenceVerdicts: echo(infsOf(db)), baseRevision: revOf(db) });
  const sub = await submitTask(db, "K-G1401-ok");
  const row = JSON.parse(itemOf(db).alternative_explanations_json || "[]").find((r) => r.id === after.id);
  check("G14-01d", "重新确认后提交 200，快照含完整 evidenceRefs/依赖元数据/失效审计", sub.status === 200 && row && row.dependencyRuleVersion === 1 && row.invalidations.length >= 1 && row.evidenceRefs.length === 2, `sub=${sub.status} refs=${row?.evidenceRefs?.length} inv=${row?.invalidations?.length}`);
}

// G14-03：inputs 修改，steps 无关推断保持有效并可提交
{
  const db = fixture();
  const stepsBefore = entryOfBasis(db, "steps");
  const res = await put(db, { answers: { inputs: "【G14-03】输入改为内部报表" }, materialStatus: "provided", baseRevision: revOf(db) });
  const stepsAfter = entryOfBasis(db, "steps");
  const stepsVerdict = draftOf(db).inferenceVerdicts[stepsAfter.id];
  const stepsStill = stepsAfter.evidenceVersion === stepsBefore.evidenceVersion
    && stepsVerdict && stepsVerdict.evidenceVersion === stepsAfter.evidenceVersion && stepsVerdict.contentVersion === stepsAfter.contentVersion;
  const task = await getTaskFromDb(db);
  await put(db, { answers: task.draftAnswers, materialStatus: "provided", inferenceVerdicts: echo(infsOf(db)), baseRevision: revOf(db) });
  const sub = await submitTask(db, "K-G1403");
  check("G14-03", "改 inputs：steps 推断 EV/verdict 不变（重判其他后提交 200）", res.status === 200 && stepsStill && sub.status === 200 && factsOf(db) === 5, `ev=${stepsAfter.evidenceVersion} stepsValid=${stepsStill} sub=${sub.status}`);
}

// G14-06：跨维失效后直接提交零副作用
{
  const db = fixture();
  const target = entryOfBasis(db, "judgments");
  patchInference(db, target.id, { evidenceRefs: [
    { dimension: "judgments", digest: draftOf(db).ledger.evidence.dimensions.judgments.digest, source: "basis", ruleId: null },
    { dimension: "inputs", digest: draftOf(db).ledger.evidence.dimensions.inputs.digest, source: "server_rule", ruleId: "G14-R-INPUTS-JUDGMENTS" },
  ], proposedDependencyDimensions: ["inputs"], dependencyProposalKey: JSON.stringify({ basis: "judgments", hints: ["inputs"] }), dependencySource: "server_rule", dependencyRuleStatus: "model_rule_validated", dependencyRuleVersion: 1, evidenceVersion: 0, invalidations: [] });
  await put(db, { answers: { inputs: "【G14-06】输入变更" }, materialStatus: "provided", baseRevision: revOf(db) });
  const rev = revOf(db); const sv = itemOf(db).submission_version; const facts = factsOf(db); const events = eventsOf(db).filter((e) => e.type === "employee_submitted").length; const key = itemOf(db).last_submission_key;
  const sub = await submitTask(db, "K-G1406");
  check("G14-06", "跨维失效后提交被拒且零副作用", [409, 422].includes(sub.status) && revOf(db) === rev && itemOf(db).submission_version === sv && factsOf(db) === facts && eventsOf(db).filter((e) => e.type === "employee_submitted").length === events && itemOf(db).last_submission_key === key, `status=${sub.status}`);
}

// G14-08/14：旧草稿无依赖元数据 → 提交 fail-closed；保存重建后旧判定 stale；重判后 200
{
  const db = fixture();
  tamper(db, (d) => {
    delete d.ledger.evidence.ruleVersion;
    for (const e of d.ledger.authoritativeInferences || []) {
      delete e.dependencyRuleVersion; delete e.dependencySource; delete e.dependencyRuleStatus;
      delete e.evidenceRefs; delete e.evidenceVersion; delete e.invalidations; delete e.proposedDependencyDimensions;
    }
  });
  const before = await submitTask(db, "K-G1408-before");
  const init = await put(db, { answers: draftOf(db).answers, materialStatus: "provided", baseRevision: revOf(db) });
  const afterInit = draftOf(db);
  const inf = afterInit.ledger.authoritativeInferences[0];
  const staleSubmit = await submitTask(db, "K-G1408-stale");
  const task = await getTaskFromDb(db);
  const rejudge = await put(db, { answers: task.draftAnswers, materialStatus: "provided", inferenceVerdicts: echo(infsOf(db)), baseRevision: revOf(db) });
  const rejudgeBody = await jsonOf(rejudge);
  const ok = await submitTask(db, "K-G1408-ok");
  const okBody = await jsonOf(ok);
  check("G14-08", "旧草稿无依赖元数据：直接提交被拒；保存后服务端重建依赖+EV 推进+审计，未重判提交拒；重判后 200",
    [409, 422].includes(before.status) && init.status === 200 && Number.isInteger(inf.dependencyRuleVersion) && inf.invalidations.length >= 1 && [409, 422].includes(staleSubmit.status) && ok.status === 200,
    `before=${before.status} init=${init.status} rejudge=${rejudge.status}/${rejudgeBody.code || ""} stale=${staleSubmit.status} ok=${ok.status}/${okBody.code || ""} ev=${inf.evidenceVersion} inv=${inf.invalidations.length}`);
}

// G14-12：失效审计容量满 → 409 dependency_audit_overflow 零副作用
{
  const db = fixture();
  const target = entryOfBasis(db, "judgments");
  patchInference(db, target.id, { evidenceRefs: [
    { dimension: "judgments", digest: draftOf(db).ledger.evidence.dimensions.judgments.digest, source: "basis", ruleId: null },
    { dimension: "inputs", digest: draftOf(db).ledger.evidence.dimensions.inputs.digest, source: "server_rule", ruleId: "G14-R-INPUTS-JUDGMENTS" },
  ], proposedDependencyDimensions: ["inputs"], dependencyProposalKey: JSON.stringify({ basis: "judgments", hints: ["inputs"] }), dependencySource: "server_rule", dependencyRuleStatus: "model_rule_validated", dependencyRuleVersion: 1, evidenceVersion: 0,
     invalidations: Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, at: "2026-01-01T00:00:00Z", draftRevision: 1, evidenceSeq: 1, reason: "dependency_changed", ruleVersion: 1, changed: [], previousEvidenceVersion: i, newEvidenceVersion: i + 1, verdictStateWas: "valid" })) });
  const rev = revOf(db); const answers = JSON.stringify(draftOf(db).answers); const ev = JSON.stringify(draftOf(db).ledger.evidence);
  const res = await put(db, { answers: { inputs: "【G14-12】容量测试" }, materialStatus: "provided", baseRevision: revOf(db) });
  const body = await jsonOf(res);
  check("G14-12", "失效审计满 20 → 409 dependency_audit_overflow，零副作用、无 slice", res.status === 409 && body.code === "dependency_audit_overflow" && revOf(db) === rev && JSON.stringify(draftOf(db).answers) === answers && JSON.stringify(draftOf(db).ledger.evidence) === ev && infsOf(db).find((e) => e.id === target.id).invalidations.length === 20, `status=${res.status} code=${body.code || ""}`);
}
// ── 扩展（回归轮补充，不放宽既有断言）：提交门禁对规则版本/依赖元数据的 fail-closed 错误码 ──
// G14-14a：evidence.ruleVersion 缺失 → 409 dependency_rule_mismatch
{
  const db = fixture();
  tamper(db, (d) => { delete d.ledger.evidence.ruleVersion; });
  const beforeFacts = factsOf(db); const beforeSv = itemOf(db).submission_version;
  const res = await submitTask(db, "K-G14-GATE-A");
  const body = await jsonOf(res);
  check("G14-14a", "evidence.ruleVersion 缺失 → 409 dependency_rule_mismatch，零事实/零提交",
    res.status === 409 && body.code === "dependency_rule_mismatch" && factsOf(db) === beforeFacts && itemOf(db).submission_version === beforeSv,
    `status=${res.status} code=${body.code || ""}`);
}
// G14-14b：推断 dependencyRuleVersion 缺失 → 409 dependency_rule_mismatch（列出推断 ID）
{
  const db = fixture(); const target = infsOf(db)[0];
  tamper(db, (d) => { delete d.ledger.authoritativeInferences.find((e) => e.id === target.id).dependencyRuleVersion; });
  const res = await submitTask(db, "K-G14-GATE-B");
  const body = await jsonOf(res);
  check("G14-14b", "推断 dependencyRuleVersion 缺失 → 409 dependency_rule_mismatch 且 inferenceIds 命中",
    res.status === 409 && body.code === "dependency_rule_mismatch" && Array.isArray(body.inferenceIds) && body.inferenceIds.includes(target.id) && factsOf(db) === 0,
    `status=${res.status} code=${body.code || ""} ids=${JSON.stringify(body.inferenceIds || [])}`);
}
// G14-14c：推断 dependencySource 缺失 → 409 dependency_metadata_missing
{
  const db = fixture(); const target = infsOf(db)[0];
  tamper(db, (d) => { delete d.ledger.authoritativeInferences.find((e) => e.id === target.id).dependencySource; });
  const res = await submitTask(db, "K-G14-GATE-C");
  const body = await jsonOf(res);
  check("G14-14c", "推断 dependencySource 缺失 → 409 dependency_metadata_missing 且 inferenceIds 命中",
    res.status === 409 && body.code === "dependency_metadata_missing" && Array.isArray(body.inferenceIds) && body.inferenceIds.includes(target.id) && factsOf(db) === 0,
    `status=${res.status} code=${body.code || ""} ids=${JSON.stringify(body.inferenceIds || [])}`);
}
// G14-14d：推断 evidenceRefs 为空/引用了非服务端依赖 → 409 dependency_metadata_missing
{
  const db = fixture(); const target = infsOf(db)[0];
  tamper(db, (d) => { d.ledger.authoritativeInferences.find((e) => e.id === target.id).evidenceRefs = []; });
  const res = await submitTask(db, "K-G14-GATE-D");
  const body = await jsonOf(res);
  check("G14-14d", "推断 evidenceRefs 为空 → 409 dependency_metadata_missing，零写入",
    res.status === 409 && body.code === "dependency_metadata_missing" && factsOf(db) === 0 && itemOf(db).submission_version === 0,
    `status=${res.status} code=${body.code || ""}`);
}
// G14-NORMAL：合法提交快照保留规则版本与逐条依赖版本（服务端可信来源）
{
  const db = fixture();
  const res = await submitTask(db, "K-G14-NORMAL");
  const body = await jsonOf(res);
  const event = eventsOf(db).find((e) => e.type === "employee_submitted");
  const payload = event ? JSON.parse(event.payload) : null;
  check("G14-NORMAL", "合法提交 200 awaiting_verification；快照 evidenceRuleVersion=1 且逐条 dependencyRuleVersion=1、facts=5",
    res.status === 200 && body.item?.status === "awaiting_verification" && factsOf(db) === 5
      && payload && payload.evidenceRuleVersion === 1
      && Array.isArray(payload.inferences) && payload.inferences.length > 0
      && payload.inferences.every((row) => row.dependencyRuleVersion === 1),
    `status=${res.status} evidenceRuleVersion=${payload?.evidenceRuleVersion} depVersions=${JSON.stringify([...new Set((payload?.inferences || []).map((r) => r.dependencyRuleVersion))])}`);
}

// ── 扩展（G14-FIX-CODEX-01 回归轮，只增不放宽）：F01/F02/F03/F04 handler 级回归 ──
// F01：模型依赖建议存在无规则维度 → 不得使用窄范围，必须回退保守潜在依赖集合（全已答维度）。
{
  const db = fixture();
  const target = infsOf(db).find((e) => e.source === "model");
  tamper(db, (d) => {
    const e = d.ledger.authoritativeInferences.find((x) => x.id === target.id);
    delete e.dependencyProposalKey;             // 旧 G14 数据：元数据完整但缺提议指纹
    e.proposedDependencyDimensions = ["handoff"];
    e.evidenceRefs = [{ dimension: e.basis, digest: d.ledger.evidence.dimensions[e.basis].digest, source: "basis", ruleId: null }];
    e.dependencySource = "server_rule";
    e.dependencyRuleStatus = "model_rule_validated";
    e.evidenceVersion = 0; e.invalidations = [];
  });
  const res = await put(db, { answers: draftOf(db).answers, materialStatus: "provided", baseRevision: revOf(db) });
  const after = infsOf(db).find((e) => e.id === target.id);
  const answeredDims = ANSWER_DIMENSIONS.filter((dim) => draftOf(db).ledger.evidence.dimensions[dim] && draftOf(db).ledger.evidence.dimensions[dim].digest);
  const refDims = [...new Set((after.evidenceRefs || []).map((ref) => ref.dimension))].sort();
  const rejected = (after.dependencyHintsRejected || []).some((row) => row.dimension === "handoff" && row.reason === "no_rule");
  check("F01", "依赖建议无规则被拒 → 回退保守潜在依赖（覆盖全部已答维度）、EV+1、指纹更新",
    res.status === 200 && after.dependencySource === "model_conservative_potential"
      && after.dependencyRuleStatus === "model_conservative_potential"
      && JSON.stringify(refDims) === JSON.stringify([...answeredDims].sort()) && rejected
      && after.evidenceVersion === 1
      && after.dependencyProposalKey === JSON.stringify({ basis: after.basis || null, hints: ["handoff"] }),
    `status=${res.status} src=${after.dependencySource} refs=${refDims.length}/${answeredDims.length} ev=${after.evidenceVersion} rejected=${rejected}`);
}

// F02：保守潜在依赖范围随"已答维度集合"动态扩缩容（新增答案维度必须被覆盖并触发重新裁决）。
{
  const six = { ...ANSWERS };
  delete six.burden;
  const db = fixture({ answers: six });
  const target = infsOf(db).find((e) => e.source === "model");
  tamper(db, (d) => {
    const e = d.ledger.authoritativeInferences.find((x) => x.id === target.id);
    const ev = d.ledger.evidence;
    e.evidenceRefs = ANSWER_DIMENSIONS.filter((dim) => ev.dimensions[dim] && ev.dimensions[dim].digest)
      .map((dim) => ({ dimension: dim, digest: ev.dimensions[dim].digest, source: "model_conservative_potential", ruleId: null }));
    e.dependencySource = "model_conservative_potential";
    e.dependencyRuleStatus = "model_conservative_potential";
    e.dependencyProposalKey = JSON.stringify({ basis: e.basis || null, hints: [] });
    e.evidenceVersion = 0; e.invalidations = [];
  });
  const res = await put(db, { answers: { burden: ANSWERS.burden }, materialStatus: "provided", baseRevision: revOf(db) });
  const after = infsOf(db).find((e) => e.id === target.id);
  const refDims = [...new Set((after.evidenceRefs || []).map((ref) => ref.dimension))].sort();
  const audit = (after.invalidations || [])[after.invalidations.length - 1] || null;
  check("F02", "新增已答维度 → 保守范围扩容覆盖 7 维并记录 conservative_dependency_changed、EV+1",
    res.status === 200 && refDims.length === 7 && after.evidenceVersion === 1
      && audit && audit.reason === "conservative_dependency_changed"
      && after.dependencySource === "model_conservative_potential",
    `status=${res.status} refs=${refDims.length} ev=${after.evidenceVersion} reason=${audit?.reason || ""}`);
}

// F03/F04：同 ID 的依赖提议指纹变化 → 重新服务端裁决；失效审计记录**变更前**判定状态。
{
  const db = fixture();
  const target = infsOf(db).find((e) => e.source === "model");
  tamper(db, (d) => {
    const e = d.ledger.authoritativeInferences.find((x) => x.id === target.id);
    e.basis = "judgments";                       // 合法规则：judgments → inputs
    e.proposedDependencyDimensions = ["inputs"]; // 指纹与库中旧值不匹配 → 必须重新裁决
    e.evidenceVersion = 0; e.invalidations = [];
  });
  const res = await put(db, { answers: draftOf(db).answers, materialStatus: "provided", baseRevision: revOf(db) });
  const after = infsOf(db).find((e) => e.id === target.id);
  const audit = (after.invalidations || [])[after.invalidations.length - 1] || null;
  const refDims = [...new Set((after.evidenceRefs || []).map((ref) => ref.dimension))].sort();
  const ruleRef = (after.evidenceRefs || []).find((ref) => ref.source === "server_rule");
  check("F03", "依赖提议指纹变化 → 重新裁决为服务端规则范围（basis+inputs）、EV+1、指纹更新",
    res.status === 200 && after.dependencySource === "server_rule"
      && after.dependencyRuleStatus === "model_rule_validated"
      && JSON.stringify(refDims) === JSON.stringify(["inputs", "judgments"])
      && ruleRef && ruleRef.ruleId === "G14-R-INPUTS-JUDGMENTS"
      && after.evidenceVersion === 1
      && after.dependencyProposalKey === JSON.stringify({ basis: "judgments", hints: ["inputs"] }),
    `status=${res.status} src=${after.dependencySource} refs=${JSON.stringify(refDims)} rule=${ruleRef?.ruleId || ""} ev=${after.evidenceVersion}`);
  check("F04", "失效审计记录变更前判定状态（verdictStateWas=valid）与前后 evidenceVersion",
    audit && audit.reason === "dependency_proposal_changed" && audit.verdictStateWas === "valid"
      && audit.previousEvidenceVersion === 0 && audit.newEvidenceVersion === 1,
    `reason=${audit?.reason || ""} verdictStateWas=${audit?.verdictStateWas || ""} ${audit?.previousEvidenceVersion}->${audit?.newEvidenceVersion}`);
}

const failed = results.filter((r) => !r.ok);
console.log("\n──────────────── 汇总 ────────────────");
console.log(`  PASS=${results.length - failed.length}  FAIL=${failed.length}`);
if (failed.length) { console.error("  G14 定向套件失败:", failed.map((r) => r.id).join(", ")); process.exitCode = 1; }
else console.log("  pilot09c g14 runtime: ok");
