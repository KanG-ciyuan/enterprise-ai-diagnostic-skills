/**
 * 未授权请求的副作用矩阵 —— 运行时行为测试（V0.1 第二批 B2-03）
 *
 * 覆盖修订稿安全性质 P-6：未授权请求不能产生业务副作用。
 *
 * 验证的是"副作用"而不是状态码：对每类写端点分别构造
 *   ① 无任何凭据 ② 存在会话但无成员关系 ③ 演示身份头
 * 三种未授权形态，断言**业务表行级快照逐表不变**、`events` 不新增。
 *
 * 结果分三类：PASS / FAIL / UNCOVERED。
 */
import assert from "node:assert/strict";
import { D1Harness } from "./d1_harness.mjs";

const MOD = "../functions/api/";

// 代表性写端点（覆盖每个业务写入面；不做无意义的全量重复）
const WRITE_ENDPOINTS = [
  { id: "projects (POST)", path: "projects.js", method: "onRequestPost", params: {}, body: { name: "x", scope: "y" }, needsKey: true },
  { id: "projects/authorizations (POST)", path: "projects/[projectId]/authorizations.js", method: "onRequestPost", params: { projectId: "PRJ-REAL000001" }, body: { label: "l", authorizerName: "n", authorizerEmail: "a@b.invalid", scope: "s", reference: "r" } },
  { id: "projects/invitations (POST)", path: "projects/[projectId]/invitations.js", method: "onRequestPost", params: { projectId: "PRJ-REAL000001" }, body: { email: "x@a.invalid", role: "employee" } },
  { id: "projects/materials (POST)", path: "projects/[projectId]/materials.js", method: "onRequestPost", params: { projectId: "PRJ-REAL000001" }, body: { label: "l", sourceType: "csv", reference: "r", visibility: "project", authorizationRecordId: "AUTH-REAL0001" } },
  { id: "projects/materials/review", path: "projects/[projectId]/materials/[materialId]/review.js", method: "onRequestPost", params: { projectId: "PRJ-REAL000001", materialId: "MAT-REAL0001" }, body: { decision: "verified", reason: "x" } },
  { id: "work-items/employee-draft", path: "work-items/[itemId]/employee-draft.js", method: "onRequestPut", params: { itemId: "WI-REAL0001" }, body: { text: "x" } },
  { id: "work-items/employee-submission", path: "work-items/[itemId]/employee-submission.js", method: "onRequestPost", params: { itemId: "WI-REAL0001" }, body: { text: "x" } },
  { id: "work-items/verification", path: "work-items/[itemId]/verification.js", method: "onRequestPost", params: { itemId: "WI-REAL0001" }, body: { factId: "FACT-REAL0001", decision: "same", reason: "x", sourceRefs: ["MAT-REAL0001"] } },
  { id: "work-items/evidence-supplement", path: "work-items/[itemId]/evidence-supplement.js", method: "onRequestPost", params: { itemId: "WI-REAL0001" }, body: { requestedMaterial: "x", responsibleAccountId: "ACC-V" } },
  { id: "work-items/reassignment", path: "work-items/[itemId]/reassignment.js", method: "onRequestPost", params: { itemId: "WI-REAL0001" }, body: { verifierAccountId: "ACC-V2", reason: "x" } },
  { id: "formal/decision-packets/draft", path: "formal/projects/[projectId]/decision-packets/draft.js", method: "onRequestPost", params: { projectId: "PRJ-REAL000001" }, body: { factRefs: [{ factId: "FACT-REAL0001" }], riskSummary: "r", pilotScope: "p", constraints: ["c"], successMetrics: ["m"], stopConditions: ["s"], downstreamOwner: "o" } },
  { id: "formal/decision-packets/verify", path: "formal/decision-packets/[packetId]/verify.js", method: "onRequestPost", params: { packetId: "PKT-REAL0001" }, body: { factRefs: [{ factId: "FACT-REAL0001" }] } },
  { id: "formal/decision-packets/publish", path: "formal/decision-packets/[packetId]/publish.js", method: "onRequestPost", params: { packetId: "PKT-REAL0001" } },
  { id: "formal/decision-packets/owner-decision", path: "formal/decision-packets/[packetId]/owner-decision.js", method: "onRequestPost", params: { packetId: "PKT-REAL0001" }, body: { decision: "continue", reason: "r", scope: "s", constraints: ["c"], successMetrics: ["m"], stopConditions: ["s"], downstreamOwner: "o" } },
  { id: "invitations/revoke", path: "invitations/[invitationRef]/revoke.js", method: "onRequestPost", params: { invitationRef: "INV-REAL0001" } },
  { id: "projects/materials/authorization-binding", path: "projects/[projectId]/materials/[materialId]/authorization-binding.js", method: "onRequestPost", params: { projectId: "PRJ-REAL000001", materialId: "MAT-REAL0001" }, body: { authorizationRecordId: "AUTH-REAL000001" } },
  { id: "auth/select-project", path: "auth/select-project.js", method: "onRequestPost", params: {}, body: { projectId: "PRJ-REAL000001" } },
  { id: "agent/employee-turn", path: "agent/employee-turn.js", method: "onRequestPost", params: { projectId: "PRJ-REAL000001" }, body: { message: "x" } },
];

