/**
 * PILOT-09C/FIX-CODEX-03A —— R03-01 提交版本绑定与 F05 收口 · 定向运行时套件
 *
 * 覆盖：
 *   A. 正常提交与等待核验人分支都必须携带/校验 baseRevision；缺失/非法 fail-closed（428）。
 *   B. 旧版本提交 → 409，且不写 employee_description / workflow_card_json / material_status /
 *      employee_draft_json / 任何提交状态。
 *   C. 当前版本正常提交 → 200；候选事实落库。
 *   D. 等待态提交：revision N→N+1、单条 CAS、无归零、答案/证据基线/判定不变（不触发 stale）。
 *   E. 等待态幂等：完整载荷相同 → 不重复推进 revision；相同文本但卡片/材料不同 → 必须落库。
 *   F. Idempotency-Key 复用不同载荷 → 409 idempotency_key_reuse，不重复提交。
 *   G. 核验人状态竞态：处理期间核验人变为就绪 → 409 verifier_ready，不写 blocked 状态。
 *   H. 并发：保存先成功/提交先成功两种顺序，revision 单调且无静默丢失更新。
 *   I. 前端契约：提交载荷携带 baseRevision、等待态提交后同步 draftRevision。
 *
 * 真实 handler + 内存 D1（node:sqlite）；不触网、不使用真实密钥。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { draftRevisionOf, normalizeEmployeeDraft, serializeEmployeeDraft } from "../functions/_shared.js";
import { ANSWER_DIMENSIONS as EVIDENCE_DIMENSIONS, canonicalJson as evidenceCanonicalJson, normalizeAnswers as evidenceNormalizeAnswers } from "../functions/api/agent/_evidence.js";
import { appendStatementHistory } from "../functions/api/agent/_adapter.js";
import { onRequestPut as saveDraft } from "../functions/api/work-items/[itemId]/employee-draft.js";
import { onRequestPost as submitEmployee } from "../functions/api/work-items/[itemId]/employee-submission.js";
import { buildInferenceRecords, resolveInferenceJudgment } from "../functions/api/agent/_adapter.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

const P = "PRJ-R03A";
const ITEM = "WI-R03A";
const EMP = "ACC-R03A-EMP";
const VER = "ACC-R03A-VER";
const TOK = "TOK-R03A";

/** 员工七维答案：夹具草稿与提交载荷的唯一来源（trigger 沿用原夹具的"初始答案"）。 */
const ANSWERS = {
  trigger: "初始答案",
  inputs: "先看昨天的曝光和点击数据，再看库存数量，然后确认投放预算还剩多少",
  steps: "先选品再写脚本，然后让剪辑同事剪出来，最后在后台提交审核并发布",
  judgments: "毛利率低于一成要先找主管确认，其他价格我自己按历史数据定",
  exceptions: "版权不确定就换同款，审核被拒就先改文案再重新提交",
  handoff: "剪完的素材交给投放同事小李，由他挂车和设置出价",
  burden: "一条视频从选题到发布大约需要三个小时，一周做五条左右",
};
// ── PILOT-09C/IMPLEMENT-05A（F04）：正式提交只承认由服务端草稿派生的规范卡/文本 ──
// 规范值 = 已持久化草稿 answers + work_items.material_status；客户端载荷不一致时
// 正常分支 422（card_evidence_mismatch / submission_text_mismatch），等待核验人分支同样校验。
// 本套件的夹具答案与提交载荷因此同源派生；原断言的版本/门禁语义不变。
const ANSWER_DIMENSIONS = [
  ["trigger", "从哪里开始"], ["inputs", "先看什么"], ["steps", "实际怎么做"],
  ["judgments", "哪些情况不能自己决定"], ["exceptions", "卡住后怎么办"],
  ["handoff", "交给谁"], ["burden", "大约多久"],
];
const MATERIAL_INDEX_LABELS = {
  provided: "员工已说明有材料，等待登记",
  none_available: "目前没有可提供的材料",
  undecided: "尚未选择",
};
const canonicalCard = (answers, materialStatus = "provided") => {
  const card = {};
  for (const [key] of ANSWER_DIMENSIONS) card[key] = String(answers[key] || "").trim();
  card.materialIndex = MATERIAL_INDEX_LABELS[materialStatus];
  return card;
};
const canonicalText = (answers) => ANSWER_DIMENSIONS.map(([key, label]) => `${label}：${String(answers[key] || "").trim()}`).join("\n\n");
const SUBMIT_TEXT = canonicalText(ANSWERS);

