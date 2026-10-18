import { cors, ensureSchema, httpError, json, requestSessionToken, requireAuthorizedProject, sessionCookie, withSessionCookie } from "../../../_shared.js";

function accountPayload(row) {
  return { id: row.id, email: row.email, name: row.name, enterpriseId: row.enterprise_id, status: row.status };
}

function sessionPayload(row) { return { expiresAt: row.expires_at, projectId: row.project_id }; }

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    await ensureSchema(env.DB);
    const body = await request.json();
    if (!body || typeof body !== "object") return httpError("接受邀请参数格式不正确", 422);
    const email = String(body.email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) return httpError("邮箱格式不正确", 422);
    const invitation = await env.DB.prepare("SELECT * FROM invitations WHERE id=? OR token=? LIMIT 1")
      .bind(params.invitationRef, params.invitationRef).first();
    if (!invitation || invitation.status !== "pending") return httpError("邀请已使用、撤回或失效", 409);
    await requireAuthorizedProject(env.DB, invitation.project_id);
    const expiresAt = new Date(invitation.expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
      await env.DB.prepare("UPDATE invitations SET status='expired' WHERE id=? AND status='pending'").bind(invitation.id).run();
      return httpError("邀请已过期", 409);
    }
    if (invitation.email.toLowerCase() !== email) return httpError("邀请邮箱不匹配", 403);

    let account = await env.DB.prepare("SELECT * FROM accounts WHERE lower(email)=lower(?)").bind(email).first();
    if (account && account.status !== "active") return httpError("账户当前不可用", 403);
    let membership = null;
    if (account) {
      membership = await env.DB.prepare("SELECT role, status FROM project_memberships WHERE project_id=? AND account_id=?")
        .bind(invitation.project_id, account.id).first();
      if (membership && membership.role !== invitation.role) return httpError("同一项目中的成员职责冲突", 409);
    } else {
      const inviter = await env.DB.prepare("SELECT enterprise_id FROM accounts WHERE id=?").bind(invitation.inviter_account_id).first();
      account = {
        id: `ACC-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
        email,
        name: String(body.name || "").trim(),
        enterprise_id: inviter?.enterprise_id || null,
        status: "active",
      };
    }
    const project = invitation.role === "employee"
      ? await env.DB.prepare("SELECT scope FROM projects WHERE id=?").bind(invitation.project_id).first()
      : null;
    const session = {
      token: crypto.randomUUID().replaceAll("-", ""),
      refresh_token: crypto.randomUUID().replaceAll("-", ""),
      account_id: account.id,
      project_id: invitation.project_id,
      expires_at: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
    };
    const statements = [];
    const previousSessionToken = requestSessionToken(request);
    if (previousSessionToken) {
      statements.push(env.DB.prepare("UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE token=? AND revoked_at IS NULL").bind(previousSessionToken));
    }
    if (!await env.DB.prepare("SELECT id FROM accounts WHERE id=?").bind(account.id).first()) {
      statements.push(env.DB.prepare("INSERT INTO accounts(id,email,name,enterprise_id,status) SELECT ?,?,?,?,? FROM invitations WHERE id=? AND status='pending'")
        .bind(account.id, account.email, account.name, account.enterprise_id, account.status, invitation.id));
    }
    if (membership) {
      statements.push(env.DB.prepare("UPDATE project_memberships SET status='active', scope=? WHERE project_id=? AND account_id=? AND EXISTS (SELECT 1 FROM invitations WHERE id=? AND status='pending')")
        .bind(invitation.scope || "project", invitation.project_id, account.id, invitation.id));
    } else {
      statements.push(env.DB.prepare("INSERT INTO project_memberships(project_id,account_id,role,scope,status) SELECT ?,?,?,?,'active' FROM invitations WHERE id=? AND status='pending' AND NOT EXISTS (SELECT 1 FROM project_memberships WHERE project_id=? AND account_id=?)")
        .bind(invitation.project_id, account.id, invitation.role, invitation.scope || "project", invitation.id, invitation.project_id, account.id));
    }
    if (invitation.role === "employee") {
      statements.push(env.DB.prepare("INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,employee_description,assignee_account_id) SELECT ?,?,?,?,'mapping','needs_input','employee',?,0,?,?,?,? FROM invitations WHERE id=? AND status='pending' AND NOT EXISTS (SELECT 1 FROM work_items WHERE project_id=? AND assignee_account_id=? AND stage='mapping')")
        .bind(`WI-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`, invitation.project_id, "还原客户交接工作", `还原你亲自参与的${project?.scope || "项目流程"}。`, account.name || "受邀员工", "等待员工完成工作还原", "开始还原我的工作", "", account.id, invitation.id, invitation.project_id, account.id));
    }
    statements.push(
      env.DB.prepare("INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) SELECT ?,?,?,?,? FROM invitations WHERE id=? AND status='pending'").bind(session.token, session.account_id, session.project_id, session.expires_at, session.refresh_token, invitation.id),
      env.DB.prepare("INSERT INTO events(event_id,project_id,work_item_id,type,actor_role,actor_id,payload) SELECT ?,?,NULL,'invitation_accepted',?,?,? FROM invitations WHERE id=? AND status='pending'").bind(`EVT-${crypto.randomUUID()}`, invitation.project_id, invitation.role, account.id, JSON.stringify({ invitationId: invitation.id, status: "accepted", reason: "invite accepted" }), invitation.id),
      env.DB.prepare("UPDATE invitations SET status='accepted', accepted_account_id=? WHERE id=? AND status='pending'").bind(account.id, invitation.id),
    );
    await env.DB.batch(statements);
    const accepted = await env.DB.prepare("SELECT accepted_account_id FROM invitations WHERE id=? AND status='accepted'").bind(invitation.id).first();
    const acceptedSession = await env.DB.prepare("SELECT token FROM sessions WHERE token=? AND account_id=?").bind(session.token, account.id).first();
    if (accepted?.accepted_account_id !== account.id || !acceptedSession) return httpError("邀请已使用、撤回或失效", 409);
    return withSessionCookie(json({ account: accountPayload(account), session: sessionPayload(session), projectId: invitation.project_id, role: invitation.role }), sessionCookie(session.token));
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
