import { cors, formalActor, httpError, itemPayload, json, receiptPayload, requireAuthorizedProject, requireMembership } from "../../../_shared.js";

export async function onRequestGet({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    if (!params.projectId.startsWith("PRJ-")) return httpError("正式员工任务需要正式项目会话", 401);
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, params.projectId, current, ["employee"]);
    await requireAuthorizedProject(env.DB, params.projectId);
    const row = await env.DB.prepare("SELECT wi.*, verifier.name AS assigned_verifier_name FROM work_items wi LEFT JOIN accounts verifier ON verifier.id=wi.assigned_verifier_id /* assigned_verifier_name */ WHERE wi.project_id=? AND ((wi.assignee_account_id=? AND wi.assignee_role='employee') OR (wi.source_employee_account_id=? AND (wi.status='blocked' OR wi.status IN ('blocked_draft','awaiting_verification','awaiting_decision','owner_decided','complete')))) ORDER BY CASE WHEN wi.status IN ('blocked','blocked_draft') THEN 0 ELSE 1 END, wi.id LIMIT 1")
      .bind(params.projectId, current.accountId, current.accountId).first();
    // A blocked fact remains linked to the employee who originally described it.
    // This source_employee_account_id boundary is what makes the supplement entry private.
    if (!row) return httpError("当前邀请没有分配员工摸排任务", 404);
    const project = await env.DB.prepare("SELECT * FROM projects WHERE id=?").bind(params.projectId).first();
    const verifierReady = await env.DB.prepare("SELECT 1 AS ready FROM project_memberships pm JOIN invitations i ON i.accepted_account_id=pm.account_id AND i.project_id=pm.project_id AND i.role='verifier' WHERE pm.project_id=? AND pm.role='verifier' AND pm.status='active' AND i.status='accepted' LIMIT 1")
      .bind(params.projectId).first();
    const task = itemPayload(row);
    const receipt = receiptPayload(row);
    task.invitationReason = "你熟悉这项工作的实际做法，项目邀请你还原本人亲自参与的部分。";
    task.workName = project?.name || "受邀工作摸排";
    task.projectScope = project?.scope || "";
    task.firstQuestion = "这项工作通常由什么事情触发？你先收到谁的什么信息？";
    task.estimatedMinutes = 10;
    task.nextRecipient = "流程核验人员";
    const builder = await env.DB.prepare("SELECT a.name,a.email FROM project_memberships m JOIN accounts a ON a.id=m.account_id WHERE m.project_id=? AND m.role='external_builder' AND m.status='active' ORDER BY m.created_at LIMIT 1").bind(params.projectId).first();
    task.assignmentOwner = builder?.name || builder?.email || "外部改造方项目负责人";
    task.submissionReady = Boolean(verifierReady);
    if (row.status === "blocked" && row.supplement_id) {
      const supplement = await env.DB.prepare("SELECT * FROM evidence_supplements WHERE id=? LIMIT 1").bind(row.supplement_id).first();
      if (supplement) task.supplementation = { id: supplement.id, requestedMaterial: supplement.requested_material, responsiblePerson: supplement.responsible_person, deadline: supplement.deadline, recoveryEntry: supplement.recovery_entry, status: supplement.status };
    }
    return json({ task, receipt });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