const results = [];
const pass = (id, name, note = "") => results.push({ id, name, verdict: "PASS", note });
const fail = (id, name, note = "") => results.push({ id, name, verdict: "FAIL", note });
const check = (id, name, ok, note = "") => (ok ? pass(id, name, note) : fail(id, name, note));

function trustedRecords(count = 2) {
  return buildInferenceRecords([], Array.from({ length: count }, (_, i) => ({
    source: "model",
    text: `R03-01 基线推断 ${i + 1}：服务端权威记录`,
    basis: "steps",
    assumes: "若与实际不符需更正",
  }))).records;
}
const verdictEcho = (records) => Object.fromEntries(records.map((entry) => [entry.id, {
  verdict: "agree", correction: "",
  contentVersion: entry.contentVersion, templateVersion: entry.templateVersion === undefined ? null : entry.templateVersion,
  evidenceHash: entry.evidenceHash || null,
  // F03：判定必须回显条目当前 evidenceVersion。
  evidenceVersion: Number.isInteger(entry.evidenceVersion) ? entry.evidenceVersion : 0,
}]));

// ── PILOT-09C/IMPLEMENT-05B（F03）：服务端证据状态夹具 ───────────────────────
// F03 起正式提交要求 ledger.evidence / statementHistory 与答案一致，推断带
// evidenceVersion/evidenceRefs，判定回显 evidenceVersion。旧夹具只播种答案/推断。
// 这里用服务端构建函数生成与真实统一证据写入同构的状态（摘要用 node:crypto
// 按同一 SHA-256 算法独立计算），保持既有 revision/断言数值不变。
const evidenceSha256 = (value) => `sha256:${createHash("sha256").update(String(value), "utf8").digest("hex")}`;
function seedEvidenceState({ answers = {}, inferences = [], revision = 0, verdicts = null, defaultVerdict = "agree" }) {
  const normalized = evidenceNormalizeAnswers(answers);
  let history = [];
  for (const dimension of EVIDENCE_DIMENSIONS) {
    if (!normalized[dimension]) continue;
    history = appendStatementHistory({ prior: history, dimension, text: normalized[dimension], revision }).history;
  }
  const dimensions = {};
  for (const dimension of EVIDENCE_DIMENSIONS) {
    dimensions[dimension] = { digest: normalized[dimension] ? evidenceSha256(normalized[dimension]) : null, seq: normalized[dimension] ? 1 : 0 };
  }
  const evidence = {
    schemaVersion: 1, seq: history.length ? 1 : 0,
    answersDigest: evidenceSha256(evidenceCanonicalJson(normalized)),
    dimensions, revision, updatedAt: new Date().toISOString(),
    // PILOT-09C/G14：证据/依赖规则版本（提交门禁要求 === G14_RULE_VERSION=1）。
    ruleVersion: 1,
  };
  const seededInferences = inferences.map((entry) => {
    const basis = EVIDENCE_DIMENSIONS.includes(entry.basis) ? entry.basis : null;
    const isTemplate = entry.source === "server_template";
    const suppliedRefs = Array.isArray(entry.evidenceRefs)
      ? entry.evidenceRefs.filter((ref) => ref && EVIDENCE_DIMENSIONS.includes(ref.dimension)) : [];
    // PILOT-09C/G14：生成服务端同构的依赖元数据。模板固定依赖 basis；模型缺少建议时绑定全部已答维度。
    const refs = isTemplate
      ? (basis && dimensions[basis] && dimensions[basis].digest
        ? [{ dimension: basis, digest: dimensions[basis].digest, source: "server_template_fixed", ruleId: null }] : [])
      : (suppliedRefs.length
        ? suppliedRefs.map((ref) => ({
          dimension: ref.dimension,
          digest: dimensions[ref.dimension].digest,
          source: typeof ref.source === "string" ? ref.source : "basis",
          ruleId: ref.ruleId === undefined ? null : ref.ruleId,
        }))
        : (basis && dimensions[basis] && dimensions[basis].digest
          ? [{ dimension: basis, digest: dimensions[basis].digest, source: "basis", ruleId: null }] : []));
    // PILOT-09C/G14-FIX-CODEX-01（F03）：依赖提议指纹必须与当前 basis/proposedDependencyDimensions
    // 一致；保存时指纹缺失或不匹配会触发服务端重新裁决（EV++），使既有判定意外失效。
    const hintDimensions = suppliedRefs.length && !isTemplate
      ? [...new Set(suppliedRefs.filter((ref) => ref.dimension !== basis).map((ref) => ref.dimension))].sort()
      : [];
    return {
      ...entry,
      evidenceVersion: Number.isInteger(entry.evidenceVersion) ? entry.evidenceVersion : 0,
      // FINAL-FIX-01: no model suggestion means conservative scope, never a fabricated basis-only rule.
      evidenceRefs: isTemplate ? refs : EVIDENCE_DIMENSIONS.filter((dim) => dimensions[dim]?.digest)
        .map((dimension) => ({ dimension, digest: dimensions[dimension].digest, source: "model_conservative_potential", ruleId: null })),
      dependencyRuleVersion: 1,
      dependencySource: isTemplate ? "server_template_fixed" : "model_conservative_potential",
      dependencyRuleStatus: isTemplate ? "server_template_fixed" : "model_conservative_potential",
      proposedDependencyDimensions: hintDimensions,
      dependencyHintsRejected: [],
      invalidations: Array.isArray(entry.invalidations) ? entry.invalidations : [],
      dependencyProposalKey: JSON.stringify({ basis: basis || null, hints: hintDimensions }),
    };
  });
  const seededVerdicts = {};
  for (const entry of seededInferences) {
    const supplied = verdicts && verdicts[entry.id] ? verdicts[entry.id] : null;
    if (!supplied && !defaultVerdict) continue;
    seededVerdicts[entry.id] = {
      verdict: supplied ? supplied.verdict : defaultVerdict,
      correction: supplied ? String(supplied.correction || "") : "",
      contentVersion: entry.contentVersion,
      templateVersion: entry.templateVersion === undefined ? null : entry.templateVersion,
      evidenceHash: entry.evidenceHash || null,
      evidenceVersion: entry.evidenceVersion,
    };
  }
  return { normalized, history, evidence, inferences: seededInferences, verdicts: seededVerdicts };
}

