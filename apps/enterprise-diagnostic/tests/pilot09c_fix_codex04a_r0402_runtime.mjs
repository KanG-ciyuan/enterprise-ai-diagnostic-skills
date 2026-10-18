/**
 * PILOT-09C/FIX-CODEX-04A —— R04-02 服务端共享草稿写入收紧 · 定向运行时套件
 *
 * 问题（VERIFY-CODEX-04A / R04-02）：
 *   `casWriteEmployeeDraft` 的 UPDATE 只按 `id + json_extract(revision)` 做 CAS。
 *   正常正式提交成功后任务进入 stage='facts' / status='awaiting_verification'，
 *   而**草稿 revision 不变**；一个在提交前已经通过 employee-draft 前置检查
 *   （stage/status/归属）的在途旧保存请求，恢复执行后仍会命中 id+revision 条件，
 *   写入 employee_draft_json / material_status 并追加 employee_draft_saved 成功事件，
 *   造成"已提交快照"与"草稿/材料状态"分离。
 *   同类风险在 employee-turn 的 issueAnchor → writePendingQuestion 路径：模型调用
 *   长窗口内完成正式提交后，旧 turn 仍可能写入 draft。
 *
 * 本套件验证修复后的契约：
 *   A. 正常提交完成后，用**提交前同一 revision** 的在途旧保存恢复执行 →
 *      409 draft_conflict；草稿 JSON / material_status / revision / stage / status /
 *      submission_version / 事件计数 / 候选事实全部与提交后快照一致；无新增
 *      employee_draft_saved 事件。
 *   B. 合法对照：保存先完成（revision+1）→ 正式提交用新 revision → 200 awaiting_verification。
 *   C. 旧版本保存 409；并发保存恰好一个成功一个 409；归属不符 403；complete 任务拒绝；
 *      重复提交幂等语义保持。
 *   D. employee-turn：turn 已过前置检查 → 模型调用窗口内正式提交完成 → turn 再写锚点
 *      ⇒ 明确 409 冲突，不写 draft/revision/ledger；正常 turn 写入（锚点落库、revision+1）不受影响；
 *      无 workItemId 的轮次（未发生写入尝试）保持旧 200 + anchorPersisted:false 语义。
 *   E. 源码契约：casWriteEmployeeDraft 的实际 UPDATE WHERE 含 stage/status/归属条件；
 *      两个生产调用方都显式传 writeGuard。
 *
 * 真实 handler + 内存 D1（tests/d1_harness.mjs，node:sqlite）；不触网、不用真实密钥、
 * 不读取 .dev.vars。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { draftRevisionOf, normalizeEmployeeDraft, serializeEmployeeDraft } from "../functions/_shared.js";
import { ANSWER_DIMENSIONS as EVIDENCE_DIMENSIONS, canonicalJson as evidenceCanonicalJson, normalizeAnswers as evidenceNormalizeAnswers } from "../functions/api/agent/_evidence.js";
import { appendStatementHistory, buildInferenceRecords } from "../functions/api/agent/_adapter.js";
import { onRequestPut as saveDraft } from "../functions/api/work-items/[itemId]/employee-draft.js";
import { onRequestPost as submitEmployee } from "../functions/api/work-items/[itemId]/employee-submission.js";
import { onRequestPost as employeeTurn } from "../functions/api/agent/employee-turn.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

const P = "PRJ-R0402";
const ITEM = "WI-R0402";
const EMP = "ACC-R0402-EMP";
const EMP2 = "ACC-R0402-EMP2";
const VER = "ACC-R0402-VER";
const TOK = "TOK-R0402-EMP";
const TOK2 = "TOK-R0402-EMP2";
const KEY = "fake-deepseek-key-not-real";

/** 员工七维答案：夹具草稿的默认答案（提交载荷按新契约由草稿派生）。 */
const ANSWERS = {
  trigger: "每天早上运营同事在群里发来当天的推广需求，我看到消息后开始处理",
  inputs: "先看昨天的曝光和点击数据，再看库存数量，然后确认投放预算还剩多少",
  steps: "先选品再写脚本，然后让剪辑同事剪出来，最后在后台提交审核并发布",
  judgments: "毛利率低于一成要先找主管确认，其他价格我自己按历史数据定",
  exceptions: "版权不确定就换同款，审核被拒就先改文案再重新提交",
  handoff: "剪完的素材交给投放同事小李，由他挂车和设置出价",
  burden: "一条视频从选题到发布大约需要三个小时，一周做五条左右",
};
// ── PILOT-09C/IMPLEMENT-05A（F04）：正式提交只承认服务端规范卡/规范文本 ──
// 规范值 = 已持久化草稿 answers + work_items.material_status。本套件夹具默认写完整七维答案，
// 提交载荷在发起时从**库中草稿**派生（与真实客户端"确认后提交"一致）。
// 原断言（版本守卫/在途写入拒绝/快照不变）全部保持原强度。
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

