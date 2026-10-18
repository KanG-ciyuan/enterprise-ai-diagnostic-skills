import { cors, formalActor, httpError, idempotencyKey, json, requireAuthorizedProject, requireDecisionPacket, requireMembership } from "../../../../_shared.js";

const allowedDecisions = new Set(["continue", "revision", "pause"]);
function requiredText(value, label) { const text = String(value || "").trim(); if (!text) throw httpError(`${label}不能为空`, 422); return text; }
function requiredList(value, label) { const items = Array.isArray(value) ? value.map((entry) => String(entry || "").trim()).filter(Boolean) : []; if (!items.length) throw httpError(`${label}至少需要一项`, 422); return items; }

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    const packet = await requireDecisionPacket(env.DB, params.packetId);
    await requireMembership(env.DB, packet.project_id, current, ["owner"]);
    await requireAuthorizedProject(env.DB, packet.project_id);
    const requestKey = idempotencyKey(request) || packet.id;
    const replay = await env.DB.prepare("SELECT response_json FROM idempotency_records WHERE account_id=? AND project_id=? AND action='owner-decision' AND request_key=?").bind(current.accountId, packet.project_id, requestKey).first();
    if (replay) return json(JSON.parse(replay.response_json));
    // ── B-01/B-02: 失效结论不得继续作为决策依据 ──────────────────────────
    // A packet becomes `stale` when a fact it cites is withdrawn (evidence
    // supplement) or upgraded to high impact. The historical record is kept, but the
    // owner must not be able to take a NEW decision on a conclusion whose evidence
    // has lapsed. The message says what happened and what to do next, rather than
    // reporting a generic state conflict.
    if (packet.status === "stale") {
      return json({
        code: "decision_packet_stale",
        detail: "该决策摘要所依据的事实已被修正或撤回，原结论已失效，不能再作为决策依据。请由外部改造方基于已重新核验的事实起草新版本后再决策。",
        packetId: packet.id,
        packetVersion: Number(packet.version),
      }, 409);
    }
    if (packet.status !== "published") return json({ code: "transition_conflict", detail: "只能对已发布的决策包做决策" }, 409);
    const body = await request.json().catch(() => ({}));
    const decision = String(body.decision || "").trim();
    if (!allowedDecisions.has(decision)) return httpError("负责人决策无效", 422);
    const reason = requiredText(body.reason, "决策理由");
    const scope = requiredText(body.scope, "适用范围");
    const constraints = requiredList(body.constraints, "执行约束");
    const successMetrics = requiredList(body.successMetrics, "成功指标");
    const stopConditions = requiredList(body.stopConditions, "停止条件");
    const downstreamOwner = requiredText(body.downstreamOwner, "后续负责人");
    const refs = JSON.parse(packet.fact_refs_json || "[]");
    const builder = await env.DB.prepare("SELECT a.id,a.name FROM accounts a JOIN project_memberships m ON m.account_id=a.id WHERE m.project_id=? AND m.role='external_builder' AND m.status='active' AND a.id=?").bind(packet.project_id, packet.drafted_by_account_id).first();
    if (!builder) return httpError("原决策包的外部改造负责人当前不可用", 409);
    const decidedAt = new Date().toISOString();
    const decisionId = `DEC-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const revisionTaskId = `REV-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const transitionKey = crypto.randomUUID();
    const receipt = { decision, reason, packetId: packet.id, packetVersion: Number(packet.version), decidedAt, downstreamOwner: decision === "revision" ? (builder.name || "外部改造方") : downstreamOwner, revisionReason: decision === "revision" ? reason : null, revisionTaskId: decision === "revision" ? revisionTaskId : null };
    const response = { decision: { id: decisionId, decision, reason, scope, constraints, successMetrics, stopConditions, downstreamOwner }, receipt };
    const nextPacketStatus = decision === "revision" ? "revision_requested" : "owner_decided";
    const statements = [
      env.DB.prepare("UPDATE decision_packets SET status=?,last_transition_key=? WHERE id=? AND project_id=? AND status='published'").bind(nextPacketStatus, transitionKey, packet.id, packet.project_id),
      env.DB.prepare("INSERT INTO owner_decisions(id,packet_id,project_id,owner_account_id,decision,reason,scope,constraints_json,success_metrics_json,stop_conditions_json,downstream_owner) SELECT ?,?,?,?,?,?,?,?,?,?,? FROM decision_packets WHERE id=? AND project_id=? AND last_transition_key=?").bind(decisionId, packet.id, packet.project_id, current.accountId, decision, reason, scope, JSON.stringify(constraints), JSON.stringify(successMetrics), JSON.stringify(stopConditions), downstreamOwner, packet.id, packet.project_id, transitionKey),
    ];
    if (decision === "revision") {
      statements.push(env.DB.prepare("INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,assignee_account_id,revision_reason,revision_from_version,revision_packet_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? FROM decision_packets WHERE id=? AND project_id=? AND last_transition_key=?").bind(revisionTaskId, packet.project_id, `修订决策摘要 v${packet.version}`, reason, "decision", "revision_requested", "external_builder", builder.name || "外部改造方", 100, reason, "根据退回理由生成新版本并交核验人员重新核验", builder.id, reason, Number(packet.version), packet.id, packet.id, packet.project_id, transitionKey));
    } else if (["continue", "pause"].includes(decision)) {
      receipt.revisionTaskId = null;
      const factIds = [...new Set(refs.map((ref) => String(ref.factId || "").trim()).filter(Boolean))];
      if (factIds.length) {
        const placeholders = factIds.map(() => "?").join(",");
        const nextAction = decision === "continue" ? "负责人已同意进入影子试点，当前摸排任务关闭" : "负责人决定暂停推进，当前摸排任务关闭";
        statements.push(env.DB.prepare(`UPDATE work_items SET status='complete',blocking_reason='',next_action=? WHERE project_id=? AND id IN (SELECT work_item_id FROM candidate_facts WHERE project_id=? AND id IN (${placeholders})) AND status IN ('awaiting_decision','owner_decided') AND EXISTS (SELECT 1 FROM decision_packets WHERE id=? AND project_id=? AND last_transition_key=?)`).bind(nextAction, packet.project_id, packet.project_id, ...factIds, packet.id, packet.project_id, transitionKey));
      }
    }
    const eventType = decision === "revision" ? "revision_requested" : "owner_decision_recorded";
    const eventPayload = JSON.stringify({ reason, sourceRefs: refs.map((ref) => ref.factId), factRefs: refs, decision, scope, constraints, successMetrics, stopConditions, downstreamOwner: receipt.downstreamOwner, packetVersion: String(packet.version), packetLink: packet.id, revisionReason: receipt.revisionReason, revisionFromVersion: decision === "revision" ? Number(packet.version) : null, revisionTaskId: receipt.revisionTaskId });
    statements.push(
      env.DB.prepare("INSERT INTO events(event_id,project_id,work_item_id,type,actor_role,actor_id,payload) SELECT ?,?,?,?,?,?,? FROM decision_packets WHERE id=? AND project_id=? AND last_transition_key=?").bind(`EVT-${crypto.randomUUID()}`, packet.project_id, decision === "revision" ? revisionTaskId : null, eventType, "owner", current.accountId, eventPayload, packet.id, packet.project_id, transitionKey),
      env.DB.prepare("INSERT INTO idempotency_records(account_id,project_id,action,request_key,response_json) SELECT ?,?,'owner-decision',?,? FROM decision_packets WHERE id=? AND project_id=? AND last_transition_key=?").bind(current.accountId, packet.project_id, requestKey, JSON.stringify(response), packet.id, packet.project_id, transitionKey),
    );
    let results; let batchError = null;
    try { results = await env.DB.batch(statements); } catch (error) { batchError = error; results = [{ meta: { changes: 0 } }]; }
    if (!Number(results[0]?.meta?.changes || 0)) {
      const winner = await env.DB.prepare("SELECT response_json FROM idempotency_records WHERE account_id=? AND project_id=? AND action='owner-decision' AND request_key=?").bind(current.accountId, packet.project_id, requestKey).first();
      if (winner) return json(JSON.parse(winner.response_json));
      if (batchError) throw batchError;
      return json({ code: "transition_conflict", detail: "该决策包已由其他请求处理" }, 409);
    }
    return json(response);
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
