/**
 * V0.2 diagnosis suggestions — stage 2 local acceptance.
 *
 * Fake model, in-memory D1 harness, no network, no production data.
 * Covers S1–S6 plus generation-cost/concurrency behaviour.
 */
import { onRequestPost as generate } from "../functions/api/formal/projects/[projectId]/diagnosis-suggestions.js";
import { onRequestPost as createDraft } from "../functions/api/formal/projects/[projectId]/decision-packets/draft.js";
import { onRequestGet as getConfirmedFacts } from "../functions/api/formal/projects/[projectId]/confirmed-facts.js";
import { onRequestGet as getDecisionPacket } from "../functions/api/formal/projects/[projectId]/decision-packet.js";
import { onRequestGet as getOwnerPacket } from "../functions/api/formal/projects/[projectId]/owner-packet.js";
import { onRequestPost as verifyPacket } from "../functions/api/formal/decision-packets/[packetId]/verify.js";
import { onRequestPost as publishPacket } from "../functions/api/formal/decision-packets/[packetId]/publish.js";
import { factsBasisDigest, findInvalidatablePacketsReferencing, formalEligibleFacts, internalEligibleFacts, INTERNAL_FACT_LIMIT } from "../functions/api/formal/decision-packets/_facts.js";
import { onRequestPost as correctFact } from "../functions/api/work-items/[itemId]/verification.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

const P = "PRJ-S";
const OTHER = "PRJ-O";
const BLD = "BLD-S", VER = "VER-S", OWN = "OWN-S", EMP = "EMP-S";
const TOK_B = "TOK-B", TOK_V = "TOK-V", TOK_O = "TOK-O", TOK_E = "TOK-E";
const PACKET_FIELDS = {
  riskSummary: "当前流程存在重复确认环节",
  pilotScope: "先在一个班组试运行",
  constraints: ["不影响现有交付节奏"],
  successMetrics: ["同一事实不再被重复确认"],
  stopConditions: ["出现无法追溯的事实引用即停止"],
  downstreamOwner: "运营负责人",
};
const env = (db) => ({ DB: db, DEEPSEEK_API_KEY: "test-key" });

function fixture() {
  const db = new D1Harness();
  db.exec(`
    INSERT INTO accounts(id,email,name,status) VALUES
      ('${BLD}','b@v02.invalid','改造方','active'),
      ('${VER}','v@v02.invalid','核验人','active'),
      ('${OWN}','o@v02.invalid','负责人','active'),
      ('${EMP}','e@v02.invalid','员工','active');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id) VALUES
      ('${P}','V02','选品到发布','decision','active','L2','external_builder','${BLD}'),
      ('${OTHER}','其他项目','范围','decision','active','L2','external_builder','${BLD}');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES
      ('AUTH-S','${P}','授权','王总','owner@v02.invalid','诊断','DOC','authorized','${BLD}','K1','n','h','2099-01-01T00:00:00Z'),
      ('AUTH-O','${OTHER}','授权','李总','owner2@v02.invalid','诊断','DOC','authorized','${BLD}','K2','n','h','2099-01-01T00:00:00Z');
    INSERT INTO project_memberships(project_id,account_id,role,status) VALUES
      ('${P}','${BLD}','external_builder','active'),
      ('${P}','${VER}','verifier','active'),
      ('${P}','${OWN}','owner','active'),
      ('${P}','${EMP}','employee','active'),
      ('${OTHER}','${BLD}','external_builder','active');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('${TOK_B}','${BLD}','${P}','2099-01-01T00:00:00Z','R1'),
      ('${TOK_V}','${VER}','${P}','2099-01-01T00:00:00Z','R2'),
      ('${TOK_O}','${OWN}','${P}','2099-01-01T00:00:00Z','R3'),
      ('${TOK_E}','${EMP}','${P}','2099-01-01T00:00:00Z','R4');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,judgment_status,assigned_verifier_id) VALUES
      ('WI-S','${P}','任务','任务','facts','awaiting_verification','employee','员工',100,'','','confirmed','${VER}'),
      ('WI-O','${OTHER}','其他任务','任务','facts','awaiting_verification','employee','员工',100,'','','confirmed',NULL);
    INSERT INTO evidence_materials(id,project_id,material_key,version,source_type,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference) VALUES
      ('MAT-S','${P}','MAT-S',1,'pdf','authorized','verified','project','${BLD}','WI-S','证据','REF');
    INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,required,impact_level,second_confirmation_status,material_status,status,source_refs_json,evidence_level) VALUES
      ('F-GOOD','${P}','WI-S','workflow','每天重复确认库存','stock',1,'normal','not_required','same','confirmed','["MAT-S"]','E2'),
      ('F-SECOND','${P}','WI-S','workflow','高影响但未二次确认','risk',0,'high','pending','same','confirmed','["MAT-S"]','E2'),
      ('F-E5','${P}','WI-S','workflow','模型推断的假设','ai',0,'normal','not_required','same','confirmed','["MAT-S"]','E5'),
      ('F-OPEN','${P}','WI-S','workflow','尚未核验的候选事实','open',0,'normal','not_required','unverified','open','[]',NULL),
      ('F-OTHER','${OTHER}','WI-O','workflow','其他项目事实','other',1,'normal','not_required','same','confirmed','[]','E2');
  `);
  return db;
}

