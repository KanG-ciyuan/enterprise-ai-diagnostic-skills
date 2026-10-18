/**
 * PILOT-09C/FIX-07A —— 提交快照判定历史完整性（R07-F01）· 定向运行时套件（基座取自 06A）
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
/**
 * PILOT-09C/FIX-07A —— 提交快照判定历史完整性（R07-F01）· 定向运行时套件
 *
 * 根因：`buildPersistedInferences()` 曾对 stamp.history 使用 slice(-10)，导致
 * `alternative_explanations_json` 与 `employee_submitted.payload.inferences` 静默丢失
 * 旧 verdict.history。本套件验证修复后快照与草稿一致、最早条目保留、等待分支不生成
 * 快照、旧数据受控初始化路径同样保留、客户端伪造历史不被接受。
 */
const results = [];
const check = (id, name, ok, note = "") => { results.push({ id, name, ok, note }); console.log(`${ok ? "✔ PASS" : "✘ FAIL"} [${id}] ${name}${note ? " | " + note : ""}`); };

const ALT = (db) => { try { return JSON.parse(itemOf(db).alternative_explanations_json || "[]"); } catch { return []; } };
const subEvent = (db) => { const e = eventsOf(db).find((x) => x.type === "employee_submitted"); return e ? JSON.parse(e.payload) : null; };
const rowOf = (rows, id) => (rows || []).find((r) => r && r.id === id) || null;
function setHistory(db, id, count, marker = "HIST") {
  tamper(db, (d) => {
    const v = d.inferenceVerdicts[id];
    v.history = Array.from({ length: count }, (_, i) => ({ verdict: "confirmed", correction: "", contentVersion: 1, evidenceHash: `${marker}-${i}`, supersededAt: "2026-01-01T00:00:00Z" }));
  });
}
console.log("PILOT-09C/FIX-07A · 提交快照判定历史完整性 —— 定向运行时套件\n");

