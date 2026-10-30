import { appendEvent, cors, decisionPacketPayload, findIdempotent, formalActor, httpError, idempotencyKey, json, requireAuthorizedProject, requireDecisionPacket, requireMembership } from "../../../../../_shared.js";
import { effectiveFactText, factsBasisDigest, formalEligibleFacts, internalEligibleFacts, INTERNAL_FACT_LIMIT, normalizeSuggestions, parseSuggestions, suggestionFactIds, suggestionEvidence, suggestionsContentHash } from "../../../decision-packets/_facts.js";

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

async function pendingRecoveryTask(db, projectId, latest, accountId) {
  // A recovery may itself become stale before publishing. Follow the predecessor
  // chain so the original owner revision survives every recovery, including old rows
  // whose immediate predecessor omitted revision_work_item_id.
  const rows = await db.prepare(`WITH RECURSIVE packet_chain AS (
    SELECT id,version,revision_from_version,revision_work_item_id FROM decision_packets WHERE id=? AND project_id=?
    UNION ALL
    SELECT p.id,p.version,p.revision_from_version,p.revision_work_item_id FROM decision_packets p
    JOIN packet_chain child ON p.version=child.revision_from_version
    WHERE p.project_id=? AND p.version<child.version
  ) SELECT DISTINCT wi.* FROM work_items wi JOIN packet_chain p
    ON wi.id=p.revision_work_item_id OR wi.revision_packet_id=p.id
    WHERE wi.project_id=? AND wi.assignee_role='external_builder'
      AND wi.status IN ('revision_requested','awaiting_verification')`)
    .bind(latest.id, projectId, projectId, projectId).all();
  const tasks = rows.results || [];
  if (tasks.length > 1) throw httpError("该版本链有多个未完成修订任务，请先核对责任。", 409, "revision_task_conflict");
  const task = tasks[0] || null;
  if (task && task.assignee_account_id !== accountId) throw httpError("该版本的退回修订任务属于其他改造方账号，请先重新分配后再处理。", 409, "revision_task_not_ready");
  return task;
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

/**
 * V0.2: content review is an explicit action, never a side effect of saving. The hash
 * binds the review to the exact suggestion items; any later edit makes it invalid.
 */
async function reviewSuggestionContent(env, params, current, body) {
  const packetId = String(body.packetId || "").trim();
  if (!packetId) throw httpError("内容审核需要 packetId", 422);
  const packet = await requireDecisionPacket(env.DB, packetId);
  if (packet.project_id !== params.projectId) throw httpError("决策包不属于当前项目", 404);
  if (packet.drafted_by_account_id !== current.accountId) throw httpError("只能审核自己起草的建议", 403);
  if (!["draft", "verifier_checked"].includes(packet.status)) throw httpError("只有未发布的决策包可以执行内容审核", 409, "content_review_status_invalid");
  const envelope = parseSuggestions(packet.suggestions_json);
  if (!envelope.items.length) throw httpError("决策包没有可审核的建议", 422, "no_suggestions");
  // Content review must bind to the exact revision the reviewer saw. Without it an old
  // page could approve a newer suggestion set that it never rendered.
  const contentKey = String(envelope.revision ?? 0);
  const rawKey = body.contentKey;
  const submittedKey = rawKey === undefined || rawKey === null || String(rawKey).trim() === "" ? null : String(rawKey);
  if (submittedKey === null) return json({ code: "content_key_required", detail: "内容审核必须携带你看到的建议内容修订标识，请刷新后重试。" }, 422);
  if (submittedKey !== contentKey) return json({ code: "suggestion_revision_changed", detail: "建议内容已在你查看后修改，旧审核不能用于当前版本，请刷新后重新审核。" }, 409);
  const contentHash = await suggestionsContentHash(envelope.items);
  const reviewedAt = new Date().toISOString();
  const review = { reviewedBy: current.accountId, reviewedAt, contentHash };
  // Only the review field is written. The items are never round-tripped from an earlier
  // read, so an old review cannot overwrite a newer saved suggestion set.
  const result = await env.DB.prepare("UPDATE decision_packets SET suggestions_json=json_set(suggestions_json,'$.contentReview',json(?)) WHERE id=? AND project_id=? AND status IN ('draft','verifier_checked') AND last_transition_key IS ? AND version=?")
    .bind(JSON.stringify(review), packetId, params.projectId, packet.last_transition_key || null, Number(body.baseVersion || packet.version)).run();
  if (!Number(result.meta?.changes || 0)) return json({ code: "transition_conflict", detail: "决策包已变化，请刷新后重试" }, 409);
  await appendEvent(env.DB, params.projectId, null, "decision_packet_content_reviewed", current, { packetId, packetVersion: Number(packet.version), contentHash });
  return json({ packet: decisionPacketPayload({ ...packet, suggestions_json: JSON.stringify({ ...envelope, contentReview: review }) }), contentReview: review });
}

/**
 * V0.2 correction path: replace the suggestion set of an unreleased package. The
 * previous content review is dropped because the envelope is rebuilt with
 * `contentReview: null`; verification can only happen after this save.
 */
async function updateSavedSuggestions(env, params, current, body) {
  const packetId = String(body.packetId || "").trim();
  if (!packetId) throw httpError("修改建议需要 packetId", 422);
  const packet = await requireDecisionPacket(env.DB, packetId);
  if (packet.project_id !== params.projectId) throw httpError("决策包不属于当前项目", 404);
  if (packet.drafted_by_account_id !== current.accountId) throw httpError("只能修改自己起草的建议", 403);
  if (!["draft", "internal_draft", "verifier_checked"].includes(packet.status)) throw httpError("已发布的建议不能再修改，请重新起草新版本", 409, "suggestions_locked");
  const existing = parseSuggestions(packet.suggestions_json);
  // A stale page must not overwrite a newer suggestion set: the request carries the
  // revision it rendered, and a mismatch means the user is editing content they never saw.
  const existingContentKey = String(existing.revision ?? 0);
  const rawKey = body.contentKey;
  const submittedKey = rawKey === undefined || rawKey === null || String(rawKey).trim() === "" ? null : String(rawKey);
  if (submittedKey === null) return json({ code: "content_key_required", detail: "修改建议必须携带你看到的建议内容修订标识，请刷新后重试。" }, 422);
  if (submittedKey !== existingContentKey) return json({ code: "suggestion_revision_changed", detail: "建议内容已在你查看后修改，旧页面不能覆盖新版本，请刷新后重试。" }, 409);
  const draftKind = body.draftKind === "internal" ? "internal" : (existing.draftKind || "formal");
  if (draftKind !== (existing.draftKind || "formal")) throw httpError("不能在正式稿与内部稿之间直接切换", 409, "suggestion_kind_change");
  const built = await buildSuggestionEnvelope(env, params, current, { suggestions: body.suggestions, draftKind, basisDigest: body.basisDigest });
  // Content revision marker: stable across review/verify/publish, incremented only when
  // the suggestion set itself changes. Verifiers bind to this value, so an old screen
  // cannot be used to confirm newer content, while a legitimate replay still matches.
  built.envelope.revision = Number(existing.revision ?? 0) + 1;
  const expectedStatus = draftKind === "internal" ? "internal_draft" : "draft";
  const transitionKey = `suggestions-revised:${packetId}:${crypto.randomUUID()}`;
  // Content revision is a compare-and-swap on the package's transition marker: an
  // in-flight verify or content review holding the previous marker must lose.
  // A revised suggestion set is a new conclusion. The previous verification receipt is
  // a cached response for the old content and must not block (or replay) the verifier's
  // new check; the fact-level audit rows and events remain untouched.
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE decision_packets SET status=?,verifier_account_id=NULL,verified_at=NULL,suggestions_json=?,fact_refs_json=?,last_transition_key=? WHERE id=? AND project_id=? AND status IN ('draft','internal_draft','verifier_checked') AND last_transition_key IS ? AND version=?")
      .bind(expectedStatus, JSON.stringify(built.envelope), JSON.stringify(built.refs), transitionKey, packetId, params.projectId, packet.last_transition_key || null, Number(body.baseVersion || packet.version)),
    env.DB.prepare("DELETE FROM idempotency_records WHERE project_id=? AND action='decision-packet-verify' AND request_key=? AND EXISTS (SELECT 1 FROM decision_packets WHERE id=? AND project_id=? AND last_transition_key=?)")
      .bind(params.projectId, packetId, packetId, params.projectId, transitionKey),
    env.DB.prepare("INSERT INTO events(event_id,project_id,type,actor_role,actor_id,payload) SELECT ?,project_id,'decision_packet_suggestions_revised',?,?,? FROM decision_packets WHERE id=? AND project_id=? AND last_transition_key=?")
      .bind(`EVT-${crypto.randomUUID()}`, current.role, current.accountId, JSON.stringify({ packetId, packetVersion: Number(packet.version), count: built.envelope.items.length }), packetId, params.projectId, transitionKey),
  ]);
  if (!Number(results[0]?.meta?.changes || 0)) return json({ code: "transition_conflict", detail: "决策包已变化，请刷新后重试" }, 409);
  return json({ packet: decisionPacketPayload({ ...packet, status: expectedStatus, verifier_account_id: null, verified_at: null, suggestions_json: JSON.stringify(built.envelope), fact_refs_json: JSON.stringify(built.refs), last_transition_key: transitionKey }) });
}

