import { cors, decisionPacketPayload, findIdempotent, formalActor, httpError, idempotencyKey, json, requireAuthorizedProject, requireMembership } from "../../../../../_shared.js";

function requiredText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw httpError(`${label}不能为空`, 422);
  return text;
}

function requiredList(value, label) {
  const items = Array.isArray(value) ? value.map((entry) => String(entry || "").trim()).filter(Boolean) : [];
  if (!items.length) throw httpError(`${label}至少需要一项`, 422);
  return items;
}

async function confirmedFacts(db, projectId, refs) {
  if (!Array.isArray(refs) || !refs.length) throw httpError("决策包至少需要一个已确认事实", 422);
  const referencedWorkItemIds = [];
  for (const ref of refs) {
    const factId = String(ref?.factId || "").trim();
    if (!factId) throw httpError("事实引用缺少 factId", 422);
    const row = await db.prepare("SELECT work_item_id FROM candidate_facts WHERE id=? AND project_id=?").bind(factId, projectId).first();
    if (!row) throw httpError("引用事实不属于当前项目", 409);
    if (!referencedWorkItemIds.includes(row.work_item_id)) referencedWorkItemIds.push(row.work_item_id);
  }
  const placeholders = referencedWorkItemIds.map(() => "?").join(",");
  const grouped = await db.prepare(`SELECT cf.* FROM candidate_facts cf JOIN work_items wi ON wi.id=cf.work_item_id WHERE cf.project_id=? AND wi.judgment_status='confirmed' AND cf.work_item_id IN (${placeholders}) ORDER BY cf.work_item_id,cf.created_at`)
    .bind(projectId, ...referencedWorkItemIds).all();
  const groupFacts = grouped.results || [];
  if (groupFacts.some((fact) => Number(fact.required) === 1 && fact.status !== "confirmed")) throw httpError("incomplete_fact_group", 409);
  const facts = [];
  for (const fact of groupFacts.filter((entry) => entry.status === "confirmed" && ["same", "different_with_correction"].includes(entry.material_status))) {
    if (fact.impact_level === "high" && fact.second_confirmation_status !== "confirmed") throw httpError("高影响事实需要第二次确认", 409);
    // V0.1-01: keep this rule identical to decision-packets/_facts.js. draft.js carries
    // its own copy of the eligibility rules (a known duplication), so the E5 rule must
    // be enforced in both places or a draft could be built from a confirmed E5 fact that
    // publishing would later refuse.
    if (String(fact.evidence_level || "").toUpperCase() === "E5") {
      throw httpError("E5 为 AI 假设（AI假设，待验证），不得作为已核实事实进入正式结论；请补充佐证材料重新定级，或撤回该事实", 409, "e5_cannot_be_confirmed_conclusion");
    }
    let sourceRefs = [];
    try { sourceRefs = JSON.parse(fact.source_refs_json || "[]"); } catch (_error) { sourceRefs = []; }
    if (!sourceRefs.length) throw httpError("已确认事实缺少合格材料引用", 409);
    const evidenceItems = [];
    for (const sourceRef of sourceRefs) {
      const material = await db.prepare("SELECT id,version,source_type,label,authorization_status,integrity_status FROM evidence_materials WHERE id=? AND project_id=? AND authorization_status='authorized' AND integrity_status='verified'")
        .bind(sourceRef, projectId).first();
      if (!material) throw httpError("事实材料引用已失效或不再合格", 409);
      evidenceItems.push({ ...material, sourceType: material.source_type });
    }
    facts.push({ factId: fact.id, materialStatus: fact.material_status, provenanceStatus: "supported", sourceRefs, evidenceItems });
  }
  if (!facts.length) throw httpError("引用工作项组没有合格已确认事实", 409);
  return facts;
}

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, params.projectId, current, ["external_builder"]);
    await requireAuthorizedProject(env.DB, params.projectId);
    const requestKey = idempotencyKey(request).trim();
    if (!requestKey) return httpError("创建决策包草稿需要 Idempotency-Key", 422);
    const replay = await findIdempotent(env.DB, current, params.projectId, "decision-packet-draft", requestKey);
    if (replay) return json(replay, 201);
    const body = await request.json().catch(() => ({}));
    const facts = await confirmedFacts(env.DB, params.projectId, body.factRefs);
    const riskSummary = requiredText(body.riskSummary, "风险摘要");
    const pilotScope = requiredText(body.pilotScope, "试点范围");
    const constraints = requiredList(body.constraints, "试点约束");
    const successMetrics = requiredList(body.successMetrics, "成功指标");
    const stopConditions = requiredList(body.stopConditions, "停止条件");
    const downstreamOwner = requiredText(body.downstreamOwner, "后续负责人");
    const latest = await env.DB.prepare("SELECT * FROM decision_packets WHERE project_id=? ORDER BY version DESC LIMIT 1").bind(params.projectId).first();
    let revisionTask = null;
    if (latest) {
      if (latest.status !== "revision_requested") return json({ code: "transition_conflict", detail: "当前决策包尚未被负责人退回，不能生成新版本" }, 409);
      revisionTask = await env.DB.prepare("SELECT * FROM work_items WHERE project_id=? AND revision_packet_id=? AND assignee_role='external_builder' AND assignee_account_id=? AND status='revision_requested'")
        .bind(params.projectId, latest.id, current.accountId).first();
      if (!revisionTask) return json({ code: "revision_task_not_ready", detail: "当前没有可处理的退回修订任务" }, 409);
    }
    const previous = await env.DB.prepare("SELECT MAX(version) AS version FROM decision_packets WHERE project_id=?").bind(params.projectId).first();
    const packetId = `PKT-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const factRefs = facts.map(({ factId, materialStatus, provenanceStatus, sourceRefs }) => ({ factId, materialStatus, provenanceStatus, sourceRefs }));
    const version = Number(previous?.version || 0) + 1;
    const createdAt = new Date().toISOString();
    const packetRow = { id: packetId, project_id: params.projectId, version, status: "draft", drafted_by_account_id: current.accountId, verifier_account_id: null, fact_refs_json: JSON.stringify(factRefs), risk_summary: riskSummary, pilot_scope: pilotScope, constraints_json: JSON.stringify(constraints), success_metrics_json: JSON.stringify(successMetrics), stop_conditions_json: JSON.stringify(stopConditions), downstream_owner: downstreamOwner, revision_reason: revisionTask?.revision_reason || null, revision_from_version: revisionTask ? Number(latest.version) : null, revision_work_item_id: revisionTask?.id || null, created_at: createdAt };
    const response = { packet: { ...decisionPacketPayload(packetRow), evidenceItems: facts.flatMap((fact) => fact.evidenceItems) } };
    const insert = revisionTask
      ? env.DB.prepare("INSERT INTO decision_packets(id,project_id,version,status,drafted_by_account_id,fact_refs_json,risk_summary,pilot_scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner,revision_reason,revision_from_version,revision_work_item_id,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM decision_packets previous WHERE previous.id=? AND previous.project_id=? AND previous.status='revision_requested' AND EXISTS (SELECT 1 FROM work_items WHERE id=? AND project_id=? AND assignee_role='external_builder' AND assignee_account_id=? AND status='revision_requested')").bind(packetId, params.projectId, version, "draft", current.accountId, JSON.stringify(factRefs), riskSummary, pilotScope, JSON.stringify(constraints), JSON.stringify(successMetrics), JSON.stringify(stopConditions), downstreamOwner, revisionTask.revision_reason, Number(latest.version), revisionTask.id, createdAt, latest.id, params.projectId, revisionTask.id, params.projectId, current.accountId)
      : env.DB.prepare("INSERT INTO decision_packets(id,project_id,version,status,drafted_by_account_id,fact_refs_json,risk_summary,pilot_scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner,revision_reason,revision_from_version,revision_work_item_id,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM decision_packets WHERE project_id=?)").bind(packetId, params.projectId, version, "draft", current.accountId, JSON.stringify(factRefs), riskSummary, pilotScope, JSON.stringify(constraints), JSON.stringify(successMetrics), JSON.stringify(stopConditions), downstreamOwner, null, null, null, createdAt, params.projectId);
    const statements = [insert];
    if (revisionTask) statements.push(env.DB.prepare("UPDATE work_items SET status='awaiting_verification',blocking_reason='等待核验人员重新核验 v' || ?,next_action='由核验人员重新确认事实引用' WHERE id=? AND project_id=? AND status='revision_requested' AND EXISTS (SELECT 1 FROM decision_packets WHERE id=? AND project_id=?)").bind(version, revisionTask.id, params.projectId, packetId, params.projectId));
    statements.push(env.DB.prepare("INSERT INTO idempotency_records(account_id,project_id,action,request_key,response_json) SELECT ?,?,'decision-packet-draft',?,? FROM decision_packets WHERE id=? AND project_id=?").bind(current.accountId, params.projectId, requestKey, JSON.stringify(response), packetId, params.projectId));
    let results; let batchError = null;
    try { results = await env.DB.batch(statements); } catch (error) { batchError = error; results = [{ meta: { changes: 0 } }]; }
    if (!Number(results[0]?.meta?.changes || 0)) {
      const winner = await findIdempotent(env.DB, current, params.projectId, "decision-packet-draft", requestKey);
      if (winner) return json(winner, 201);
      if (batchError && !String(batchError.message || "").includes("UNIQUE constraint failed")) throw batchError;
      return json({ code: "transition_conflict", detail: "决策包草稿已由其他请求创建" }, 409);
    }
    return json(response, 201);
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