const okJson = async (response) => ({ status: response.status, body: await response.clone().json().catch(() => ({})) });
const post = (handler, token, body, params, key) =>
  handler({ request: bearerRequest(`http://127.0.0.1/api/${params.projectId || params.packetId}`, token, body, key ? { "Idempotency-Key": key } : {}), env: env(handler.db || globalThis.__db), params });
const get = (handler, token, url, params, db) =>
  handler({ request: bearerRequest(url, token), env: env(db), params });

let db;
const call = (handler, token, body, params, key) =>
  handler({ request: bearerRequest(`http://127.0.0.1/x`, token, body, key ? { "Idempotency-Key": key } : {}), env: env(db), params });

function suggestion(factIds = ["F-GOOD"], overrides = {}) {
  return {
    problem: "库存确认依赖人工重复核对",
    opportunity: "把库存核对整理成自动提醒",
    factIds,
    priority: "high",
    priorityReason: "每天重复发生且影响交付节奏",
    pendingConditions: [],
    ...overrides,
  };
}

// The saved preview must carry the digest of the fact set the model saw. Tests build
// it from the same shared helpers the handlers use, not from a hard-coded string.
async function basis(db, scope = "formal") {
  const formal = await formalEligibleFacts(db, P);
  const facts = scope === "internal"
    ? await internalEligibleFacts(db, P, INTERNAL_FACT_LIMIT, formal)
    : [...formal.values()];
  return factsBasisDigest(facts);
}

function stubModel(payload, { delayMs = 0 } = {}) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { calls: () => calls, restore: () => { globalThis.fetch = original; } };
}
function stubFailure(error) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw error; };
  return { calls: () => calls, restore: () => { globalThis.fetch = original; } };
}

const results = [];
function check(id, name, pass, note = "") {
  results.push({ id, name, pass, note });
  console.log(`${pass ? "✔ PASS" : "✘ FAIL"} [${id}] ${name}${note ? " | " + note : ""}`);
}
const generateBody = (scope = "formal") => ({ scope });

console.log("V0.2 suggestions stage 2\n");

