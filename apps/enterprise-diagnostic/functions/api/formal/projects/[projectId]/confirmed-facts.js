import { cors, formalActor, httpError, json, requireAuthorizedProject, requireMembership } from "../../../../_shared.js";

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

export async function onRequestGet({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, params.projectId, current, ["external_builder"]);
    await requireAuthorizedProject(env.DB, params.projectId);
    const result = await env.DB.prepare("SELECT cf.*,wi.title FROM candidate_facts cf JOIN work_items wi ON wi.id=cf.work_item_id WHERE cf.project_id=? AND wi.judgment_status='confirmed' AND cf.status='confirmed' AND cf.material_status IN ('same','different_with_correction') AND (cf.impact_level!='high' OR cf.second_confirmation_status='confirmed') AND NOT EXISTS (SELECT 1 FROM candidate_facts dependent WHERE dependent.work_item_id=cf.work_item_id AND dependent.required=1 AND dependent.status!='confirmed') ORDER BY cf.work_item_id,cf.created_at").bind(params.projectId).all();
    const facts = [];
    for (const fact of result.results || []) {
      const sourceRefs = await eligibleMaterialRefs(env.DB, fact, current.role);
      if (!sourceRefs) continue;
      facts.push({ factId: fact.id, workItemId: fact.work_item_id, title: fact.title, claim: fact.claim, materialStatus: fact.material_status, provenanceStatus: "supported", sourceRefs: sourceRefs.map((source) => source.id), evidenceMaterials: sourceRefs, impactLevel: fact.impact_level, secondConfirmationStatus: fact.second_confirmation_status });
    }
    return json({ facts });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
