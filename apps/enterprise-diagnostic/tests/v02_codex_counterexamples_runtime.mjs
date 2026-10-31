import { withFixtureViewedVersions } from "./verification_view_fixture.mjs";
/**
 * V0.2 Codex 独立审查反例回归（R01–R13）。
 *
 * 每个场景使用真实 Pages 处理函数 + 内存 D1 + 假模型；R02 使用实际 app.js 渲染函数
 * 与最小 DOM 替身。不是浏览器验收，也不是真实模型/生产验证。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { onRequestPost as generate } from "../functions/api/formal/projects/[projectId]/diagnosis-suggestions.js";
import { onRequestPost as draft } from "../functions/api/formal/projects/[projectId]/decision-packets/draft.js";
import { onRequestGet as packetGet } from "../functions/api/formal/projects/[projectId]/decision-packet.js";
import { onRequestGet as ownerGet } from "../functions/api/formal/projects/[projectId]/owner-packet.js";
import { onRequestGet as factsGet } from "../functions/api/formal/projects/[projectId]/confirmed-facts.js";
import { onRequest as projectGet } from "../functions/api/projects/[projectId].js";
import { onRequestPost as verify } from "../functions/api/formal/decision-packets/[packetId]/verify.js";
import { onRequestPost as publish } from "../functions/api/formal/decision-packets/[packetId]/publish.js";
import { onRequestPost as decide } from "../functions/api/formal/decision-packets/[packetId]/owner-decision.js";
import { onRequestPost as factVerify } from "../functions/api/work-items/[itemId]/verification.js";
import { factsBasisDigest, formalEligibleFacts, internalEligibleFacts, INTERNAL_FACT_LIMIT } from "../functions/api/formal/decision-packets/_facts.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

const P = "PRJ-S", OTHER = "PRJ-O";
const BLD = "BLD-S", VER = "VER-S", OWN = "OWN-S", EMP = "EMP-S";
const TOK_B = "TOK-B", TOK_V = "TOK-V", TOK_O = "TOK-O", TOK_E = "TOK-E";
const PACKET_FIELDS = {
  riskSummary: "当前流程存在重复确认环节", pilotScope: "先在一个班组试运行",
  constraints: ["不影响现有交付节奏"], successMetrics: ["同一事实不再被重复确认"],
  stopConditions: ["出现无法追溯的事实引用即停止"], downstreamOwner: "运营负责人",
};
const env = (db) => ({ DB: db, DEEPSEEK_API_KEY: "test-key" });

function fixture() {
  const db = new D1Harness();
  db.exec(`
    INSERT INTO accounts(id,email,name,status) VALUES
      ('${BLD}','b@v02.invalid','改造方','active'),('${VER}','v@v02.invalid','核验人','active'),
      ('${OWN}','o@v02.invalid','负责人','active'),('${EMP}','e@v02.invalid','员工','active');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id) VALUES
      ('${P}','V02','选品到发布','decision','active','L2','external_builder','${BLD}'),
      ('${OTHER}','其他项目','范围','decision','active','L2','external_builder','${BLD}');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES
      ('AUTH-S','${P}','授权','王总','owner@v02.invalid','诊断','DOC','authorized','${BLD}','K1','n','h','2099-01-01T00:00:00Z'),
      ('AUTH-O','${OTHER}','授权','李总','owner2@v02.invalid','诊断','DOC','authorized','${BLD}','K2','n','h','2099-01-01T00:00:00Z');
    INSERT INTO project_memberships(project_id,account_id,role,status) VALUES
      ('${P}','${BLD}','external_builder','active'),('${P}','${VER}','verifier','active'),
      ('${P}','${OWN}','owner','active'),('${P}','${EMP}','employee','active'),
      ('${OTHER}','${BLD}','external_builder','active');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('${TOK_B}','${BLD}','${P}','2099-01-01T00:00:00Z','R1'),('${TOK_V}','${VER}','${P}','2099-01-01T00:00:00Z','R2'),
      ('${TOK_O}','${OWN}','${P}','2099-01-01T00:00:00Z','R3'),('${TOK_E}','${EMP}','${P}','2099-01-01T00:00:00Z','R4');
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

const results = [];
function record(id, pass, note = "") { results.push({ id, pass }); console.log(`${pass ? "✔ PASS" : "✘ FAIL"} [${id}]${note ? " | " + note : ""}`); }
async function call(db, handler, token, body, params = {}, key = "", query = "") {
  if (handler===factVerify) body=withFixtureViewedVersions(db,body);
  const response = await handler({ request: bearerRequest(`http://127.0.0.1/x${query}`, token, body, key ? { "Idempotency-Key": key } : {}), env: env(db), params });
  const text = await response.text();
  let json = {}; try { json = JSON.parse(text); } catch (_error) { json = { raw: text }; }
  return { status: response.status, body: json };
}
function suggestion(factIds = ["F-GOOD"], overrides = {}) {
  return { problem: "库存核对重复", opportunity: "自动提醒", factIds, priority: "high", priorityReason: "重复影响交接", pendingConditions: [], ...overrides };
}
async function basis(db, scope = "formal") {
  const formal = await formalEligibleFacts(db, P);
  const facts = scope === "internal"
    ? await internalEligibleFacts(db, P, INTERNAL_FACT_LIMIT, formal)
    : [...formal.values()];
  return factsBasisDigest(facts);
}
async function create(db, items = [suggestion()], extra = {}) {
  const scope = extra.draftKind === "internal" ? "internal" : "formal";
  const r = await call(db, draft, TOK_B, { ...PACKET_FIELDS, suggestions: items, basisDigest: await basis(db, scope), ...extra }, { projectId: P }, crypto.randomUUID());
  assert.equal(r.status, 201, JSON.stringify(r));
  return r.body.packet;
}
async function ready(db, p) {
  assert.equal((await call(db, draft, TOK_B, { action: "content_review", packetId: p.id, baseVersion: p.version, contentKey: p.contentKey }, { projectId: P })).status, 200);
  assert.equal((await call(db, verify, TOK_V, { factRefs: p.factRefs, contentKey: p.contentKey }, { packetId: p.id })).status, 200);
}
async function published(db) { const p = await create(db); await ready(db, p); assert.equal((await call(db, publish, TOK_B, {}, { packetId: p.id })).status, 200); return p; }
const decision = { decision: "continue", reason: "按诊断推进", scope: "一个班组", constraints: ["人工确认"], successMetrics: ["可追溯"], stopConditions: ["出现异常"], downstreamOwner: "业务负责人" };
async function grade(db, target) { return call(db, factVerify, TOK_V, { action: "correct_evidence_level", factId: "F-GOOD", reason: "审查场景等级调整", evidenceLevel: target }, { itemId: "WI-S" }); }
function modelStub(text = "库存核对重复", factIds = ["F-GOOD"]) {
  const prompts = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.deepseek.com/chat/completions", "network must remain stubbed");
    prompts.push(JSON.parse(init.body).messages);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions: [suggestion(factIds, { problem: text, pendingConditions: ["确认口径"] })] }) } }] }));
  };
  return prompts;
}
globalThis.fetch = async () => { throw new Error("external network blocked by audit"); };

// ── R01 内部稿拒绝响应不得泄漏 ────────────────────────────────────────
{
  const db = fixture();
  const p = await create(db, [suggestion(["F-OPEN"], { pendingConditions: ["核实口径"], problem: "内部机密建议标记" })], { draftKind: "internal" });
  const denied = await call(db, verify, TOK_V, { factRefs: p.factRefs }, { packetId: p.id });
  const read = await call(db, packetGet, TOK_V, undefined, { projectId: P }, "", "?scope=internal");
  const leaked = denied.body.packet !== undefined || JSON.stringify(denied.body).includes("内部机密建议标记");
  record("R01", denied.status === 409 && read.status === 403 && !leaked,
    `verify=${denied.status} read=${read.status} leaked=${leaked}`);
  db.close();
}

// ── R02 界面分支：内部预览优先；内部稿不阻塞正式；退回不丢建议 ─────────
{
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const code = app.slice(app.indexOf("function renderSuggestionCards("), app.indexOf("// 一键进演示："));
  const panel = { hidden: true, innerHTML: "", querySelector: () => null };
  const state = {
    formalProjectId: P, formalConfirmedFacts: [], formalInternalFacts: [{ factId: "F-OPEN", claim: "待确认事实", status: "open" }],
    formalDecisionPacket: null, formalInternalPacket: null,
    formalSuggestionDraft: { scope: "internal", suggestions: [suggestion(["F-OPEN"])] },
    formalSuggestionPending: false, formalSuggestionError: "",
  };
  const context = { state, formalBuilderDecisionPanel: panel, escapeMarkup: (v) => String(v ?? ""), formatFormalTime: String, submitFormalDecisionPacket() {}, window: {}, formalUiContract: null };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL("../formal-ui-contract.js", import.meta.url), "utf8"), context);
  context.formalUiContract = context.window.formalUiContract;
  vm.runInContext(code, context);
  context.renderFormalBuilderDecisionPanel();
  const noMaterial = { preview: panel.innerHTML.includes("suggestion-preview"), form: panel.innerHTML.includes("<form") };

  state.formalConfirmedFacts = [{ factId: "F-GOOD", claim: "已确认" }];
  state.formalInternalPacket = { suggestions: [suggestion(["F-OPEN"])] };
  state.formalSuggestionDraft = { scope: "formal", suggestions: [suggestion()] };
  context.renderFormalBuilderDecisionPanel();
  const afterInternal = { preview: panel.innerHTML.includes("suggestion-preview"), form: panel.innerHTML.includes("<form") };

  state.formalInternalPacket = null;
  state.formalDecisionPacket = { status: "revision_requested", suggestions: [suggestion()] };
  state.formalBuilderControl = { revisionBlocker: { revisionReason: "调整建议", revisionFromVersion: 1 } };
  state.formalSuggestionDraft = null;
  context.renderFormalBuilderDecisionPanel();
  const revision = { generator: panel.innerHTML.includes('data-action="generate-suggestions"'), suggestionCards: panel.innerHTML.includes("suggestion-card") };

  record("R02", noMaterial.preview && noMaterial.form && afterInternal.preview && afterInternal.form && revision.generator && revision.suggestionCards,
    `noMaterial=${JSON.stringify(noMaterial)} afterInternal=${JSON.stringify(afterInternal)} revision=${JSON.stringify(revision)}`);
}

// ── R03 正式生成使用核验更正后的当前有效文本 ──────────────────────────
{
  const db = fixture();
  db.exec("UPDATE candidate_facts SET status='open',material_status='unverified',claim='每天人工重复核对库存' WHERE id='F-GOOD'");
  const corrected = await call(db, factVerify, TOK_V, { factId: "F-GOOD", decision: "different_with_correction", correction: "库存核对已自动完成，无需人工重复操作", reason: "材料实际显示已经自动化", sourceRefs: ["MAT-S"], evidenceLevel: "E2" }, { itemId: "WI-S" });
  const prompts = modelStub();
  const generated = await call(db, generate, TOK_B, { scope: "formal" }, { projectId: P }, "CORRECTED-GEN");
  const prompt = prompts[0]?.[1]?.content || "";
  record("R03", corrected.status === 200 && generated.status === 200
    && prompt.includes("库存核对已自动完成") && !prompt.includes("每天人工重复核对库存"),
    `verification=${corrected.status} generation=${generated.status} correctedInPrompt=${prompt.includes("库存核对已自动完成")}`);
  db.close();
}

// ── R04 中文金额、百分之、全角百分号、实施周期均被拒绝 ─────────────────
{
  const cases = [
    "承诺3天完成上线，每年节省十万元，效率提升百分之三十",
    "效率提升３０％",
    "实施周期为两周",
  ];
  let blocked = 0;
  for (const text of cases) {
    const db = fixture();
    modelStub(text);
    const r = await call(db, generate, TOK_B, { scope: "formal" }, { projectId: P }, `QUANT-${blocked}`);
    if (r.status === 422 && r.body.code === "fabricated_quantification") blocked += 1;
    db.close();
  }
  record("R04", blocked === cases.length, `blocked=${blocked}/${cases.length}`);
}

// ── R05 依据在草案阶段变化：核验与发布都必须拒绝 ───────────────────────
{
  const db = fixture();
  const p = await create(db);
  assert.equal((await grade(db, "E1")).status, 200);
  const verifyR = await call(db, verify, TOK_V, { factRefs: p.factRefs, contentKey: p.contentKey }, { packetId: p.id });
  const publishR = await call(db, publish, TOK_B, {}, { packetId: p.id });
  record("R05", verifyR.status === 409 && verifyR.body.code === "suggestion_basis_changed" && publishR.status === 409,
    `verify=${verifyR.status}/${verifyR.body.code} publish=${publishR.status}`);
  db.close();
}

// ── R06 stale 后可重新起草；旧发布重放返回冲突；负责人不能决策 ──────────
{
  const db = fixture();
  const p = await published(db);
  assert.equal((await grade(db, "E1")).status, 200);
  const fresh = await call(db, draft, TOK_B, { ...PACKET_FIELDS, suggestions: [suggestion()], basisDigest: await basis(db) }, { projectId: P }, "RECOVER-DRAFT");
  const revision = await call(db, decide, TOK_O, { ...decision, decision: "revision" }, { packetId: p.id }, "RECOVER-REVISION");
  const get = await call(db, packetGet, TOK_B, undefined, { projectId: P });
  const replay = await call(db, publish, TOK_B, {}, { packetId: p.id });
  record("R06", fresh.status === 201 && revision.status === 409
    && get.status === 200 && ["draft", "stale"].includes(get.body.packet?.status)
    && db.get("SELECT status FROM decision_packets WHERE id=?", p.id).status === "stale"
    && replay.status === 409 && replay.body.code === "decision_packet_stale",
    `newDraft=${fresh.status} revision=${revision.status} get=${get.status}/${get.body.packet?.status} staleRow=${db.get("SELECT status FROM decision_packets WHERE id=?", p.id).status} replay=${replay.status}/${replay.body.code}`);
  db.close();
}

// ── R07 已决策历史保留；等级恢复不得让建议重新生效 ──────────────────────
{
  const db = fixture();
  const p = await published(db);
  assert.equal((await call(db, decide, TOK_O, decision, { packetId: p.id }, "HISTORY")).status, 200);
  assert.equal((await grade(db, "E1")).status, 200);
  const after = await call(db, ownerGet, TOK_O, undefined, { projectId: P });
  assert.equal((await grade(db, "E2")).status, 200);
  const restored = await call(db, ownerGet, TOK_O, undefined, { projectId: P });
  record("R07", after.body.packet?.suggestionsInvalidated?.invalidated === true
    && restored.body.packet?.suggestions?.length === 0
    && restored.body.packet?.suggestionsInvalidated?.invalidated === true
    && restored.body.packet?.status === "stale",
    `status=${restored.body.packet?.status} visibleAfterRestore=${restored.body.packet?.suggestions?.length}`);
  db.close();
}

// ── R08 改造方项目详情不返回员工原始草稿 ───────────────────────────────
{
  const db = fixture();
  db.prepare("UPDATE work_items SET employee_description=?,employee_draft_json=? WHERE id=?").bind("私有员工对话标记", JSON.stringify({ schemaVersion: 2, answers: { trigger: "私有草稿标记" }, ledger: { rawConversation: "私有原始对话标记" } }), "WI-S").run();
  const r = await call(db, projectGet, TOK_B, undefined, { projectId: P });
  const task = (r.body.tasks || []).find((entry) => entry.id === "WI-S") || {};
  const leaked = Boolean(task.draft || task.draftAnswers || task.employeeDescription || task.workflowCard || task.alternativeExplanations);
  record("R08", r.status === 200 && !leaked && task.status === "awaiting_verification",
    `status=${r.status} leaked=${leaked} keys=${JSON.stringify(Object.keys(task).slice(0, 6))}`);
  db.close();
}

// ── R09 内部事实列表与生成使用同一资格与范围（先过滤再截断）────────────
{
  const db = fixture();
  const insert = db.database.prepare("INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,required,impact_level,material_status,status,source_refs_json,evidence_level,created_at) VALUES (?,?,'WI-S','workflow','已确认事实','extra',0,'normal','same','confirmed','[\"MAT-S\"]','E2','2000-01-01')");
  for (let i = 0; i < 30; i += 1) insert.run(`F-BULK-${i}`, P);
  const list = await call(db, factsGet, TOK_B, undefined, { projectId: P }, "", "?scope=internal");
  modelStub("库存核对重复", ["F-E5"]);
  const gen = await call(db, generate, TOK_B, { scope: "internal" }, { projectId: P }, "LIMIT-30");
  record("R09", (list.body.facts || []).length === 3 && gen.status === 200,
    `uiInternalFacts=${(list.body.facts || []).length} generation=${gen.status}`);
  db.close();
}

// ── R10 并发：失效在发布之后落库，包仍被标 stale，决策被拒 ──────────────
{
  const db = fixture();
  const p = await create(db);
  let release;
  const originalBatch = db.batch.bind(db);
  db.batch = (statements) => {
    if (statements[0].sql.startsWith("UPDATE candidate_facts SET evidence_level=")) {
      return new Promise((resolve) => { release = () => resolve(originalBatch(statements)); });
    }
    return originalBatch(statements);
  };
  const changing = grade(db, "E5");
  for (let i = 0; i < 50 && !release; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(release, "grade request reached batch");
  await ready(db, p);
  const pub = await call(db, publish, TOK_B, {}, { packetId: p.id });
  release();
  assert.equal((await changing).status, 200);
  const owner = await call(db, ownerGet, TOK_O, undefined, { projectId: P });
  const dec = await call(db, decide, TOK_O, decision, { packetId: p.id }, "RACE-DECIDE");
  record("R10", pub.status === 200 && owner.body.packet?.status === "stale" && dec.status === 409,
    `publish=${pub.status} packet=${owner.body.packet?.status} decision=${dec.status}`);
  db.close();
}

// ── R11 已保存草稿可修正，修改后旧审核失效 ─────────────────────────────
{
  const db = fixture();
  const p = await create(db);
  const updated = await call(db, draft, TOK_B, { action: "update_suggestions", packetId: p.id, baseVersion: p.version, contentKey: p.contentKey, suggestions: [suggestion(["F-GOOD"], { problem: "人工审核后调整的建议" })], basisDigest: await basis(db) }, { projectId: P });
  const envelope = JSON.parse(db.get("SELECT suggestions_json FROM decision_packets WHERE id=?", p.id).suggestions_json);
  record("R11", updated.status === 200 && updated.body.packet?.suggestions?.[0]?.problem === "人工审核后调整的建议"
    && envelope.contentReview === null,
    `status=${updated.status} review=${envelope.contentReview}`);
  db.close();
}

// ── R12 负责人退回后必须携带建议，不能静默清空 ─────────────────────────
{
  const db = fixture();
  db.exec("DELETE FROM candidate_facts WHERE id IN ('F-SECOND','F-E5','F-OPEN')");
  const p = await published(db);
  assert.equal((await call(db, decide, TOK_O, { ...decision, decision: "revision" }, { packetId: p.id }, "AI-REVISION")).status, 200);
  const without = await call(db, draft, TOK_B, { ...PACKET_FIELDS, factRefs: [{ factId: "F-GOOD", materialStatus: "same" }] }, { projectId: P }, "UI-REVISION-0");
  const withSuggestions = await call(db, draft, TOK_B, { ...PACKET_FIELDS, suggestions: [suggestion()], basisDigest: await basis(db) }, { projectId: P }, "UI-REVISION-1");
  record("R12", without.status === 422 && without.body.code === "revision_requires_suggestions"
    && withSuggestions.status === 201 && withSuggestions.body.packet?.suggestions?.length === 1,
    `without=${without.status}/${without.body.code} with=${withSuggestions.status}/${withSuggestions.body.packet?.suggestions?.length}`);
  db.close();
}

// ── R13 E5 不再出现在正式列表；内部列表带证据等级 ──────────────────────
{
  const db = fixture();
  const formal = await call(db, factsGet, TOK_B, undefined, { projectId: P });
  const internal = await call(db, factsGet, TOK_B, undefined, { projectId: P }, "", "?scope=internal");
  const formallyListed = (formal.body.facts || []).some((fact) => fact.factId === "F-E5");
  const internallyListed = (internal.body.facts || []).some((fact) => fact.factId === "F-E5");
  const good = (formal.body.facts || []).find((fact) => fact.factId === "F-GOOD");
  record("R13", !formallyListed && internallyListed && good?.evidenceLevel === "E2",
    `formalE5=${formallyListed} internalE5=${internallyListed} level=${good?.evidenceLevel}`);
  db.close();
}

// ── R14 核验人可读取建议引用事实的有效文本与材料 ─────────────────────
{
  const db = fixture();
  const p = await create(db);
  const view = await call(db, packetGet, TOK_V, undefined, { projectId: P });
  const fact = (view.body.packet?.suggestionFacts || []).find((entry) => entry.factId === "F-GOOD") || {};
  record("R14", view.status === 200 && fact.effectiveText === "每天重复确认库存"
    && (fact.materials || []).some((material) => material.materialId === "MAT-S" && material.authorizationStatus === "authorized"),
    `status=${view.status} text=${fact.effectiveText} materials=${(fact.materials || []).length}`);
  db.close();
}

const pass = results.filter((result) => result.pass).length;
console.log(`\nCOUNTEREXAMPLES PASS=${pass} FAIL=${results.length - pass}`);
process.exit(pass === results.length ? 0 : 1);