// ── S1 正常生成与结构拒绝 ──────────────────────────────────────────────
{
  db = fixture();
  const stub = stubModel({ suggestions: [suggestion(), suggestion(["F-GOOD"], { priority: "medium", pendingConditions: ["确认库存口径"] })] });
  const res = await call(generate, TOK_B, generateBody(), { projectId: P }, "GEN-S1");
  stub.restore();
  const body = await okJson(res);
  const item = body.body.suggestions?.[0] || {};
  check("S1-generate", "合格事实生成 2 条结构完整建议",
    res.status === 200 && body.body.suggestions?.length === 2
      && ["problem", "opportunity", "factIds", "priority", "priorityReason", "pendingConditions"].every((key) => key in item)
      && item.evidence?.[0]?.factId === "F-GOOD" && item.unverified === false,
    `status=${res.status} count=${body.body.suggestions?.length} priority=${item.priority}`);

  for (const [id, payload, code] of [
    ["S1-too-many", { suggestions: [suggestion(), suggestion(), suggestion(), suggestion()] }, "too_many_suggestions"],
    ["S1-bad-priority", { suggestions: [suggestion(["F-GOOD"], { priority: "urgent" })] }, "invalid_priority"],
    ["S1-fabricated", { suggestions: [suggestion(["F-GOOD"], { priorityReason: "预计提升 30% 效率" })] }, "fabricated_quantification"],
    ["S1-unknown-fact", { suggestions: [suggestion(["F-NOT-EXIST"])] }, "unknown_fact_refs"],
  ]) {
    db = fixture();
    const stubBad = stubModel(payload);
    const bad = await call(generate, TOK_B, generateBody(), { projectId: P }, `GEN-${id}`);
    stubBad.restore();
    const badBody = await okJson(bad);
    check(id, `非法输出整稿拒绝（${code}）`, bad.status === 422 && badBody.body.code === code,
      `status=${bad.status} code=${badBody.body.code || "-"}`);
  }

  db = fixture();
  const noKey = await call(generate, TOK_B, generateBody(), { projectId: P });
  check("S1-idempotency", "缺少 Idempotency-Key 拒绝生成", noKey.status === 422, `status=${noKey.status}`);
}

// ── S2 权限与引用真实性 ────────────────────────────────────────────────
{
  db = fixture();
  const stub = stubModel({ suggestions: [suggestion()] });
  const employee = await call(generate, TOK_E, generateBody(), { projectId: P }, "GEN-S2-E");
  const verifier = await call(generate, TOK_V, generateBody("internal"), { projectId: P }, "GEN-S2-V");
  stub.restore();
  check("S2-role", "员工/核验人不能生成建议", employee.status === 403 && verifier.status === 403,
    `employee=${employee.status} verifier=${verifier.status}`);

  db = fixture();
  const internalView = await get(getConfirmedFacts, TOK_B, `http://127.0.0.1/x?scope=internal`, { projectId: P }, db);
  const internalBody = await okJson(internalView);
  const ids = (internalBody.body.facts || []).map((fact) => fact.factId);
  const fields = Object.keys((internalBody.body.facts || [])[0] || {});
  check("S2-internal-read", "改造方读取未核实事实：仅白名单字段、无跨项目泄漏",
    internalView.status === 200 && ids.includes("F-OPEN") && ids.includes("F-E5") && ids.includes("F-SECOND")
      && !ids.includes("F-GOOD") && !ids.includes("F-OTHER")
      && fields.every((key) => ["factId", "claim", "status", "evidenceLevel", "impactLevel", "eligible", "unverified"].includes(key))
      && (internalBody.body.facts || []).every((fact) => fact.unverified === true && fact.eligible === false),
    `ids=${JSON.stringify(ids)} fields=${JSON.stringify(fields)}`);

  const employeeRead = await get(getConfirmedFacts, TOK_E, `http://127.0.0.1/x?scope=internal`, { projectId: P }, db);
  check("S2-internal-denied", "员工不能读取未核实事实", employeeRead.status === 403, `status=${employeeRead.status}`);

  db = fixture();
  const stubCross = stubModel({ suggestions: [suggestion(["F-OTHER"])] });
  const cross = await call(generate, TOK_B, generateBody(), { projectId: P }, "GEN-S2-X");
  stubCross.restore();
  const crossBody = await okJson(cross);
  check("S2-cross-project", "跨项目事实 ID 被拒绝", cross.status === 422 && crossBody.body.code === "unknown_fact_refs",
    `status=${cross.status} code=${crossBody.body.code || "-"}`);

  const wrongProject = await call(generate, TOK_B, generateBody(), { projectId: OTHER }, "GEN-S2-P");
  check("S2-project-scope", "会话绑定的项目之外不能读取或生成", wrongProject.status === 403, `status=${wrongProject.status}`);
}

