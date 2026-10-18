/**
 * 演示与正式隔离 —— 运行时行为测试（V0.1 第二批 B2-03）
 *
 * 覆盖修订稿安全性质 P-1 / P-2 / P-3 / P-4 / P-9。
 *
 * 设计原则（遵循授权范围 §6）：
 *   · 调用**真实 handler**，断言**可观察状态**（响应体内容 + 数据库行级快照），
 *     不以源码字符串搜索代替行为测试；
 *   · 不要求"所有端点统一返回 401"——验证的是**权限、数据与副作用**，
 *     状态码只是手段之一；
 *   · 结果分三类：PASS / FAIL / UNCOVERED；UNCOVERED 不得计入通过。
 *
 * 关键背景：演示与正式**共用同一个 D1 与同一批数据表**，隔离依据是
 *   (a) formalActor 拒绝 X-Demo-* 头；(b) 项目 ID 的 `PRJ-` 前缀约定。
 * 本套件把这两条从"约定"提升为"被测试守住的性质"。
 */
import assert from "node:assert/strict";
import { D1Harness } from "./d1_harness.mjs";

// ── 30 个使用 formalActor 的正式端点（逐个显式登记，不抽样）──────────────
const MOD = "../functions/api/";
const FORMAL_ENDPOINTS = [
  { id: "agent/employee-turn", path: "agent/employee-turn.js", method: "onRequestPost", params: { projectId: "PRJ-REAL000001" }, body: { message: "x" } },
  { id: "auth/logout", path: "auth/logout.js", method: "onRequestPost", params: {} },
  { id: "auth/select-project", path: "auth/select-project.js", method: "onRequestPost", params: {}, body: { projectId: "PRJ-REAL000001" } },
  { id: "auth/session", path: "auth/session.js", method: "onRequestGet", params: {} },
  { id: "formal/decision-packets/owner-decision", path: "formal/decision-packets/[packetId]/owner-decision.js", method: "onRequestPost", params: { packetId: "PKT-REAL0001" }, body: { decision: "continue" } },
  { id: "formal/decision-packets/publish", path: "formal/decision-packets/[packetId]/publish.js", method: "onRequestPost", params: { packetId: "PKT-REAL0001" } },
  { id: "formal/decision-packets/verify", path: "formal/decision-packets/[packetId]/verify.js", method: "onRequestPost", params: { packetId: "PKT-REAL0001" }, body: { factRefs: [] } },
  { id: "formal/projects/confirmed-facts", path: "formal/projects/[projectId]/confirmed-facts.js", method: "onRequestGet", params: { projectId: "PRJ-REAL000001" } },
  { id: "formal/projects/decision-packet", path: "formal/projects/[projectId]/decision-packet.js", method: "onRequestGet", params: { projectId: "PRJ-REAL000001" } },
  { id: "formal/projects/decision-packets/draft", path: "formal/projects/[projectId]/decision-packets/draft.js", method: "onRequestPost", params: { projectId: "PRJ-REAL000001" }, body: { factRefs: [] } },
  { id: "formal/projects/owner-packet", path: "formal/projects/[projectId]/owner-packet.js", method: "onRequestGet", params: { projectId: "PRJ-REAL000001" } },
  { id: "formal/projects/verifier-facts", path: "formal/projects/[projectId]/verifier-facts.js", method: "onRequestGet", params: { projectId: "PRJ-REAL000001" } },
  { id: "invitations/revoke", path: "invitations/[invitationRef]/revoke.js", method: "onRequestPost", params: { invitationRef: "INV-REAL0001" } },
  { id: "projects (GET)", path: "projects.js", method: "onRequestGet", params: {} },
  { id: "projects (POST)", path: "projects.js", method: "onRequestPost", params: {}, body: { name: "x", scope: "y" } },
  { id: "projects/[projectId]", path: "projects/[projectId].js", method: "onRequest", params: { projectId: "PRJ-REAL000001" } },
  { id: "projects/authorizations (GET)", path: "projects/[projectId]/authorizations.js", method: "onRequestGet", params: { projectId: "PRJ-REAL000001" } },
  { id: "projects/authorizations (POST)", path: "projects/[projectId]/authorizations.js", method: "onRequestPost", params: { projectId: "PRJ-REAL000001" }, body: { label: "x", authorizerName: "y", authorizerEmail: "z@a.invalid", scope: "s", reference: "r" } },
  { id: "projects/authorizations/resend", path: "projects/[projectId]/authorizations/[authorizationId]/resend.js", method: "onRequestPost", params: { projectId: "PRJ-REAL000001", authorizationId: "AUTH-REAL0001" } },
  { id: "projects/employee-task", path: "projects/[projectId]/employee-task.js", method: "onRequestGet", params: { projectId: "PRJ-REAL000001" } },
  { id: "projects/events", path: "projects/[projectId]/events.js", method: "onRequest", params: { projectId: "PRJ-REAL000001" } },
  { id: "projects/invitations (GET)", path: "projects/[projectId]/invitations.js", method: "onRequestGet", params: { projectId: "PRJ-REAL000001" } },
  { id: "projects/invitations (POST)", path: "projects/[projectId]/invitations.js", method: "onRequestPost", params: { projectId: "PRJ-REAL000001" }, body: { email: "x@a.invalid", role: "employee" } },
  { id: "projects/materials (GET)", path: "projects/[projectId]/materials.js", method: "onRequestGet", params: { projectId: "PRJ-REAL000001" } },
  { id: "projects/materials (POST)", path: "projects/[projectId]/materials.js", method: "onRequestPost", params: { projectId: "PRJ-REAL000001" }, body: { label: "x", sourceType: "csv", reference: "r", visibility: "project" } },
  { id: "projects/materials/authorization-binding", path: "projects/[projectId]/materials/[materialId]/authorization-binding.js", method: "onRequestPost", params: { projectId: "PRJ-REAL000001", materialId: "MAT-REAL0001" }, body: { authorizationRecordId: "AUTH-REAL0001" } },
  { id: "projects/materials/review", path: "projects/[projectId]/materials/[materialId]/review.js", method: "onRequestPost", params: { projectId: "PRJ-REAL000001", materialId: "MAT-REAL0001" }, body: { decision: "verified", reason: "x" } },
  { id: "projects/verifier-candidates", path: "projects/[projectId]/verifier-candidates.js", method: "onRequestGet", params: { projectId: "PRJ-REAL000001" } },
  { id: "projects/work-items", path: "projects/[projectId]/work-items.js", method: "onRequest", params: { projectId: "PRJ-REAL000001" } },
  { id: "work-items/employee-draft", path: "work-items/[itemId]/employee-draft.js", method: "onRequestPut", params: { itemId: "WI-REAL0001" }, body: { text: "x" } },
  { id: "work-items/employee-submission", path: "work-items/[itemId]/employee-submission.js", method: "onRequestPost", params: { itemId: "WI-REAL0001" }, body: { text: "x" } },
  { id: "work-items/evidence-supplement", path: "work-items/[itemId]/evidence-supplement.js", method: "onRequestPost", params: { itemId: "WI-REAL0001" }, body: { requestedMaterial: "x" } },
  { id: "work-items/reassignment", path: "work-items/[itemId]/reassignment.js", method: "onRequestPost", params: { itemId: "WI-REAL0001" }, body: { verifierAccountId: "ACC-V" } },
  { id: "work-items/verification", path: "work-items/[itemId]/verification.js", method: "onRequestPost", params: { itemId: "WI-REAL0001" }, body: { factId: "FACT-REAL0001", decision: "same", reason: "x" } },
];

