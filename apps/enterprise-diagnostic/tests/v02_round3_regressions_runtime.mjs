/**
 * V0.2 第三轮审查缺陷修复回归与并发反向对照。
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

import { onRequestPost as reassign } from '../functions/api/work-items/[itemId]/reassignment.js';

async function revise(db, p, text = '修改后的建议') {
  const r = await call(db, draft, TOK_B, { action: 'update_suggestions', packetId: p.id, baseVersion: p.version, contentKey: p.contentKey, basisDigest: await basis(db), suggestions: [suggestion(['F-GOOD'], { problem: text })] }, { projectId: P });
  assert.equal(r.status, 200, JSON.stringify(r));
  return r.body.packet;
}
function assignmentFixture() {
  const db = fixture();
  db.exec(`UPDATE evidence_materials SET visibility='verifier' WHERE id='MAT-S'; UPDATE work_items SET assignee_role='verifier',assignee_account_id='${VER}' WHERE id='WI-S'`);
  return db;
}
async function move(db, id, version, key = crypto.randomUUID()) {
  const r = await call(db, reassign, TOK_B, { targetVerifierId: id, assignmentVersion: version, reason: '合成核验交接' }, { itemId: 'WI-S' }, key);
  assert.equal(r.status, 200, JSON.stringify(r));
}
function snapshot(db) {
  return JSON.stringify(Object.fromEntries(['candidate_facts','work_items','decision_packets','events','fact_judgments','idempotency_records'].map(t => [t, db.all(`SELECT * FROM ${t} ORDER BY rowid`)])));
}

await scenario('T01_non_draft_rejection_has_no_private_packet', async () => {
  const db = assignmentFixture(), p = await create(db); await ready(db, p);
  for (const status of ['verifier_checked','published','revision_requested','stale']) {
    db.prepare('UPDATE decision_packets SET status=? WHERE id=?').bind(status, p.id).run();
    const r = await call(db, verify, TOK_V2, {}, { packetId: p.id });
    assert.equal(r.status, 409);
    assert.equal(r.body.packet, undefined);
    assert.ok(!JSON.stringify(r.body).includes('每天重复确认库存'));
  }
  db.close(); return { rejectedStatuses: 4 };
});

await scenario('T02_reassigned_verifier_cannot_replay_private_receipt', async () => {
  const db = assignmentFixture(), p = await create(db); await ready(db, p);
  const positive = await call(db, verify, TOK_V, {}, { packetId: p.id });
  assert.equal(positive.status, 200);
  await move(db, VER2, 1);
  const replay = await call(db, verify, TOK_V, {}, { packetId: p.id });
  assert.equal(replay.status, 403);
  assert.ok(!JSON.stringify(replay.body).includes('每天重复确认库存'));
  assert.equal(replay.body.packet, undefined);
  const pub = await call(db, publish, TOK_B, {}, { packetId: p.id });
  assert.equal(pub.status, 403, 'old assignment must not authorize a fresh publication');
  db.close(); return { assignedReplay: 200, oldReplay: replay.status, publish: pub.status };
});

await scenario('T03_old_publication_cannot_skip_new_content_review', async () => {
  const db = fixture(), p = await create(db); await ready(db, p);
  const hold = await gateBatch(db, ss => ss[0].sql.startsWith("UPDATE decision_packets SET status='published'"), () => call(db, publish, TOK_B, {}, { packetId: p.id }));
  const q = await revise(db, p, '新稿必须重新审核');
  assert.equal((await call(db, verify, TOK_V, { factRefs: q.factRefs, contentKey: q.contentKey }, { packetId: q.id })).status, 200);
  assert.equal((await call(db, publish, TOK_B, {}, { packetId: q.id })).status, 409);
  hold.release(); const old = await hold.pending;
  assert.equal(old.status, 409);
  assert.equal(db.get('SELECT status FROM decision_packets WHERE id=?', p.id).status, 'verifier_checked');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE type='risk_summary_published'").n, 0);
  assert.equal((await call(db, ownerGet, TOK_O, undefined, { projectId: P })).status, 404);
  assert.equal((await call(db, draft, TOK_B, { action: 'content_review', packetId: q.id, contentKey: q.contentKey, baseVersion: q.version }, { projectId: P })).status, 200);
  const pub = await call(db, publish, TOK_B, {}, { packetId: q.id });
  assert.equal(pub.status, 200); assert.equal(pub.body.packet.contentKey, q.contentKey);
  const own = await call(db, ownerGet, TOK_O, undefined, { projectId: P });
  assert.equal(own.body.packet.suggestions[0].problem, '新稿必须重新审核');
  assert.ok(own.body.packet.suggestionReview);
  db.close(); return { oldPublish: old.status, newReviewedPublish: pub.status };
});

await scenario('T04_quantification_word_order_and_negation_scope', async () => {
  const forbidden = ['上线仅需三天','上线需三天','部署只要72小时','三日后完成上线','不承诺收益，预计节省十万','预计上线需要两周','三天后完成上线','一周即可上线','部署只要三个工作日','不承诺收益但保证节省十万','不承诺三天上线但保证五天完成交付','不承诺收益且保证节省十万','不承诺周期并预计上线只需三天','保证节省十万元','预计提高效率三成'];
  const allowed = ['不承诺上线仅需三天','不承诺三天后完成上线，需先核对条件','不承诺收益且不保证节省十万','先收集3万条订单作为样本','实施前先收集一周日志','不承诺实施周期，需先核实业务前提','不预设投资回报率，先核实事实'];
  for (const text of forbidden) assert.throws(() => normalizeSuggestions([suggestion(['F-GOOD'], { problem: text })]), text);
  for (const text of allowed) assert.doesNotThrow(() => normalizeSuggestions([suggestion(['F-GOOD'], { problem: text })]), text);
  return { refused: forbidden.length, allowed: allowed.length };
});

await scenario('T05_promise_refused_on_all_writes_legal_chain_still_delivers', async () => {
  const db = fixture(); modelStub('上线仅需三天');
  const gen = await call(db, generate, TOK_B, { scope: 'formal' }, { projectId: P }, 'T05-BLOCK'); restoreFetchToBlocked();
  assert.equal(gen.status, 422);
  const bad = await call(db, draft, TOK_B, { ...PACKET_FIELDS, basisDigest: await basis(db), suggestions: [suggestion(['F-GOOD'], { problem: '上线仅需三天' })] }, { projectId: P }, 'T05-SAVE');
  assert.equal(bad.status, 422); assert.equal(db.count('decision_packets'), 0);
  modelStub('实施前先收集一周日志');
  const good = await call(db, generate, TOK_B, { scope: 'formal' }, { projectId: P }, 'T05-LEGAL'); restoreFetchToBlocked();
  assert.equal(good.status, 200);
  const p = await create(db, wire(good.body.suggestions), { basisDigest: good.body.generation.basisDigest });
  const edit = await call(db, draft, TOK_B, { action: 'update_suggestions', packetId: p.id, contentKey: p.contentKey, basisDigest: await basis(db), suggestions: [suggestion(['F-GOOD'], { problem: '三天后完成上线' })] }, { projectId: P });
  assert.equal(edit.status, 422);
  await ready(db, p); assert.equal((await call(db, publish, TOK_B, {}, { packetId: p.id })).status, 200);
  const own = await call(db, ownerGet, TOK_O, undefined, { projectId: P });
  assert.equal(own.body.packet.suggestions[0].problem, '实施前先收集一周日志');
  assert.equal((await call(db, decide, TOK_O, decision, { packetId: p.id }, 'T05-DECIDE')).status, 200);
  db.close(); return { generation: gen.status, save: bad.status, update: edit.status, legalDecision: 200 };
});

await scenario('T06_repeated_stale_recoveries_keep_original_revision_task', async () => {
  const db = fixture(), p = await published(db);
  const returned = await call(db, decide, TOK_O, { ...decision, decision: 'revision', reason: '补齐库存口径' }, { packetId: p.id }, 'T06-RETURN');
  assert.equal(returned.status, 200); const taskId = returned.body.receipt.revisionTaskId;
  let latest;
  for (const level of ['E1','E2','E3']) {
    assert.equal((await grade(db, level)).status, 200);
    latest = await create(db);
    assert.equal(latest.revisionWorkItemId, taskId); assert.equal(latest.revisionReason, '补齐库存口径');
    await ready(db, latest);
  }
  assert.equal((await call(db, publish, TOK_B, {}, { packetId: latest.id })).status, 200);
  assert.equal(db.get('SELECT status FROM work_items WHERE id=?', taskId).status, 'complete');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM decision_packets WHERE status='published'").n, 1);
  db.close(); return { recoveryVersions: 3, originalTaskCompleted: true };
});

await scenario('T07_stale_event_failure_rolls_back_every_business_row', async () => {
  const db = fixture(); await published(db); const before = snapshot(db); db.failOnEvent = true;
  const g = await grade(db, 'E1'); db.failOnEvent = false;
  assert.equal(g.status, 500); assert.equal(snapshot(db), before);
  db.close(); return { failed: g.status, zeroWrites: true };
});

await scenario('T08_losing_grade_cas_has_no_stale_side_effects', async () => {
  const db = fixture(); await published(db);
  const hold = await gateBatch(db, ss => ss[0].sql.startsWith('UPDATE candidate_facts SET evidence_level='), () => grade(db, 'E1'));
  assert.equal((await grade(db, 'E1')).status, 200);
  const p = await create(db); await ready(db, p); assert.equal((await call(db, publish, TOK_B, {}, { packetId: p.id })).status, 200);
  const before = snapshot(db); hold.release(); const loser = await hold.pending;
  assert.equal(loser.status, 409); assert.equal(snapshot(db), before);
  assert.equal(db.get('SELECT status FROM decision_packets WHERE id=?', p.id).status, 'published');
  const events = db.all("SELECT payload FROM events WHERE type='decision_packet_staled'");
  assert.equal(events.length, 1);
  db.close(); return { loser: loser.status, staleEvents: events.length, zeroWrites: true };
});

await scenario('T09_invalidation_uses_exact_refs_not_prefixes_or_text_mentions', async () => {
  const db = fixture();
  db.exec(`INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,required,material_status,status,source_refs_json,evidence_level) VALUES('F-GOOD-NEW','${P}','WI-S','workflow','独立核验事实','extra',0,'same','confirmed','["MAT-S"]','E2')`);
  const p = await create(db, [suggestion(['F-GOOD-NEW'], { problem: '仅在说明文字提及 F-GOOD' })]); await ready(db, p);
  assert.equal((await call(db, publish, TOK_B, {}, { packetId: p.id })).status, 200);
  assert.equal((await grade(db, 'E1')).status, 200);
  assert.equal(db.get('SELECT status FROM decision_packets WHERE id=?', p.id).status, 'published');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE type='decision_packet_staled'").n, 0);
  db.close(); return { independentPacketStillPublished: true };
});

await scenario('T10_assignment_changed_during_verify_rejects_old_actor', async () => {
  const db = assignmentFixture(), p = await create(db);
  const hold = await gateBatch(db, ss => ss[0].sql.startsWith("UPDATE decision_packets SET status='verifier_checked'"), () => call(db, verify, TOK_V, { factRefs: p.factRefs, contentKey: p.contentKey }, { packetId: p.id }));
  await move(db, VER2, 1); const before = snapshot(db); hold.release(); const old = await hold.pending;
  assert.equal(old.status, 409); assert.equal(snapshot(db), before);
  assert.equal(db.get('SELECT status FROM decision_packets WHERE id=?', p.id).status, 'draft');
  const newVerifier = await call(db, verify, TOK_V2, { factRefs: p.factRefs, contentKey: p.contentKey }, { packetId: p.id });
  assert.equal(newVerifier.status, 200);
  db.close(); return { old: old.status, new: newVerifier.status };
});

await scenario('T11_assignment_round_trip_still_invalidates_old_verify', async () => {
  const db = assignmentFixture(), p = await create(db);
  const hold = await gateBatch(db, ss => ss[0].sql.startsWith("UPDATE decision_packets SET status='verifier_checked'"), () => call(db, verify, TOK_V, { factRefs: p.factRefs, contentKey: p.contentKey }, { packetId: p.id }));
  await move(db, VER2, 1); await move(db, VER, 2); const before = snapshot(db); hold.release(); const old = await hold.pending;
  assert.equal(old.status, 409); assert.equal(snapshot(db), before);
  assert.equal((await call(db, verify, TOK_V, { factRefs: p.factRefs, contentKey: p.contentKey }, { packetId: p.id })).status, 200);
  db.close(); return { assignmentVersion: 3, old: old.status, fresh: 200 };
});

await scenario('T12_assignment_changed_during_publication_has_zero_writes', async () => {
  const db = assignmentFixture(), p = await create(db); await ready(db, p);
  const hold = await gateBatch(db, ss => ss[0].sql.startsWith("UPDATE decision_packets SET status='published'"), () => call(db, publish, TOK_B, {}, { packetId: p.id }));
  await move(db, VER2, 1); const before = snapshot(db); hold.release(); const old = await hold.pending;
  assert.equal(old.status, 409); assert.equal(snapshot(db), before);
  db.close(); return { publish: old.status, zeroWrites: true };
});

await scenario('T13_fact_changes_during_verify_reject_old_basis', async () => {
  const db = fixture(), p = await create(db);
  const hold = await gateBatch(db, ss => ss[0].sql.startsWith("UPDATE decision_packets SET status='verifier_checked'"), () => call(db, verify, TOK_V, { factRefs: p.factRefs, contentKey: p.contentKey }, { packetId: p.id }));
  assert.equal((await grade(db, 'E1')).status, 200); const before = snapshot(db); hold.release(); const old = await hold.pending;
  assert.equal(old.status, 409); assert.equal(snapshot(db), before);
  db.close(); return { verify: old.status, zeroWrites: true };
});

await scenario('T14_private_facts_cannot_leak_through_suggestion_business_fields', async () => {
  const db = assignmentFixture(); await create(db, [suggestion(['F-GOOD'], { problem: '每天重复确认库存', opportunity: '每天重复确认库存', priorityReason: '每天重复确认库存', pendingConditions: ['每天重复确认库存'] })]);
  const r = await call(db, packetGet, TOK_V2, undefined, { projectId: P });
  assert.equal(r.status, 200); assert.ok(!JSON.stringify(r.body).includes('每天重复确认库存')); assert.equal(r.body.packet.suggestions[0].restricted, true);
  const own = await call(db, packetGet, TOK_V, undefined, { projectId: P }); assert.ok(JSON.stringify(own.body).includes('每天重复确认库存'));
  db.close(); return { restrictedProjection: true, assignedProjectionPreserved: true };
});

await scenario('T15_legacy_suggestions_need_complete_basis_but_no_suggestion_packets_work', async () => {
  const db = fixture(), p = await create(db);
  const e = JSON.parse(db.get('SELECT suggestions_json FROM decision_packets WHERE id=?', p.id).suggestions_json); delete e.items[0].evidence[0].evidenceVersion;
  db.prepare('UPDATE decision_packets SET suggestions_json=? WHERE id=?').bind(JSON.stringify(e), p.id).run();
  const r = await call(db, verify, TOK_V, { factRefs: p.factRefs, contentKey: p.contentKey }, { packetId: p.id });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'suggestion_basis_changed');
  db.close(); return { unsafeHistoricalBasis: r.status, legacyWithoutSuggestions: 'covered by decision_packet_runtime and suggestions S5-legacy' };
});

await scenario('T16_edit_event_failure_preserves_content_and_old_receipt', async () => {
  const db = fixture(), p = await create(db); await ready(db, p); const before = snapshot(db); db.failOnEvent = true;
  const r = await call(db, draft, TOK_B, { action: 'update_suggestions', packetId: p.id, contentKey: p.contentKey, basisDigest: await basis(db), suggestions: [suggestion(['F-GOOD'], { problem: '需重新核验' })] }, { projectId: P });
  db.failOnEvent = false; assert.equal(r.status, 500); assert.equal(snapshot(db), before);
  db.close(); return { edit: r.status, zeroWrites: true };
});

await scenario('T17_latest_decided_packet_never_resurrects_returned_v1', async () => {
  const db = fixture(), v1 = await published(db);
  assert.equal((await call(db, decide, TOK_O, { ...decision, decision: 'revision', reason: '明确人工放行边界' }, { packetId: v1.id }, 'T17-RETURN')).status, 200);
  const v2 = await create(db); await ready(db, v2);
  assert.equal((await call(db, publish, TOK_B, {}, { packetId: v2.id })).status, 200);
  assert.equal((await call(db, decide, TOK_O, decision, { packetId: v2.id }, 'T17-CONTINUE')).status, 200);
  const before = snapshot(db);
  for (const token of [TOK_V, TOK_B]) {
    const r = await call(db, packetGet, token, undefined, { projectId: P });
    assert.equal(r.status, 404, 'a finished latest version must not fall back to returned v1');
    assert.equal(r.body.packet, undefined);
  }
  const historical = await call(db, verify, TOK_V, { factRefs: v1.factRefs, contentKey: v1.contentKey }, { packetId: v1.id });
  assert.equal(historical.status, 200, 'historical idempotent verification receipt is preserved');
  assert.equal(historical.body.packet.status, 'revision_requested');
  const owner = await call(db, ownerGet, TOK_O, undefined, { projectId: P });
  assert.equal(owner.body.packet.id, v2.id);
  assert.equal(db.count('owner_decisions'), 2);
  assert.equal(snapshot(db), before, 'queue reads and receipt replay must have no side effects');
  db.close(); return { currentQueue: 404, historicalReplay: 200, ownerVersion: 2, zeroWrites: true };
});

await scenario('T18_pending_packet_states_are_role_specific_and_never_fall_back', async () => {
  const db = fixture(), v1 = await published(db);
  assert.equal((await call(db, decide, TOK_O, { ...decision, decision: 'revision' }, { packetId: v1.id }, 'T18-RETURN')).status, 200);
  const v2 = await create(db);
  const matrix = { draft: [200, 200], verifier_checked: [404, 200], revision_requested: [404, 200], stale: [404, 200], published: [404, 404], owner_decided: [404, 404] };
  for (const [status, expected] of Object.entries(matrix)) {
    db.prepare('UPDATE decision_packets SET status=? WHERE id=?').bind(status, v2.id).run();
    const before = snapshot(db);
    for (const [index, token] of [TOK_V, TOK_B].entries()) {
      const r = await call(db, packetGet, token, undefined, { projectId: P });
      assert.equal(r.status, expected[index], `${status} / ${token}`);
      if (r.status === 200) assert.equal(r.body.packet.id, v2.id, 'only the newest formal version is actionable');
      else assert.equal(r.body.packet, undefined);
    }
    assert.equal(snapshot(db), before);
  }
  db.close(); return { statuses: Object.keys(matrix), roleChecks: 12, zeroWrites: true };
});

await scenario('T19_internal_drafts_permissions_and_active_formal_version_stay_separate', async () => {
  const db = fixture(), formal = await create(db);
  const internal = await create(db, [suggestion(['F-OPEN'], { pendingConditions: ['员工说明仍待核对'] })], { draftKind: 'internal' });
  assert.ok(internal.version > formal.version);
  const before = snapshot(db);
  const active = await call(db, packetGet, TOK_V, undefined, { projectId: P });
  assert.equal(active.status, 200); assert.equal(active.body.packet.id, formal.id);
  const builderInternal = await call(db, packetGet, TOK_B, undefined, { projectId: P }, '', '?scope=internal');
  assert.equal(builderInternal.status, 200); assert.equal(builderInternal.body.packet.id, internal.id);
  for (const [token, query] of [[TOK_V, '?scope=internal'], [TOK_E, ''], [TOK_O, '']]) {
    const r = await call(db, packetGet, token, undefined, { projectId: P }, '', query);
    assert.equal(r.status, 403); assert.equal(r.body.packet, undefined);
  }
  const crossProject = await call(db, packetGet, TOK_V, undefined, { projectId: OTHER });
  assert.equal(crossProject.status, 403); assert.equal(crossProject.body.packet, undefined);
  assert.equal(snapshot(db), before);
  db.close(); return { newestInternalDoesNotHideFormal: true, forbiddenReads: 4, zeroWrites: true };
});

const passed = results.filter(r => r.passed).length;
console.log(`ROUND3 PASS=${passed} FAIL=${results.length - passed}`);
if (passed !== results.length) process.exitCode = 1;