// ── S3 审核真实生效 ────────────────────────────────────────────────────
{
  db = fixture();
  const draft = await call(createDraft, TOK_B, { ...PACKET_FIELDS, suggestions: [suggestion()], basisDigest: await basis(db) }, { projectId: P }, "DRAFT-S3");
  const draftBody = await okJson(draft);
  const packetId = draftBody.body.packet?.id;
  check("S3-draft", "建议草稿建立，包级引用等于建议并集且状态为 draft",
    draft.status === 201 && draftBody.body.packet?.status === "draft"
      && JSON.stringify(draftBody.body.packet?.factRefs?.map((ref) => ref.factId)) === JSON.stringify(["F-GOOD"]),
    `status=${draft.status} packet=${packetId}`);

  const verify = await call(verifyPacket, TOK_V, { factRefs: [{ factId: "F-GOOD" }], contentKey: draftBody.body.packet.contentKey }, { packetId });
  check("S3-verify", "核验人逐条建议引用校验通过", verify.status === 200, `status=${verify.status}`);

  const publishBefore = await call(publishPacket, TOK_B, {}, { packetId });
  const publishBeforeBody = await okJson(publishBefore);
  check("S3-review-required", "未完成内容审核不能发布",
    publishBefore.status === 409 && publishBeforeBody.body.code === "content_review_required",
    `status=${publishBefore.status} code=${publishBeforeBody.body.code || "-"}`);

  const review = await call(createDraft, TOK_B, { action: "content_review", packetId, baseVersion: 1, contentKey: "0" }, { projectId: P });
  const reviewBody = await okJson(review);
  check("S3-review", "显式内容审核记录审核人/时间/哈希",
    review.status === 200 && reviewBody.body.contentReview?.reviewedBy === BLD && reviewBody.body.contentReview?.contentHash,
    `status=${review.status} reviewer=${reviewBody.body.contentReview?.reviewedBy}`);

  const publish = await call(publishPacket, TOK_B, {}, { packetId });
  check("S3-publish", "内容审核 + 事实核验齐备后发布成功", publish.status === 200, `status=${publish.status}`);

  // 审核后篡改建议 → 哈希失效（用未发布过的新包，避免幂等重放干扰）
  db = fixture();
  const draft3 = await call(createDraft, TOK_B, { ...PACKET_FIELDS, suggestions: [suggestion()], basisDigest: await basis(db) }, { projectId: P }, "DRAFT-S3-3");
  const packetId3 = (await okJson(draft3)).body.packet.id;
  await call(verifyPacket, TOK_V, { factRefs: [{ factId: "F-GOOD" }], contentKey: "0" }, { packetId: packetId3 });
  await call(createDraft, TOK_B, { action: "content_review", packetId: packetId3, baseVersion: 1, contentKey: "0" }, { projectId: P });
  const envelope3 = JSON.parse(db.get("SELECT suggestions_json FROM decision_packets WHERE id=?", packetId3).suggestions_json);
  envelope3.items[0].problem = "审核后修改过的业务问题";
  db.exec(`UPDATE decision_packets SET suggestions_json='${JSON.stringify(envelope3).replace(/'/g, "''")}' WHERE id='${packetId3}'`);
  const republish = await call(publishPacket, TOK_B, {}, { packetId: packetId3 });
  check("S3-review-stale", "内容审核后修改建议，旧审核失效（发布被拒）",
    republish.status === 409 && (await okJson(republish)).body.code === "content_review_stale",
    `status=${republish.status}`);

  // 建议级引用不合格 → 核验拒绝（即使包级引用仍一致）
  db = fixture();
  const draft2 = await call(createDraft, TOK_B, { ...PACKET_FIELDS, suggestions: [suggestion()], basisDigest: await basis(db) }, { projectId: P }, "DRAFT-S3-2");
  const packetId2 = (await okJson(draft2)).body.packet.id;
  const env2 = JSON.parse(db.get("SELECT suggestions_json FROM decision_packets WHERE id=?", packetId2).suggestions_json);
  env2.items[0].factIds = ["F-OPEN"];
  db.exec(`UPDATE decision_packets SET suggestions_json='${JSON.stringify(env2).replace(/'/g, "''")}', fact_refs_json='[{"factId":"F-OPEN"}]' WHERE id='${packetId2}'`);
  const verifyBad = await call(verifyPacket, TOK_V, { factRefs: [{ factId: "F-OPEN" }], contentKey: "0" }, { packetId: packetId2 });
  check("S3-per-suggestion", "建议引用未核实事实时核验拒绝", verifyBad.status === 409, `status=${verifyBad.status}`);
}