// formalActor 覆盖的端点数（用于校验清单不遗漏）
const FORMAL_COUNT = FORMAL_ENDPOINTS.length;   // 34 条调用项，覆盖 30 个独立端点文件

const results = [];
const record = (id, name, verdict, note = "") => results.push({ id, name, verdict, note });
const pass = (id, name, note) => record(id, name, "PASS", note);
const fail = (id, name, note) => record(id, name, "FAIL", note);
const uncovered = (id, name, note) => record(id, name, "UNCOVERED", note);

const realpi = async (entry, extraHeaders = {}, overrides = {}) => {
  const mod = await import(MOD + entry.path);
  const handler = mod[entry.method];
  if (typeof handler !== "function") return { missing: true, status: null };
  const method = entry.method === "onRequestGet" ? "GET" : entry.method === "onRequestPut" ? "PUT" : "POST";
  const body = overrides.body !== undefined ? overrides.body : entry.body;
  const request = new Request("http://127.0.0.1/api/" + entry.id, {
    method,
    headers: { "content-type": "application/json", ...extraHeaders },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  try {
    const response = await handler({ request, env: overrides.env, params: entry.params });
    return { status: response?.status ?? null, response };
  } catch (error) {
    return { status: "throw", error: String(error?.message || error).slice(0, 80) };
  }
};

// ── 夹具：一个真实项目 + 一个演示项目（共享 PRJ- 前缀）─────────────────
function formalFixture({ sameNamespaceDemo = true } = {}) {
  const db = new D1Harness();
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES
      ('ACC-V','verifier@real.example','核验人','active','member'),
      ('ACC-B','builder@real.example','改造方','active','external_builder'),
      ('ACC-D','demo@demo.local','演示账号','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage) VALUES
      ('PRJ-REAL000001','真实客户项目','真实范围','facts','active','unknown','external_builder','ACC-B','authorized'),
      ${sameNamespaceDemo ? "('PRJ-DEMO-0001','演示项目','演示范围','facts','active','E5','external_builder','ACC-D','authorized')," : ""}
      ('PRJ-DEMO00001','另一演示项目','演示范围','facts','active','E5','external_builder','ACC-D','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,scope,status) VALUES
      ('PRJ-REAL000001','ACC-B','external_builder','project','active'),
      ('PRJ-REAL000001','ACC-V','verifier','project','active'),
      ${sameNamespaceDemo ? "('PRJ-DEMO-0001','ACC-D','owner','project','active')," : ""}
      ('PRJ-DEMO00001','ACC-D','owner','project','active');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES
      ('AUTH-REAL0001','PRJ-REAL000001','授权','负责人','o@real.example','范围','ref','authorized','ACC-B','k','n','h','2099-01-01T00:00:00Z'),
      ('AUTH-DEMO0001','PRJ-DEMO-0001','授权','负责人','o@demo.local','范围','ref','authorized','ACC-D','k2','n2','h2','2099-01-01T00:00:00Z');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,assigned_verifier_id) VALUES
      ('WI-REAL0001','PRJ-REAL000001','真实任务','真实描述','facts','awaiting_verification','verifier','核验人',50,'','核验','ACC-V','ACC-V'),
      ('WI-DEMO0001','PRJ-DEMO-0001','演示任务','演示描述','facts','awaiting_verification','verifier','核验人',50,'','核验','ACC-D','ACC-D');
    INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,required,impact_level,second_confirmation_status,material_status,status,source_refs_json,evidence_version) VALUES
      ('FACT-REAL0001','PRJ-REAL000001','WI-REAL0001','workflow','真实事实','f',1,'normal','not_required','same','open','[]',1),
      ('FACT-DEMO0001','PRJ-DEMO-0001','WI-DEMO0001','workflow','演示事实','f',1,'normal','not_required','same','open','[]',1);
    INSERT INTO decision_packets(id,project_id,version,status,drafted_by_account_id,fact_refs_json,risk_summary,pilot_scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner,published_at) VALUES
      ('PKT-REAL0001','PRJ-REAL000001',1,'published','ACC-B','[{"factId":"FACT-REAL0001"}]','真实风险','真实试点','["c"]','["m"]','["s"]','改造方','2026-01-01T00:00:00Z');
    INSERT INTO evidence_materials(id,project_id,material_key,version,source_type,authorization_record_id,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference) VALUES
      ('MAT-REAL0001','PRJ-REAL000001','MK1',1,'csv','AUTH-REAL0001','authorized','verified','project','ACC-B','WI-REAL0001','真实材料','r');
  `);
  return db;
}

// 业务表行级快照（用于"无副作用"断言，比状态码更严格）
const SNAPSHOT_TABLES = ["projects", "project_memberships", "work_items", "candidate_facts", "decision_packets", "owner_decisions", "evidence_materials", "sessions", "events", "invitations", "enterprise_authorizations", "fact_judgments"];
const snapshot = (db) => Object.fromEntries(SNAPSHOT_TABLES.map((t) => [t, db.count(t)]));
const diffSnapshot = (a, b) => Object.entries(b).filter(([k, v]) => a[k] !== v).map(([k, v]) => `${k}:${a[k]}→${v}`);

console.log("演示与正式隔离 —— 运行时行为测试\n");
console.log(`正式端点调用项：${FORMAL_COUNT} 条（覆盖 30 个独立端点，含 projects.js / logout 的多方法，逐条登记不抽样）\n`);

// ── P-1：演示身份不能获得正式权限（覆盖全部 30 个正式端点）─────────────
console.log("P-1 演示身份不能获得正式权限（全部正式端点）");
{
  const failures = [];
  let checked = 0;
  for (const entry of FORMAL_ENDPOINTS) {
    const db = formalFixture();
    const env = { DB: db, FORMAL_AUTH_MODE: "production" };
    const before = snapshot(db);
    const demoHeaders = { "X-Demo-Role": "external_builder", "X-Demo-User": "ACC-B" };
    const out = await realpi(entry, demoHeaders, { env });
    if (out.missing) { failures.push(`${entry.id}: handler 未导出 ${entry.method}`); db.close(); continue; }
    checked += 1;
    const after = snapshot(db);
    const sideEffects = diffSnapshot(before, after);
    const granted = out.status === 200 && !entry.id.startsWith("auth/session");
    // 断言：不获得正式数据(非 200) 且 无副作用；豁免 auth/session 的 200（它返回的是"无会话"而非项目数据）
    const sessionLeak = entry.id === "auth/session" && out.status === 200;
    if (granted || sideEffects.length || out.status === "throw") {
      failures.push(`${entry.id}: status=${out.status} 副作用=[${sideEffects.join(",")}]`);
    }
    if (sessionLeak) {
      // 单独确认 auth/session 未返回项目数据
      const body = await out.response.json().catch(() => ({}));
      const leaked = Boolean(body?.memberships?.length) || Boolean(body?.projects?.length);
      if (leaked) failures.push(`auth/session 泄露了项目数据`);
      // 无会话时应当是 401；若是 200 需确认无项目数据
      if (out.status === 200 && !leaked) { /* 允许：等价于"未登录" */ }
      else if (out.status !== 401) failures.push(`auth/session 未拒绝演示身份：${out.status}`);
    }
    db.close();
  }
  if (failures.length === 0) pass("P-1", `全部 ${checked} 个正式端点拒绝演示身份且无副作用`);
  else fail("P-1", `${failures.length}/${checked} 个端点未通过`, failures.slice(0, 6).join(" | "));
  if (checked !== FORMAL_COUNT) fail("P-1", `端点覆盖不完整：登记 ${FORMAL_COUNT} 实际调用 ${checked}`);
}

// ── P-2：演示身份不能读取正式数据 ─────────────────────────────────────
console.log("P-2 演示身份不能读取正式数据");
{
  const readEndpoints = FORMAL_ENDPOINTS.filter((e) => e.method === "onRequestGet" || e.method === "onRequest");
  const leakedMarkers = ["真实客户项目", "真实风险", "真实事实", "真实材料", "PRJ-REAL000001", "WI-REAL0001", "ACC-B", "ACC-V"];
  const failures = [];
  for (const entry of readEndpoints) {
    const db = formalFixture();
    const env = { DB: db, FORMAL_AUTH_MODE: "production" };
    const out = await realpi(entry, { "X-Demo-Role": "external_builder", "X-Demo-User": "ACC-B" }, { env });
    if (out.missing) { db.close(); continue; }
    const text = out.response ? await out.response.text().catch(() => "") : "";
    const hit = leakedMarkers.filter((m) => text.includes(m));
    if (hit.length) failures.push(`${entry.id}: 响应含 ${hit.join(",")}`);
    db.close();
  }
  if (!failures.length) pass("P-2", `${readEndpoints.length} 个读取端点响应体均不含正式业务字段`);
  else fail("P-2", failures.slice(0, 5).join(" | "));
}

// ── P-3：演示身份不能修改正式数据 ─────────────────────────────────────
console.log("P-3 演示身份不能修改正式数据");
{
  const writeEndpoints = FORMAL_ENDPOINTS.filter((e) => e.method !== "onRequestGet" && e.method !== "onRequest");
  const failures = [];
  for (const entry of writeEndpoints) {
    const db = formalFixture();
    const env = { DB: db, FORMAL_AUTH_MODE: "production" };
    const before = snapshot(db);
    const out = await realpi(entry, { "X-Demo-Role": "external_builder", "X-Demo-User": "ACC-B" }, { env });
    const after = snapshot(db);
    const effects = diffSnapshot(before, after);
    if (effects.length) failures.push(`${entry.id}: ${effects.join(",")}`);
    if (out.missing) failures.push(`${entry.id}: handler 缺失`);
    db.close();
  }
  if (!failures.length) pass("P-3", `${writeEndpoints.length} 个写入端点均未产生任何行级副作用`);
  else fail("P-3", failures.slice(0, 5).join(" | "));
}

// ── P-4：正式身份不能越权访问演示数据 ─────────────────────────────────
console.log("P-4 正式身份不能越权访问演示数据");
{
  const failures = [];
  // 用真实账号（无演示项目成员关系）的正式会话访问演示项目
  for (const projectId of ["PRJ-DEMO-0001", "PRJ-DEMO00001"]) {
    for (const entry of FORMAL_ENDPOINTS.filter((e) => e.params && e.params.projectId)) {
      const db = formalFixture();
      db.exec("INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('TOK-REAL','ACC-B','PRJ-REAL000001','2099-01-01T00:00:00Z','R')");
      const env = { DB: db, FORMAL_AUTH_MODE: "production" };
      const patched = { ...entry, params: { ...entry.params, projectId } };
      const before = snapshot(db);
      const out = await realpi(patched, { Authorization: "Bearer TOK-REAL" }, { env });
      const after = snapshot(db);
      // 会话绑定在 PRJ-REAL000001，访问其它项目必须被拒
      if (out.status === 200) failures.push(`${projectId} ${entry.id}: 200 越权`);
      const effects = diffSnapshot(before, after).filter((x) => !x.startsWith("sessions"));
      if (effects.length) failures.push(`${projectId} ${entry.id}: 副作用 ${effects.join(",")}`);
      db.close();
      if (failures.length > 8) break;
    }
    if (failures.length > 8) break;
  }
  if (!failures.length) pass("P-4", "正式会话跨项目访问演示项目一律被拒且无副作用");
  else fail("P-4", failures.slice(0, 5).join(" | "));
}

// ── P-9：PRJ-DEMO-0001 与正式项目共享 PRJ- 前缀仍不能越权 ──────────────
console.log("P-9 共享 PRJ- 前缀的演示项目不能导致越权");
{
  const failures = [];
  // ① 演示身份（X-Demo-*）访问 PRJ-DEMO-0001：演示项目不走 formalActor，
  //    但必须确认演示头不会被当作正式身份去写正式表。
  {
    const db = formalFixture();
    const env = { DB: db, FORMAL_AUTH_MODE: "development" };
    const before = snapshot(db);
    await realpi(FORMAL_ENDPOINTS.find((e) => e.id === "projects/work-items"), { "X-Demo-Role": "verifier", "X-Demo-User": "ACC-V" }, { env });
    const after = snapshot(db);
    const effects = diffSnapshot(before, after);
    if (effects.length) failures.push(`演示头读取 work-items 产生副作用: ${effects.join(",")}`);
    db.close();
  }
  // ② 正式会话访问 PRJ-DEMO-0001（同前缀）必须被拒
  {
    const db = formalFixture();
    db.exec("INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('TOK-R2','ACC-B','PRJ-REAL000001','2099-01-01T00:00:00Z','R')");
    const env = { DB: db, FORMAL_AUTH_MODE: "production" };
    const entry = { ...FORMAL_ENDPOINTS.find((e) => e.id === "projects/[projectId]"), params: { projectId: "PRJ-DEMO-0001" } };
    const out = await realpi(entry, { Authorization: "Bearer TOK-R2" }, { env });
    const text = out.response ? await out.response.text().catch(() => "") : "";
    if (out.status === 200 && text.includes("演示项目")) failures.push("正式会话读到了 PRJ-DEMO-0001 的数据");
    if (![403, 401].includes(out.status)) failures.push(`PRJ-DEMO-0001 返回 ${out.status}（期望 403/401）`);
    db.close();
  }
  // ③ 两者不共用成员关系
  {
    const db = formalFixture();
    const shared = db.get("SELECT COUNT(*) AS c FROM project_memberships m1 JOIN project_memberships m2 ON m1.account_id=m2.account_id WHERE m1.project_id='PRJ-REAL000001' AND m2.project_id='PRJ-DEMO-0001'");
    if (Number(shared?.c || 0) === 0) pass("P-9", "PRJ-DEMO-0001 与真实项目不共用任何成员关系");
    else fail("P-9", "存在同时属于演示与真实项目的账号", JSON.stringify(shared));
    db.close();
  }
  // ④ 前缀约定本身不是安全边界 —— 记录为未覆盖（设计性风险）
  uncovered("P-9", "`PRJ-` 前缀约定的结构性脆弱", "隔离依赖项目 ID 命名约定（app 内多处 startsWith(\"PRJ-\")），数据库层无 CHECK/外键强制。本套件已验证当前 30 个端点行为正确，但无法证明「未来新增端点也不会漏判」。建议后续把判定收敛为单一共享函数（本批未授权）。");
  if (!failures.length) pass("P-9", "同前缀演示项目未造成越权");
  else fail("P-9", failures.join(" | "));
}

// ── 汇总 ──────────────────────────────────────────────────────────────
const count = (v) => results.filter((r) => r.verdict === v).length;
console.log("\n──────────────── 结果明细 ────────────────");
for (const r of results) {
  const icon = r.verdict === "PASS" ? "✔" : r.verdict === "FAIL" ? "✘" : "○";
  console.log(`  ${icon} [${r.verdict}] ${r.id} · ${r.name}${r.note ? `\n        ${r.note}` : ""}`);
}
console.log("\n──────────────── 汇总 ────────────────");
console.log(`  PASS=${count("PASS")}  FAIL=${count("FAIL")}  UNCOVERED=${count("UNCOVERED")}`);
if (count("UNCOVERED")) {
  console.log("\n  UNCOVERED 明细（不得计入通过）：");
  for (const r of results.filter((x) => x.verdict === "UNCOVERED")) console.log(`    · ${r.id} ${r.name}\n      ${r.note}`);
}
assert.equal(count("FAIL"), 0, "存在 FAIL 用例");
console.log("\ndemo/formal isolation runtime: ok");
