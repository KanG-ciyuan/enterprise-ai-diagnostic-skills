import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { onRequestPost as verifyFact } from "../functions/api/work-items/[itemId]/verification.js";
import { onRequestPost as submitEvidence } from "../functions/api/work-items/[itemId]/evidence-supplement.js";
import { onRequestPost as draftPacket } from "../functions/api/formal/projects/[projectId]/decision-packets/draft.js";
import { onRequestPost as ownerDecision } from "../functions/api/formal/decision-packets/[packetId]/owner-decision.js";
import { onRequestGet as ownerPacket } from "../functions/api/formal/projects/[projectId]/owner-packet.js";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";

/**
 * V0.1 第一批 runtime 验收
 *
 * 事实级 E1–E5 落库与审计、高影响判定与漏判升级、已发布结论失效保护。
 * 直接调用真实生产 handler，使用真实 schema.sql。
 */

const PROJ = "PRJ-V01";
const ITEM = "WI-V01";

function seed(db) {
  db.exec(`
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id)
      VALUES ('${PROJ}','V01','Scope','facts','active','unknown','external_builder','BLD');
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('BLD','b@v01.invalid','Builder','active','external_builder'),
      ('VER','v@v01.invalid','Verifier','active','member'),
      ('VER2','v2@v01.invalid','Verifier2','active','member'),
      ('EMP','e@v01.invalid','Employee','active','member'),
      ('OWN','o@v01.invalid','Owner','active','member');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at)
      VALUES ('AUTH-V01','${PROJ}','Auth','Owner','o@v01.invalid','read','oa://a','authorized','BLD','K1','n','h','2099-01-01T00:00:00Z');
    INSERT INTO project_memberships(project_id,account_id,role,status) VALUES
      ('${PROJ}','BLD','external_builder','active'),
      ('${PROJ}','VER','verifier','active'),
      ('${PROJ}','VER2','verifier','active'),
      ('${PROJ}','EMP','employee','active'),
      ('${PROJ}','OWN','owner','active');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('TOK-V','VER','${PROJ}','2099-01-01T00:00:00Z','R1'),
      ('TOK-V2','VER2','${PROJ}','2099-01-01T00:00:00Z','R2'),
      ('TOK-B','BLD','${PROJ}','2099-01-01T00:00:00Z','R3'),
      ('TOK-O','OWN','${PROJ}','2099-01-01T00:00:00Z','R4'),
      ('TOK-E','EMP','${PROJ}','2099-01-01T00:00:00Z','R5');
    INSERT INTO evidence_materials(id,project_id,material_key,version,source_type,authorization_record_id,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference)
      VALUES ('MAT-1','${PROJ}','MAT-1',1,'csv','AUTH-V01','authorized','verified','project','BLD',NULL,'Export','ref');
    -- 员工主动注销后，员工的活跃核验任务会退回改派状态。
    -- 分配语义不是本批主题，这里直接以“已具名核验人”的核验任务为起点。
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id)
      VALUES ('${ITEM}','${PROJ}','Task','D','facts','awaiting_verification','verifier','V',0,'','verify','EMP','VER');
  `);
}

function addFact(db, f) {
  db.exec(`INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,required,impact_level,second_confirmation_status,material_status,status,source_refs_json,first_verified_by_account_id,evidence_version)
    VALUES ('${f.id}','${PROJ}','${ITEM}','workflow','${f.claim}','field',1,'${f.impact}','${f.second}','${f.material || "same"}','${f.status}','${f.refs || '["MAT-1"]'}',${f.first ? `'${f.first}'` : "NULL"},1);`);
}

