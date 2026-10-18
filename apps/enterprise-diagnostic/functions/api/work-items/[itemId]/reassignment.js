import { cors, findIdempotent, formalActor, httpError, idempotencyKey, itemPayload, json, requireAuthorizedProject, requireItem, requireMembership } from "../../../_shared.js";

const ACTION = "work-item-reassignment";
const ELIGIBLE_STATUSES = new Set(["awaiting_verification", "blocked"]);

function matchesRecordedPayload(replay, targetVerifierId, reason, expectedVersion) {
  const recorded = replay?.reassignment || {};
  return recorded.toVerifierId === targetVerifierId
    && recorded.reason === reason
    && Number(recorded.assignmentVersion) === expectedVersion + 1;
}

async function responsibilitySummary(db, itemId) {
  const row = await db.prepare("SELECT wi.*,a.name AS assigned_verifier_name FROM work_items wi LEFT JOIN accounts a ON a.id=wi.assigned_verifier_id WHERE wi.id=?").bind(itemId).first();
  return {
    workItemId: row.id,
    assignedVerifierId: row.assigned_verifier_id || null,
    assignedVerifierName: row.assigned_verifier_name || row.assignee_label || null,
    assigneeAccountId: row.assignee_account_id || null,
    assigneeLabel: row.assignee_label,
    assignmentVersion: Number(row.assignment_version || 1),
  };
}

async function assignmentConflict(db, itemId) {
  return json({ code: "assignment_conflict", detail: "任务责任人已变化，请刷新后重试。", assignment: await responsibilitySummary(db, itemId) }, 409);
}

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const item = await requireItem(env.DB, params.itemId);
    if (!item.project_id.startsWith("PRJ-")) return httpError("具名重新分配只支持正式项目", 401);
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, item.project_id, current, ["external_builder"]);
    await requireAuthorizedProject(env.DB, item.project_id);
    const body = await request.json().catch(() => ({}));
    const key = idempotencyKey(request).trim();
    if (!key) return httpError("重新分配需要 Idempotency-Key", 422);
    const targetVerifierId = String(body.targetVerifierId || "").trim();
    const reason = String(body.reason || "").trim();
    const expectedVersion = Number(body.assignmentVersion);
    if (!targetVerifierId) return httpError("必须选择新的具名核验人", 422);
    if (!reason) return httpError("重新分配必须填写原因", 422);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return httpError("assignmentVersion 无效", 422);

    const replay = await findIdempotent(env.DB, current, item.project_id, ACTION, key);
    if (replay) {
      if (!matchesRecordedPayload(replay, targetVerifierId, reason, expectedVersion)) {
        return httpError("同一请求键不能用于不同的重新分配内容", 409, "idempotency_conflict");
      }
      return json(replay);
    }
    const currentVersion = Number(item.assignment_version || 1);
    if (expectedVersion !== currentVersion) return assignmentConflict(env.DB, item.id);
    if (item.stage !== "facts" || item.assignee_role !== "verifier" || !ELIGIBLE_STATUSES.has(item.status)) {
      return httpError("只有未完成的事实核验任务可以重新分配", 409);
    }
    if (!item.assigned_verifier_id || item.assigned_verifier_id !== item.assignee_account_id) return httpError("当前任务没有一致的具名核验责任", 409);
    if (targetVerifierId === item.assigned_verifier_id) return httpError("新的核验人必须与当前核验人不同", 422);
    const target = await env.DB.prepare("SELECT pm.account_id,a.name FROM project_memberships pm JOIN accounts a ON a.id=pm.account_id WHERE pm.project_id=? AND pm.account_id=? AND pm.role='verifier' AND pm.status='active' AND a.status='active'")
      .bind(item.project_id, targetVerifierId).first();
    if (!target) return httpError("目标账号必须是当前项目的在岗核验人员", 422);
    const fromAccount = await env.DB.prepare("SELECT name FROM accounts WHERE id=?").bind(item.assigned_verifier_id).first();
    const nextVersion = currentVersion + 1;
    const eventId = `EVT-REASSIGN-${item.id}-${nextVersion}`;
    const reassignment = {
      workItemId: item.id,
      fromVerifierId: item.assigned_verifier_id,
      fromVerifierName: fromAccount?.name || item.assignee_label,
      toVerifierId: target.account_id,
      toVerifierName: target.name || "未命名核验人",
      reason,
      assignmentVersion: nextVersion,
      eventId,
    };
    const updatedItem = itemPayload({
      ...item,
      assigned_verifier_id: target.account_id,
      assigned_verifier_name: target.name || "未命名核验人",
      assignee_account_id: target.account_id,
      assignee_label: target.name || "未命名核验人",
      assignment_version: nextVersion,
    });
    const response = { reassignment, item: updatedItem };
    const eventPayload = JSON.stringify({
      fromVerifierId: reassignment.fromVerifierId,
      fromVerifierName: reassignment.fromVerifierName,
      toVerifierId: reassignment.toVerifierId,
      toVerifierName: reassignment.toVerifierName,
      reason,
      fromAssignmentVersion: currentVersion,
      assignmentVersion: nextVersion,
      unfinishedResponsibilityOnly: true,
    });
    let results;
    try {
      results = await env.DB.batch([
        env.DB.prepare("UPDATE work_items SET assigned_verifier_id=?,assignee_account_id=?,assignee_label=?,assignment_version=assignment_version+1 WHERE id=? AND project_id=? AND stage='facts' AND assignee_role='verifier' AND status IN ('awaiting_verification','blocked') AND assigned_verifier_id=? AND assignee_account_id=? AND assignment_version=?")
          .bind(target.account_id, target.account_id, target.name || "未命名核验人", item.id, item.project_id, item.assigned_verifier_id, item.assignee_account_id, currentVersion),
        env.DB.prepare("INSERT INTO events(event_id,project_id,work_item_id,type,actor_role,actor_id,payload) SELECT ?,project_id,id,'work_item_reassigned','external_builder',?,? FROM work_items WHERE id=? AND project_id=? AND assigned_verifier_id=? AND assignment_version=?")
          .bind(eventId, current.accountId, eventPayload, item.id, item.project_id, target.account_id, nextVersion),
        env.DB.prepare("INSERT INTO idempotency_records(account_id,project_id,action,request_key,response_json) SELECT ?,?,?,?,? FROM work_items WHERE id=? AND project_id=? AND assigned_verifier_id=? AND assignment_version=?")
          .bind(current.accountId, item.project_id, ACTION, key, JSON.stringify(response), item.id, item.project_id, target.account_id, nextVersion),
      ]);
    } catch (_conflict) {
      const winner = await findIdempotent(env.DB, current, item.project_id, ACTION, key);
      if (winner) {
        if (!matchesRecordedPayload(winner, targetVerifierId, reason, expectedVersion)) return httpError("同一请求键不能用于不同的重新分配内容", 409, "idempotency_conflict");
        return json(winner);
      }
      return assignmentConflict(env.DB, item.id);
    }
    if (!Number(results[0]?.meta?.changes || 0)) return assignmentConflict(env.DB, item.id);
    return json(response);
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