// ── S4 内部稿隔离 ──────────────────────────────────────────────────────
{
  db = fixture();
  const internal = await call(createDraft, TOK_B, {
    ...PACKET_FIELDS,
    draftKind: "internal",
    suggestions: [suggestion(["F-OPEN"], { pendingConditions: ["确认员工所述口径"] })],
    basisDigest: await basis(db, "internal"),
  }, { projectId: P }, "DRAFT-S4");
  const internalBody = await okJson(internal);
  const packetId = internalBody.body.packet?.id;
  check("S4-create", "无材料内部待核实稿建立（internal_draft，unverified）",
    internal.status === 201 && internalBody.body.packet?.status === "internal_draft"
      && internalBody.body.packet?.suggestions?.[0]?.unverified === true,
    `status=${internal.status} packet=${packetId}`);

  const verify = await call(verifyPacket, TOK_V, { factRefs: [{ factId: "F-OPEN" }] }, { packetId });
  const publish = await call(publishPacket, TOK_B, {}, { packetId });
  const owner = await get(getOwnerPacket, TOK_O, "http://127.0.0.1/x", { projectId: P }, db);
  check("S4-isolation", "内部稿不能核验、不能发布、负责人不可见",
    verify.status === 409 && publish.status === 409 && owner.status === 404,
    `verify=${verify.status} publish=${publish.status} owner=${owner.status}`);
  check("S4-published-at", "内部稿不写 published_at",
    db.get("SELECT published_at FROM decision_packets WHERE id=?", packetId).published_at === null, "published_at=null");

  const internalRead = await get(getDecisionPacket, TOK_B, "http://127.0.0.1/x?scope=internal", { projectId: P }, db);
  const internalReadBody = await okJson(internalRead);
  const verifierInternalRead = await get(getDecisionPacket, TOK_V, "http://127.0.0.1/x?scope=internal", { projectId: P }, db);
  const verifierDefaultRead = await get(getDecisionPacket, TOK_V, "http://127.0.0.1/x", { projectId: P }, db);
  check("S4-builder-read", "改造方可重新打开内部稿，核验人读取被拒且默认接口看不到",
    internalRead.status === 200 && internalReadBody.body.packet?.status === "internal_draft"
      && verifierInternalRead.status === 403 && verifierDefaultRead.status === 404,
    `builder=${internalRead.status} verifierScope=${verifierInternalRead.status} verifierDefault=${verifierDefaultRead.status}`);

  const formalAfterInternal = await call(createDraft, TOK_B, { ...PACKET_FIELDS, suggestions: [suggestion()], basisDigest: await basis(db) }, { projectId: P }, "DRAFT-S4-F");
  const formalAfterBody = await okJson(formalAfterInternal);
  check("S4-formal-after-internal", "内部稿存在时仍可建立正式草稿",
    formalAfterInternal.status === 201 && formalAfterBody.body.packet?.status === "draft",
    `status=${formalAfterInternal.status} packetStatus=${formalAfterBody.body.packet?.status || "-"}`);

  db = fixture();
  const onlyFormal = await call(createDraft, TOK_B, { ...PACKET_FIELDS, draftKind: "internal", suggestions: [suggestion(["F-GOOD"], { pendingConditions: ["确认库存口径"] })] }, { projectId: P }, "DRAFT-S4-2");
  const onlyFormalBody = await okJson(onlyFormal);
  check("S4-requires-unverified", "内部稿必须引用未核实事实", onlyFormal.status === 422 && onlyFormalBody.body.code === "internal_requires_unverified",
    `status=${onlyFormal.status} code=${onlyFormalBody.body.code || "-"}`);

  db = fixture();
  const noPending = await call(createDraft, TOK_B, { ...PACKET_FIELDS, draftKind: "internal", suggestions: [suggestion(["F-OPEN"], { pendingConditions: [] })] }, { projectId: P }, "DRAFT-S4-3");
  check("S4-pending", "内部建议必须写明待确认条件", noPending.status === 422, `status=${noPending.status}`);

  // 补齐材料后，旧内部稿仍不可进入正式链路
  db = fixture();
  const draft = await call(createDraft, TOK_B, { ...PACKET_FIELDS, draftKind: "internal", suggestions: [suggestion(["F-OPEN"], { pendingConditions: ["确认口径"] })], basisDigest: await basis(db, "internal") }, { projectId: P }, "DRAFT-S4-4");
  const packetId4 = (await okJson(draft)).body.packet.id;
  db.exec("UPDATE candidate_facts SET status='confirmed',material_status='same',source_refs_json='[\"MAT-S\"]' WHERE id='F-OPEN'");
  const verifyAfter = await call(verifyPacket, TOK_V, { factRefs: [{ factId: "F-OPEN" }] }, { packetId: packetId4 });
  const publishAfter = await call(publishPacket, TOK_B, {}, { packetId: packetId4 });
  check("S4-no-inheritance", "补齐材料后旧内部稿仍不能核验/发布", verifyAfter.status === 409 && publishAfter.status === 409,
    `verify=${verifyAfter.status} publish=${publishAfter.status}`);
}

