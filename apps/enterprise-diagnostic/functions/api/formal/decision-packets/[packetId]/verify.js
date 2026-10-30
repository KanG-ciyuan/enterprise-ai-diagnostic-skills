import { cors, decisionPacketPayload, formalActor, httpError, json, requireAuthorizedProject, requireDecisionPacket, requireMembership } from "../../../../_shared.js";
import { packetFactIds, parseSuggestions, requireEligiblePacketFacts, requireSuggestionBasisCurrent, requireSuggestionFacts, suggestionFactIds, verifierPacketGuard } from "../_facts.js";

async function replayVerification(db, packet, current, replayRow) {
  if (packet.status === "stale") return json({ code: "decision_packet_stale", detail: "该决策包的依据已失效，历史核验回执保留，但当前不能再作为有效核验结果。" }, 409);
  const suggestions = parseSuggestions(packet.suggestions_json);
  if (suggestions.items.length) {
    await verifierPacketGuard(db, packet.project_id, current.accountId, JSON.parse(packet.fact_refs_json || "[]"));
    await requireSuggestionBasisCurrent(db, packet.project_id, packet);
  }
  const contentKey = String(suggestions.revision ?? 0);
  const replay = JSON.parse(replayRow.response_json);
  if (replay?.contentKey !== undefined && replay.contentKey !== contentKey) {
    return json({ code: "suggestion_revision_changed", detail: "建议内容已修改，请刷新后重新核验。" }, 409);
  }
  return json({ ...replay, packet: decisionPacketPayload(packet) });
}

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    const packet = await requireDecisionPacket(env.DB, params.packetId);
    await requireMembership(env.DB, packet.project_id, current, ["verifier"]);
    await requireAuthorizedProject(env.DB, packet.project_id);
    if (packet.status === "internal_draft") return json({ code: "internal_draft_not_verifiable", detail: "内部待核实初稿不能进入正式核验" }, 409);
    const contentKey = String(parseSuggestions(packet.suggestions_json).revision ?? 0);
    const replayRow = await env.DB.prepare("SELECT response_json FROM idempotency_records WHERE account_id=? AND project_id=? AND action='decision-packet-verify' AND request_key=?").bind(current.accountId, packet.project_id, packet.id).first();
    if (replayRow) return await replayVerification(env.DB, packet, current, replayRow);
    // A caller without internal-draft read permission must not receive its content in
    // the rejection body. Only a code and the safe next step are returned.
    if (packet.status === "internal_draft") return json({ code: "internal_draft_not_verifiable", detail: "内部待核实初稿不能进入正式核验" }, 409);
    if (packet.status !== "draft") return json({ code: "transition_conflict", detail: "当前决策包不能再核验" }, 409);
    const body = await request.json().catch(() => ({}));
    const storedRefs = JSON.parse(packet.fact_refs_json || "[]");
    const expected = packetFactIds(storedRefs);
    const actual = packetFactIds(body.factRefs);
    if (!actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) return httpError("核验的事实引用必须与决策包一致", 422);
    const suggestions = parseSuggestions(packet.suggestions_json);
    let writeGuard = { sql: "1", values: [] };
    if (suggestions.items.length) {
      // The verifier must confirm the revision they actually saw, not merely the refs.
      // A missing marker means an old screen that cannot have seen the current content.
      const rawKey = body.contentKey;
      const submittedKey = rawKey === undefined || rawKey === null || String(rawKey).trim() === "" ? null : String(rawKey);
      if (submittedKey === null) return json({ code: "content_key_required", detail: "核验建议必须携带你看到的内容修订标识，请刷新后重新核验。" }, 422);
      if (submittedKey !== contentKey) return json({ code: "suggestion_revision_changed", detail: "建议内容已在你查看后修改，请刷新后重新核验。" }, 409);
      // every referenced fact must still be eligible. A single bad reference rejects the
      // whole packet rather than silently dropping it.
      const suggested = suggestionFactIds(suggestions);
      if (JSON.stringify(suggested) !== JSON.stringify(expected)) return httpError("建议引用并集与决策包事实引用不一致", 409, "suggestion_refs_mismatch");
      // Eligibility is checked before the access boundary so an ineligible fact reports
      // its real rule (409) rather than masquerading as an assignment problem.
      await requireSuggestionFacts(env.DB, packet.project_id, suggestions);
      // A verifier may only confirm references whose facts/materials they may actually read.
      writeGuard = await verifierPacketGuard(env.DB, packet.project_id, current.accountId, storedRefs);
      await requireSuggestionBasisCurrent(env.DB, packet.project_id, packet);
    }
    await requireEligiblePacketFacts(env.DB, packet.project_id, storedRefs);
    const verifiedAt = new Date().toISOString();
    const transitionKey = crypto.randomUUID();
    const response = { packet: decisionPacketPayload({ ...packet, status: "verifier_checked", verifier_account_id: current.accountId, verified_at: verifiedAt }), contentKey };
    let results; let batchError = null;
    try {
      results = await env.DB.batch([
        env.DB.prepare(`UPDATE decision_packets SET status='verifier_checked',verifier_account_id=?,verified_at=?,last_transition_key=? WHERE id=? AND project_id=? AND status='draft' AND last_transition_key IS ? AND (${writeGuard.sql})`).bind(current.accountId, verifiedAt, transitionKey, packet.id, packet.project_id, packet.last_transition_key || null, ...writeGuard.values),
        env.DB.prepare("INSERT INTO idempotency_records(account_id,project_id,action,request_key,response_json) SELECT ?,?,'decision-packet-verify',?,? FROM decision_packets WHERE id=? AND project_id=? AND last_transition_key=?").bind(current.accountId, packet.project_id, packet.id, JSON.stringify(response), packet.id, packet.project_id, transitionKey),
      ]);
    } catch (error) { batchError = error; results = [{ meta: { changes: 0 } }]; }
    if (!Number(results[0]?.meta?.changes || 0)) {
      const winner = await env.DB.prepare("SELECT response_json FROM idempotency_records WHERE account_id=? AND project_id=? AND action='decision-packet-verify' AND request_key=?").bind(current.accountId, packet.project_id, packet.id).first();
      if (winner) return await replayVerification(env.DB, await requireDecisionPacket(env.DB, packet.id), current, winner);
      if (batchError) throw batchError;
      // A content revision that landed between this read and the write is a different
      // conclusion, not a generic state conflict. Say so, so the verifier knows to
      // reload instead of retrying the same refs against unseen content.
      const latest = await requireDecisionPacket(env.DB, packet.id);
      if ((latest.last_transition_key || null) !== (packet.last_transition_key || null) || parseSuggestions(latest.suggestions_json).items.length !== parseSuggestions(packet.suggestions_json).items.length) {
        return json({ code: "suggestion_revision_changed", detail: "建议内容已在你查看后修改，请刷新后重新核验。" }, 409);
      }
      return json({ code: "transition_conflict", detail: "决策包、事实依据或核验责任已变化，请刷新后重新核验。" }, 409);
    }
    return json(response);
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