/** Turn model output into the server-owned envelope: ids, evidence snapshots, unverified flag. */
async function buildSuggestionEnvelope(env, params, current, body) {
  const draftKind = body.draftKind === "internal" ? "internal" : "formal";
  const normalized = normalizeSuggestions(body.suggestions, { requirePending: draftKind === "internal" });
  const formal = await formalEligibleFacts(env.DB, params.projectId);
  const factMap = new Map();
  let basisFacts;
  if (draftKind === "internal") {
    // An internal draft may mix verified and unverified facts, but at least one reference
    // must be unverified; otherwise it is a formal draft in disguise.
    for (const [id, fact] of formal) factMap.set(id, { ...fact, eligible: true });
    const rows = await internalEligibleFacts(env.DB, params.projectId, INTERNAL_FACT_LIMIT, formal);
    basisFacts = rows;
    for (const row of rows) {
      if (!formal.has(row.id)) factMap.set(row.id, { ...row, eligible: false });
    }
    for (const item of normalized) {
      for (const factId of item.factIds) {
        if (!factMap.has(factId)) throw httpError("建议引用了不允许或不存在的事实", 409, "suggestion_fact_not_internal");
      }
    }
    const unverifiedItems = normalized.filter((item) => item.factIds.some((factId) => !formal.has(factId)));
    if (!unverifiedItems.length) throw httpError("内部初稿必须引用至少一条未核实事实", 422, "internal_requires_unverified");
  } else {
    for (const [id, fact] of formal) factMap.set(id, { ...fact, eligible: true });
    basisFacts = [...formal.values()];
    for (const item of normalized) {
      for (const factId of item.factIds) {
        if (!factMap.has(factId)) throw httpError("建议引用了不合格或不存在的事实", 409, "suggestion_fact_not_eligible");
      }
    }
  }
  // A preview is only valid for the exact fact basis the model saw.
  const currentDigest = await factsBasisDigest(basisFacts);
  const supplied = String(body.basisDigest || "").trim();
  if (!supplied) throw httpError("保存建议需要携带生成时的依据摘要", 422, "basis_digest_required");
  if (supplied !== currentDigest) throw httpError("事实已在你生成预览后变化，旧预览不能保存；请重新生成。", 409, "preview_basis_changed");
  const items = suggestionEvidence(normalized, factMap).map((item) => ({
    ...item,
    id: `SUG-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`,
    unverified: draftKind === "internal" || item.evidence.some((entry) => !entry.eligible),
  }));
  const refs = suggestionFactIds({ items }).map((factId) => ({
    factId,
    materialStatus: factMap.get(factId)?.material_status || "unverified",
    provenanceStatus: draftKind === "internal" ? "unverified" : "supported",
    sourceRefs: [],
  }));
  return {
    status: draftKind === "internal" ? "internal_draft" : "draft",
    refs,
    envelope: { schemaVersion: 1, draftKind, revision: 0, basisDigest: currentDigest, generatedBy: current.accountId, createdAt: new Date().toISOString(), contentReview: null, items },
  };
}

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, params.projectId, current, ["external_builder"]);
    await requireAuthorizedProject(env.DB, params.projectId);
    const body = await request.json().catch(() => ({}));
    if (body.action === "content_review") return await reviewSuggestionContent(env, params, current, body);
    if (body.action === "update_suggestions") return await updateSavedSuggestions(env, params, current, body);
    const requestKey = idempotencyKey(request).trim();
    if (!requestKey) return httpError("创建决策包草稿需要 Idempotency-Key", 422);
    const replay = await findIdempotent(env.DB, current, params.projectId, "decision-packet-draft", requestKey);
    if (replay) return json(replay, 201);
    const built = Array.isArray(body.suggestions) && body.suggestions.length
      ? await buildSuggestionEnvelope(env, params, current, body)
      : null;
    const facts = built ? [] : await confirmedFacts(env.DB, params.projectId, body.factRefs);
    const riskSummary = requiredText(body.riskSummary, "风险摘要");
    const pilotScope = requiredText(body.pilotScope, "试点范围");
    const constraints = requiredList(body.constraints, "试点约束");
    const successMetrics = requiredList(body.successMetrics, "成功指标");
    const stopConditions = requiredList(body.stopConditions, "停止条件");
    const downstreamOwner = requiredText(body.downstreamOwner, "后续负责人");
    const latest = await env.DB.prepare("SELECT * FROM decision_packets WHERE project_id=? AND status!='internal_draft' ORDER BY version DESC LIMIT 1").bind(params.projectId).first();
    let revisionTask = null;
    const internal = built?.status === "internal_draft";
    const staleRecovery = latest?.status === "stale";
    const previousHadSuggestions = Boolean(latest) && parseSuggestions(latest.suggestions_json).items.length > 0;
    if (latest && !internal && !staleRecovery) {
      if (latest.status !== "revision_requested") return json({ code: "transition_conflict", detail: "当前决策包尚未被负责人退回，不能生成新版本" }, 409);
      revisionTask = await env.DB.prepare("SELECT * FROM work_items WHERE project_id=? AND revision_packet_id=? AND assignee_role='external_builder' AND assignee_account_id=? AND status='revision_requested'")
        .bind(params.projectId, latest.id, current.accountId).first();
      if (!revisionTask) return json({ code: "revision_task_not_ready", detail: "当前没有可处理的退回修订任务" }, 409);
      // The owner asked for changes; dropping the AI suggestions silently would hide
      // part of what was rejected. A revision must carry a freshly generated set.
      if (previousHadSuggestions && !built) return json({ code: "revision_requires_suggestions", detail: "负责人退回的版本包含诊断建议，请重新生成或在表单中保留后再提交修订" }, 422);
      if (built?.status === "internal_draft") return json({ code: "revision_requires_formal", detail: "修订版本必须是正式诊断建议" }, 409);
    } else if (latest && !internal && staleRecovery) {
      // Recovery is a re-draft of the same conclusion, not a shortcut around review.
      // Losing the suggestions here would let an empty conclusion be verified and
      // published, so the same "must carry a new set" rule applies to stale packets.
      if (previousHadSuggestions && !built) return json({ code: "revision_requires_suggestions", detail: "原诊断包包含诊断建议，重新起草请重新生成或在表单中保留后再提交" }, 422);
      // A pending owner revision survives the invalidation. Carry the task, its reason
      // and its completion path into the new version instead of leaving it hanging.
      revisionTask = await pendingRecoveryTask(env.DB, params.projectId, latest, current.accountId);
    }
    const previous = await env.DB.prepare("SELECT MAX(version) AS version FROM decision_packets WHERE project_id=?").bind(params.projectId).first();
    const packetId = `PKT-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const factRefs = built ? built.refs : facts.map(({ factId, materialStatus, provenanceStatus, sourceRefs }) => ({ factId, materialStatus, provenanceStatus, sourceRefs }));
    const suggestionsJson = built ? JSON.stringify(built.envelope) : "[]";
    const version = Number(previous?.version || 0) + 1;
    const createdAt = new Date().toISOString();
    const revisionReason = revisionTask?.revision_reason || (staleRecovery ? (latest.revision_reason || "依据失效后重新起草") : null);
    const packetRow = { id: packetId, project_id: params.projectId, version, status: built?.status || "draft", drafted_by_account_id: current.accountId, verifier_account_id: null, fact_refs_json: JSON.stringify(factRefs), suggestions_json: suggestionsJson, risk_summary: riskSummary, pilot_scope: pilotScope, constraints_json: JSON.stringify(constraints), success_metrics_json: JSON.stringify(successMetrics), stop_conditions_json: JSON.stringify(stopConditions), downstream_owner: downstreamOwner, revision_reason: revisionReason, revision_from_version: revisionTask ? Number(latest.version) : (staleRecovery ? Number(latest.version) : null), revision_work_item_id: revisionTask?.id || null, created_at: createdAt };
    const response = { packet: { ...decisionPacketPayload(packetRow), evidenceItems: facts.flatMap((fact) => fact.evidenceItems) } };
    // Whole-chain guard: a stale recovery may only succeed while the predecessor it was
    // computed from is still the newest stale version. Without the "no successor"
    // condition, two requests that both saw v1 stale could each create and publish a
    // successor (v2 and v3), and the database's version uniqueness cannot stop them.
    const taskGuard = revisionTask ? { sql: "EXISTS (SELECT 1 FROM work_items WHERE id=? AND project_id=? AND assignee_role='external_builder' AND assignee_account_id=? AND status=?)", values: [revisionTask.id, params.projectId, current.accountId, revisionTask.status] } : { sql: "1", values: [] };
    const insert = staleRecovery && !internal
      ? env.DB.prepare(`INSERT INTO decision_packets(id,project_id,version,status,drafted_by_account_id,fact_refs_json,suggestions_json,risk_summary,pilot_scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner,revision_reason,revision_from_version,revision_work_item_id,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM decision_packets previous WHERE previous.id=? AND previous.project_id=? AND previous.status='stale' AND NOT EXISTS (SELECT 1 FROM decision_packets successor WHERE successor.project_id=previous.project_id AND successor.status!='internal_draft' AND successor.version>previous.version) AND (${taskGuard.sql})`).bind(packetId, params.projectId, version, "draft", current.accountId, JSON.stringify(factRefs), suggestionsJson, riskSummary, pilotScope, JSON.stringify(constraints), JSON.stringify(successMetrics), JSON.stringify(stopConditions), downstreamOwner, revisionReason, Number(latest.version), revisionTask?.id || null, createdAt, latest.id, params.projectId, ...taskGuard.values)
      : revisionTask
        ? env.DB.prepare("INSERT INTO decision_packets(id,project_id,version,status,drafted_by_account_id,fact_refs_json,suggestions_json,risk_summary,pilot_scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner,revision_reason,revision_from_version,revision_work_item_id,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM decision_packets previous WHERE previous.id=? AND previous.project_id=? AND previous.status='revision_requested' AND EXISTS (SELECT 1 FROM work_items WHERE id=? AND project_id=? AND assignee_role='external_builder' AND assignee_account_id=? AND status='revision_requested')").bind(packetId, params.projectId, version, "draft", current.accountId, JSON.stringify(factRefs), suggestionsJson, riskSummary, pilotScope, JSON.stringify(constraints), JSON.stringify(successMetrics), JSON.stringify(stopConditions), downstreamOwner, revisionTask.revision_reason, Number(latest.version), revisionTask.id, createdAt, latest.id, params.projectId, revisionTask.id, params.projectId, current.accountId)
        : internal
          ? env.DB.prepare("INSERT INTO decision_packets(id,project_id,version,status,drafted_by_account_id,fact_refs_json,suggestions_json,risk_summary,pilot_scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner,revision_reason,revision_from_version,revision_work_item_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?)").bind(packetId, params.projectId, version, "internal_draft", current.accountId, JSON.stringify(factRefs), suggestionsJson, riskSummary, pilotScope, JSON.stringify(constraints), JSON.stringify(successMetrics), JSON.stringify(stopConditions), downstreamOwner, createdAt)
          : env.DB.prepare("INSERT INTO decision_packets(id,project_id,version,status,drafted_by_account_id,fact_refs_json,suggestions_json,risk_summary,pilot_scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner,revision_reason,revision_from_version,revision_work_item_id,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM decision_packets WHERE project_id=? AND status!='internal_draft')").bind(packetId, params.projectId, version, "draft", current.accountId, JSON.stringify(factRefs), suggestionsJson, riskSummary, pilotScope, JSON.stringify(constraints), JSON.stringify(successMetrics), JSON.stringify(stopConditions), downstreamOwner, null, null, null, createdAt, params.projectId);
    const statements = [insert];
    if (revisionTask) statements.push(env.DB.prepare("UPDATE work_items SET status='awaiting_verification',blocking_reason='等待核验人员重新核验 v' || ?,next_action='由核验人员重新确认事实引用' WHERE id=? AND project_id=? AND status IN ('revision_requested','awaiting_verification') AND EXISTS (SELECT 1 FROM decision_packets WHERE id=? AND project_id=?)").bind(version, revisionTask.id, params.projectId, packetId, params.projectId));
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
