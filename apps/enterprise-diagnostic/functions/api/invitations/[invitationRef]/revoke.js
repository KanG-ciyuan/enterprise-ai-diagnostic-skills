import { cors, formalActor, httpError, json, requireMembership } from "../../../_shared.js";

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
    // ── B2-R2：撤回状态与审计事件必须同批提交 ──────────────────────────────
    // 旧实现先 UPDATE（独立 run）再 appendEvent（独立 run）：审计失败时邀请已撤回、
    // 事件缺失，客户端只看到 500。现在同批 ⇒ 审计失败整笔回滚，邀请保持 pending。
    // 事件 id 按邀请确定 ⇒ 同一邀请至多一条撤回事件：并发重复撤回时后到请求会撞
    // event_id 唯一约束 ⇒ 整批回滚 ⇒ 归类为"当前邀请不可撤回"。
    const revokedEventPayload = JSON.stringify({ invitationId: invitation.id, status: "revoked", reason: "revoked by member" });
    let revokedBatch;
    try {
      revokedBatch = await env.DB.batch([
        env.DB.prepare("UPDATE invitations SET status='revoked' WHERE id=? AND status='pending'").bind(invitation.id),
        env.DB.prepare("INSERT INTO events (event_id,project_id,work_item_id,type,actor_role,actor_id,payload) SELECT ?,?,?,?,?,?,? WHERE changes()=1 AND EXISTS (SELECT 1 FROM invitations WHERE id=? AND status='revoked')")
          .bind(`EVT-INV-REVOKED-${invitation.id}`, invitation.project_id, null, "invitation_revoked", current.role, current.userId || current.accountId, revokedEventPayload, invitation.id),
      ]);
    } catch (error) {
      const fresh = await env.DB.prepare("SELECT status FROM invitations WHERE id=?").bind(invitation.id).first();
      if (fresh?.status !== "pending") return httpError("当前邀请不可撤回", 409);
      throw error;
    }
    if (Number(revokedBatch?.[0]?.meta?.changes || 0) !== 1) return httpError("当前邀请不可撤回", 409);
    return json({ invitation: invitationPayload(invitation, "revoked") });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