// ── S5 正式交付与旧包兼容 ──────────────────────────────────────────────
{
  db = fixture();
  const draft = await call(createDraft, TOK_B, { ...PACKET_FIELDS, suggestions: [suggestion()], basisDigest: await basis(db) }, { projectId: P }, "DRAFT-S5");
  const packetId = (await okJson(draft)).body.packet.id;
  await call(createDraft, TOK_B, { action: "content_review", packetId, baseVersion: 1, contentKey: "0" }, { projectId: P });
  await call(verifyPacket, TOK_V, { factRefs: [{ factId: "F-GOOD" }], contentKey: "0" }, { packetId });
  const publish = await call(publishPacket, TOK_B, {}, { packetId });
  const owner = await get(getOwnerPacket, TOK_O, "http://127.0.0.1/x", { projectId: P }, db);
  const ownerBody = await okJson(owner);
  check("S5-delivery", "正式发布后负责人可看到建议与内容审核记录",
    publish.status === 200 && owner.status === 200
      && ownerBody.body.packet?.suggestions?.length === 1
      && ownerBody.body.packet?.suggestionReview?.reviewedBy === BLD
      && ownerBody.body.packet?.suggestionsInvalidated === null,
    `publish=${publish.status} owner=${owner.status} suggestions=${ownerBody.body.packet?.suggestions?.length}`);

  // 旧包（无建议）行为不变
  db = fixture();
  db.exec(`INSERT INTO decision_packets(id,project_id,version,status,drafted_by_account_id,fact_refs_json,risk_summary,pilot_scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner) VALUES ('PKT-LEGACY','${P}',1,'draft','${BLD}','[{"factId":"F-GOOD"}]','R','P','["c"]','["m"]','["s"]','Owner')`);
  const legacyVerify = await call(verifyPacket, TOK_V, { factRefs: [{ factId: "F-GOOD" }] }, { packetId: "PKT-LEGACY" });
  const legacyPublish = await call(publishPacket, TOK_B, {}, { packetId: "PKT-LEGACY" });
  const legacyOwner = await get(getOwnerPacket, TOK_O, "http://127.0.0.1/x", { projectId: P }, db);
  const legacyBody = await okJson(legacyOwner);
  check("S5-legacy", "旧决策包（无建议）核验/发布/负责人读取保持兼容",
    legacyVerify.status === 200 && legacyPublish.status === 200 && legacyOwner.status === 200
      && Array.isArray(legacyBody.body.packet?.suggestions) && legacyBody.body.packet.suggestions.length === 0,
    `verify=${legacyVerify.status} publish=${legacyPublish.status} owner=${legacyOwner.status}`);
}