const results = [];
const pass = (id, name, note = "") => results.push({ id, name, verdict: "PASS", note });
const fail = (id, name, note = "") => results.push({ id, name, verdict: "FAIL", note });
const check = (id, name, ok, note = "") => (ok ? pass(id, name, note) : fail(id, name, note));
const jsonOf = async (response) => response.clone().json().catch(() => ({}));

// ── PILOT-09C/IMPLEMENT-05B（F03）：服务端证据状态夹具 ───────────────────────
// F03 起正式提交要求 ledger.evidence / statementHistory 与答案一致，推断带
// evidenceVersion/evidenceRefs，判定回显 evidenceVersion。旧夹具只播种答案。
// 这里用服务端构建函数生成与真实统一证据写入同构的状态（摘要用 node:crypto
// 按同一 SHA-256 算法独立计算），保持既有 revision/断言数值不变。
const evidenceSha256 = (value) => `sha256:${createHash("sha256").update(String(value), "utf8").digest("hex")}`;
const DEFAULT_INFERENCE_DEFS = [
  { source: "model", text: "R04-02 基线推断 1：服务端权威记录（步骤）", basis: "steps", assumes: "若与实际不符需更正" },
  { source: "model", text: "R04-02 基线推断 2：服务端权威记录（判断）", basis: "judgments", assumes: "若与实际不符需更正" },
];
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
 * fixture：合法正式项目 + 员工任务。
 * opts: revision/answers/ledger/stage/status/assignee/materialStatus/workflowCard/
 *       employeeDescription/submissionVersion/verifierReady
 */