const verify = (db, token, body) =>
  verifyFact({ request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/verification`, token, body), env: { DB: db }, params: { itemId: ITEM } });
const supplement = (db, token, body) =>
  submitEvidence({ request: bearerRequest(`http://127.0.0.1/api/work-items/${ITEM}/evidence-supplement`, token, body), env: { DB: db }, params: { itemId: ITEM } });
let draftSeq = 0;
const draft = (db, body) =>
  draftPacket({
    // 决策包草稿要求 Idempotency-Key（既有语义）
    request: bearerRequest(`http://127.0.0.1/api/formal/projects/${PROJ}/decision-packets/draft`, "TOK-B", body, { "Idempotency-Key": `v01-draft-${++draftSeq}` }),
    env: { DB: db }, params: { projectId: PROJ },
  });
const decide = (db, packetId, body) =>
  ownerDecision({ request: bearerRequest(`http://127.0.0.1/api/formal/decision-packets/${packetId}/owner-decision`, "TOK-O", body), env: { DB: db }, params: { packetId } });

const PACKET_BODY = (factId) => ({
  factRefs: [{ factId }], riskSummary: "r", pilotScope: "p",
  constraints: ["c"], successMetrics: ["m"], stopConditions: ["s"], downstreamOwner: "OWN",
});

// draft.js 的事实组查询要求工作项 judgment_status='confirmed'（既有语义）。
// 本批不改动该语义，只在测试里把工作项置于"事实组核验完毕"的状态。
const markFactsDone = (db) => db.exec(`UPDATE work_items SET stage='decision',status='awaiting_decision',judgment_status='confirmed' WHERE id='${ITEM}'`);

function insertPublishedPacket(db, id, factId) {
  db.exec(`INSERT INTO decision_packets(id,project_id,version,status,drafted_by_account_id,fact_refs_json,risk_summary,pilot_scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner,published_at)
    VALUES ('${id}','${PROJ}',1,'published','BLD','[{"factId":"${factId}"}]','r','p','["c"]','["m"]','["s"]','OWN','2026-01-01T00:00:00Z');`);
}

// ── 1. 历史未定级事实保持 NULL，不自动回填 ──────────────────────────────
{
  const db = new D1Harness();
  seed(db);
  db.exec(`INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,required,impact_level,second_confirmation_status,material_status,status,source_refs_json)
    VALUES ('FACT-HIST','${PROJ}','${ITEM}','workflow','历史事实','field',1,'normal','not_required','unverified','open','[]');`);
  const row = db.get("SELECT evidence_level,evidence_labeled FROM candidate_facts WHERE id='FACT-HIST'");
  assert.equal(row.evidence_level, null, "历史行必须保持 NULL，不得回填");
  assert.equal(Number(row.evidence_labeled), 0, "历史行不得被回溯标记为 AI 假设");
  db.close();
  console.log("  ✔ 1. 历史未定级事实保持 NULL，未自动回填");
}

// ── 2. 证据等级落库 + 审计；与确认状态独立 ──────────────────────────────
{
  const db = new D1Harness();
  seed(db);
  addFact(db, { id: "FACT-L", claim: "普通事实", impact: "normal", second: "not_required", status: "open" });
  const res = await verify(db, "TOK-V", { factId: "FACT-L", decision: "same", reason: "核对一致", sourceRefs: ["MAT-1"], evidenceLevel: "E2" });
  assert.equal(res.status, 200, JSON.stringify(res.body ?? {}));
  const row = db.get("SELECT status,evidence_level,evidence_level_source,evidence_level_updated_by_account_id,evidence_level_updated_at FROM candidate_facts WHERE id='FACT-L'");
  assert.equal(row.status, "confirmed", "确认状态独立推进");
  assert.equal(row.evidence_level, "E2", "等级应落库");
  assert.equal(row.evidence_level_source, "verifier");
  assert.equal(row.evidence_level_updated_by_account_id, "VER", "必须记录修改人");
  assert.ok(row.evidence_level_updated_at, "必须记录修改时间");
  assert.ok(db.count("fact_judgments") > 0, "核验必须留下判定记录");
  db.close();
  console.log("  ✔ 2. 证据等级落库，记录操作者与时间");
}

// ── 3. 非法等级被拒绝 ──────────────────────────────────────────────────
{
  const db = new D1Harness();
  seed(db);
  addFact(db, { id: "FACT-BAD", claim: "x", impact: "normal", second: "not_required", status: "open" });
  const res = await verify(db, "TOK-V", { factId: "FACT-BAD", decision: "same", reason: "r", sourceRefs: ["MAT-1"], evidenceLevel: "E9" });
  assert.equal(res.status, 422, "非法等级必须拒绝");
  db.close();
  console.log("  ✔ 3. 非法证据等级被拒绝（仅接受 E1–E5）");
}

// ── 4. 工时 / 成本 / 岗位调整进入高影响判定；漏判可升级 ─────────────────
{
  const src = readFileSync(new URL("../functions/api/work-items/[itemId]/employee-submission.js", import.meta.url), "utf8");
  const match = src.match(/const HIGH_IMPACT_TOPICS = (\/.+\/i);/);
  assert.ok(match, "应能定位 HIGH_IMPACT_TOPICS");
  const re = new RegExp(match[1].slice(1, match[1].lastIndexOf("/")), "i");
  const expectations = [
    ["单条视频人工工时约 40 分钟", true],
    ["每条剪辑成本约 15 元", true],
    ["需要新增 2 名剪辑岗位", true],
    ["岗位调整方案", true],
    ["客户归属需要确认", true],
    ["合规要求需核对", true],
    ["素材来源是共享网盘", false],
    ["脚本由运营手写", false],
  ];
  for (const [claim, expected] of expectations) {
    assert.equal(re.test(claim), expected, `高影响判定不符：${claim}`);
  }
  const db = new D1Harness();
  seed(db);
  addFact(db, { id: "FACT-H1", claim: "单条视频人工工时约 40 分钟", impact: "normal", second: "not_required", status: "open" });
  const up = await verify(db, "TOK-V", { factId: "FACT-H1", action: "upgrade_impact", impactLevel: "high", reason: "该事实决定报价与改造范围" });
  assert.equal(up.status, 200, JSON.stringify(up.body ?? {}));
  const row = db.get("SELECT impact_level,second_confirmation_status,impact_level_reason,impact_level_updated_by_account_id,impact_level_updated_at FROM candidate_facts WHERE id='FACT-H1'");
  assert.equal(row.impact_level, "high");
  assert.equal(row.second_confirmation_status, "pending", "升级后必须重新进入二次确认");
  assert.equal(row.impact_level_updated_by_account_id, "VER", "必须记录操作者");
  assert.ok(row.impact_level_updated_at, "必须记录时间");
  assert.ok(row.impact_level_reason, "必须记录理由");
  db.close();
  console.log("  ✔ 4. 工时/成本/岗位调整进入高影响判定；漏判可升级并留审计");
}

// ── 5. 升级需理由；高影响未二次确认不得进入正式方案；不得自我二次确认 ──
{
  const db = new D1Harness();
  seed(db);
  addFact(db, { id: "FACT-U", claim: "剪辑成本", impact: "normal", second: "not_required", status: "open" });
  const noReason = await verify(db, "TOK-V", { factId: "FACT-U", action: "upgrade_impact", impactLevel: "high" });
  assert.equal(noReason.status, 422, "升级必须填写理由");

  await verify(db, "TOK-V", { factId: "FACT-U", action: "upgrade_impact", impactLevel: "high", reason: "影响报价" });
  const first = await verify(db, "TOK-V", { factId: "FACT-U", decision: "same", reason: "核对", sourceRefs: ["MAT-1"], evidenceLevel: "E1" });
  assert.equal(first.status, 200, JSON.stringify(first.body ?? {}));
  assert.equal(db.get("SELECT status FROM candidate_facts WHERE id='FACT-U'").status, "awaiting_second_confirmation");

  const samePerson = await verify(db, "TOK-V", { factId: "FACT-U", action: "second_confirmation", secondConfirmationReason: "自证" });
  assert.equal(samePerson.status, 403, "首次核验人不得自我二次确认");

  markFactsDone(db);
  const blocked = await draft(db, PACKET_BODY("FACT-U"));
  assert.equal(blocked.status, 409, "未完成二次确认的高影响事实不得进入正式方案");
  db.close();
  console.log("  ✔ 5. 升级需理由；未二次确认不得进入方案；不得自我二次确认");
}

// ── 6. E5 假设不得作为已核实事实进入正式结论 ────────────────────────────
{
  const db = new D1Harness();
  seed(db);
  addFact(db, { id: "FACT-E5", claim: "AI 推断：剪辑可批量套版", impact: "normal", second: "not_required", status: "confirmed", first: "VER" });
  db.exec("UPDATE candidate_facts SET evidence_level='E5',evidence_labeled=1 WHERE id='FACT-E5'");
  markFactsDone(db);
  const res = await draft(db, PACKET_BODY("FACT-E5"));
  assert.equal(res.status, 409, "E5 已确认事实必须被拒绝进入正式结论");
  const body = await res.json();
  assert.equal(body.code, "e5_cannot_be_confirmed_conclusion");
  db.close();
  console.log("  ✔ 6. E5（AI假设，待验证）不得作为已核实事实进入正式结论");
}

// ── 7. 事实撤回 → 相关已发布包失效；历史发布记录保留 ────────────────────
{
  const db = new D1Harness();
  seed(db);
  addFact(db, { id: "FACT-P", claim: "已确认事实", impact: "normal", second: "not_required", status: "confirmed", first: "VER" });
  insertPublishedPacket(db, "PKT-P", "FACT-P");
  db.exec(`UPDATE candidate_facts SET status='insufficient_evidence' WHERE id='FACT-P';
    UPDATE work_items SET status='blocked',stage='facts',supplement_id='SUP-1',evidence_version=1 WHERE id='${ITEM}';
    INSERT INTO evidence_supplements(id,work_item_id,fact_id,requested_material,responsible_person,responsible_account_id,deadline,recovery_entry,authorization_scope,source_refs,old_evidence_version,new_evidence_version,status)
      VALUES ('SUP-1','${ITEM}','FACT-P','名单','Emp','EMP','2026-02-01','recovery','project','[]',1,2,'waiting');`);
  // 补证只能由被指派的一线员工提交（evidence-supplement.js 授权门）
  const res = await supplement(db, "TOK-E", { material: "名单附件", reference: "ref://x", sourceType: "csv", metadata: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body ?? {}));
  assert.equal(db.get("SELECT status FROM decision_packets WHERE id='PKT-P'").status, "stale", "被引用事实撤回后，已发布包必须失效");
  assert.equal(Number(db.get("SELECT COUNT(*) c FROM events WHERE type='decision_packet_staled'").c), 1, "必须留下失效事件");
  assert.ok(db.get("SELECT published_at FROM decision_packets WHERE id='PKT-P'").published_at, "历史发布记录不得被清除");
  db.close();
  console.log("  ✔ 7. 事实撤回导致引用它的已发布包失效（历史保留）");
}

// ── 8. 失效包拒绝新决策；历史决策保留并显示失效警告 ─────────────────────
{
  const db = new D1Harness();
  seed(db);
  addFact(db, { id: "FACT-S", claim: "事实", impact: "normal", second: "not_required", status: "confirmed", first: "VER" });
  insertPublishedPacket(db, "PKT-S", "FACT-S");
  db.exec(`INSERT INTO owner_decisions(id,packet_id,project_id,owner_account_id,decision,reason,scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner)
    VALUES ('DEC-S','PKT-S','${PROJ}','OWN','continue','历史决策','scope','["c"]','["m"]','["s"]','BLD');`);

  await verify(db, "TOK-V", { factId: "FACT-S", action: "upgrade_impact", impactLevel: "high", reason: "影响报价" });
  assert.equal(db.get("SELECT status FROM decision_packets WHERE id='PKT-S'").status, "stale", "高影响升级必须使已发布包失效");

  const blocked = await decide(db, "PKT-S", { decision: "continue", reason: "再次批准", scope: "s", constraints: ["c"], successMetrics: ["m"], stopConditions: ["s"], downstreamOwner: "BLD" });
  assert.equal(blocked.status, 409, "失效包不得接受新的负责人决策");
  assert.equal(Number(db.get("SELECT COUNT(*) c FROM owner_decisions WHERE packet_id='PKT-S'").c), 1, "历史负责人决策必须保留且不得被覆盖");

  const view = await ownerPacket({ request: bearerRequest(`http://127.0.0.1/api/formal/projects/${PROJ}/owner-packet`, "TOK-O"), env: { DB: db }, params: { projectId: PROJ } });
  assert.equal(view.status, 200);
  const payload = await view.json();
  assert.ok(payload.packet.invalidation?.stale, "负责人视图必须给出失效标记");
  assert.ok(String(payload.packet.invalidation.notice).includes("失效"), "必须明示依据已失效");
  db.close();
  console.log("  ✔ 8. 失效包拒绝新决策；历史决策保留并显示失效警告");
}

// ── 9. 等级与确认状态正交 ────────────────────────────────────────────
{
  const db = new D1Harness();
  seed(db);
  addFact(db, { id: "FACT-O1", claim: "未确认已定级", impact: "normal", second: "not_required", status: "open" });
  addFact(db, { id: "FACT-O2", claim: "已确认未定级", impact: "normal", second: "not_required", status: "confirmed", first: "VER" });
  db.exec("UPDATE candidate_facts SET evidence_level='E4' WHERE id='FACT-O1'");
  const a = db.get("SELECT status,evidence_level FROM candidate_facts WHERE id='FACT-O1'");
  const b = db.get("SELECT status,evidence_level FROM candidate_facts WHERE id='FACT-O2'");
  assert.deepEqual([a.status, a.evidence_level], ["open", "E4"], "未确认但已定级必须合法");
  assert.deepEqual([b.status, b.evidence_level], ["confirmed", null], "已确认但未定级必须合法");
  db.close();
  console.log("  ✔ 9. 证据等级与确认状态正交（两种组合均合法）");
}

// ── 10. 非 E5 的已确认事实仍可正常进入决策包（防止过度拦截）─────────────
{
  const db = new D1Harness();
  seed(db);
  addFact(db, { id: "FACT-OK", claim: "正常事实", impact: "normal", second: "not_required", status: "confirmed", first: "VER" });
  db.exec("UPDATE candidate_facts SET evidence_level='E2' WHERE id='FACT-OK'");
  markFactsDone(db);
  const res = await draft(db, PACKET_BODY("FACT-OK"));
  assert.equal(res.status, 201, `合格事实应可进入决策包，实际 ${res.status}`);
  db.close();
  console.log("  ✔ 10. 合格的已确认事实仍可正常进入决策包（未过度拦截）");
}

console.log("first batch runtime: ok");