// ── S6 证据失效 ────────────────────────────────────────────────────────
{
  db = fixture();
  const draft = await call(createDraft, TOK_B, { ...PACKET_FIELDS, suggestions: [suggestion()], basisDigest: await basis(db) }, { projectId: P }, "DRAFT-S6");
  const packetId = (await okJson(draft)).body.packet.id;
  await call(createDraft, TOK_B, { action: "content_review", packetId, baseVersion: 1, contentKey: "0" }, { projectId: P });
  await call(verifyPacket, TOK_V, { factRefs: [{ factId: "F-GOOD" }], contentKey: "0" }, { packetId });
  await call(publishPacket, TOK_B, {}, { packetId });

  const changed = await call(correctFact, TOK_V, { action: "correct_evidence_level", factId: "F-GOOD", evidenceLevel: "E1", reason: "证据等级修正" }, { itemId: "WI-S" });
  if (changed.status !== 200) throw new Error("S6 requires a successful fact transition");
  const owner = await get(getOwnerPacket, TOK_O, "http://127.0.0.1/x", { projectId: P }, db);
  const ownerBody = await okJson(owner);
  check("S6-stale", "发布后事实变化 → packet stale，负责人不再获得有效建议",
    db.get("SELECT status FROM decision_packets WHERE id=?", packetId).status === "stale"
      && owner.status === 200 && ownerBody.body.packet?.suggestions?.length === 0
      && ownerBody.body.packet?.suggestionsInvalidated?.invalidated === true,
    `status=${db.get("SELECT status FROM decision_packets WHERE id=?", packetId).status} suggestions=${ownerBody.body.packet?.suggestions?.length}`);

  // 仅建议引用（不在 fact_refs_json）也应被扫描到
  db = fixture();
  db.exec(`INSERT INTO decision_packets(id,project_id,version,status,drafted_by_account_id,fact_refs_json,suggestions_json,risk_summary,pilot_scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner) VALUES ('PKT-SUG','${P}',1,'published','${BLD}','[{"factId":"F-GOOD"}]','{"schemaVersion":1,"draftKind":"internal","items":[{"id":"SUG-1","problem":"p","opportunity":"o","factIds":["F-OPEN"],"priority":"low","priorityReason":"r","pendingConditions":["c"],"evidence":[]}],"contentReview":null}','R','P','["c"]','["m"]','["s"]','Owner')`);
  const scan = await findInvalidatablePacketsReferencing(db, P, "F-OPEN");
  check("S6-scan-suggestions", "失效扫描能识别 suggestions_json 中的引用",
    scan.length === 1 && scan[0].id === "PKT-SUG", `packets=${JSON.stringify(scan.map((p) => p.id))}`);

  // 无失效事件时，读取期漂移也必须扣留建议
  db = fixture();
  const draft2 = await call(createDraft, TOK_B, { ...PACKET_FIELDS, suggestions: [suggestion()], basisDigest: await basis(db) }, { projectId: P }, "DRAFT-S6-2");
  const packetId2 = (await okJson(draft2)).body.packet.id;
  await call(createDraft, TOK_B, { action: "content_review", packetId: packetId2, baseVersion: 1, contentKey: "0" }, { projectId: P });
  await call(verifyPacket, TOK_V, { factRefs: [{ factId: "F-GOOD" }], contentKey: "0" }, { packetId: packetId2 });
  await call(publishPacket, TOK_B, {}, { packetId: packetId2 });
  db.exec("UPDATE candidate_facts SET evidence_level='E1' WHERE id='F-GOOD'");
  const driftOwner = await get(getOwnerPacket, TOK_O, "http://127.0.0.1/x", { projectId: P }, db);
  const driftBody = await okJson(driftOwner);
  check("S6-read-drift", "读取期发现事实漂移 → 不把建议作为有效结论返回",
    driftOwner.status === 200 && driftBody.body.packet?.suggestions?.length === 0
      && driftBody.body.packet?.suggestionsInvalidated?.invalidated === true,
    `suggestions=${driftBody.body.packet?.suggestions?.length}`);
}