function fixture(opts = {}) {
  const {
    revision = 0,
    answers = ANSWERS,
    ledger = null,
    stage = "mapping",
    status = "needs_input",
    assignee = EMP,
    materialStatus = "provided",
    workflowCard = {},
    employeeDescription = "",
    submissionVersion = 0,
    verifierReady = true,
  } = opts;
  const db = new D1Harness();
  // F03：播种与真实统一证据写入同构的 evidence / statementHistory / 推断证据版本；
  // 推断基线带版本回显，使正式提交在"有访谈证据"前提下验证在途写入/CAS 契约。
  const priorLedger = ledger && typeof ledger === "object" ? ledger : {};
  const baseRecords = Array.isArray(priorLedger.authoritativeInferences) && priorLedger.authoritativeInferences.length
    ? priorLedger.authoritativeInferences : buildInferenceRecords([], DEFAULT_INFERENCE_DEFS).records;
  const evidenceSeed = seedEvidenceState({ answers, inferences: baseRecords, revision });
  const draft = serializeEmployeeDraft({
    answers,
    ledger: {
      ...priorLedger,
      evidence: evidenceSeed.evidence,
      statementHistory: evidenceSeed.history,
      authoritativeInferences: evidenceSeed.inferences,
    },
    inferenceVerdicts: evidenceSeed.verdicts,
    submissionText: "",
    revision,
  });
  const verifierInvitation = verifierReady
    ? `('INV-R0402-VER','inv-r0402-ver','${P}','${EMP}','ver@r0402.invalid','verifier','project','accepted','2099-01-01T00:00:00Z','${VER}','IK-R0402')`
    : `('INV-R0402-VER','inv-r0402-ver','${P}','${EMP}','ver@r0402.invalid','verifier','project','pending','2099-01-01T00:00:00Z',NULL,'IK-R0402')`;
  const verifierMembership = verifierReady
    ? `INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES ('${P}','${VER}','verifier','project','active');`
    : "";
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('${EMP}','emp@r0402.invalid','员工甲','active','member'),
      ('${EMP2}','emp2@r0402.invalid','员工乙','active','member'),
      ('${VER}','ver@r0402.invalid','核验人乙','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage)
      VALUES ('${P}','R04-02 验证','选品到发布','${stage}','active','unknown','external_builder','${EMP}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status)
      VALUES ('${P}','${EMP}','employee','project','active'),
             ('${P}','${EMP2}','employee','project','active');
    ${verifierMembership}
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at)
      VALUES ('AUTH-R0402','${P}','授权','王总','o@r0402.invalid','只读','DOC','authorized','${EMP}','k','n','h','2099-01-01T00:00:00Z');
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,accepted_account_id,idempotency_key)
      VALUES ${verifierInvitation};
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token)
      VALUES ('${TOK}','${EMP}','${P}','2099-01-01T00:00:00Z','R-R0402-1'),
             ('${TOK2}','${EMP2}','${P}','2099-01-01T00:00:00Z','R-R0402-2');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,material_status,flow_card_version,evidence_version,submission_version,employee_description,workflow_card_json)
      VALUES ('${ITEM}','${P}','还原工作','d','${stage}','${status}','employee','员工甲',0,'b','n','${assignee}',
              ${verifierReady ? `'${VER}'` : "NULL"},'${draft.replace(/'/g, "''")}','${materialStatus}',1,1,${submissionVersion},'${employeeDescription.replace(/'/g, "''")}','${JSON.stringify(workflowCard).replace(/'/g, "''")}');
  `);
  return db;
}

const itemOf = (db) => db.get("SELECT * FROM work_items WHERE id=?", ITEM);
const draftJsonOf = (db) => itemOf(db).employee_draft_json;
const draftOf = (db) => normalizeEmployeeDraft(JSON.parse(draftJsonOf(db) || "{}"));
const revOf = (db) => draftRevisionOf(JSON.parse(draftJsonOf(db) || "{}"));
const factsOf = (db) => db.all("SELECT id, fact_type, claim, source_field, status FROM candidate_facts WHERE work_item_id=? ORDER BY id", ITEM);
const eventsOfType = (db, type) => db.all("SELECT event_id, type FROM events WHERE work_item_id=? AND type=? ORDER BY id", ITEM, type);
const eventCount = (db) => Number(db.get("SELECT COUNT(*) AS c FROM events WHERE work_item_id=?", ITEM).c);

const put = (db, body, token = TOK) => saveDraft({
  request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-draft`, token, body),
  env: { DB: db }, params: { itemId: ITEM },
});
const submit = (db, body, key = "K-R0402", token = TOK) => submitEmployee({
  request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-submission`, token, body, { "Idempotency-Key": key }),
  env: { DB: db }, params: { itemId: ITEM },
});
const turn = (db, body, envExtra = {}) => employeeTurn({
  request: bearerRequest("http://127.0.0.1/api/agent/employee-turn", TOK, body),
  env: { DB: db, ...envExtra }, params: {},
});
/**
 * IMPLEMENT-05A：提交载荷按新契约从**库中已持久化草稿**派生规范卡/规范文本。
 * baseRevision 仍由各用例显式声明（本套件的核心验证对象）。
 */
const submissionBody = (db, baseRevision, extra = {}) => {
  const answers = draftOf(db).answers;
  const materialStatus = itemOf(db).material_status;
  return { text: canonicalText(answers), workflowCard: canonicalCard(answers, materialStatus), materialStatus, inferences: [], inferenceVerdicts: {}, baseRevision, ...extra };
};

/** 提交后快照：用于证明"在途旧保存被拒时一切不变"。 */
const fullSnapshot = (db) => {
  const item = itemOf(db);
  return JSON.stringify({
    draft: item.employee_draft_json,
    material_status: item.material_status,
    stage: item.stage,
    status: item.status,
    assignee_account_id: item.assignee_account_id,
    submission_version: item.submission_version,
    submitted_at: item.submitted_at,
    employee_description: item.employee_description,
    workflow_card_json: item.workflow_card_json,
    handoff_status: item.handoff_status,
    last_submission_key: item.last_submission_key,
    events: eventCount(db),
    draftSavedEvents: eventsOfType(db, "employee_draft_saved"),
    candidateFacts: factsOf(db),
  });
};

const originalFetch = globalThis.fetch;
function fakeModel(content) {
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { "content-type": "application/json" } });
}
function restoreFetch() { globalThis.fetch = originalFetch; }
const Q = (key) => JSON.stringify({ turnKind: "question", question: { key, label: key, prompt: `请说明 ${key}` } });

/**
 * 受控 DB 包装：在 employee-draft 真正执行 CAS UPDATE（shared 写入函数）的那一刻，
 * 先执行一次正式提交，再继续执行原 UPDATE —— 精确模拟"保存请求已通过前置检查、
 * 但恢复执行时正式提交已完成"的在途窗口，且对修复前后的 SQL 都成立。
 */
function withInterleavedSubmission(db, interleave) {
  let fired = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop !== "prepare") {
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql) => {
        const text = String(sql);
        if (!fired && /UPDATE\s+work_items\s+SET\s+employee_draft_json/i.test(text)) {
          return {
            bind: (...values) => ({
              run: async () => {
                if (!fired) { fired = true; await interleave(); }
                return target.prepare(sql).bind(...values).run();
              },
              first: () => target.prepare(sql).bind(...values).first(),
            }),
          };
        }
        return target.prepare(sql);
      };
    },
  });
}

console.log("PILOT-09C/FIX-CODEX-04A · R04-02 服务端共享草稿写入收紧 —— 定向运行时套件\n");

// ═══════════════════════════════════════════════════════════════
console.log("── A. 提交后在途旧保存：409 draft_conflict 且所有字段/事件不变 ──");
{
  const db = fixture({ revision: 2, answers: { ...ANSWERS, trigger: "提交前的旧答案" } });
  let submitStatus = null;
  let afterSubmitSnapshot = null;
  const proxyDB = withInterleavedSubmission(db, async () => {
    const res = await submit(db, submissionBody(db, 2), "K-A-submit");
    submitStatus = res.status;
    // 正式提交刚刚完成、在途旧保存尚未恢复执行 —— 此刻是"提交后快照"的权威时点。
    afterSubmitSnapshot = fullSnapshot(db);
  });
  const stale = await put(proxyDB, {
    answers: { trigger: "在途旧保存写入的答案" },
    materialStatus: "none_available",
    ledger: null,
    inferenceVerdicts: {},
    baseRevision: 2,
  });
  const staleBody = await jsonOf(stale);
  const afterStale = JSON.parse(fullSnapshot(db));
  const submittedSnapshot = JSON.parse(afterSubmitSnapshot);
  check("A0", "前置条件：在途旧保存恢复前正式提交（baseRevision=2）成功 → 200 awaiting_verification",
    submitStatus === 200 && submittedSnapshot.status === "awaiting_verification"
      && submittedSnapshot.stage === "facts" && submittedSnapshot.submission_version === 1,
    `submit=${submitStatus} stage=${submittedSnapshot.stage} status=${submittedSnapshot.status} version=${submittedSnapshot.submission_version}`);
  check("A1", "在途旧保存恢复执行 → 409 draft_conflict（不得 200 成功语义）",
    stale.status === 409 && staleBody.code === "draft_conflict",
    `${stale.status} ${staleBody.code || ""}/${staleBody.reason || ""}`);
  check("A2", "409 分类理由为任务已不可编辑（stage/status 守卫命中）",
    staleBody.reason === "not_editable",
    `reason=${staleBody.reason || ""}`);
  check("A3", "草稿 JSON / material_status / revision / stage / status / submission_version 与提交后快照一致",
    afterStale.draft === submittedSnapshot.draft
      && afterStale.material_status === submittedSnapshot.material_status
      && afterStale.status === submittedSnapshot.status
      && afterStale.stage === submittedSnapshot.stage
      && afterStale.submission_version === submittedSnapshot.submission_version
      && revOf(db) === 2
      && !afterStale.draft.includes("在途旧保存写入的答案"),
    `rev=${revOf(db)} material=${afterStale.material_status} textHit=${afterStale.draft.includes("在途旧保存写入的答案")}`);
  check("A4", "候选事实全部与提交后快照一致（5 条、内容未变）",
    JSON.stringify(afterStale.candidateFacts) === JSON.stringify(submittedSnapshot.candidateFacts) && factsOf(db).length === 5,
    `facts=${factsOf(db).length}`);
  check("A5", "无新增 employee_draft_saved 成功事件（appendEvent 仍只在 CAS 成功后）",
    JSON.stringify(afterStale.draftSavedEvents) === JSON.stringify(submittedSnapshot.draftSavedEvents)
      && afterStale.draftSavedEvents.length === 0,
    `draftSavedEvents=${afterStale.draftSavedEvents.length}`);
  check("A6", "整份提交后快照逐字节不变（含事件总数）",
    JSON.stringify(afterStale) === JSON.stringify(submittedSnapshot),
    `eventCount=${afterStale.events}/${submittedSnapshot.events}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── B. 合法时序对照：保存先完成 → 提交用新 revision → 200 ──");
{
  const db = fixture({ revision: 2, answers: { ...ANSWERS, trigger: "初始答案" } });
  const saved = await put(db, { answers: { trigger: "保存完成的新答案" }, materialStatus: "provided", ledger: null, inferenceVerdicts: {}, baseRevision: 2 });
  const savedBody = await jsonOf(saved);
  const savedRevision = revOf(db);
  // G14：改 trigger 会使无建议模型的保守依赖失效；合法提交必须先重新核验当前 EV。
  const unjudged = await submit(db, submissionBody(db, savedRevision), "K-B-unjudged");
  const currentEntries = draftOf(db).ledger.authoritativeInferences;
  const judged = await put(db, { baseRevision: savedRevision, inferenceVerdicts: Object.fromEntries(currentEntries.map((entry) => [entry.id, {
    verdict: "agree", contentVersion: entry.contentVersion, templateVersion: entry.templateVersion ?? null,
    evidenceHash: entry.evidenceHash || null, evidenceVersion: entry.evidenceVersion,
  }])) });
  const judgedRevision = revOf(db);
  const submitted = await submit(db, submissionBody(db, judgedRevision), "K-B-submit");
  const submittedBody = await jsonOf(submitted);
  const item = itemOf(db);
  check("B1", "保存先完成 → 200，revision 2→3",
    saved.status === 200 && savedRevision === 3 && savedBody.task?.draftRevision === 3,
    `save=${saved.status} rev=${revOf(db)}`);
  check("B2", "随后用新 revision 正式提交 → 200 awaiting_verification，候选事实 5 条",
    unjudged.status === 422 && judged.status === 200 && judgedRevision === savedRevision + 1
      && submitted.status === 200 && submittedBody.item?.status === "awaiting_verification"
      && item.status === "awaiting_verification" && item.stage === "facts" && factsOf(db).length === 5,
    `submit=${submitted.status} item=${submittedBody.item?.status || ""} facts=${factsOf(db).length}`);
  check("B3", "合法时序下已保存答案保留，提交不改写 revision",
    draftOf(db).answers.trigger === "保存完成的新答案" && revOf(db) === judgedRevision && item.submission_version === 1,
    `trigger=${draftOf(db).answers.trigger} rev=${revOf(db)} version=${item.submission_version}`);
  db.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── C. 旧版本 / 并发 / 归属 / complete / 重复提交 ──");
{
  // C1：旧版本保存
  const db1 = fixture({ revision: 3, answers: { trigger: "当前答案" } });
  const before1 = JSON.stringify({ draft: draftJsonOf(db1), material: itemOf(db1).material_status, events: eventCount(db1) });
  const stale = await put(db1, { answers: { trigger: "旧版本答案" }, materialStatus: "none_available", ledger: null, inferenceVerdicts: {}, baseRevision: 2 });
  const staleBody = await jsonOf(stale);
  check("C1", "旧版本保存 → 409 draft_conflict(stale_revision)，草稿/材料/事件不变",
    stale.status === 409 && staleBody.code === "draft_conflict" && staleBody.reason === "stale_revision"
      && JSON.stringify({ draft: draftJsonOf(db1), material: itemOf(db1).material_status, events: eventCount(db1) }) === before1,
    `${stale.status} ${staleBody.code || ""}/${staleBody.reason || ""}`);
  db1.close();

  // C2：并发保存：恰好一个成功、一个 409
  const db2 = fixture({ revision: 0 });
  const [r1, r2] = await Promise.all([
    put(db2, { answers: { trigger: "并发A" }, materialStatus: "provided", ledger: null, inferenceVerdicts: {}, baseRevision: 0 }),
    put(db2, { answers: { trigger: "并发B" }, materialStatus: "none_available", ledger: null, inferenceVerdicts: {}, baseRevision: 0 }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  const winner = r1.status === 200 ? "并发A" : "并发B";
  check("C2", "并发保存：恰好一个 200、一个 409 draft_conflict，revision 只 +1 且无静默覆盖",
    statuses[0] === 200 && statuses[1] === 409 && revOf(db2) === 1 && draftOf(db2).answers.trigger === winner,
    `statuses=${JSON.stringify([r1.status, r2.status])} rev=${revOf(db2)} winner=${draftOf(db2).answers.trigger}`);
  db2.close();

  // C3：归属不符 → 403，不写
  const db3 = fixture({ revision: 1, answers: { trigger: "本人答案" } });
  const before3 = JSON.stringify({ draft: draftJsonOf(db3), events: eventCount(db3) });
  const foreign = await put(db3, { answers: { trigger: "他人写入" }, materialStatus: "provided", ledger: null, inferenceVerdicts: {}, baseRevision: 1 }, TOK2);
  check("C3", "归属不符（其他员工会话）保存 → 403，不写草稿/事件",
    foreign.status === 403 && JSON.stringify({ draft: draftJsonOf(db3), events: eventCount(db3) }) === before3,
    `${foreign.status}`);
  db3.close();

  // C4：complete / 非 mapping 任务拒绝
  const completeDB = fixture({ revision: 1, status: "complete" });
  const beforeC4 = JSON.stringify({ draft: draftJsonOf(completeDB), events: eventCount(completeDB) });
  const completeRes = await put(completeDB, { answers: { trigger: "完成后写入" }, materialStatus: "provided", ledger: null, inferenceVerdicts: {}, baseRevision: 1 });
  check("C4", "complete 任务保存 → 409，不写草稿/事件",
    completeRes.status === 409 && JSON.stringify({ draft: draftJsonOf(completeDB), events: eventCount(completeDB) }) === beforeC4,
    `${completeRes.status}`);
  completeDB.close();

  // C5：重复提交幂等语义保持（提交成功后重放 403 归属守卫；复位归属后同一完整载荷重放 → 200 原响应）
  const db5 = fixture({ revision: 1 });
  const first = await submit(db5, submissionBody(db5, 1), "K-C5");
  const firstBody = await jsonOf(first);
  const factsAfterFirst = factsOf(db5).length;
  const replayBlocked = await submit(db5, submissionBody(db5, 1), "K-C5");
  const afterReplayBlocked = { facts: factsOf(db5).length, version: itemOf(db5).submission_version };
  db5.prepare("UPDATE work_items SET assignee_account_id=? WHERE id=?").bind(EMP, ITEM).run();
  const replayIdempotent = await submit(db5, submissionBody(db5, 1), "K-C5");
  const replayBody = await jsonOf(replayIdempotent);
  check("C5", "重复提交幂等语义保持：成功后重放 403 不重复写；同键同载荷重放返回原响应且事实/版本不变",
    first.status === 200 && firstBody.item?.status === "awaiting_verification"
      && replayBlocked.status === 403 && afterReplayBlocked.facts === 5 && afterReplayBlocked.version === 1
      && replayIdempotent.status === 200 && replayBody.item?.status === "awaiting_verification"
      && factsOf(db5).length === factsAfterFirst && itemOf(db5).submission_version === 1,
    `first=${first.status} blockedReplay=${replayBlocked.status} idemReplay=${replayIdempotent.status} facts=${factsOf(db5).length}`);
  db5.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── D. employee-turn：模型调用窗口内完成正式提交后写锚点必须 409 ──");
{
  // D1：turn 已过前置检查并进入模型调用；窗口内正式提交完成；turn 恢复后写锚点。
  const db = fixture({ revision: 0 });
  const recover = await turn(db, { projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "fixture", baseRevision: revOf(db) });
  const recoverBody = await jsonOf(recover);
  const anchor = draftOf(db).ledger?.pendingQuestion || null;
  check("D0", "前置条件：服务端恢复签发锚点 → 200 question_reissued，revision 0→1",
    recover.status === 200 && recoverBody.code === "question_reissued" && anchor && revOf(db) === 1,
    `recover=${recover.status} rev=${revOf(db)} anchor=${anchor?.key || ""}`);
  const anchorBefore = JSON.stringify(anchor);
  const draftBefore = draftJsonOf(db);
  let submitStatus = null;
  const originalTurnFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    if (submitStatus === null) {
      const res = await submit(db, submissionBody(db, 1), "K-D-submit");
      submitStatus = res.status;
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: Q("inputs") } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  let turnRes; let turnBody;
  try {
    turnRes = await turn(db, {
      projectId: P, workItemId: ITEM, questionKey: anchor?.key, answer: "在模型窗口内回答，此时正式提交已完成",
      mode: "harness", baseRevision: 1,
    }, { DEEPSEEK_API_KEY: KEY });
    turnBody = await jsonOf(turnRes);
  } finally { globalThis.fetch = originalTurnFetch; }
  const itemAfter = itemOf(db);
  check("D1", "模型窗口内正式提交成功（前置条件）",
    submitStatus === 200 && itemAfter.stage === "facts" && itemAfter.status === "awaiting_verification",
    `submit=${submitStatus} stage=${itemAfter.stage} status=${itemAfter.status}`);
  check("D2", "提交完成后 turn 写锚点 → 明确 409 draft_conflict（不得 200 成功语义）",
    turnRes.status === 409 && turnBody.code === "draft_conflict",
    `${turnRes.status} code=${turnBody.code || ""} reason=${turnBody.reason || ""}`);
  check("D3", "turn 未写 draft / revision / ledger（草稿 JSON 逐字节不变，锚点未被替换）",
    draftJsonOf(db) === draftBefore && revOf(db) === 1 && JSON.stringify(draftOf(db).ledger?.pendingQuestion || null) === anchorBefore,
    `rev=${revOf(db)} draftChanged=${draftJsonOf(db) !== draftBefore}`);
  check("D4", "409 响应不携带成功语义的 turn/output，也不声称 anchorPersisted",
    turnBody.turn === undefined && turnBody.output === undefined && turnBody.anchorPersisted !== true,
    `keys=${JSON.stringify(Object.keys(turnBody))}`);
  db.close();

  // D2b：正常 turn 写入不受影响（锚点落库、revision+1）
  const db2 = fixture({ revision: 0 });
  const recover2 = await turn(db2, { projectId: P, workItemId: ITEM, recover: true, answers: {}, mode: "fixture", baseRevision: revOf(db2) });
  const recover2Body = await jsonOf(recover2);
  const anchor2 = draftOf(db2).ledger?.pendingQuestion || null;
  fakeModel(Q("inputs"));
  let normalRes; let normalBody;
  try {
    normalRes = await turn(db2, {
      projectId: P, workItemId: ITEM, questionKey: anchor2?.key, answer: "正常情况下的一轮回答",
      mode: "harness", baseRevision: 1,
    }, { DEEPSEEK_API_KEY: KEY });
    normalBody = await jsonOf(normalRes);
  } finally { restoreFetch(); }
  const stored2 = draftOf(db2);
  check("D5", "正常 turn（无并发提交）→ 200，锚点落库、revision 1→2（行为契约不变）",
    recover2.status === 200 && normalRes.status === 200 && normalBody.anchorPersisted === true
      && revOf(db2) === 2 && stored2.ledger?.pendingQuestion?.key === "inputs"
      && normalBody.draftRevision === 2,
    `status=${normalRes.status} rev=${revOf(db2)} anchor=${stored2.ledger?.pendingQuestion?.key || ""} anchorPersisted=${normalBody.anchorPersisted}`);
  db2.close();

  // D6：无 workItemId 的 recover 轮 —— issueAnchor 本来就立即返回 null（**未尝试任何写入**），
  // 这不是 CAS 冲突：必须保持旧响应语义（200 / draftRevision:currentRevision /
  // anchorPersisted:false），不得被 R04-02 的 409 收敛"顺便"改掉。
  const db3 = fixture({ revision: 0 });
  const noItemSnapshot = () => {
    const i = itemOf(db3);
    return JSON.stringify({
      draft: i.employee_draft_json, stage: i.stage, status: i.status,
      submission_version: i.submission_version, assignee_account_id: i.assignee_account_id,
      events: eventCount(db3),
    });
  };
  const beforeD6 = noItemSnapshot();
  const noItemRecover = await turn(db3, { projectId: P, recover: true, answers: {}, mode: "fixture", baseRevision: 0 });
  const noItemBody = await jsonOf(noItemRecover);
  check("D6", "无 workItemId 的 recover 轮保持 200 + anchorPersisted:false（无写入尝试≠CAS 冲突），且不写库",
    noItemRecover.status === 200 && noItemBody.code === "question_reissued"
      && noItemBody.anchorPersisted === false && noItemBody.draftRevision === 0
      && noItemSnapshot() === beforeD6,
    `status=${noItemRecover.status} code=${noItemBody.code || ""} anchorPersisted=${noItemBody.anchorPersisted} draftRevision=${noItemBody.draftRevision}`);
  db3.close();
}

// ═══════════════════════════════════════════════════════════════
console.log("\n── E. 源码契约：UPDATE WHERE 含守卫 + 两个调用方显式传 guard ──");
{
  const sharedSrc = readFileSync(new URL("../functions/_shared.js", import.meta.url), "utf8");
  const draftSrc = readFileSync(new URL("../functions/api/work-items/[itemId]/employee-draft.js", import.meta.url), "utf8");
  const turnSrc = readFileSync(new URL("../functions/api/agent/employee-turn.js", import.meta.url), "utf8");
  const evidenceSrc = readFileSync(new URL("../functions/api/agent/_evidence.js", import.meta.url), "utf8");
  const casFn = sharedSrc.slice(sharedSrc.indexOf("export async function casWriteEmployeeDraft"), sharedSrc.indexOf("export async function updateItem"));
  const guardedWhere = /UPDATE\s+work_items[\s\S]{0,800}?stage\s*=\s*'mapping'[\s\S]{0,300}?status\s*!=\s*'complete'[\s\S]{0,300}?assignee_account_id\s*=\s*\?/.test(casFn);
  const guardBound = /\.bind\([^;]{0,400}?assigneeAccountId/.test(casFn);
  const casSignature = /export async function casWriteEmployeeDraft\([^)]*writeGuard\s*=\s*null\s*\)/.test(sharedSrc);
  check("E1", "casWriteEmployeeDraft：实际 UPDATE WHERE 同一语句含 stage='mapping' / status!='complete' / assignee_account_id=?，且绑定写入者",
    guardedWhere && guardBound && casSignature,
    JSON.stringify({ guardedWhere, guardBound, casSignature }));

  const draftGuardDecl = draftSrc.includes("{ assigneeAccountId: current.accountId, requireEditable: true }");
  // F03 起 employee-draft 通过统一证据入口写入（applyEvidenceMutation），guard 必须穿透到
  // 真实 CAS 层 casWriteEmployeeDraft；断言仍验证"调用方显式传 guard 且 CAS 收到 guard"。
  const draftPassesGuard = /applyEvidenceMutation\(\{[\s\S]{0,900}?writeGuard/.test(draftSrc)
    && /casWriteEmployeeDraft\(db, itemId, expectedRevision, draftJson, materialStatus, writeGuard\)/.test(evidenceSrc);
  const draftReason = draftSrc.includes("reason: cas.reason");
  check("E2", "employee-draft 调用方显式传 writeGuard（含写入者 + requireEditable），经统一证据入口穿透到 CAS，409 带 reason 分类",
    draftGuardDecl && draftPassesGuard && draftReason,
    JSON.stringify({ draftGuardDecl, draftPassesGuard, draftReason }));

  const turnGuardDecl = turnSrc.includes("assigneeAccountId: current.accountId, requireEditable: true");
  // 单个调用参数内可能含对象字面量，按"调用起点 → writeGuard 作为实参"做有界匹配。
  // writeGuard 既可能是最后一个实参，后面也可能继续跟随 answerContext。
  const turnIssueAnchorGuard = (turnSrc.match(/issueAnchor\([^;]{0,400}?writeGuard\s*[,)]/g) || []).length;
  // F03 起 turn 的锚点写入统一走 applyTurnEvidence（_evidence.js），guard 必须穿透到 CAS。
  const turnCasGuard = turnSrc.includes("applyTurnEvidence({")
    && evidenceSrc.includes("applyEvidenceMutation({")
    && /casWriteEmployeeDraft\(db, itemId, expectedRevision, draftJson, materialStatus, writeGuard\)/.test(evidenceSrc);
  const turnSignatures = /function writePendingQuestion\([^)]*writeGuard\s*=\s*null/.test(turnSrc)
    && /function issueAnchor\([^)]*writeGuard\s*=\s*null/.test(turnSrc);
  check("E3", "employee-turn：issueAnchor 5 个调用点全部传 writeGuard，经统一证据入口穿透到 CAS，签名透传一致",
    turnGuardDecl && turnIssueAnchorGuard >= 5 && turnCasGuard && turnSignatures,
    JSON.stringify({ turnGuardDecl, turnIssueAnchorGuard, turnCasGuard, turnSignatures }));
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
  console.error(`\n  R04-02 修复套件失败 ${failed.length} 项：${failed.map((entry) => entry.id).join(", ")}`);
  process.exitCode = 1;
} else {
  console.log("  pilot09c fix-codex-04a r0402 runtime: ok");
}
