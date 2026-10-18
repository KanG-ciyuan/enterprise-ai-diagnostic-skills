import { cors, decisionPacketPayload, formalActor, httpError, json, requireAuthorizedProject, requireMembership } from "../../../../_shared.js";

export async function onRequestGet({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, params.projectId, current, ["owner"]);
    await requireAuthorizedProject(env.DB, params.projectId);
    const packet = await env.DB.prepare("SELECT * FROM decision_packets WHERE project_id=? AND status IN ('published','revision_requested','owner_decided','stale') ORDER BY version DESC LIMIT 1")
      .bind(params.projectId).first();
    if (!packet) return httpError("当前没有可供负责人审阅的已发布摘要", 404);
    const summary = decisionPacketPayload(packet);
    const refs = summary.factRefs.map((ref) => ref.factId).filter(Boolean);
    const confirmedFacts = [];
    for (const factId of refs) {
      const fact = await env.DB.prepare("SELECT id,claim,correction,material_status,verified_at,evidence_level,evidence_labeled FROM candidate_facts WHERE id=? AND project_id=? AND status='confirmed'").bind(factId, params.projectId).first();
      if (!fact) continue;
      // V0.1-01: the evidence grade travels with the fact all the way to the owner
      // view. E5 (AI inference / analyst hypothesis) must keep its label everywhere
      // it is rendered — it is never allowed to appear as a plain confirmed fact.
      const level = String(fact.evidence_level || "").toUpperCase() || null;
      confirmedFacts.push({
        factId: fact.id, claim: fact.claim, correction: fact.correction || null, decision: fact.material_status,
        confirmedAt: fact.verified_at || null,
        evidenceLevel: level,
        evidenceLevelLabel: level || "未定级",
        requiresAiLabel: level === "E5" || Number(fact.evidence_labeled || 0) === 1,
        aiLabel: (level === "E5" || Number(fact.evidence_labeled || 0) === 1) ? "AI假设，待验证" : null,
      });
    }
    const decision = await env.DB.prepare("SELECT od.*,a.name AS owner_name FROM owner_decisions od JOIN accounts a ON a.id=od.owner_account_id WHERE od.packet_id=? LIMIT 1").bind(packet.id).first();
    const decisionReceipt = decision ? { decision: decision.decision, reason: decision.reason, packetVersion: Number(packet.version), decidedAt: decision.created_at, downstreamOwner: decision.decision === "revision" ? "外部改造方" : decision.downstream_owner } : null;
    // ── B-01/B-02: 失效结论仍然可见，但必须显式告知其依据已失效 ──────────────
    // The historical decision is never hidden or rewritten. When the packet is stale,
    // the owner sees the same record plus an explicit invalidation notice, so the
    // record and its lapse are both legible.
    const isStale = packet.status === "stale";
    let invalidation = null;
    if (isStale) {
      const event = await env.DB.prepare("SELECT payload,created_at FROM events WHERE project_id=? AND type='decision_packet_staled' AND payload LIKE ? ORDER BY id DESC LIMIT 1").bind(params.projectId, `%${packet.id}%`).first();
      let reason = "所依据的事实已被修正或撤回";
      try { reason = JSON.parse(event?.payload || "{}").reason || reason; } catch (_error) { /* keep default */ }
      invalidation = { stale: true, reason, occurredAt: event?.created_at || null, notice: "本摘要所依据的事实已失效，不能继续作为决策依据；历史决策记录保留但依据已失效。" };
    }
    // Raw evidence remains behind the verifier boundary; owners receive only confirmed claims and the published summary.
    return json({ packet: { ...summary, confirmedFacts, decisionReceipt, invalidation } });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