// R1：history 恰好 10 → 快照 10、最早保留
{
  const db = fixture(); const id = infsOf(db)[0].id; setHistory(db, id, 10, "OLDEST-0");
  const res = await submit(db, subBody(ANSWERS), "K-R1");
  const row = rowOf(ALT(db), id); const payloadRow = rowOf((subEvent(db)?.inferences) || [], id);
  check("R1", "history=10 → 提交 200，快照 history=10 且最早 OLDEST-0 保留",
    res.status === 200 && row && row.history.length === 10 && row.history[0].evidenceHash === "OLDEST-0-0" && payloadRow && payloadRow.history.length === 10,
    `status=${res.status} snapshot=${row ? row.history.length : "-"} first=${row && row.history[0] && row.history[0].evidenceHash}`);
}
// R2：旧数据 history=12 → 快照必须完整 12（修复前会被截成 10）
{
  const db = fixture(); const id = infsOf(db)[0].id; setHistory(db, id, 12, "OLDEST-0");
  const before = draftOf(db).inferenceVerdicts[id].history.length;
  const res = await submit(db, subBody(ANSWERS), "K-R2");
  const row = rowOf(ALT(db), id); const payloadRow = rowOf((subEvent(db)?.inferences) || [], id);
  check("R2", "history=12 → 提交 200，快照 alternative_explanations_json 与 employee_submitted payload 均完整保留 12 条/最早条目",
    res.status === 200 && before === 12 && row && row.history.length === 12 && row.history[0].evidenceHash === "OLDEST-0-0" && payloadRow && payloadRow.history.length === 12,
    `status=${res.status} draftBefore=${before} snapshot=${row ? row.history.length : "-"} payload=${payloadRow ? payloadRow.history.length : "-"} first=${row && row.history[0] && row.history[0].evidenceHash}`);
}
// R3：等待核验人分支 + history=12 → 不生成提交快照，草稿保留 12
{
  const db = fixture({ verifierReady: false }); const id = infsOf(db)[0].id; setHistory(db, id, 12, "OLDEST-0");
  const res = await submit(db, subBody(ANSWERS), "K-R3");
  const body = await jsonOf(res); const alt = ALT(db); const draftHist = draftOf(db).inferenceVerdicts[id].history.length;
  check("R3", "等待核验人分支 409 verifier_not_ready，不生成提交快照，草稿 history 12 完整",
    res.status === 409 && body.code === "verifier_not_ready" && alt.length === 0 && factsOf(db) === 0 && draftHist === 12,
    `status=${res.status} code=${body.code || ""} altRows=${alt.length} draftHist=${draftHist}`);
}
// R4：旧数据受控初始化（无 evidence/版本）+ history=12 → 重新确认后提交，快照仍 12
{
  const db = fixture(); const id = infsOf(db)[0].id;
  tamper(db, (d) => {
    delete d.ledger.evidence; d.ledger.statementHistory = [];
    for (const e of d.ledger.authoritativeInferences || []) { delete e.evidenceVersion; delete e.evidenceRefs; delete e.evidenceHistory; }
    const v = d.inferenceVerdicts[id]; delete v.evidenceVersion; v.verdict = "confirmed"; v.correction = ""; v.history = Array.from({ length: 12 }, (_, i) => ({ verdict: "confirmed", correction: "", contentVersion: 1, evidenceHash: `OLDEST-0-${i}`, supersededAt: "2026-01-01T00:00:00Z" }));
  });
  const init = await put(db, { answers: ANSWERS, materialStatus: "provided", baseRevision: revOf(db) });
  const ev = draftOf(db).ledger?.evidence || {};
  const infs = infsOf(db);
  const resave = await put(db, { answers: ANSWERS, materialStatus: "provided", inferenceVerdicts: echo(infs), baseRevision: revOf(db) });
  const res = await submit(db, subBody(ANSWERS), "K-R4");
  const row = rowOf(ALT(db), id);
  check("R4", "旧数据受控初始化（legacyInitialized/source）+ history 12 → 提交快照完整保留 12 条",
    init.status === 200 && ev.legacyInitialized === true && resave.status === 200 && res.status === 200 && row && row.history.length === 12 && row.history[0].evidenceHash === "OLDEST-0-0",
    `init=${init.status} legacy=${ev.legacyInitialized} resave=${resave.status} submit=${res.status} snapshot=${row ? row.history.length : "-"}`);
}
// R5：客户端伪造 history=99 → 服务端不接受；提交快照取服务端 12 条
{
  const db = fixture(); const id = infsOf(db)[0].id; setHistory(db, id, 12, "OLDEST-0");
  const before = draftOf(db).inferenceVerdicts[id].history.length;
  const forged = { answers: ANSWERS, materialStatus: "provided", baseRevision: revOf(db),
    inferenceVerdicts: { [id]: { verdict: "agree", correction: "", contentVersion: 1, templateVersion: 1, evidenceHash: "EH-FAKE", evidenceVersion: 0, history: Array.from({ length: 99 }, (_, i) => ({ verdict: "confirmed", evidenceHash: `FORGED-${i}` })) } },
    ledger: { evidence: { legacyInitialized: true, source: "legacy_controlled_init" }, statementHistory: [{ seq: 1, dimension: "trigger", text: "FORGED" }] } };
  const putRes = await put(db, forged);
  const afterPut = draftOf(db).inferenceVerdicts[id].history;
  const res = await submit(db, subBody(ANSWERS), "K-R5");
  const row = rowOf(ALT(db), id);
  const forgedRejected = !afterPut.some((h) => String(h.evidenceHash || "").startsWith("FORGED"));
  check("R5", "客户端伪造 history=99 被服务端忽略（DB 仍 12 条），提交快照取服务端 12 条完整历史",
    putRes.status === 200 && before === 12 && afterPut.length === 12 && forgedRejected && res.status === 200 && row && row.history.length === 12 && row.history[0].evidenceHash === "OLDEST-0-0",
    `put=${putRes.status} dbHist=${afterPut.length} forgedRejected=${forgedRejected} submit=${res.status} snapshot=${row ? row.history.length : "-"}`);
}
// NORMAL：正常合法提交不受影响
{
  const db = fixture();
  const res = await submit(db, subBody(ANSWERS), "K-NORMAL-07A");
  const row = rowOf(ALT(db), infsOf(db)[0].id);
  check("NORMAL", "正常合法提交 200 / awaiting_verification / facts=5，快照正常生成",
    res.status === 200 && itemOf(db).status === "awaiting_verification" && factsOf(db) === 5 && row && Array.isArray(row.history),
    `status=${res.status} facts=${factsOf(db)} snapshot=${row ? row.history.length : "-"}`);
}

const failed = results.filter((r) => !r.ok);
console.log("\n──────────────── 汇总 ────────────────");
console.log(`  PASS=${results.length - failed.length}  FAIL=${failed.length}`);
if (failed.length) { console.error("  FIX-07A 定向套件失败:", failed.map((r) => r.id).join(", ")); process.exitCode = 1; }
else console.log("  pilot09c fix-07a runtime: ok");
