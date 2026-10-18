import { cors, decisionPacketPayload, formalActor, httpError, json, requireAuthorizedProject, requireDecisionPacket, requireMembership } from "../../../../_shared.js";
import { packetFactIds, requireEligiblePacketFacts } from "../_facts.js";

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    const packet = await requireDecisionPacket(env.DB, params.packetId);
    await requireMembership(env.DB, packet.project_id, current, ["verifier"]);
    await requireAuthorizedProject(env.DB, packet.project_id);
    const replayRow = await env.DB.prepare("SELECT response_json FROM idempotency_records WHERE account_id=? AND project_id=? AND action='decision-packet-verify' AND request_key=?").bind(current.accountId, packet.project_id, packet.id).first();
    if (replayRow) return json(JSON.parse(replayRow.response_json));
    if (packet.status !== "draft") return json({ code: "transition_conflict", detail: "当前决策包不能再核验", packet: decisionPacketPayload(packet) }, 409);
    const body = await request.json().catch(() => ({}));
    const storedRefs = JSON.parse(packet.fact_refs_json || "[]");
    const expected = packetFactIds(storedRefs);
    const actual = packetFactIds(body.factRefs);
    if (!actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) return httpError("核验的事实引用必须与决策包一致", 422);
    await requireEligiblePacketFacts(env.DB, packet.project_id, storedRefs);
    const verifiedAt = new Date().toISOString();
    const transitionKey = crypto.randomUUID();
    const response = { packet: decisionPacketPayload({ ...packet, status: "verifier_checked", verifier_account_id: current.accountId, verified_at: verifiedAt }) };
    let results; let batchError = null;
    try {
      results = await env.DB.batch([
        env.DB.prepare("UPDATE decision_packets SET status='verifier_checked',verifier_account_id=?,verified_at=?,last_transition_key=? WHERE id=? AND project_id=? AND status='draft'").bind(current.accountId, verifiedAt, transitionKey, packet.id, packet.project_id),
        env.DB.prepare("INSERT INTO idempotency_records(account_id,project_id,action,request_key,response_json) SELECT ?,?,'decision-packet-verify',?,? FROM decision_packets WHERE id=? AND project_id=? AND last_transition_key=?").bind(current.accountId, packet.project_id, packet.id, JSON.stringify(response), packet.id, packet.project_id, transitionKey),
      ]);
    } catch (error) { batchError = error; results = [{ meta: { changes: 0 } }]; }
    if (!Number(results[0]?.meta?.changes || 0)) {
      const winner = await env.DB.prepare("SELECT response_json FROM idempotency_records WHERE account_id=? AND project_id=? AND action='decision-packet-verify' AND request_key=?").bind(current.accountId, packet.project_id, packet.id).first();
      if (winner) return json(JSON.parse(winner.response_json));
      if (batchError) throw batchError;
      return json({ code: "transition_conflict", detail: "决策包已由其他核验请求处理", packet: decisionPacketPayload(await requireDecisionPacket(env.DB, packet.id)) }, 409);
    }
    return json(response);
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
