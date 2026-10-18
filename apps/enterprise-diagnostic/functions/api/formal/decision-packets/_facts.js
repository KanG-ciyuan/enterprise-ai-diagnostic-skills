import { httpError } from "../../../_shared.js";

export function packetFactIds(refs) {
  if (!Array.isArray(refs)) return [];
  return [...new Set(refs.map((ref) => String(ref?.factId || "").trim()).filter(Boolean))].sort();
}

/**
 * B-01/B-02 — published conclusion protection.
 *
 * A decision packet snapshots `fact_refs_json` at draft time. After publication the
 * facts can change underneath it: an employee supplement resets a fact to `open`
 * (evidence-supplement.js), a verifier re-grades it, or a missed high-impact fact is
 * upgraded and re-enters second confirmation. `requireEligiblePacketFacts` only runs
 * at verify/publish time, so a published packet could keep being treated as a valid
 * basis for decisions after its evidence had been invalidated.
 *
 * These helpers find the published packets that depend on a fact and mark them
 * `stale`. They never delete or rewrite history: the packet row, its version, the
 * attached `owner_decisions` and all prior events stay exactly as they were. Only an
 * explicit invalidation marker plus an append-only event are added, so a later reader
 * can see both that a decision was made and that its basis lapsed afterwards.
 */

function safeParse(value) {
  try { return JSON.parse(value || "[]"); } catch (_error) { return []; }
}

/** Find published / verifier-checked packets in a project that reference this fact. */
export async function findInvalidatablePacketsReferencing(db, projectId, factId) {
  const key = String(factId || "").trim();
  if (!key) return [];
  const result = await db.prepare(
    "SELECT id,version,status,fact_refs_json FROM decision_packets WHERE project_id=? AND status IN ('published','verifier_checked') AND fact_refs_json LIKE ?"
  ).bind(projectId, `%${key}%`).all();
  return (result.results || []).filter((packet) => packetFactIds(safeParse(packet.fact_refs_json)).includes(key));
}

/**
 * Build the statements that mark the given packets `stale` and append one event each.
 * Idempotent: the UPDATE is guarded on the current status, and the event is guarded
 * on the resulting `last_transition_key`, so a retry cannot double-write an event.
 * Callers splice these into the same `db.batch` as the fact change that caused them.
 */
export function stalePacketStatements(db, { packets, projectId, factId, actorRole, actorId, reason }) {
  const statements = [];
  const staled = [];
  for (const packet of packets) {
    const transitionKey = `stale:${packet.id}:${factId}`;
    statements.push(
      db.prepare("UPDATE decision_packets SET status='stale',last_transition_key=? WHERE id=? AND project_id=? AND status IN ('published','verifier_checked')")
        .bind(transitionKey, packet.id, projectId)
    );
    statements.push(
      db.prepare("INSERT INTO events(event_id,project_id,type,actor_role,actor_id,payload) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM decision_packets WHERE id=? AND project_id=? AND status='stale' AND last_transition_key=?)")
        .bind(`EVT-STALE-${crypto.randomUUID()}`, projectId, "decision_packet_staled", actorRole, actorId,
          JSON.stringify({ packetId: packet.id, packetVersion: Number(packet.version), triggeringFactId: factId, reason, previousStatus: packet.status }),
          packet.id, projectId, transitionKey)
    );
    staled.push(packet.id);
  }
  return { statements, staled };
}

export async function requireEligiblePacketFacts(db, projectId, refs) {
  const ids = packetFactIds(refs);
  if (!ids.length || ids.length !== refs.length) throw httpError("决策包事实引用无效", 409);
  const placeholders = ids.map(() => "?").join(",");
  const result = await db.prepare(`SELECT * FROM candidate_facts WHERE project_id=? AND id IN (${placeholders})`).bind(projectId, ...ids).all();
  const facts = result.results || [];
  if (facts.length !== ids.length) throw httpError("决策包中的事实不存在或已跨项目", 409);
  for (const fact of facts) {
    if (fact.status !== "confirmed" || !["same", "different_with_correction"].includes(fact.material_status)) throw httpError("决策包中的事实已不再是合格确认状态", 409);
    if (fact.impact_level === "high" && fact.second_confirmation_status !== "confirmed") throw httpError("高影响事实尚未完成二次确认", 409);
    // V0.1-01: an E5 grade is a model inference or an analyst hypothesis. It may be
    // recorded and may steer further verification, but it must never stand as a
    // confirmed fact inside a formal conclusion. A confirmed E5 fact blocks the
    // packet; the resolution is to obtain corroborating evidence (raising the grade)
    // or to withdraw the fact — not to publish it with an "unverified" label.
    if (String(fact.evidence_level || "").toUpperCase() === "E5") {
      throw httpError("E5 为 AI 假设（AI假设，待验证），不得作为已核实事实进入正式结论；请补充佐证材料重新定级，或撤回该事实", 409, "e5_cannot_be_confirmed_conclusion");
    }
    let sourceRefs = [];
    try { sourceRefs = JSON.parse(fact.source_refs_json || "[]"); } catch (_error) { sourceRefs = []; }
    if (!sourceRefs.length) throw httpError("决策包事实缺少材料引用", 409);
    for (const sourceRef of sourceRefs) {
      const material = await db.prepare("SELECT 1 FROM evidence_materials WHERE id=? AND project_id=? AND authorization_status='authorized' AND integrity_status='verified'").bind(sourceRef, projectId).first();
      if (!material) throw httpError("决策包事实的材料已不再合格", 409);
    }
  }
  return facts;
}