// ── 生成次数控制与失败恢复 ─────────────────────────────────────────────
{
  db = fixture();
  const stub = stubModel({ suggestions: [suggestion()] }, { delayMs: 60 });
  const [first, second] = await Promise.all([
    call(generate, TOK_B, generateBody(), { projectId: P }, "GEN-C1"),
    call(generate, TOK_B, generateBody(), { projectId: P }, "GEN-C2"),
  ]);
  stub.restore();
  check("C-concurrency", "并发生成只调用一次模型，另一请求 409",
    stub.calls() === 1 && [first.status, second.status].sort().join(",") === "200,409",
    `calls=${stub.calls()} statuses=${first.status},${second.status}`);

  db = fixture();
  const stubIdem = stubModel({ suggestions: [suggestion()] });
  const idemFirst = await call(generate, TOK_B, generateBody(), { projectId: P }, "GEN-IDEM");
  const idemSecond = await call(generate, TOK_B, generateBody(), { projectId: P }, "GEN-IDEM");
  stubIdem.restore();
  const idemBody = await okJson(idemFirst);
  const idemReplay = await okJson(idemSecond);
  check("C-idempotent", "同一幂等键重放返回同一份初稿且不再调用模型",
    stubIdem.calls() === 1 && idemFirst.status === 200 && idemSecond.status === 200
      && JSON.stringify(idemBody.body) === JSON.stringify(idemReplay.body),
    `calls=${stubIdem.calls()} statuses=${idemFirst.status},${idemSecond.status}`);

  db = fixture();
  const failing = stubFailure(new Error("network down"));
  const failures = [];
  for (let index = 0; index < 3; index += 1) failures.push(await call(generate, TOK_B, generateBody(), { projectId: P }, `GEN-F${index}`));
  const fourth = await call(generate, TOK_B, generateBody(), { projectId: P }, "GEN-F4");
  failing.restore();
  check("C-retry", "失败可重试但每 10 分钟最多 3 次，之后 429",
    failures.every((response) => response.status === 502) && fourth.status === 429,
    `statuses=${failures.map((r) => r.status).join(",")},${fourth.status} calls=${failing.calls()}`);

  db = fixture();
  const timeout = stubFailure(Object.assign(new Error("aborted"), { name: "AbortError" }));
  const timeoutRes = await call(generate, TOK_B, generateBody(), { projectId: P }, "GEN-T");
  timeout.restore();
  check("C-timeout", "模型超时返回 504 且不永久锁死", timeoutRes.status === 504, `status=${timeoutRes.status}`);
}

const pass = results.filter((result) => result.pass).length;
const fail = results.length - pass;
console.log(`\nPASS=${pass} FAIL=${fail}`);
if (fail) for (const result of results.filter((entry) => !entry.pass)) console.log(`  FAILED [${result.id}] ${result.note}`);
db?.close();
process.exit(fail ? 1 : 0);