/**
 * fixture：合法项目 + 员工任务。
 * opts.verifierReady：核验人已接受邀请（true）或无成员邀请（false）
 * opts.revision：草稿 revision；opts.answers；opts.records；opts.verdicts
 * opts.status / opts.stage / opts.submissionVersion / opts.workflowCard / opts.materialStatus
 */
function fixture(opts = {}) {
  const {
    verifierReady = false,
    revision = 0,
    answers = ANSWERS,
    records = [],
    verdicts = {},
    status = "needs_input",
    stage = "mapping",
    submissionVersion = 0,
    workflowCard = {},
    materialStatus = "provided",
    employeeDescription = "",
  } = opts;
  const db = new D1Harness();
  // F03：播种与真实统一证据写入同构的 evidence / statementHistory / 推断证据版本。
  // 未显式提供推断基线时使用默认服务端基线（提交门禁要求"有访谈证据"）。
  const baseRecords = records.length ? records : trustedRecords(2);
  const evidenceSeed = seedEvidenceState({ answers, inferences: baseRecords, revision, verdicts });
  const draft = serializeEmployeeDraft({
    answers,
    ledger: {
      statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: evidenceSeed.evidence,
      authoritativeInferences: evidenceSeed.inferences, statementHistory: evidenceSeed.history, burdenAsked: false,
    },
    inferenceVerdicts: evidenceSeed.verdicts,
    submissionText: "",
    revision,
  });
  const verifierInvitation = verifierReady
    ? `('INV-R03A-VER','inv-r03a-ver','${P}','${EMP}','ver@r03a.invalid','verifier','project','accepted','2099-01-01T00:00:00Z','${VER}','IK-R03A')`
    : `('INV-R03A-VER','inv-r03a-ver','${P}','${EMP}','ver@r03a.invalid','verifier','project','pending','2099-01-01T00:00:00Z',NULL,'IK-R03A')`;
  const verifierMembership = verifierReady
    ? `INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES ('${P}','${VER}','verifier','project','active');`
    : "";
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('${EMP}','emp@r03a.invalid','员工甲','active','member'),
      ('${VER}','ver@r03a.invalid','核验人乙','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage)
      VALUES ('${P}','R03-01 验证','选品到发布','${stage}','active','unknown','external_builder','${EMP}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status)
      VALUES ('${P}','${EMP}','employee','project','active');
    ${verifierMembership}
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at)
      VALUES ('AUTH-R03A','${P}','授权','王总','o@r03a.invalid','只读','DOC','authorized','${EMP}','k','n','h','2099-01-01T00:00:00Z');
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,accepted_account_id,idempotency_key)
      VALUES ${verifierInvitation};
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,material_status,flow_card_version,evidence_version,submission_version,employee_description,workflow_card_json)
      VALUES ('${ITEM}','${P}','还原工作','d','${stage}','${status}','employee','员工甲',0,'b','n','${EMP}',
              ${verifierReady ? `'${VER}'` : "NULL"},'${draft.replace(/'/g, "''")}','${materialStatus}',1,1,${submissionVersion},'${employeeDescription.replace(/'/g, "''")}','${JSON.stringify(workflowCard).replace(/'/g, "''")}');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token)
      VALUES ('${TOK}','${EMP}','${P}','2099-01-01T00:00:00Z','R-R03A');
  `);
  return db;
}

const draftOf = (db) => normalizeEmployeeDraft(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
const revisionOf = (db) => draftRevisionOf(JSON.parse(db.get("SELECT employee_draft_json FROM work_items WHERE id=?", ITEM).employee_draft_json));
const itemOf = (db) => db.get("SELECT * FROM work_items WHERE id=?", ITEM);
const factsOf = (db) => db.all("SELECT * FROM candidate_facts WHERE work_item_id=? ORDER BY id", ITEM);
const jsonOf = async (response) => response.clone().json().catch(() => ({}));

const submit = (db, body, key = "K-R03A", envDB = null) => submitEmployee({
  request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-submission`, TOK, body, { "Idempotency-Key": key }),
  env: { DB: envDB || db }, params: { itemId: ITEM },
});
const put = (db, body) => saveDraft({
  request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, TOK, body),
  env: { DB: db }, params: { itemId: ITEM },
});
const submissionBody = (extra = {}) => ({ text: canonicalText(ANSWERS), workflowCard: canonicalCard(ANSWERS, "provided"), materialStatus: "provided", inferences: [], inferenceVerdicts: {}, ...extra });
const snapshotSubmissionFields = (db) => {
  const item = itemOf(db);
  const draft = JSON.parse(item.employee_draft_json || "{}");
  return JSON.stringify({
    employee_description: item.employee_description,
    workflow_card_json: item.workflow_card_json,
    material_status: item.material_status,
    stage: item.stage,
    status: item.status,
    submission_version: item.submission_version,
    assigned_verifier_id: item.assigned_verifier_id,
    draft_revision: draft.revision,
    draft_answers: draft.answers || {},
    draft_verdicts: draft.inferenceVerdicts || {},
    facts: factsOf(db).length,
  });
};