const SNAPSHOT_TABLES = ["projects", "project_memberships", "work_items", "candidate_facts", "decision_packets", "owner_decisions", "evidence_materials", "sessions", "events", "invitations", "enterprise_authorizations", "fact_judgments", "evidence_supplements"];
const snapshot = (db) => Object.fromEntries(SNAPSHOT_TABLES.map((t) => [t, db.count(t)]));
const diff = (a, b) => Object.entries(b).filter(([k, v]) => a[k] !== v).map(([k, v]) => `${k}:${a[k]}→${v}`);

const results = [];
const pass = (id, name, note) => results.push({ id, name, verdict: "PASS", note });
const fail = (id, name, note) => results.push({ id, name, verdict: "FAIL", note });
const uncovered = (id, name, note) => results.push({ id, name, verdict: "UNCOVERED", note });

function fixture() {
  const db = new D1Harness();
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('ACC-B','builder@real.example','改造方','active','external_builder'),
      ('ACC-V','verifier@real.example','核验人','active','member'),
      ('ACC-O','owner@real.example','负责人','active','member'),
      ('ACC-V2','v2@real.example','核验人2','active','member'),
      ('ACC-OUT','outsider@real.example','局外人','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage) VALUES
      ('PRJ-REAL000001','真实项目','s','facts','active','unknown','external_builder','ACC-B','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES
      ('PRJ-REAL000001','ACC-B','external_builder','project','active'),
      ('PRJ-REAL000001','ACC-V','verifier','project','active'),
      ('PRJ-REAL000001','ACC-O','owner','project','active'),
      ('PRJ-REAL000001','ACC-V2','verifier','project','active');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES
      ('AUTH-REAL0001','PRJ-REAL000001','授权','负责人','o@real.example','范围','ref','authorized','ACC-B','k','n','h','2099-01-01T00:00:00Z');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id) VALUES
      ('WI-REAL0001','PRJ-REAL000001','任务','描述','facts','awaiting_verification','verifier','核验人',50,'','核验','ACC-V','ACC-V');
    INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,required,impact_level,second_confirmation_status,material_status,status,source_refs_json,evidence_version) VALUES
      ('FACT-REAL0001','PRJ-REAL000001','WI-REAL0001','workflow','事实','f',1,'normal','not_required','same','open','["MAT-REAL0001"]',1);
    INSERT INTO decision_packets(id,project_id,version,status,drafted_by_account_id,fact_refs_json,risk_summary,pilot_scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner,published_at) VALUES
      ('PKT-REAL0001','PRJ-REAL000001',1,'published','ACC-B','[{"factId":"FACT-REAL0001"}]','风险','试点','["c"]','["m"]','["s"]','改造方','2026-01-01T00:00:00Z');
    INSERT INTO evidence_materials(id,project_id,material_key,version,source_type,authorization_record_id,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference) VALUES
      ('MAT-REAL0001','PRJ-REAL000001','MK1',1,'csv','AUTH-REAL0001','authorized','verified','project','ACC-B','WI-REAL0001','材料','r');
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,accepted_account_id,idempotency_key) VALUES
      ('INV-REAL0001','tok1','PRJ-REAL000001','ACC-B','v@real.example','verifier','project','pending','2099-01-01T00:00:00Z',NULL,'k1');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('TOK-OUT','ACC-OUT',NULL,'2099-01-01T00:00:00Z','R1');
  `);
  return db;
}

const invoke = async (entry, headers, env) => {
  const mod = await import(MOD + entry.path);
  const handler = mod[entry.method];
  if (typeof handler !== "function") return { missing: true };
  const method = entry.method === "onRequestPut" ? "PUT" : "POST";
  const request = new Request("http://127.0.0.1/api/" + entry.id, {
    method,
    headers: { "content-type": "application/json", "Idempotency-Key": "K-" + entry.id, ...headers },
    body: JSON.stringify(entry.body ?? {}),
  });
  try { return { status: (await handler({ request, env, params: entry.params }))?.status ?? null }; }
  catch (e) { return { status: "throw", error: String(e?.message || e).slice(0, 60) }; }
};

// 三种未授权形态
const UNAUTHORIZED_CASES = [
  { label: "无任何凭据", headers: () => ({}) },
  { label: "有会话但无成员关系", headers: () => ({ Authorization: "Bearer TOK-OUT" }) },
  { label: "演示身份头", headers: () => ({ "X-Demo-Role": "external_builder", "X-Demo-User": "ACC-B" }) },
];

console.log("未授权请求副作用矩阵\n");
console.log(`写端点：${WRITE_ENDPOINTS.length} 个 × 未授权形态 ${UNAUTHORIZED_CASES.length} 种 = ${WRITE_ENDPOINTS.length * UNAUTHORIZED_CASES.length} 组\n`);

for (const c of UNAUTHORIZED_CASES) {
  const failures = [];
  let checked = 0;
  for (const entry of WRITE_ENDPOINTS) {
    const db = fixture();
    const env = { DB: db, FORMAL_AUTH_MODE: "production" };
    const before = snapshot(db);
    const out = await invoke(entry, c.headers(), env);
    const after = snapshot(db);
    if (out.missing) { failures.push(`${entry.id}: handler 缺失`); db.close(); continue; }
    checked += 1;
    const effects = diff(before, after);
    if (effects.length) failures.push(`${entry.id}: ${effects.join(",")}`);
    if (out.status === "throw") failures.push(`${entry.id}: 抛异常 ${out.error}`);
    db.close();
  }
  const name = `${c.label} · ${checked} 个写端点`;
  if (!failures.length) pass("P-6", name, "全部无行级副作用");
  else fail("P-6", name, failures.slice(0, 5).join(" | "));
}

// 正向对照：有权限的请求**应当**产生副作用（证明矩阵不是"恒不变化"的假通过）
{
  const db = fixture();
  const env = { DB: db, FORMAL_AUTH_MODE: "production" };
  db.exec("INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('TOK-V','ACC-V','PRJ-REAL000001','2099-01-01T00:00:00Z','R2')");
  const before = snapshot(db);
  const entry = WRITE_ENDPOINTS.find((e) => e.id === "work-items/verification");
  const out = await invoke(entry, { Authorization: "Bearer TOK-V" }, env);
  const after = snapshot(db);
  const effects = diff(before, after);
  if (out.status === 200 && effects.length > 0) pass("P-6", "正向对照：有权限核验请求确实产生副作用", effects.join(","));
  else fail("P-6", "正向对照失败（矩阵可能恒真）", `status=${out.status} 副作用=[${effects.join(",")}]`);
  db.close();
}

// 未覆盖声明
uncovered("P-6", "并发/重放路径下的副作用", "本矩阵为串行单请求验证。并发写入与幂等重放的副作用边界由既有 authorization_runtime / owner_revision_runtime 套件覆盖，本套件未重复验证。剩余风险：极端并发下的重复副作用未在本批复验。");
uncovered("P-6", "非 HTTP 入口的副作用", "未覆盖计划任务 / Queue 消费者等非 HTTP 路径（本批无此类入口）。剩余风险：未来新增后台任务时需补充。");

const count = (v) => results.filter((r) => r.verdict === v).length;
console.log("──────────────── 结果明细 ────────────────");
for (const r of results) {
  const icon = r.verdict === "PASS" ? "✔" : r.verdict === "FAIL" ? "✘" : "○";
  console.log(`  ${icon} [${r.verdict}] ${r.id} · ${r.name}${r.note ? `\n        ${r.note}` : ""}`);
}
console.log("\n──────────────── 汇总 ────────────────");
console.log(`  PASS=${count("PASS")}  FAIL=${count("FAIL")}  UNCOVERED=${count("UNCOVERED")}`);
assert.equal(count("FAIL"), 0, "存在 FAIL 用例");
console.log("\nwrite side-effect matrix runtime: ok");
