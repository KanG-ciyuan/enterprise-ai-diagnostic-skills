import { cors, decisionPacketPayload, formalActor, httpError, json, requireAuthorizedProject, requireMembership } from "../../../../_shared.js";
import { effectiveFactText, parseSuggestions, verifierCanReadFact } from "../../decision-packets/_facts.js";

export async function onRequestGet({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    const internal = new URL(request.url).searchParams.get("scope") === "internal";
    // V0.2: the builder needs to re-open an internal draft after a refresh; nobody else may.
    await requireMembership(env.DB, params.projectId, current, internal ? ["external_builder"] : ["external_builder", "verifier"]);
    await requireAuthorizedProject(env.DB, params.projectId);
    const packet = await env.DB.prepare(internal
      ? "SELECT * FROM decision_packets WHERE project_id=? AND status='internal_draft' ORDER BY version DESC LIMIT 1"
      : "SELECT * FROM decision_packets WHERE project_id=? AND status!='internal_draft' ORDER BY version DESC LIMIT 1")
      .bind(params.projectId).first();
    // Select the newest formal version before checking whether it needs action.
    // Otherwise a finished v2 resurrects a returned v1 as a current task.
    const pendingStatuses = current.role === "verifier" ? ["draft"] : ["draft", "verifier_checked", "revision_requested", "stale"];
    if (!packet || (!internal && !pendingStatuses.includes(packet.status))) return httpError("当前没有待处理的决策包", 404);
    const payload = { packet: decisionPacketPayload(packet) };
    // Verifiers must be able to read the effective text and the eligible materials they
    // are confirming, not only IDs. This stays inside the packet read they already have.
    const envelope = parseSuggestions(packet.suggestions_json);
    if (envelope.items.length) {
      const factIds = [...new Set(envelope.items.flatMap((item) => item.factIds || []))];
      if (factIds.length) {
        const rows = await env.DB.prepare(`SELECT id,claim,correction,material_status,status,evidence_level,impact_level,second_confirmation_status,source_refs_json FROM candidate_facts WHERE project_id=? AND id IN (${factIds.map(() => "?").join(",")})`).bind(params.projectId, ...factIds).all();
        const rowsById = new Map((rows.results || []).map((fact) => [fact.id, fact]));
        const details = [];
        const readableIds = new Set();
        for (const factId of factIds) {
          const fact = rowsById.get(factId);
          if (!fact) {
            details.push({ factId, restricted: true, note: "该事实已不存在或不可访问，不能在此查看。" });
            continue;
          }
          if (current.role === "verifier" && !(await verifierCanReadFact(env.DB, params.projectId, current.accountId, fact.id))) {
            details.push({ factId: fact.id, restricted: true, note: "该事实引用了未分配给你的任务或不可见材料，不能在此查看。" });
            continue;
          }
          let refs = [];
          try { refs = JSON.parse(fact.source_refs_json || "[]"); } catch (_error) { refs = []; }
          const materials = [];
          for (const ref of refs) {
            const material = await env.DB.prepare("SELECT id,label,version,source_type,authorization_status,integrity_status FROM evidence_materials WHERE id=? AND project_id=?").bind(ref, params.projectId).first();
            if (material) materials.push({ materialId: material.id, label: material.label, version: material.version, sourceType: material.source_type, authorizationStatus: material.authorization_status, integrityStatus: material.integrity_status });
          }
          readableIds.add(fact.id);
          details.push({ factId: fact.id, claim: fact.claim, effectiveText: effectiveFactText(fact), correction: fact.correction || null, status: fact.status, materialStatus: fact.material_status, evidenceLevel: String(fact.evidence_level || "").toUpperCase() || null, impactLevel: fact.impact_level, secondConfirmationStatus: fact.second_confirmation_status, materials });
        }
        payload.packet.suggestionFacts = details;
        // The suggestion envelope carries a snapshot of each fact's text. For a fact the
        // verifier may not read (or that no longer exists), that snapshot is exactly the
        // private content the suggestionFacts projection is hiding, so it must be
        // redacted as well.
        const restrictedIds = new Set(factIds.filter((factId) => !readableIds.has(factId)));
        if (restrictedIds.size) {
          payload.packet.factRefs = payload.packet.factRefs.map((ref) => restrictedIds.has(ref.factId) ? { factId: ref.factId, restricted: true } : ref);
          payload.packet.suggestions = payload.packet.suggestions.map((item) => ({
            ...item,
            ...(item.factIds.some((id) => restrictedIds.has(id)) ? {
              restricted: true, problem: "该建议的部分依据不可访问", opportunity: "", priorityReason: "", pendingConditions: [],
            } : {}),
            evidence: (item.evidence || []).map((entry) => restrictedIds.has(entry.factId) ? { ...entry, text: null, redacted: true } : entry),
          }));
        }
      }
    }
    return json(payload);
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