console.log("PILOT-09C/FIX-CODEX-03A · R03-01 提交版本绑定与 F05 收口 —— 定向运行时套件\n");

// ═══════════════════════════════════════════════════════════════
console.log("── A. 缺失/非法 baseRevision（正常提交 & 等待核验人分支）──");
{
  const db = fixture({ verifierReady: true, revision: 3 });
  const before = snapshotSubmissionFields(db);
  const cases = [
    ["normal-missing", submissionBody(), "missing"],
    ["normal-string", submissionBody({ baseRevision: "3" }), "string"],
    ["normal-negative", submissionBody({ baseRevision: -1 }), "negative"],
    ["normal-float", submissionBody({ baseRevision: 3.5 }), "float"],
  ];
  for (const [id, body] of cases) {
    const res = await submit(db, body, `K-${id}`);
    const resBody = await jsonOf(res);
    check(`A-${id}`, `正常提交 ${id} → 428 base_revision_required，且无任何写入`,
      res.status === 428 && resBody.code === "base_revision_required" && snapshotSubmissionFields(db) === before,
      `${res.status} ${resBody.code || ""}`);
  }
  const blockedDB = fixture({ verifierReady: false, revision: 4 });
  const blockedBefore = snapshotSubmissionFields(blockedDB);
  for (const [id, body] of [["blocked-missing", submissionBody()], ["blocked-invalid", submissionBody({ baseRevision: null })]]) {
    const res = await submit(blockedDB, body, `K-${id}`);
    const resBody = await jsonOf(res);
    check(`A-${id}`, `等待核验人分支 ${id} → 428，且不写 blocked 状态/草稿`,
      res.status === 428 && resBody.code === "base_revision_required" && snapshotSubmissionFields(blockedDB) === blockedBefore,
      `${res.status} ${resBody.code || ""}`);
  }
  db.close(); blockedDB.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── B. 旧版本/未来版本提交：409 且所有关键字段不变 ──");
{
  const db = fixture({ verifierReady: true, revision: 3, answers: { trigger: "初始答案" } });
  const before = snapshotSubmissionFields(db);
  const stale = await submit(db, submissionBody({ baseRevision: 2, text: `${SUBMIT_TEXT}\n\n（旧提交）`, workflowCard: canonicalCard({ ...ANSWERS, steps: "旧卡片步骤" }) }), "K-B-stale");
  const staleBody = await jsonOf(stale);
  check("B1", "正常提交旧版本 → 409 submission_conflict(stale_base_revision)，无任何写入",
    stale.status === 409 && staleBody.code === "submission_conflict" && staleBody.reason === "stale_base_revision"
      && snapshotSubmissionFields(db) === before,
    `${stale.status} ${staleBody.code || ""}/${staleBody.reason || ""}`);
  const future = await submit(db, submissionBody({ baseRevision: 99 }), "K-B-future");
  const futureBody = await jsonOf(future);
  check("B2", "未来版本 → 409，无任何写入", future.status === 409 && snapshotSubmissionFields(db) === before,
    `${future.status} ${futureBody.code || ""}`);

  const blockedDB = fixture({ verifierReady: false, revision: 4, answers: { trigger: "初始答案" } });
  const blockedBefore = snapshotSubmissionFields(blockedDB);
  const blockedStale = await submit(blockedDB, submissionBody({ baseRevision: 3 }), "K-B-blocked-stale");
  const blockedStaleBody = await jsonOf(blockedStale);
  check("B3", "等待核验人分支旧版本 → 409，且 revision/状态/草稿均不变",
    blockedStale.status === 409 && blockedStaleBody.code === "submission_conflict"
      && blockedStaleBody.reason === "stale_base_revision" && snapshotSubmissionFields(blockedDB) === blockedBefore,
    `${blockedStale.status} ${blockedStaleBody.code || ""}`);
  db.close(); blockedDB.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── C. 当前版本正常提交成功；候选事实落库 ──");
{
  const db = fixture({ verifierReady: true, revision: 3 });
  const ok = await submit(db, submissionBody({ baseRevision: 3 }), "K-C-ok");
  const body = await jsonOf(ok);
  const item = itemOf(db);
  check("C1", "当前版本正常提交 → 200 awaiting_verification，候选事实 5 条、revision 不变",
    ok.status === 200 && body.item?.status === "awaiting_verification"
      && factsOf(db).length === 5 && revisionOf(db) === 3 && item.submission_version === 1,
    `status=${ok.status} item=${body.item?.status || ""} facts=${factsOf(db).length} rev=${revisionOf(db)}`);
  // 既有的成功提交后重放：任务已转交核验人 → 归属守卫 403（原契约：比幂等重放更严格）。
  const rejectedReplay = await submit(db, submissionBody({ baseRevision: 3 }), "K-C-ok");
  const rejectedReplayBody = await jsonOf(rejectedReplay);
  check("C2", "成功提交后原员工重放 → 403（归属守卫），不重复写入/记账",
    rejectedReplay.status === 403 && factsOf(db).length === 5 && revisionOf(db) === 3,
    `${rejectedReplay.status} ${rejectedReplayBody.code || ""} facts=${factsOf(db).length}`);
  // 受控测试：把 assignee 复位为原员工（模拟“幂等记录存在但归属检查可过”的窗口），
  // 覆盖 Idempotency-Key 完整载荷摘要分支。
  db.prepare("UPDATE work_items SET assignee_account_id=? WHERE id=?").bind(EMP, ITEM).run();
  const reused = await submit(db, submissionBody({ baseRevision: 3, text: `${SUBMIT_TEXT}\n\n（不同载荷）` }), "K-C-ok");
  const reusedBody = await jsonOf(reused);
  check("C3", "同一 Idempotency-Key 复用不同完整载荷 → 409 idempotency_key_reuse，不重复提交",
    reused.status === 409 && reusedBody.code === "idempotency_key_reuse" && factsOf(db).length === 5 && revisionOf(db) === 3,
    `${reused.status} ${reusedBody.code || ""} facts=${factsOf(db).length}`);
  const replay = await submit(db, submissionBody({ baseRevision: 3 }), "K-C-ok");
  const replayBody = await jsonOf(replay);
  check("C4", "同一 Idempotency-Key 同一完整载荷重放 → 返回原响应（不新增事实/不改状态）",
    replay.status === 200 && replayBody.item?.status === "awaiting_verification" && factsOf(db).length === 5,
    `${replay.status} item=${replayBody.item?.status || ""} facts=${factsOf(db).length}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── D. 等待核验人分支：N→N+1、单条 CAS、证据版本不失效 ──");
{
  const records = trustedRecords(2);
  const db = fixture({ verifierReady: false, revision: 2, answers: ANSWERS, records, verdicts: verdictEcho(records) });
  // 推进 revision 到 3（合法草稿保存）
  const advance = await put(db, { answers: { trigger: "初始答案" }, materialStatus: "provided", ledger: null, inferenceVerdicts: {}, baseRevision: 2 });
  const before = draftOf(db);
  const beforeEvidence = JSON.stringify((before.ledger?.authoritativeInferences || []).map((entry) => ({
    id: entry.id, cv: entry.contentVersion, eh: entry.evidenceHash, quote: entry.quote,
  })));
  const blocked = await submit(db, submissionBody({ baseRevision: 3 }), "K-D-blocked");
  const blockedBody = await jsonOf(blocked);
  const after = draftOf(db);
  const item = itemOf(db);
  const afterEvidence = JSON.stringify((after.ledger?.authoritativeInferences || []).map((entry) => ({
    id: entry.id, cv: entry.contentVersion, eh: entry.evidenceHash, quote: entry.quote,
  })));
  const verdictsStillValid = (after.ledger?.authoritativeInferences || []).every((entry) => resolveInferenceJudgment(entry, after.inferenceVerdicts) === "valid");
  check("D1", "等待态提交 → 409 verifier_not_ready，revision 3→4（严格 +1，绝不归零）",
    advance.status === 200 && blocked.status === 409 && blockedBody.code === "verifier_not_ready"
      && Number(blockedBody.task?.draftRevision) === 4 && revisionOf(db) === 4,
    `status=${blocked.status} respRev=${blockedBody.task?.draftRevision} dbRev=${revisionOf(db)}`);
  check("D2", "等待态提交保留答案/基线；不把旧快照写回；不产生候选事实/提交版本",
    JSON.stringify(after.answers) === JSON.stringify(before.answers)
      && afterEvidence === beforeEvidence && item.status === "blocked_draft"
      && item.submission_version === 0 && factsOf(db).length === 0,
    `answersEqual=${JSON.stringify(after.answers) === JSON.stringify(before.answers)} evidenceEqual=${afterEvidence === beforeEvidence} version=${item.submission_version}`);
  check("D3", "等待态提交推进 draft revision 不得令证据判定 stale（不把 revision 当 evidenceDigest）",
    verdictsStillValid, `valid=${(after.ledger?.authoritativeInferences || []).filter((entry) => resolveInferenceJudgment(entry, after.inferenceVerdicts) === "valid").length}/${(after.ledger?.authoritativeInferences || []).length}`);
  // 旧版本请求仍被拒绝
  const staleSave = await put(db, { answers: { trigger: "旧页面写入" }, materialStatus: "provided", ledger: null, inferenceVerdicts: {}, baseRevision: 3 });
  check("D4", "等待态提交后，用提交前版本保存仍 409，数据不变",
    staleSave.status === 409 && revisionOf(db) === 4 && JSON.stringify(draftOf(db).answers) === JSON.stringify(after.answers),
    `${staleSave.status} revision=${revisionOf(db)}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── E. 等待态幂等：完整载荷相同不推进；卡片/材料变化必须落库 ──");
{
  const db = fixture({ verifierReady: false, revision: 3, answers: ANSWERS });
  const first = await submit(db, submissionBody({ baseRevision: 3 }), "K-E-1");
  const firstBody = await jsonOf(first);
  const revisionAfterFirst = revisionOf(db);
  const duplicate = await submit(db, submissionBody({ baseRevision: revisionAfterFirst }), "K-E-dup");
  const duplicateBody = await jsonOf(duplicate);
  check("E1", "同一完整载荷重复等待态提交 → 幂等（revision 不再推进，仍返回 verifier_not_ready）",
    first.status === 409 && firstBody.code === "verifier_not_ready"
      && duplicate.status === 409 && duplicateBody.code === "verifier_not_ready"
      && revisionOf(db) === revisionAfterFirst,
    `firstRev=${revisionAfterFirst} dupRev=${revisionOf(db)} dupCode=${duplicateBody.code || ""}`);
  // IMPLEMENT-05A 适配：新契约下"卡片/材料"必须与**服务端草稿**逐字段一致，
  // 因此先按真实流程把新答案 + 新材料状态合法保存进草稿（revision +1），
  // 再用由草稿派生的规范卡/文本提交；这样提交载荷与首次不同 ⇒ 不得判为重复。
  // 因多了一次合法保存，最终 revision 预期由 revisionAfterFirst+1 调整为 +2（断言强度不变）。
  const changedAnswers = { ...ANSWERS, steps: "相同文本对应的新步骤（E2 卡片步骤已更新）" };
  const changedMaterial = "none_available";
  const changedSave = await put(db, { answers: changedAnswers, materialStatus: changedMaterial, baseRevision: revisionAfterFirst });
  const changed = await submit(db, { text: canonicalText(changedAnswers), workflowCard: canonicalCard(changedAnswers, changedMaterial), materialStatus: changedMaterial, inferences: [], inferenceVerdicts: {}, baseRevision: revisionOf(db) }, "K-E-changed");
  const changedBody = await jsonOf(changed);
  const item = itemOf(db);
  const storedCard = JSON.parse(item.workflow_card_json || "{}");
  check("E2", "相同文本但卡片/材料不同 → 不得判为重复：revision +1，且新卡片/材料落库",
    changedSave.status === 200 && changed.status === 409 && changedBody.code === "verifier_not_ready"
      && revisionOf(db) === revisionAfterFirst + 2
      && storedCard.steps === changedAnswers.steps && item.material_status === changedMaterial,
    `rev=${revisionOf(db)} steps=${String(storedCard.steps).slice(0, 16)} material=${item.material_status}`);
  const afterChange = revisionOf(db);
  const again = await submit(db, { text: canonicalText(changedAnswers), workflowCard: canonicalCard(changedAnswers, changedMaterial), materialStatus: changedMaterial, inferences: [], inferenceVerdicts: {}, baseRevision: afterChange }, "K-E-dup2");
  check("E3", "E2 之后再次完全重复（新完整载荷）→ 幂等，revision 不再推进",
    again.status === 409 && revisionOf(db) === afterChange, `status=${again.status} rev=${revisionOf(db)}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── G. 核验人状态竞态（处理期间核验人变为就绪）──");
{
  const db = fixture({ verifierReady: false, revision: 3, answers: ANSWERS });
  let verifierQueryCount = 0;
  const realPrepare = db.prepare.bind(db);
  const proxyDB = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql) => {
          if (String(sql).includes("role='verifier'")) {
            verifierQueryCount += 1;
            if (verifierQueryCount === 1) {
              // 第一次（请求入口）核验人尚未就绪
              return { bind: () => ({ first: async () => null }) };
            }
            // 第二次（等待态分支内复核）核验人已就绪
            return { bind: () => ({ first: async () => ({ account_id: VER, assigned_verifier_name: "核验人乙" }) }) };
          }
          return realPrepare(sql);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const before = snapshotSubmissionFields(db);
  const res = await submit(db, submissionBody({ baseRevision: 3 }), "K-G-verifier-race", proxyDB);
  const resBody = await jsonOf(res);
  check("G1", "分支内复核发现核验人已就绪 → 409 verifier_ready，不写 blocked 状态/草稿",
    res.status === 409 && resBody.code === "submission_conflict" && resBody.reason === "verifier_ready"
      && verifierQueryCount >= 2 && snapshotSubmissionFields(db) === before,
    `${res.status} ${resBody.code || ""}/${resBody.reason || ""} queries=${verifierQueryCount}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── H. 并发：保存先成功 / 提交先成功两种顺序 ──");
{
  // H1：保存先成功 → 基于旧版本的提交 409，且不写任何提交字段
  const db1 = fixture({ verifierReady: false, revision: 3, answers: ANSWERS });
  const saved = await put(db1, { answers: { trigger: "保存先成功的新答案" }, materialStatus: "provided", ledger: null, inferenceVerdicts: {}, baseRevision: 3 });
  const beforeH1 = snapshotSubmissionFields(db1);
  const staleSubmit = await submit(db1, submissionBody({ baseRevision: 3 }), "K-H1");
  check("H1", "保存先成功：revision 3→4；随后基于旧版本的提交 409 且所有字段不变",
    saved.status === 200 && revisionOf(db1) === 4 && staleSubmit.status === 409
      && snapshotSubmissionFields(db1) === beforeH1,
    `save=${saved.status} rev=${revisionOf(db1)} submit=${staleSubmit.status}`);
  db1.close();

  // H2：等待态提交先成功 → 基于旧版本的保存 409，不丢失提交文本
  const db2 = fixture({ verifierReady: false, revision: 3, answers: ANSWERS });
  const submitFirst = await submit(db2, submissionBody({ baseRevision: 3 }), "K-H2");
  const blockedText = draftOf(db2).submissionText;
  const staleSave = await put(db2, { answers: { trigger: "提交后才到的旧保存" }, materialStatus: "provided", ledger: null, inferenceVerdicts: {}, baseRevision: 3 });
  const afterH2 = draftOf(db2);
  check("H2", "提交先成功：revision 3→4（blocked）且提交文本保留；基于旧版本的保存 409，不覆盖",
    submitFirst.status === 409 && revisionOf(db2) === 4 && blockedText === SUBMIT_TEXT
      && staleSave.status === 409 && JSON.stringify(afterH2.answers) === JSON.stringify(ANSWERS),
    `submit=${submitFirst.status} save=${staleSave.status} rev=${revisionOf(db2)}`);
  db2.close();

  // H3：真正同时发起保存+提交（同 baseRevision）
  const db3 = fixture({ verifierReady: false, revision: 3, answers: ANSWERS });
  const [saveRes, submitRes] = await Promise.all([
    put(db3, { answers: { trigger: "并发保存答案" }, materialStatus: "provided", ledger: null, inferenceVerdicts: {}, baseRevision: 3 }),
    submit(db3, submissionBody({ baseRevision: 3 }), "K-H3"),
  ]);
  const finalRev = revisionOf(db3);
  const finalDraft = draftOf(db3);
  const loserExplicit = [saveRes.status, submitRes.status].some((status) => status === 409);
  check("H3", "同时保存+提交：revision 3→4（恰一次推进），冲突方明确 409，无回退/双重推进",
    finalRev === 4 && loserExplicit && (saveRes.status === 200 || submitRes.status === 409),
    JSON.stringify({ save: saveRes.status, submit: submitRes.status, rev: finalRev, answers: finalDraft.answers.trigger }));
  db3.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── I. 前端契约与静态防线 ──");
{
  const appSrc = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const clientSrc = readFileSync(new URL("../api-client.js", import.meta.url), "utf8");
  const serverSrc = readFileSync(new URL("../functions/api/work-items/[itemId]/employee-submission.js", import.meta.url), "utf8");
  const submitCallHasVersion = /submitFormalEmployee\([\s\S]{0,600}?baseRevision: Number\.isInteger\(state\.formalInterviewRevision\)/.test(appSrc);
  const clientSendsVersion = clientSrc.includes("submitFormalEmployee") && /baseRevision: Number\.isInteger\(extras\.baseRevision\)/.test(clientSrc);
  // PILOT-09C/FIX-CODEX-04A（R04-01）：等待态同步 draftRevision 的前端判据，已从
  // 宽泛的 `409 && payload.receipt` 收紧为 verifier_not_ready 校验器门控分支。
  // 本断言保留原意图（等待态提交后必须同步服务端 draftRevision），只同步新实现形状。
  const blockedSyncsRevision = /const waitingPayload = error\.status === 409[\s\S]{0,900}?state\.formalInterviewRevision = waitingPayload\.task\.draftRevision/.test(appSrc);
  const serverRequiresVersion = serverSrc.includes("base_revision_required")
    && serverSrc.includes("reason: \"stale_base_revision\"")
    && serverSrc.includes("reason: \"verifier_ready\"")
    && serverSrc.includes("assignee_account_id=? AND assigned_verifier_id IS NULL")
    && serverSrc.includes("canonicalJson")
    && serverSrc.includes("idempotency_key_reuse");
  check("I1", "app.js 提交调用携带 baseRevision；api-client 透传；等待态提交后同步 draftRevision",
    submitCallHasVersion && clientSendsVersion && blockedSyncsRevision,
    JSON.stringify({ submitCallHasVersion, clientSendsVersion, blockedSyncsRevision }));
  check("I2", "服务端防线齐全：缺版本 428 / 旧版本 409 / 核验人竞态 409 / 归属 CAS / 完整载荷幂等 / 幂等键复用 409",
    serverRequiresVersion, "");
}

// ═══════════════════════════════════════════════════════════════
const failed = results.filter((entry) => entry.verdict === "FAIL");
console.log("\n──────────────── 结果明细 ────────────────");
for (const entry of results) {
  console.log(`  ${entry.verdict === "PASS" ? "✔" : "✘"} [${entry.verdict}] ${entry.id} · ${entry.name}${entry.note ? "\n        " + entry.note : ""}`);
}
console.log("\n──────────────── 汇总 ────────────────");
console.log(`  PASS=${results.length - failed.length}  FAIL=${failed.length}`);
if (failed.length) {
  console.error(`\n  R03-01 修复套件失败 ${failed.length} 项：${failed.map((entry) => entry.id).join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("  pilot09c fix-codex-03a runtime: ok");
}
