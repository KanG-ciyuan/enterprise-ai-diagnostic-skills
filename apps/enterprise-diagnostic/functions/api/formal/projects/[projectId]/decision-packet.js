import { cors, decisionPacketPayload, formalActor, httpError, json, requireAuthorizedProject, requireMembership } from "../../../../_shared.js";

export async function onRequestGet({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, params.projectId, current, ["external_builder", "verifier"]);
    await requireAuthorizedProject(env.DB, params.projectId);
    const packet = await env.DB.prepare("SELECT * FROM decision_packets WHERE project_id=? AND status IN ('draft','verifier_checked','revision_requested') ORDER BY version DESC LIMIT 1")
      .bind(params.projectId).first();
    if (!packet) return httpError("当前没有待处理的决策包", 404);
    return json({ packet: decisionPacketPayload(packet) });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
