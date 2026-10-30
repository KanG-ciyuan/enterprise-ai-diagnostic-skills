/**
 * V0.2 第二轮复审（Codex N1–N8）修复后的独立断言。
 *
 * 每个场景都使用真实 Pages 处理函数 + 内存 D1 + 假模型；没有网络、真实模型或生产数据。
 * 这不是浏览器验收：S01–S18 的原脚本用于证明漏洞存在，本文件把它们改写为
 * “修复后必须成立”的断言，而不是仅把原脚本跑完当作 PASS。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
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
import { onRequestPost as supplementPost } from "../functions/api/work-items/[itemId]/evidence-supplement.js";
import { onRequestGet as materialsGet } from "../functions/api/projects/[projectId]/materials.js";
import { onRequest as eventsGet } from "../functions/api/projects/[projectId]/events.js";
import { onRequestPut as saveDraft } from "../functions/api/work-items/[itemId]/employee-draft.js";
import { onRequestPost as submitEmployee } from "../functions/api/work-items/[itemId]/employee-submission.js";
import { onRequest as projectDetail } from "../functions/api/projects/[projectId].js";
import { onRequest as projectWorkItems } from "../functions/api/projects/[projectId]/work-items.js";
import { normalizeEmployeeDraft, serializeEmployeeDraft } from "../functions/_shared.js";
import { ANSWER_DIMENSIONS, canonicalJson, normalizeAnswers } from "../functions/api/agent/_evidence.js";
import { appendStatementHistory, buildInferenceRecords, buildInferences } from "../functions/api/agent/_adapter.js";
import { effectiveFactText, factsBasisDigest, formalEligibleFacts, internalEligibleFacts, INTERNAL_FACT_LIMIT, normalizeSuggestions } from "../functions/api/formal/decision-packets/_facts.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

const P = "PRJ-S", OTHER = "PRJ-O";
const BLD = "BLD-S", VER = "VER-S", VER2 = "VER2-S", OWN = "OWN-S", EMP = "EMP-S";
const TOK_B = "TOK-B", TOK_V = "TOK-V", TOK_V2 = "TOK-V2", TOK_O = "TOK-O", TOK_E = "TOK-E";
const PACKET_FIELDS = {
  riskSummary: "当前流程存在重复确认环节", pilotScope: "先在一个班组试运行",
  constraints: ["不影响现有交付节奏"], successMetrics: ["同一事实不再被重复确认"],
  stopConditions: ["出现无法追溯的事实引用即停止"], downstreamOwner: "运营负责人",
};
const env = (db) => ({ DB: db, DEEPSEEK_API_KEY: "test-key" });
const blockedFetch = async () => { throw new Error("external network blocked by audit"); };
globalThis.fetch = blockedFetch;

function fixture() {
  const db = new D1Harness();
  db.exec(`
    INSERT INTO accounts(id,email,name,status) VALUES
      ('${BLD}','b@v02.invalid','改造方','active'),('${VER}','v@v02.invalid','核验人','active'),
      ('${VER2}','v2@v02.invalid','其他核验人','active'),
      ('${OWN}','o@v02.invalid','负责人','active'),('${EMP}','e@v02.invalid','员工','active');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id) VALUES
      ('${P}','V02','选品到发布','decision','active','L2','external_builder','${BLD}'),
      ('${OTHER}','其他项目','范围','decision','active','L2','external_builder','${BLD}');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES
      ('AUTH-S','${P}','授权','王总','owner@v02.invalid','诊断','DOC','authorized','${BLD}','K1','n','h','2099-01-01T00:00:00Z'),
      ('AUTH-O','${OTHER}','授权','李总','owner2@v02.invalid','诊断','DOC','authorized','${BLD}','K2','n','h','2099-01-01T00:00:00Z');
    INSERT INTO project_memberships(project_id,account_id,role,status) VALUES
      ('${P}','${BLD}','external_builder','active'),('${P}','${VER}','verifier','active'),
      ('${P}','${VER2}','verifier','active'),
      ('${P}','${OWN}','owner','active'),('${P}','${EMP}','employee','active'),
      ('${OTHER}','${BLD}','external_builder','active');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('${TOK_B}','${BLD}','${P}','2099-01-01T00:00:00Z','R1'),('${TOK_V}','${VER}','${P}','2099-01-01T00:00:00Z','R2'),
      ('${TOK_V2}','${VER2}','${P}','2099-01-01T00:00:00Z','R-V2'),
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
function record(id, passed, note = "") { results.push({ id, passed, note }); console.log(`${passed ? "✔ PASS" : "✘ FAIL"} [${id}]${note ? " | " + note : ""}`); }
async function scenario(id, fn) {
  try { const detail = await fn(); record(id, true, JSON.stringify(detail)); }
  catch (error) { record(id, false, error.message); }
}
async function call(db, handler, token, body, params = {}, key = "", query = "") {
  const response = await handler({ request: bearerRequest(`http://127.0.0.1/x${query}`, token, body, key ? { "Idempotency-Key": key } : {}), env: env(db), params });
  const text = await response.text();
  let parsed = {}; try { parsed = JSON.parse(text); } catch (_error) { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
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
  assert.equal((await call(db, draft, TOK_B, { action: "content_review", packetId: p.id, baseVersion: p.version, contentKey: p.contentKey }, { projectId: P })).status, 200, "content review must pass");
  assert.equal((await call(db, verify, TOK_V, { factRefs: p.factRefs, contentKey: p.contentKey }, { packetId: p.id })).status, 200, "verify must pass");
}
async function published(db) {
  const p = await create(db);
  await ready(db, p);
  assert.equal((await call(db, publish, TOK_B, {}, { packetId: p.id })).status, 200, "publish must pass");
  return p;
}
const decision = { decision: "continue", reason: "按诊断推进", scope: "一个班组", constraints: ["人工确认"], successMetrics: ["可追溯"], stopConditions: ["出现异常"], downstreamOwner: "业务负责人" };
async function grade(db, target) { return call(db, factVerify, TOK_V, { action: "correct_evidence_level", factId: "F-GOOD", reason: "复审场景等级调整", evidenceLevel: target }, { itemId: "WI-S" }); }
function modelStub(text = "库存核对重复", factIds = ["F-GOOD"]) {
  const prompts = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://api.deepseek.com/chat/completions", "network must remain stubbed");
    prompts.push(JSON.parse(init.body).messages);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions: [suggestion(factIds, { problem: text, pendingConditions: ["确认口径"] })] }) } }] }));
  };
  return prompts;
}
function restoreFetchToBlocked() { globalThis.fetch = blockedFetch; }
async function gateBatch(db, predicate, operation) {
  const original = db.batch.bind(db); let release = null; let claimed = false;
  db.batch = (statements) => {
    if (!claimed && predicate(statements)) {
      claimed = true;
      return new Promise((resolve, reject) => { release = () => { try { resolve(original(statements)); } catch (error) { reject(error); } }; });
    }
    return original(statements);
  };
  const pending = operation();
  for (let i = 0; i < 400 && !release; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(release, "controlled request must reach the targeted batch");
  return { pending, release: () => { db.batch = original; release(); } };
}
function wire(items) { return (items || []).map(({ problem, opportunity, factIds, priority, priorityReason, pendingConditions }) => ({ problem, opportunity, factIds, priority, priorityReason, pendingConditions })); }

// ── S01 历史私有材料：核验人读到受限占位，且不能核验 ─────────────────────
await scenario("S01_private_material_projection", async () => {
  const db = fixture();
  db.exec("UPDATE evidence_materials SET visibility='employee',label='员工专用材料标题_SYNTHETIC' WHERE id='MAT-S'");
  const p = await create(db);
  const list = await call(db, materialsGet, TOK_V, undefined, { projectId: P });
  const detail = await call(db, packetGet, TOK_V, undefined, { projectId: P });
  const restricted = (detail.body.packet?.suggestionFacts || []).find((fact) => fact.factId === "F-GOOD") || {};
  const verifyR = await call(db, verify, TOK_V, { factRefs: p.factRefs, contentKey: p.contentKey }, { packetId: p.id });
  assert.equal(list.status, 200);
  assert.equal(list.body.materials.length, 0, "verifier must not see the employee-only material");
  assert.equal(detail.status, 200);
  assert.equal(restricted.restricted, true, "private fact must be redacted");
  assert.ok(!JSON.stringify(detail.body).includes("员工专用材料标题_SYNTHETIC"), "private material label must not leak");
  assert.ok(!JSON.stringify(detail.body).includes("每天重复确认库存"), "private fact text must not leak");
  assert.equal(verifyR.status, 403, "verifier without the private basis cannot verify");
  db.close();
  return { materials: list.body.materials.length, read: detail.status, verify: verifyR.status };
});

// ── S02 未分配任务的另一核验人不能读取/核验具名材料事实 ────────────────
await scenario("S02_verifier_assignment_projection", async () => {
  const db = fixture();
  db.exec("UPDATE evidence_materials SET visibility='verifier',label='指派任务的材料_SYNTHETIC' WHERE id='MAT-S'");
  db.exec("UPDATE candidate_facts SET status='open',material_status='unverified' WHERE id='F-GOOD'");
  const confirm = await call(db, factVerify, TOK_V, { factId: "F-GOOD", decision: "same", reason: "具名核验人核实", sourceRefs: ["MAT-S"], evidenceLevel: "E2" }, { itemId: "WI-S" });
  assert.equal(confirm.status, 200, JSON.stringify(confirm));
  const p = await create(db);
  const list = await call(db, materialsGet, TOK_V2, undefined, { projectId: P });
  const detail = await call(db, packetGet, TOK_V2, undefined, { projectId: P });
  const restricted = (detail.body.packet?.suggestionFacts || []).find((fact) => fact.factId === "F-GOOD") || {};
  const verifyR = await call(db, verify, TOK_V2, { factRefs: p.factRefs, contentKey: p.contentKey }, { packetId: p.id });
  const ownerVerify = await call(db, verify, TOK_V, { factRefs: p.factRefs, contentKey: p.contentKey }, { packetId: p.id });
  assert.equal(list.body.materials.length, 0, "non-assigned verifier sees no material");
  assert.equal(restricted.restricted, true);
  assert.ok(!JSON.stringify(detail.body).includes("指派任务的材料_SYNTHETIC"));
  assert.ok(!JSON.stringify(detail.body).includes("每天重复确认库存"), "the fact text must be redacted, not only its material label");
  assert.equal(verifyR.status, 403, "non-assigned verifier cannot verify");
  assert.equal(ownerVerify.status, 200, "assigned verifier can still verify");
  db.close();
  return { confirm: confirm.status, list: list.body.materials.length, verifyOther: verifyR.status, verifyAssigned: ownerVerify.status };
});

// ── S03 旧核验不能确认替换后的新引用 ──────────────────────────────────
await scenario("S03_update_during_verification", async () => {
  const db = fixture();
  db.exec(`INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,required,impact_level,second_confirmation_status,material_status,status,source_refs_json,evidence_level) VALUES('F-NEW','${P}','WI-S','workflow','另一个核验完成的事实','extra',0,'normal','not_required','same','confirmed','["MAT-S"]','E2')`);
  const p = await create(db);
  const hold = await gateBatch(db, (statements) => statements[0].sql.startsWith("UPDATE decision_packets SET status='verifier_checked'"), () => call(db, verify, TOK_V, { factRefs: p.factRefs, contentKey: p.contentKey }, { packetId: p.id }));
  const update = await call(db, draft, TOK_B, { action: "update_suggestions", packetId: p.id, baseVersion: p.version, contentKey: p.contentKey, suggestions: [suggestion(["F-NEW"], { problem: "核验请求发出后替换的建议_SYNTHETIC" })], basisDigest: await basis(db) }, { projectId: P });
  assert.equal(update.status, 200, JSON.stringify(update));
  hold.release();
  const oldVerify = await hold.pending;
  assert.equal(oldVerify.status, 409, "old verification must lose");
  assert.equal(oldVerify.body.code, "suggestion_revision_changed");
  const fresh = await call(db, packetGet, TOK_V, undefined, { projectId: P });
  const verifyNew = await call(db, verify, TOK_V, { factRefs: fresh.body.packet.factRefs, contentKey: fresh.body.packet.contentKey }, { packetId: p.id });
  assert.equal(verifyNew.status, 200, JSON.stringify(verifyNew));
  assert.equal((await call(db, draft, TOK_B, { action: "content_review", packetId: p.id, baseVersion: p.version, contentKey: fresh.body.packet.contentKey }, { projectId: P })).status, 200);
  const pub = await call(db, publish, TOK_B, {}, { packetId: p.id });
  assert.equal(pub.status, 200);
  const stored = JSON.parse(db.get("SELECT fact_refs_json FROM decision_packets WHERE id=?", p.id).fact_refs_json).map((ref) => ref.factId);
  assert.deepEqual(stored, ["F-NEW"], "published packet must carry the new refs");
  assert.equal(db.get("SELECT status FROM decision_packets WHERE id=?", p.id).status, "published");
  db.close();
  return { update: update.status, oldVerify: oldVerify.status, verifyNew: verifyNew.status, publish: pub.status, stored };
});

// ── S04 旧内容审核不能覆盖已保存的新建议 ──────────────────────────────
await scenario("S04_content_review_races_edit", async () => {
  const db = fixture();
  const p = await create(db);
  const originalPrepare = db.prepare.bind(db);
  let release = null;
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (sql.startsWith("UPDATE decision_packets SET suggestions_json=json_set(")) {
      const oldBind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = oldBind(...values);
        const oldRun = bound.run.bind(bound);
        bound.run = () => new Promise((resolve) => { release = () => resolve(oldRun()); });
        return bound;
      };
    }
    return statement;
  };
  const pendingReview = call(db, draft, TOK_B, { action: "content_review", packetId: p.id, baseVersion: p.version, contentKey: p.contentKey }, { projectId: P });
  for (let i = 0; i < 400 && !release; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(release, "content review must reach its UPDATE");
  const update = await call(db, draft, TOK_B, { action: "update_suggestions", packetId: p.id, baseVersion: p.version, contentKey: p.contentKey, suggestions: [suggestion(["F-GOOD"], { problem: "已保存的新建议_SYNTHETIC" })], basisDigest: await basis(db) }, { projectId: P });
  assert.equal(update.status, 200, JSON.stringify(update));
  db.prepare = originalPrepare;
  release();
  const oldReview = await pendingReview;
  assert.equal(oldReview.status, 409, "old content review must lose");
  const stored = JSON.parse(db.get("SELECT suggestions_json FROM decision_packets WHERE id=?", p.id).suggestions_json);
  assert.equal(stored.items[0].problem, "已保存的新建议_SYNTHETIC", "new suggestions must survive");
  assert.equal(stored.contentReview, null, "old review must not attach to the new content");
  db.close();
  return { update: update.status, oldReview: oldReview.status, storedProblem: stored.items[0].problem, review: stored.contentReview };
});

// ── S05 旧生成预览不能绑定到变化后的依据 ──────────────────────────────
await scenario("S05_old_preview_rebound_to_new_grade", async () => {
  const db = fixture();
  const prompts = modelStub("基于旧E2事实的建议_SYNTHETIC");
  const generated = await call(db, generate, TOK_B, { scope: "formal" }, { projectId: P }, "OLD-PREVIEW");
  assert.equal(generated.status, 200);
  assert.equal((await grade(db, "E1")).status, 200);
  const staleSave = await call(db, draft, TOK_B, { ...PACKET_FIELDS, suggestions: wire(generated.body.suggestions), draftKind: "formal", basisDigest: generated.body.generation.basisDigest }, { projectId: P }, "S05-STALE");
  assert.equal(staleSave.status, 409, "old preview must be refused");
  assert.equal(staleSave.body.code, "preview_basis_changed");
  const missingDigest = await call(db, draft, TOK_B, { ...PACKET_FIELDS, suggestions: wire(generated.body.suggestions), draftKind: "formal" }, { projectId: P }, "S05-NODIGEST");
  assert.equal(missingDigest.status, 422);
  assert.equal(missingDigest.body.code, "basis_digest_required");
  const replay = await call(db, generate, TOK_B, { scope: "formal" }, { projectId: P }, "OLD-PREVIEW");
  assert.equal(replay.status, 409, "replaying the old generation must not return an old preview");
  assert.equal(replay.body.code, "preview_basis_changed");
  const fresh = await call(db, generate, TOK_B, { scope: "formal" }, { projectId: P }, "NEW-PREVIEW");
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.suggestions[0].evidence[0].evidenceLevel, "E1");
  const saved = await create(db, wire(fresh.body.suggestions), { basisDigest: fresh.body.generation.basisDigest });
  assert.equal(saved.suggestions[0].evidence[0].evidenceLevel, "E1");
  const finalPub = await call(db, publish, TOK_B, {}, { packetId: saved.id });
  restoreFetchToBlocked();
  assert.equal(finalPub.status, 409, "publish before review/verify must fail");
  db.close();
  return { firstPromptE2: prompts[0][1].content.includes("E2"), staleSave: staleSave.status, replay: replay.status, freshLevel: fresh.body.suggestions[0].evidence[0].evidenceLevel, save: 201 };
});

// ── S06 等级往返必须被识别（草稿不能沿用旧快照）──────────────────────
await scenario("S06_grade_changed_back_while_draft", async () => {
  const db = fixture();
  const p = await create(db);
  assert.equal((await grade(db, "E1")).status, 200);
  assert.equal((await grade(db, "E2")).status, 200);
  const verifyR = await call(db, verify, TOK_V, { factRefs: p.factRefs, contentKey: p.contentKey }, { packetId: p.id });
  assert.equal(verifyR.status, 409);
  assert.equal(verifyR.body.code, "suggestion_basis_changed");
  assert.equal((await call(db, publish, TOK_B, {}, { packetId: p.id })).status, 409);
  const row = db.get("SELECT evidence_level,evidence_version FROM candidate_facts WHERE id='F-GOOD'");
  assert.equal(row.evidence_level, "E2");
  assert.ok(Number(row.evidence_version) >= 3, "grade round-trip must advance the fact revision");
  db.close();
  return { verify: verifyR.status, level: row.evidence_level, evidenceVersion: row.evidence_version };
});

// ── S07 量化承诺/否定声明/样本量的允许与拒绝边界 ──────────────────────
await scenario("S07_quantification_boundaries", async () => {
  const cases = [
    ["承诺三天完成上线", false],
    ["两周内完成上线", false],
    ["每年节省十万，效率提升三成", false],
    ["预计节省10万元", false],
    ["三个工作日内完成上线", false],
    ["半年内完成上线", false],
    ["尚未统计，预计节省十万", false],
    ["未来预计节省十万", false],
    ["不排除未来提升三成", false],
    ["承诺三个月完成上线", false],
    ["不承诺实施周期，需先核实业务前提", true],
    ["不预设投资回报率，先核实事实", true],
    ["不承诺三个月完成上线，需重新评估", true],
    ["并没有节省十万", true],
    ["先收集3万条订单作为样本", true],
    ["实施前先收集一周日志", true],
  ];
  const observed = cases.map(([text, allowed]) => {
    let accepted = true; let code = null;
    try { normalizeSuggestions([suggestion(["F-GOOD"], { problem: text })]); } catch (error) { accepted = false; code = error.code || null; }
    assert.equal(accepted, allowed, `${text} expected ${allowed ? "allowed" : "rejected"} but was ${accepted ? "allowed" : "rejected"}`);
    return { text, accepted, code };
  });
  // The rule must hold at every write path, not only in the generation normaliser.
  const db = fixture();
  const blockedSave = await call(db, draft, TOK_B, { ...PACKET_FIELDS, suggestions: [suggestion(["F-GOOD"], { problem: "承诺三天完成上线" })], basisDigest: await basis(db) }, { projectId: P }, "QUANT-SAVE-BLOCK");
  assert.equal(blockedSave.status, 422, JSON.stringify(blockedSave));
  assert.equal(blockedSave.body.code, "fabricated_quantification");
  const allowedSave = await call(db, draft, TOK_B, { ...PACKET_FIELDS, suggestions: [suggestion(["F-GOOD"], { problem: "实施前先收集一周日志" })], basisDigest: await basis(db) }, { projectId: P }, "QUANT-SAVE-ALLOW");
  assert.equal(allowedSave.status, 201, JSON.stringify(allowedSave));
  const p = allowedSave.body.packet;
  const blockedUpdate = await call(db, draft, TOK_B, { action: "update_suggestions", packetId: p.id, baseVersion: p.version, contentKey: p.contentKey, suggestions: [suggestion(["F-GOOD"], { problem: "两周内完成上线" })], basisDigest: await basis(db) }, { projectId: P });
  assert.equal(blockedUpdate.status, 422, JSON.stringify(blockedUpdate));
  assert.equal(blockedUpdate.body.code, "fabricated_quantification");
  db.close();
  return { cases: observed, save: blockedSave.status, update: blockedUpdate.status };
});

// ── S08 stale 恢复必须携带建议，并且可正常审核/核验/发布 ───────────────
await scenario("S08_stale_recovery_must_carry_suggestions", async () => {
  const db = fixture();
  db.exec("DELETE FROM candidate_facts WHERE id IN ('F-SECOND','F-E5','F-OPEN')");
  const p = await published(db);
  assert.equal((await grade(db, "E1")).status, 200);
  assert.equal(db.get("SELECT status FROM decision_packets WHERE id=?", p.id).status, "stale");
  const without = await call(db, draft, TOK_B, { ...PACKET_FIELDS, factRefs: [{ factId: "F-GOOD", materialStatus: "same" }] }, { projectId: P }, "STALE-NO-SUG");
  assert.equal(without.status, 422, JSON.stringify(without));
  assert.equal(without.body.code, "revision_requires_suggestions");
  const q = await create(db);
  assert.equal(q.suggestions.length, 1);
  assert.equal(q.revisionFromVersion, 1);
  await ready(db, q);
  assert.equal((await call(db, publish, TOK_B, {}, { packetId: q.id })).status, 200);
  const owner = await call(db, ownerGet, TOK_O, undefined, { projectId: P });
  assert.equal(owner.body.packet.suggestions.length, 1);
  assert.equal(owner.body.packet.status, "published");
  db.close();
  return { without: without.status, recovery: 201, publish: 200, ownerSuggestions: owner.body.packet.suggestions.length };
});

// ── S09 两个恢复请求：只允许一个后继版本 ──────────────────────────────
await scenario("S09_two_recovery_drafts_interleaved", async () => {
  const db = fixture();
  const p = await published(db);
  assert.equal((await grade(db, "E1")).status, 200);
  const digestA = await basis(db);
  const hold = await gateBatch(db, (statements) => statements[0].sql.startsWith("INSERT INTO decision_packets"), () => call(db, draft, TOK_B, { ...PACKET_FIELDS, suggestions: [suggestion()], basisDigest: digestA }, { projectId: P }, "DRAFT-A"));
  const b = await call(db, draft, TOK_B, { ...PACKET_FIELDS, suggestions: [suggestion()], basisDigest: await basis(db) }, { projectId: P }, "DRAFT-B");
  assert.equal(b.status, 201);
  await ready(db, b.body.packet);
  assert.equal((await call(db, publish, TOK_B, {}, { packetId: b.body.packet.id })).status, 200);
  hold.release();
  const a = await hold.pending;
  assert.equal(a.status, 409, "late recovery must not create a second successor");
  const rows = db.all("SELECT version,status FROM decision_packets ORDER BY version");
  assert.equal(rows.filter((row) => row.version > 1).length, 1, "only one successor may exist");
  assert.equal(rows.find((row) => row.version === 1).status, "stale", "historical stale version is preserved");
  db.close();
  return { winner: b.status, delayed: a.status, packets: rows };
});

// ── S10 内部列表与模型输入使用同一范围 ────────────────────────────────
await scenario("S10_internal_limit_agreement", async () => {
  const db = fixture();
  for (let i = 0; i < 40; i += 1) {
    db.prepare("INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,status,material_status,created_at) VALUES(?,?,'WI-S','workflow','未核验事实','extra','open','unverified','2000-01-01')").bind(`UN-${String(i).padStart(2, "0")}`, P).run();
  }
  const list = await call(db, factsGet, TOK_B, undefined, { projectId: P }, "", "?scope=internal");
  const listIds = (list.body.facts || []).map((fact) => fact.factId);
  let prompts = [];
  globalThis.fetch = async (url, init) => {
    const messages = JSON.parse(init.body).messages;
    prompts.push(messages);
    const ids = messages[1].content.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.split(" | ")[0].slice(2));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions: [suggestion([ids[0]], { pendingConditions: ["待核实"] })] }) } }] }));
  };
  const generated = await call(db, generate, TOK_B, { scope: "internal" }, { projectId: P }, "LIMIT-CHECK");
  assert.equal(generated.status, 200);
  const promptIds = prompts[0][1].content.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.split(" | ")[0].slice(2));
  assert.equal(list.body.facts.length, INTERNAL_FACT_LIMIT, `list must expose ${INTERNAL_FACT_LIMIT}`);
  assert.equal(promptIds.length, INTERNAL_FACT_LIMIT, "model prompt must use the same range");
  assert.deepEqual([...promptIds].sort(), [...listIds].sort(), "list and prompt must describe the same fact set");
  const saved = await call(db, draft, TOK_B, { ...PACKET_FIELDS, draftKind: "internal", suggestions: wire(generated.body.suggestions), basisDigest: generated.body.generation.basisDigest }, { projectId: P }, "LIMIT-SAVE");
  restoreFetchToBlocked();
  assert.equal(saved.status, 201, "save must accept the same 30-fact basis");
  // The formal path must also expose exactly the facts the model receives, even when the
  // project has more than the internal limit.
  const db2 = fixture();
  for (let i = 0; i < 35; i += 1) {
    db2.prepare("INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,required,impact_level,second_confirmation_status,material_status,status,source_refs_json,evidence_level,created_at) VALUES(?,?,'WI-S','workflow','正式范围事实','scope',0,'normal','not_required','same','confirmed','[\"MAT-S\"]','E2','2001-01-01')").bind(`FM-${String(i).padStart(2, "0")}`, P).run();
  }
  const formalList = await call(db2, factsGet, TOK_B, undefined, { projectId: P });
  const formalIds = (formalList.body.facts || []).map((fact) => fact.factId).sort();
  const prompts2 = modelStub("正式范围建议");
  const formalGen = await call(db2, generate, TOK_B, { scope: "formal" }, { projectId: P }, "FORMAL-RANGE");
  restoreFetchToBlocked();
  assert.equal(formalGen.status, 200, JSON.stringify(formalGen));
  const formalPromptIds = prompts2[0][1].content.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.split(" | ")[0].slice(2)).sort();
  assert.equal(formalIds.length, 36, `formal list must expose every eligible fact: ${formalIds.length}`);
  assert.deepEqual(formalPromptIds, formalIds, "formal list and model prompt must agree");
  const formalSaved = await call(db2, draft, TOK_B, { ...PACKET_FIELDS, suggestions: wire(formalGen.body.suggestions), basisDigest: formalGen.body.generation.basisDigest }, { projectId: P }, "FORMAL-RANGE-SAVE");
  assert.equal(formalSaved.status, 201, JSON.stringify(formalSaved));
  db.close(); db2.close();
  return { list: listIds.length, prompt: promptIds.length, missing: listIds.filter((id) => !promptIds.includes(id)).length, save: saved.status, formalList: formalIds.length, formalPrompt: formalPromptIds.length, formalSave: formalSaved.status };
});

// ── S11 迟到的 stale 恢复不能越过最新版本 ─────────────────────────────
await scenario("S11_stale_recovery_chain_guard", async () => {
  const db = fixture();
  const p = await published(db);
  assert.equal((await grade(db, "E1")).status, 200);
  const originalPrepare = db.prepare.bind(db);
  let release = null;
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (sql === "SELECT MAX(version) AS version FROM decision_packets WHERE project_id=?") {
      const oldBind = statement.bind.bind(statement);
      statement.bind = (...values) => {
        const bound = oldBind(...values);
        const oldFirst = bound.first.bind(bound);
        bound.first = () => new Promise((resolve) => { release = () => resolve(oldFirst()); });
        return bound;
      };
    }
    return statement;
  };
  const aPending = call(db, draft, TOK_B, { ...PACKET_FIELDS, suggestions: [suggestion()], basisDigest: await basis(db) }, { projectId: P }, "LATE-A");
  for (let i = 0; i < 400 && !release; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(release, "recovery A must reach MAX(version)");
  db.prepare = originalPrepare;
  const b = await call(db, draft, TOK_B, { ...PACKET_FIELDS, suggestions: [suggestion()], basisDigest: await basis(db) }, { projectId: P }, "LATE-B");
  assert.equal(b.status, 201);
  await ready(db, b.body.packet);
  assert.equal((await call(db, publish, TOK_B, {}, { packetId: b.body.packet.id })).status, 200);
  release();
  const a = await aPending;
  assert.equal(a.status, 409, "delayed recovery must be rejected after a published successor");
  const rows = db.all("SELECT version,status FROM decision_packets ORDER BY version");
  assert.equal(rows.filter((row) => row.status === "published").length, 1);
  db.close();
  return { winner: b.status, delayed: a.status, packets: rows };
});

// ── S12 stale 恢复承接原退回任务与理由 ────────────────────────────────
await scenario("S12_revision_task_carried_through_recovery", async () => {
  const db = fixture();
  const p = await published(db);
  const revision = await call(db, decide, TOK_O, { ...decision, decision: "revision", reason: "请补充库存盘点口径" }, { packetId: p.id }, "REV-TASK");
  assert.equal(revision.status, 200);
  const taskId = revision.body.receipt.revisionTaskId;
  assert.equal((await grade(db, "E1")).status, 200);
  const q = await create(db);
  assert.equal(q.revisionFromVersion, 1);
  assert.equal(q.revisionWorkItemId, taskId, "recovery must adopt the pending revision task");
  assert.equal(q.revisionReason, "请补充库存盘点口径", "recovery must keep the owner's reason");
  assert.equal(db.get("SELECT status FROM work_items WHERE id=?", taskId).status, "awaiting_verification");
  await ready(db, q);
  assert.equal((await call(db, publish, TOK_B, {}, { packetId: q.id })).status, 200);
  const taskStatus = db.get("SELECT status FROM work_items WHERE id=?", taskId).status;
  assert.equal(taskStatus, "complete", "publishing the recovery completes the revision task");
  db.close();
  return { recovery: 201, revisionWorkItemId: q.revisionWorkItemId, reason: q.revisionReason, taskStatus };
});

// ── S13 同一事实多轮失效：事件 ID 不得冲突回滚合法修正 ─────────────────
await scenario("S13_sweep_event_id_collision", async () => {
  const db = fixture();
  const p1 = await create(db);
  let hold = await gateBatch(db, (statements) => statements[0].sql.startsWith("UPDATE candidate_facts SET evidence_level="), () => grade(db, "E1"));
  await ready(db, p1);
  assert.equal((await call(db, publish, TOK_B, {}, { packetId: p1.id })).status, 200);
  hold.release();
  const g1 = await hold.pending;
  assert.equal(g1.status, 200, JSON.stringify(g1));
  const p2 = await create(db);
  hold = await gateBatch(db, (statements) => statements[0].sql.startsWith("UPDATE candidate_facts SET evidence_level="), () => grade(db, "E2"));
  await ready(db, p2);
  assert.equal((await call(db, publish, TOK_B, {}, { packetId: p2.id })).status, 200);
  hold.release();
  const g2 = await hold.pending;
  assert.equal(g2.status, 200, `second grade must not roll back: ${JSON.stringify(g2)}`);
  assert.notEqual(g2.body.code, "UNIQUE constraint failed");
  assert.equal(db.get("SELECT evidence_level FROM candidate_facts WHERE id='F-GOOD'").evidence_level, "E2");
  const events = db.all("SELECT event_id FROM events WHERE type='decision_packet_staled'");
  assert.ok(events.length >= 2, "each invalidated packet must keep its own event");
  assert.equal(new Set(events.map((event) => event.event_id)).size, events.length, "stale events must have unique ids");
  db.close();
  return { firstGrade: g1.status, secondGrade: g2.status, staleEvents: events.length, level: "E2" };
});

// ── S14 改造方材料出口不得返回员工补证正文/原始对话 ────────────────────
await scenario("S14_employee_material_body_exit", async () => {
  const db = fixture();
  db.exec("UPDATE candidate_facts SET status='open',material_status='unverified' WHERE id='F-GOOD'");
  const ask = await call(db, factVerify, TOK_V, { factId: "F-GOOD", decision: "insufficient_evidence", reason: "需要原始核对材料", requestedMaterial: "核对记录", responsibleAccountId: EMP }, { itemId: "WI-S" });
  assert.equal(ask.status, 200, JSON.stringify(ask));
  const supplied = await call(db, supplementPost, TOK_E, { material: "员工补证正文_SYNTHETIC", reference: "synthetic://private-file", sourceType: "text", metadata: { rawConversation: "补证中的员工私有原始对话_SYNTHETIC" } }, { itemId: "WI-S" });
  assert.equal(supplied.status, 200, JSON.stringify(supplied));
  const read = await call(db, materialsGet, TOK_B, undefined, { projectId: P });
  const row = (read.body.materials || []).find((entry) => entry.id === supplied.body.recovery.materialId);
  assert.ok(row, "builder still sees the material record for management");
  assert.equal(row.metadata_json, undefined, "raw metadata must not be projected");
  assert.ok(!JSON.stringify(row).includes("员工补证正文_SYNTHETIC"));
  assert.ok(!JSON.stringify(row).includes("补证中的员工私有原始对话_SYNTHETIC"));
  db.close();
  return { request: ask.status, supply: supplied.status, builderRead: read.status, metadata: row.metadata_json };
});

// ── S15 旧核验页面看到的旧稿不能用于新稿 ──────────────────────────────
await scenario("S15_stale_verifier_screen_rejected", async () => {
  const db = fixture();
  const p = await create(db);
  const seen = await call(db, packetGet, TOK_V, undefined, { projectId: P });
  const seenBuilder = await call(db, packetGet, TOK_B, undefined, { projectId: P });
  // Both write paths require the revision marker; a client that omits it is refused.
  const reviewNoKey = await call(db, draft, TOK_B, { action: "content_review", packetId: p.id, baseVersion: p.version }, { projectId: P });
  assert.equal(reviewNoKey.status, 422, JSON.stringify(reviewNoKey));
  assert.equal(reviewNoKey.body.code, "content_key_required");
  const updateNoKey = await call(db, draft, TOK_B, { action: "update_suggestions", packetId: p.id, baseVersion: p.version, suggestions: [suggestion()], basisDigest: await basis(db) }, { projectId: P });
  assert.equal(updateNoKey.status, 422, JSON.stringify(updateNoKey));
  assert.equal(updateNoKey.body.code, "content_key_required");
  assert.equal((await call(db, draft, TOK_B, { action: "content_review", packetId: p.id, baseVersion: p.version, contentKey: p.contentKey }, { projectId: P })).status, 200);
  const update = await call(db, draft, TOK_B, { action: "update_suggestions", packetId: p.id, baseVersion: p.version, contentKey: p.contentKey, suggestions: [suggestion(["F-GOOD"], { problem: "核验人旧页面没有看到的建议_SYNTHETIC" })], basisDigest: await basis(db) }, { projectId: P });
  assert.equal(update.status, 200);
  // The verifier's old screen cannot confirm the revised content.
  const oldVerify = await call(db, verify, TOK_V, { factRefs: seen.body.packet.factRefs, contentKey: seen.body.packet.contentKey }, { packetId: p.id });
  assert.equal(oldVerify.status, 409);
  assert.equal(oldVerify.body.code, "suggestion_revision_changed");
  // The builder's old screen cannot review or overwrite the revised content either.
  const oldReview = await call(db, draft, TOK_B, { action: "content_review", packetId: p.id, baseVersion: p.version, contentKey: seenBuilder.body.packet.contentKey }, { projectId: P });
  assert.equal(oldReview.status, 409, JSON.stringify(oldReview));
  assert.equal(oldReview.body.code, "suggestion_revision_changed");
  const oldUpdate = await call(db, draft, TOK_B, { action: "update_suggestions", packetId: p.id, baseVersion: p.version, contentKey: seenBuilder.body.packet.contentKey, suggestions: [suggestion(["F-GOOD"], { problem: "旧页面覆盖新版本_SYNTHETIC" })], basisDigest: await basis(db) }, { projectId: P });
  assert.equal(oldUpdate.status, 409, JSON.stringify(oldUpdate));
  assert.equal(oldUpdate.body.code, "suggestion_revision_changed");
  const current = JSON.parse(db.get("SELECT suggestions_json FROM decision_packets WHERE id=?", p.id).suggestions_json);
  assert.equal(current.items[0].problem, "核验人旧页面没有看到的建议_SYNTHETIC", "a stale page must not overwrite the saved content");
  const fresh = await call(db, packetGet, TOK_V, undefined, { projectId: P });
  assert.equal((await call(db, verify, TOK_V, { factRefs: fresh.body.packet.factRefs, contentKey: fresh.body.packet.contentKey }, { packetId: p.id })).status, 200);
  assert.equal((await call(db, draft, TOK_B, { action: "content_review", packetId: p.id, baseVersion: p.version, contentKey: fresh.body.packet.contentKey }, { projectId: P })).status, 200);
  assert.equal((await call(db, publish, TOK_B, {}, { packetId: p.id })).status, 200);
  const envelope = JSON.parse(db.get("SELECT suggestions_json FROM decision_packets WHERE id=?", p.id).suggestions_json);
  assert.equal(envelope.items[0].problem, "核验人旧页面没有看到的建议_SYNTHETIC");
  db.close();
  return { oldVerify: oldVerify.status, oldReview: oldReview.status, oldUpdate: oldUpdate.status, freshVerify: 200, storedProblem: envelope.items[0].problem };
});

// ── S16 已核验但未发布：仍可修改、重新审核、重新核验 ─────────────────
await scenario("S16_correct_after_fact_verification", async () => {
  const db = fixture();
  const p = await create(db);
  assert.equal((await call(db, verify, TOK_V, { factRefs: p.factRefs, contentKey: p.contentKey }, { packetId: p.id })).status, 200);
  const update = await call(db, draft, TOK_B, { action: "update_suggestions", packetId: p.id, baseVersion: p.version, contentKey: p.contentKey, suggestions: [suggestion(["F-GOOD"], { problem: "内容审核中发现错误需改正" })], basisDigest: await basis(db) }, { projectId: P });
  assert.equal(update.status, 200, JSON.stringify(update));
  assert.equal(update.body.packet.contentKey, "1", "a saved revision must publish a new content key");
  const review = await call(db, draft, TOK_B, { action: "content_review", packetId: p.id, baseVersion: p.version, contentKey: update.body.packet.contentKey }, { projectId: P });
  assert.equal(review.status, 200, "review: " + JSON.stringify(review));
  const fresh = await call(db, packetGet, TOK_V, undefined, { projectId: P });
  const reverify = await call(db, verify, TOK_V, { factRefs: fresh.body.packet.factRefs, contentKey: fresh.body.packet.contentKey }, { packetId: p.id });
  assert.equal(reverify.status, 200, "verify: " + JSON.stringify(reverify));
  const republish = await call(db, publish, TOK_B, {}, { packetId: p.id });
  assert.equal(republish.status, 200, "publish: " + JSON.stringify(republish));
  db.close();
  return { verify: 200, update: update.status, review: review.status, republish: 200 };
});

// ── S17 中文周期承诺不能进入交付；合法前置活动仍可通过 ─────────────────
await scenario("S17_chinese_duration_full_publish_flow", async () => {
  const db = fixture();
  modelStub("承诺三天完成上线");
  const blocked = await call(db, generate, TOK_B, { scope: "formal" }, { projectId: P }, "CHINESE-BLOCK");
  restoreFetchToBlocked();
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.code, "fabricated_quantification");
  const db2 = fixture();
  modelStub("实施前先收集一周日志作为输入");
  const allowed = await call(db2, generate, TOK_B, { scope: "formal" }, { projectId: P }, "CHINESE-ALLOW");
  assert.equal(allowed.status, 200);
  const saved = await create(db2, wire(allowed.body.suggestions), { basisDigest: allowed.body.generation.basisDigest });
  await ready(db2, saved);
  assert.equal((await call(db2, publish, TOK_B, {}, { packetId: saved.id })).status, 200);
  const owner = await call(db2, ownerGet, TOK_O, undefined, { projectId: P });
  restoreFetchToBlocked();
  assert.equal(owner.body.packet.suggestions[0].problem, "实施前先收集一周日志作为输入");
  db.close(); db2.close();
  return { promiseGeneration: blocked.status, allowedGeneration: allowed.status, publish: 200, ownerText: owner.body.packet.suggestions[0].problem };
});

// ── S18 改造方事件出口不得返回员工原始提交/流程卡/推断 ────────────────
await scenario("S18_employee_submission_events_exit", async () => {
  const P18 = "PRJ-R2-EVENTS", ITEM = "WI-R2-EVENTS", EMP18 = "ACC-R2-EMP", VER18 = "ACC-R2-VER", TOK18 = "TOK-R2-EVENTS", BLD18 = "ACC-R2-BLD", TOKB = "TOK-R2-BLD";
  const ANSWERS = {
    trigger: "每天早上运营同事在群里发来当天的推广需求，我看到消息后开始处理",
    inputs: "先看昨天的曝光和点击数据，再看库存数量，然后确认投放预算还剩多少",
    steps: "先选品再写脚本，然后让剪辑同事剪出来，最后在后台提交审核并发布",
    judgments: "毛利率低于一成要先找主管确认，其他价格我自己按历史数据定",
    exceptions: "版权不确定就换同款，审核被拒就先改文案再重新提交",
    handoff: "剪完的素材交给投放同事小李，由他挂车和设置出价",
    burden: "一条视频从选题到发布大约需要三个小时，一周做五条左右",
  };
  const LABELS = { trigger: "从哪里开始", inputs: "先看什么", steps: "实际怎么做", judgments: "哪些情况不能自己决定", exceptions: "卡住后怎么办", handoff: "交给谁", burden: "大约多久" };
  const MAT = { provided: "员工已说明有材料，等待登记", none_available: "目前没有可提供的材料", undecided: "尚未选择" };
  const sha = (value) => `sha256:${createHash("sha256").update(String(value), "utf8").digest("hex")}`;
  const cardOf = (answers) => ({ ...Object.fromEntries(ANSWER_DIMENSIONS.map((key) => [key, String(answers[key] || "").trim()])), materialIndex: MAT.provided });
  const textOf = (answers) => ANSWER_DIMENSIONS.map((key) => `${LABELS[key]}：${String(answers[key] || "").trim()}`).join("\n\n");
  const baseline = (answers) => buildInferenceRecords([], [
    ...buildInferences({ statements: answers }, {}),
    { source: "model", text: "访谈基线推断：素材剪完交给投放同事挂车发布", basis: "handoff", assumes: "若实际不是这样需更正" },
  ]).records;
  function seed(answers) {
    const inferences = baseline(answers).map((entry) => ({ ...entry, evidenceVersion: Number.isInteger(entry.evidenceVersion) ? entry.evidenceVersion : 0 }));
    let history = [];
    for (const dimension of ANSWER_DIMENSIONS) if (answers[dimension]) history = appendStatementHistory({ prior: history, dimension, text: answers[dimension], revision: 0 }).history;
    const dimensions = Object.fromEntries(ANSWER_DIMENSIONS.map((dimension) => [dimension, { digest: answers[dimension] ? sha(normalizeAnswers(answers)[dimension]) : null, seq: answers[dimension] ? 1 : 0 }]));
    const evidence = { schemaVersion: 1, seq: 1, answersDigest: sha(canonicalJson(normalizeAnswers(answers))), dimensions, revision: 0, source: "interview", legacyInitialized: false, ruleVersion: 1 };
    for (const entry of inferences) {
      entry.evidenceRefs = ANSWER_DIMENSIONS.filter((dimension) => dimensions[dimension] && dimensions[dimension].digest).map((dimension) => ({ dimension, digest: dimensions[dimension].digest, source: "model_conservative_potential", ruleId: null }));
      entry.evidenceVersion = 0; entry.dependencyRuleVersion = 1; entry.dependencySource = "model_conservative_potential"; entry.dependencyRuleStatus = "model_conservative_potential";
      entry.proposedDependencyDimensions = []; entry.dependencyHintsRejected = []; entry.invalidations = [];
      entry.dependencyProposalKey = JSON.stringify({ basis: entry.basis || null, hints: [] });
    }
    return { inferences, history, evidence };
  }
  const answers = { ...ANSWERS, trigger: "员工原始访谈_SYNTHETIC " + ANSWERS.trigger };
  const seeded = seed(answers);
  const verdicts = Object.fromEntries(seeded.inferences.map((entry) => [entry.id, { verdict: "agree", correction: "", contentVersion: entry.contentVersion, templateVersion: entry.templateVersion === undefined ? null : entry.templateVersion, evidenceHash: entry.evidenceHash || null, evidenceVersion: entry.evidenceVersion }]));
  const ledger = { statements: {}, covered: [], vagueTerms: [], unresolved: [], authoritativeInferences: seeded.inferences, statementHistory: seeded.history, burdenAsked: true, evidence: seeded.evidence };
  const draftJson = serializeEmployeeDraft({ answers, ledger, inferenceVerdicts: verdicts, submissionText: "", revision: 0 });
  const db = new D1Harness();
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('${EMP18}','emp@events.invalid','员工甲','active','member'),('${VER18}','ver@events.invalid','核验人乙','active','member'),
      ('${BLD18}','bld@events.invalid','改造方','active','external_builder');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage)
      VALUES ('${P18}','R2-EVENTS','选品到发布','mapping','active','unknown','external_builder','${EMP18}','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES
      ('${P18}','${EMP18}','employee','project','active'),('${P18}','${VER18}','verifier','project','active'),
      ('${P18}','${BLD18}','external_builder','project','active');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at)
      VALUES ('AUTH-R2E','${P18}','授权','王总','o@events.invalid','只读','DOC','authorized','${EMP18}','k','n','h','2099-01-01T00:00:00Z');
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,accepted_account_id,idempotency_key)
      VALUES ('INV-R2E','inv-r2e','${P18}','${EMP18}','ver@events.invalid','verifier','project','accepted','2099-01-01T00:00:00Z','${VER18}','IK-R2E');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id,employee_draft_json,material_status,flow_card_version,evidence_version)
      VALUES ('${ITEM}','${P18}','还原工作','d','mapping','needs_input','employee','员工甲',0,'b','n','${EMP18}','${VER18}','${draftJson.replace(/'/g, "''")}','provided',1,1);
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('${TOK18}','${EMP18}','${P18}','2099-01-01T00:00:00Z','R-EMP'),('${TOKB}','${BLD18}','${P18}','2099-01-01T00:00:00Z','R-BLD');
  `);
  const item = db.get("SELECT * FROM work_items WHERE id=?", ITEM);
  const currentRevision = normalizeEmployeeDraft(JSON.parse(item.employee_draft_json || "{}")).revision;
  const submit = await submitEmployee({ request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/employee-submission`, TOK18, { text: textOf(answers), workflowCard: cardOf(answers), materialStatus: "provided", inferences: [], inferenceVerdicts: {}, baseRevision: currentRevision }, { "Idempotency-Key": "PRIVATE-EVENT" }), env: { DB: db }, params: { itemId: ITEM } });
  const submitted = await submit.json();
  assert.equal(submit.status, 200, JSON.stringify(submitted));
  const events = await eventsGet({ request: bearerRequest("http://127.0.0.1/x", TOKB), env: { DB: db }, params: { projectId: P18 } });
  const eventBody = await events.json();
  const event = (eventBody.events || []).find((entry) => entry.type === "employee_submitted");
  assert.ok(event, "builder still sees the business event type");
  assert.equal(event.payload, undefined, "builder must not receive the payload");
  assert.ok(!JSON.stringify(eventBody).includes("员工原始访谈_SYNTHETIC"));
  const detail = await projectDetail({ request: bearerRequest("http://127.0.0.1/x", TOKB), env: { DB: db }, params: { projectId: P18 } });
  const project = await detail.json();
  assert.equal(detail.status, 200);
  assert.equal(project.latestEvent?.payload, undefined);
  assert.ok(!JSON.stringify(project.latestEvent || {}).includes("员工原始访谈_SYNTHETIC"));
  // Sweep every builder-facing control-plane exit in the same run: none may return the
  // raw interview, workflow card, inference snapshots or an employee task payload.
  const workItems = await call(db, projectWorkItems, TOKB, undefined, { projectId: P18 });
  const materials = await call(db, materialsGet, TOKB, undefined, { projectId: P18 });
  assert.equal(workItems.status, 200);
  assert.equal((workItems.body.items || []).length, 0, "builder must not receive employee work-item payloads");
  const builderExits = JSON.stringify([eventBody, project, workItems.body, materials.body]);
  for (const marker of ["员工原始访谈_SYNTHETIC", "流程卡", "访谈基线推断", "先看昨天的曝光和点击数据"]) {
    assert.ok(!builderExits.includes(marker), `builder exit leaked: ${marker}`);
  }
  db.close();
  return { submission: submit.status, eventRead: events.status, payload: event.payload === undefined, detailPayload: project.latestEvent?.payload === undefined, builderTasks: workItems.body.items?.length };
});

// ── S19 另一个改造方不能把退回任务静默遗留在旧版本 ────────────────────
await scenario("S19_recovery_does_not_orphan_revision_task", async () => {
  const db = fixture();
  db.exec(`INSERT INTO accounts(id,email,name,status) VALUES('BLD-S2','b2@v02.invalid','第二改造方','active');
    INSERT INTO project_memberships(project_id,account_id,role,status) VALUES('${P}','BLD-S2','external_builder','active');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES('TOK-B2','BLD-S2','${P}','2099-01-01T00:00:00Z','R-B2');`);
  const p = await published(db);
  const revision = await call(db, decide, TOK_O, { ...decision, decision: "revision", reason: "请补充库存盘点口径" }, { packetId: p.id }, "REV-S19");
  assert.equal(revision.status, 200);
  const taskId = revision.body.receipt.revisionTaskId;
  assert.equal((await grade(db, "E1")).status, 200);
  const other = await call(db, draft, "TOK-B2", { ...PACKET_FIELDS, suggestions: [suggestion()], basisDigest: await basis(db) }, { projectId: P }, "S19-OTHER");
  assert.equal(other.status, 409, JSON.stringify(other));
  assert.equal(other.body.code, "revision_task_not_ready");
  assert.equal(db.get("SELECT status FROM work_items WHERE id=?", taskId).status, "revision_requested", "the task must not be silently abandoned");
  const own = await create(db);
  assert.equal(own.revisionWorkItemId, taskId, "the owning builder carries the pending task");
  await ready(db, own);
  assert.equal((await call(db, publish, TOK_B, {}, { packetId: own.id })).status, 200);
  assert.equal(db.get("SELECT status FROM work_items WHERE id=?", taskId).status, "complete");
  db.close();
  return { other: other.status, recovery: 201, taskStatus: "complete" };
});

// ── 前端/事件出口的补充静态断言（不替代浏览器）────────────────────────
await scenario("frontend_wiring_round2", async () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const client = readFileSync(new URL("../api-client.js", import.meta.url), "utf8");
  for (const marker of ["basisDigest: preview.basisDigest", "response.generation?.basisDigest", "fact.restricted", "state.verifierPacket.contentKey", "data-content-key=", "保存修改并退回草稿"]) {
    assert.ok(app.includes(marker), `app.js missing ${marker}`);
  }
  assert.ok(client.includes("verifyFormalDecisionPacket(packetId, factRefs, contentKey)"), "api-client must send contentKey to verify");
  assert.ok(client.includes("reviewFormalSuggestionContent(projectId, packetId, baseVersion, contentKey)"), "api-client must send contentKey to content review");
  return { markers: 6 };
});

const pass = results.filter((entry) => entry.passed).length;
const fail = results.length - pass;
console.log(`\nROUND2 PASS=${pass} FAIL=${fail}`);
if (fail) for (const entry of results.filter((item) => !item.passed)) console.log(`  FAILED [${entry.id}] ${entry.note}`);
process.exit(fail ? 1 : 0);
