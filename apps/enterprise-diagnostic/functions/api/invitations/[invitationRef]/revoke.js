import { appendEvent, cors, formalActor, httpError, json, requireMembership } from "../../../_shared.js";

function invitationPayload(row, status = row.status) {
  return { id: row.id, token: row.token, projectId: row.project_id, email: row.email, role: row.role, scope: row.scope, status, expiresAt: row.expires_at };
}

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    const invitation = await env.DB.prepare("SELECT * FROM invitations WHERE id=? OR token=? LIMIT 1")
      .bind(params.invitationRef, params.invitationRef).first();
    if (!invitation) return httpError("邀请不存在", 404);
    await requireMembership(env.DB, invitation.project_id, current, ["external_builder"]);
    if (invitation.status !== "pending") return httpError("当前邀请不可撤回", 409);
    const result = await env.DB.prepare("UPDATE invitations SET status='revoked' WHERE id=? AND status='pending'").bind(invitation.id).run();
    if (result.meta?.changes === 0) return httpError("当前邀请不可撤回", 409);
    await appendEvent(env.DB, invitation.project_id, null, "invitation_revoked", current, { invitationId: invitation.id, status: "revoked", reason: "revoked by member" });
    return json({ invitation: invitationPayload(invitation, "revoked") });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
