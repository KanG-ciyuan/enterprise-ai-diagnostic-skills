import { cors, formalActor, httpError, json, requireAuthorizedProject, requireMembership } from "../../../../_shared.js";
import { effectiveFactText, formalEligibleFacts, INTERNAL_FACT_LIMIT, internalEligibleFacts } from "../../decision-packets/_facts.js";

async function eligibleMaterialRefs(db, fact, role) {
  let refs = [];
  try { refs = JSON.parse(fact.source_refs_json || "[]"); } catch (_error) { refs = []; }
  if (!refs.length) return null;
  const eligible = [];
  for (const ref of refs) {
    const sql = role === "external_builder"
      ? "SELECT id,source_type FROM evidence_materials WHERE id=? AND project_id=? AND authorization_status='authorized' AND integrity_status='verified'"
      : "SELECT id,source_type FROM evidence_materials WHERE id=? AND project_id=? AND authorization_status='authorized' AND integrity_status='verified' AND (visibility='project' OR visibility=?)";
    const statement = db.prepare(sql);
    const material = role === "external_builder"
      ? await statement.bind(ref, fact.project_id).first()
      : await statement.bind(ref, fact.project_id, role).first();
    if (!material) return null;
    eligible.push({ id: material.id, sourceType: material.source_type });
  }
  return eligible;
}

/**
 * V0.2 internal draft scope (approved B): the builder may read persisted candidate facts
 * that are not formally eligible, but only the six whitelisted fields. Raw employee
 * statements, drafts, AI inference lists, material bodies and cross-project rows are
 * never selected here.
 */
async function internalFacts(db, projectId) {
  // Same range rule as generation and save: the first 30 non-formal candidates.
  const rows = await internalEligibleFacts(db, projectId, INTERNAL_FACT_LIMIT);
  return rows.map((fact) => ({
    factId: fact.id,
    claim: effectiveFactText(fact),
    status: fact.status,
    evidenceLevel: String(fact.evidence_level || "").toUpperCase() || null,
    impactLevel: fact.impact_level,
    eligible: false,
    unverified: true,
  }));
}

export async function onRequestGet({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, params.projectId, current, ["external_builder"]);
    await requireAuthorizedProject(env.DB, params.projectId);
    if (new URL(request.url).searchParams.get("scope") === "internal") {
      return json({ scope: "internal", facts: await internalFacts(env.DB, params.projectId), limit: INTERNAL_FACT_LIMIT });
    }
    const eligible = await formalEligibleFacts(env.DB, params.projectId);
    const facts = [];
    for (const [factId, fact] of eligible) {
      const sourceRefs = await eligibleMaterialRefs(env.DB, fact, current.role);
      if (!sourceRefs) continue;
      facts.push({ factId, workItemId: fact.work_item_id, claim: effectiveFactText(fact), materialStatus: fact.material_status, provenanceStatus: "supported", sourceRefs: sourceRefs.map((source) => source.id), evidenceMaterials: sourceRefs, evidenceLevel: String(fact.evidence_level || "").toUpperCase() || null, impactLevel: fact.impact_level, secondConfirmationStatus: fact.second_confirmation_status });
    }
    return json({ facts });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
