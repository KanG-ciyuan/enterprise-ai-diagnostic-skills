import { cors, decisionPacketPayload, formalActor, httpError, json, requireAuthorizedProject, requireDecisionPacket, requireMembership } from "../../../../_shared.js";
import { requireEligiblePacketFacts } from "../_facts.js";

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    const packet = await requireDecisionPacket(env.DB, params.packetId);
    await requireMembership(env.DB, packet.project_id, current, ["external_builder"]);
    await requireAuthorizedProject(env.DB, packet.project_id);
    if (packet.drafted_by_account_id !== current.accountId) return httpError("只能发布自己起草的决策包", 403);
    const replayRow = await env.DB.prepare("SELECT response_json FROM idempotency_records WHERE account_id=? AND project_id=? AND action='decision-packet-publish' AND request_key=?").bind(current.accountId, packet.project_id, packet.id).first();
    if (replayRow) return json(JSON.parse(replayRow.response_json));
    if (packet.status !== "verifier_checked") return json({ code: "transition_conflict", detail: "决策包尚未完成事实引用核验", packet: decisionPacketPayload(packet) }, 409);
    const refs = JSON.parse(packet.fact_refs_json || "[]");
    await requireEligiblePacketFacts(env.DB, packet.project_id, refs);
    const publishedAt = new Date().toISOString();
    const transitionKey = crypto.randomUUID();
    const eventPayload = {
      reason: "风险与影子试点建议已发布", sourceRefs: refs.map((ref) => ref.factId), factRefs: refs,
      packetVersion: String(packet.version), packetLink: packet.id, publicationStatus: "published",
      verifierId: packet.verifier_account_id, verifierRole: "verifier", verifierVersion: 1,
      verifierLink: packet.id, packetChain: [packet.id],
    };
    const response = { packet: decisionPacketPayload({ ...packet, status: "published", published_at: publishedAt }) };
    let results; let batchError = null;
    try {
      results = await env.DB.batch([
        env.DB.prepare("UPDATE decision_packets SET status='published',published_at=?,last_transition_key=? WHERE id=? AND project_id=? AND status='verifier_checked'").bind(publishedAt, transitionKey, packet.id, packet.project_id),
        env.DB.prepare("UPDATE work_items SET status='complete',blocking_reason='',next_action='负责人可审阅新版本' WHERE id=? AND project_id=? AND status='awaiting_verification' AND EXISTS (SELECT 1 FROM decision_packets WHERE id=? AND project_id=? AND last_transition_key=?)").bind(packet.revision_work_item_id || "", packet.project_id, packet.id, packet.project_id, transitionKey),
        env.DB.prepare("INSERT INTO events(event_id,project_id,work_item_id,type,actor_role,actor_id,payload) SELECT ?,project_id,?,'risk_summary_published','external_builder',?,? FROM decision_packets WHERE id=? AND project_id=? AND last_transition_key=?").bind(`EVT-${crypto.randomUUID()}`, packet.revision_work_item_id || null, current.accountId, JSON.stringify(eventPayload), packet.id, packet.project_id, transitionKey),
        env.DB.prepare("INSERT INTO idempotency_records(account_id,project_id,action,request_key,response_json) SELECT ?,?,'decision-packet-publish',?,? FROM decision_packets WHERE id=? AND project_id=? AND last_transition_key=?").bind(current.accountId, packet.project_id, packet.id, JSON.stringify(response), packet.id, packet.project_id, transitionKey),
      ]);
    } catch (error) { batchError = error; results = [{ meta: { changes: 0 } }]; }
    if (!Number(results[0]?.meta?.changes || 0)) {
      const winner = await env.DB.prepare("SELECT response_json FROM idempotency_records WHERE account_id=? AND project_id=? AND action='decision-packet-publish' AND request_key=?").bind(current.accountId, packet.project_id, packet.id).first();
      if (winner) return json(JSON.parse(winner.response_json));
      if (batchError) throw batchError;
      return json({ code: "transition_conflict", detail: "决策包已由其他发布请求处理", packet: decisionPacketPayload(await requireDecisionPacket(env.DB, packet.id)) }, 409);
    }
    return json(response);
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
