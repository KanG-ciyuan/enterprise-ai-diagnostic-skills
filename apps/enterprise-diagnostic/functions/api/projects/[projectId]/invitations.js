import { appendEvent, cors, formalActor, httpError, idempotencyKey, json, requireAuthorizedProject, requireMembership } from "../../../_shared.js";

const roles = new Set(["employee", "verifier", "owner", "external_builder", "it_admin"]);

function invitationPayload(row) {
  return {
    id: row.id,
    token: row.token,
    projectId: row.project_id,
    email: row.email,
    role: row.role,
    scope: row.scope,
    status: row.status,
    expiresAt: row.expires_at,
  };
}

export async function onRequestGet({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, params.projectId, current, ["external_builder"]);
    const result = await env.DB.prepare("SELECT id,project_id,email,role,scope,status,expires_at,accepted_account_id,created_at FROM invitations WHERE project_id=? ORDER BY created_at DESC").bind(params.projectId).all();
    return json({ invitations: (result.results || []).map((row) => ({ ...invitationPayload(row), token: undefined, acceptedAccountId: row.accepted_account_id || null, createdAt: row.created_at })) });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    const projectId = params.projectId;
    await requireMembership(env.DB, projectId, current, ["external_builder"]);
    await requireAuthorizedProject(env.DB, projectId);
    const body = await request.json();
    if (!body || typeof body !== "object") return httpError("邀请参数格式不正确", 422);
    const email = String(body.email || "").trim().toLowerCase();
    const role = String(body.role || "").trim();
    if (!email || !email.includes("@")) return httpError("邀请邮箱格式不正确", 422);
    if (!roles.has(role)) return httpError("邀请职责不受支持", 422);
    const expiresInSeconds = Number(body.expiresInSeconds ?? 7 * 24 * 3600);
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 90 * 24 * 3600) return httpError("邀请有效期不合法", 422);
    const key = idempotencyKey(request) || `${email}:${role}`;
    const duplicate = await env.DB.prepare("SELECT * FROM invitations WHERE project_id=? AND inviter_account_id=? AND idempotency_key=?")
      .bind(projectId, current.accountId, key).first();
    if (duplicate) return json({ invitation: invitationPayload(duplicate) }, 201);

    const target = await env.DB.prepare("SELECT id, status FROM accounts WHERE lower(email)=lower(?)").bind(email).first();
    if (target?.status && target.status !== "active") return httpError("受邀账户当前不可用", 403);
    if (target) {
      const membership = await env.DB.prepare("SELECT role FROM project_memberships WHERE project_id=? AND account_id=? AND status='active'")
        .bind(projectId, target.id).first();
      if (membership && membership.role !== role) return httpError("同一项目中的成员职责冲突", 409);
    }
    const pending = await env.DB.prepare("SELECT role FROM invitations WHERE project_id=? AND lower(email)=lower(?) AND status='pending' LIMIT 1")
      .bind(projectId, email).first();
    if (pending && pending.role !== role) return httpError("同一项目中的成员职责冲突", 409);

    const invitation = {
      id: `INV-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
      token: crypto.randomUUID().replaceAll("-", ""),
      project_id: projectId,
      inviter_account_id: current.accountId,
      email,
      role,
      scope: "project",
      status: "pending",
      expires_at: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    };
    await env.DB.prepare("INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,scope,status,expires_at,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(invitation.id, invitation.token, projectId, current.accountId, email, role, "project", "pending", invitation.expires_at, key).run();
    await appendEvent(env.DB, projectId, null, "invitation_created", current, { invitationId: invitation.id, status: "pending", role, reason: "project invitation" });
    return json({ invitation: invitationPayload(invitation) }, 201);
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
