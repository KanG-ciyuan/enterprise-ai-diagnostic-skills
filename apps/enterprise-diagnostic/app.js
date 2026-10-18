document.documentElement.classList.add("js-enabled");

const localAppUrl = "http://127.0.0.1:53117/";
const isDirectFileMode = window.location.protocol === "file:";
const fixture = window.diagnosticMvpFixture;
function validateDomainModel(model) {
  if (!model || model.project?.id !== "DIA-CRM-001") throw new Error("诊断项目模型无效");
  for (const collection of ["memberships", "workItems", "evidenceItems", "candidateFacts", "confirmations", "riskFindings", "decisionRecords", "handoffEvents"]) {
    if (!Array.isArray(model[collection])) throw new Error(`领域模型缺少 ${collection}`);
  }
  if (!model.permissionMatrix || !model.handoffRules?.length) throw new Error("领域模型缺少权限或交接规则");
  return model;
}
validateDomainModel(fixture.domainModel);
const state = {
  ...structuredClone(fixture),
  projectCreated: true,
  wizardStep: 0,
  blockingMessage: "",
  activityEvents: [],
  employeeDraft: fixture.employeeTask.draft,
  employeeSubmissionState: "idle",
  employeeInterviewStep: 0,
  employeeInterviewAnswers: [],
  formalEmployeeTask: null,
  formalEmployeeStep: "intro",
  formalEmployeeAnswers: {},
  formalEmployeeEditIndex: null,
  formalEmployeeMaterialStatus: "undecided",
  formalAgentQuestion: null,
  // 适配器返回的追问台账；必须跨轮带回，否则同一问题会被无限追问。
  formalInterviewLedger: null,
  formalAgentInferences: [],
  formalInferenceVerdicts: {},
  // PILOT-09C/IMPLEMENT-2D：交互态（**不是可信判定**）。
  //   · pending —— 用户已选择但尚未保存成功的判定动作；
  //   · priorVerdicts —— 服务端返回的"过期判定"（仅用于提示"上次判定：X"）。
  // 权威判定永远来自服务端返回的 draftInferenceVerdicts。
  formalInferencePending: {},
  formalInferencePriorVerdicts: {},
  // FIX-3B：被服务端以「版本冲突」拒绝的判定（仅用于展示，不参与提交）
  formalInferenceRejected: {},
  formalAgentFlowCard: null,
  formalAgentThinking: false,
  // PILOT-04B/A：访谈会话状态与自动保存状态。
  // formalInterviewRevision 是服务端草稿修订号 —— 唯一可靠的并发标识。
  formalInterviewRevision: 0,
  // PILOT-09C/FIX-CODEX-02B（F02）：冲突闩锁。发生 409 draft_conflict 后置为 true，
  // 在用户刷新（重新加载服务端任务）前禁止继续写草稿，避免用旧页面数据再次覆盖新内容。
  formalEmployeeConflict: false,
  formalEmployeeSaveState: "idle",   // idle | saving | saved | error | stale | conflict
  formalEmployeeSavedAt: 0,
  formalEmployeeSaveError: "",
  // PILOT-07/S6：服务端权威覆盖裁决与结束建议（模型建议 ≠ 可以结束）
  formalCoverage: null,
  formalEndingNote: "",
  formalInterviewEngine: "",   // "harness" = 模型自主访谈；"fixture" = 固定题库降级
  formalEmployeeSaving: false,
  formalEmployeeSubmitting: false,
  formalEmployeeRechecking: false,
  formalEmployeeSubmissionKey: "",
  formalEmployeeReceipt: null,
  formalSessionActive: false,
  formalProjectId: "",
  formalProjects: [],
  formalConfirmedFacts: [],
  formalDecisionPacket: null,
  formalBuilderControl: null,
  formalBuilderMaterials: [],
  formalInvitations: [],
  formalBuilderEvents: [],
  formalBuilderPendingAction: "",
  formalReassignment: { open: false, itemId: "", currentVerifierId: "", currentVerifierName: "", assignmentVersion: 1, targetVerifierId: "", reason: "", candidates: [], loading: false, pending: false, error: "", idempotencyKey: "" },
  formalReassignmentReceipt: null,
  formalProjectSubmitting: false,
  formalProjectCreateKey: "",
  formalProjectCreatePayload: null,
  formalAuthorizationKey: "",
  formalManualAuthorizationLink: "",
  formalManualAuthorizationWarning: "",
  formalDecisionDraftKey: "",
  formalDecisionDraftPayload: null,
  formalBuilderName: "",
  formalBuilderEnterprise: "",
  verifierFact: null,
  verifierFacts: [],
  verifierHistory: [],
  verifierFactIndex: 0,
  verifierProgress: { current: 0, total: 0, completed: 0 },
  verifierResponsibleMembers: [],
  verifierSourceRefs: [],
  verifierReviewingMaterial: "",
  verifierSubmitting: false,
  verifierPacket: null,
  verifierDecision: "",
  verifierEvidenceLevel: "",
  verifierReason: "",
  verifierCorrection: "",
  verifierSupplement: { requestedMaterial: "", responsiblePerson: "", deadline: "", recoveryEntry: "", authorizationScope: "project", sourceRefs: [] },
  verifierState: "waiting",
  formalOwnerPacket: null,
  formalOwnerSubmitting: false,
  formalOwnerReceipt: null,
  formalEmployeeSupplementing: false,
};

const formalUiContract = window.formalUiContract;

const views = Array.from(document.querySelectorAll("[data-view]"));
const invitationForm = document.querySelector("#invitation-form");
const formalBuilderLoginForm = document.querySelector("#formal-builder-login-form");
const formalMemberLoginForm = document.querySelector("#formal-member-login-form");
const formalMemberLoginStatus = document.querySelector("#formal-member-login-status");
const formalMemberTestConsume = document.querySelector("#formal-member-test-consume");
const formalInvitationAcceptForm = document.querySelector("#formal-invitation-accept-form");
const formalProjectForm = document.querySelector("#formal-project-form");
const formalInvitationForm = document.querySelector("#formal-invitation-form");
const formalProjectList = document.querySelector("#formal-project-list");
const formalInvitationPanel = document.querySelector("#formal-invitation-panel");
const formalInvitationResult = document.querySelector("#formal-invitation-result");
const formalBuilderDecisionPanel = document.querySelector("#formal-builder-decision-panel");
const formalBuilderControl = document.querySelector("#formal-builder-control");
const projectList = document.querySelector("#project-list");
const diagnosticWorkbench = document.querySelector("#diagnostic-workbench");
const employeeWorkbench = document.querySelector("#employee-workbench");
const formalEmployeeWorkbench = document.querySelector("#formal-employee-workbench");
const formalOwnerWorkbench = document.querySelector("#formal-owner-workbench");
const verifierWorkbench = document.querySelector("#verifier-workbench");
const demoVerifierWorkbench = document.querySelector("#demo-verifier-workbench");
const ownerReviewWorkbench = document.querySelector("#owner-review-workbench");
const workbenchState = document.querySelector("#workbench-state");
const wizardDialog = document.querySelector("#project-wizard-dialog");
const wizardPanel = document.querySelector("#wizard-panel");
const wizardSteps = Array.from(document.querySelectorAll("#wizard-steps li"));
const wizardBackButton = document.querySelector("#wizard-back-button");
const wizardNextButton = document.querySelector("#wizard-next-button");
const statusMessage = document.querySelector("#status-message");
const roleInput = document.querySelector("#invitation-role");
const roleOptions = Array.from(document.querySelectorAll("[data-role-choice]"));
const sidebarItems = Array.from(document.querySelectorAll(".sidebar-item"));

const wizardContent = [
  {
    title: "选择要诊断的流程",
    text: "第一版固定使用已经完成摸排的客户交接流程，不新增其他业务场景。",
    selection: "客户交接流程",
  },
  {
    title: "说明这次诊断的范围",
    text: "从销售提交交接名单开始，到 CRM 管理员完成归属变更并返回处理结果为止。",
    selection: "暂不包含 CRM 实际写入、正式授权或其他业务系统改造。",
  },
  {
    title: "选择参与流程的职责",
    text: "用职责而非固定岗位名称描述参与人，方便后续适配不同企业。",
    selection: "企业负责人、参与流程的员工、流程核验人员、系统管理员。",
  },
  {
    title: "选择本次使用的材料",
    text: "材料只用于模拟诊断，不会被发送到企业系统或作为真实业务依据。",
    selection: "模拟访谈记录、模拟 Excel、流程确认卡和风险说明。",
  },
];

function cloneFixture() {
  return structuredClone(fixture);
}

function resolveRoleRoute(role) {
  return state.visibleWorkspaces.includes(role) && state.roleRoutes[role]
    ? state.roleRoutes[role]
    : "project-list-view";
}

function enterFromInvitation(event) {
  event.preventDefault();
  const params = new URLSearchParams(window.location.search);
  if (params.get("role") === "employee" && params.get("project")) {
    loadFormalEmployeeTask(params.get("project"));
    return;
  }
  if (params.get("role") === "verifier" && params.get("project")) {
    loadFormalVerifierWorkspace(params.get("project"));
    return;
  }
  const formData = new FormData(invitationForm);
  const role = formData.get("role");
  if (!state.visibleWorkspaces.includes(role)) {
    showMessage("当前邀请未分配可用职责，请联系项目负责人。" );
    return;
  }
  state.authenticated = true;
  showRoleRoute(role);
}

async function openFormalEntry() {
  const params = new URLSearchParams(window.location.search);
  const loginToken = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("login");
  if (loginToken) {
    window.history.replaceState({}, "", window.location.pathname + window.location.search);
    showFormalEntryMode("member");
    showView("formal-entry-view");
    try { await consumeFormalMemberToken(loginToken); } catch (_error) { if (formalMemberLoginStatus) formalMemberLoginStatus.textContent = "验证链接已过期或已使用，请重新请求。"; }
    return;
  }
  const invitationToken = params.get("invite");
  if (formalUiContract.formalEntryMode({ invitationToken, hasSession: false }) === "invite") {
    state.formalSessionActive = false;
    if (formalBuilderLoginForm) formalBuilderLoginForm.hidden = true;
    if (formalInvitationAcceptForm) formalInvitationAcceptForm.hidden = false;
    showView("formal-entry-view");
    return;
  }
  try {
    const restored = await window.diagnosticApi.restoreSession();
    state.formalSessionActive = true;
    state.formalProjectId = restored.projectId || "";
    state.formalBuilderName = restored.account?.name || "";
    if (restored.role === "employee" && restored.projectId) return loadFormalEmployeeTask(restored.projectId);
    if (restored.role === "verifier" && restored.projectId) return loadFormalVerifierWorkspace(restored.projectId);
    if (restored.role === "owner" && restored.projectId) return loadFormalOwnerWorkspace(restored.projectId);
    if (restored.role === "account") return loadFormalBuilderWorkspace();
  } catch (_error) {
    state.formalSessionActive = false;
  }
  if (formalBuilderLoginForm) formalBuilderLoginForm.hidden = Boolean(invitationToken);
  if (formalInvitationAcceptForm) formalInvitationAcceptForm.hidden = !invitationToken;
  if (formalMemberTestConsume) formalMemberTestConsume.hidden = !["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (!invitationToken) showFormalEntryMode("builder");
  showView("formal-entry-view");
}

async function submitFormalInvitationAccept(event) {
  event.preventDefault();
  const invitationToken = new URLSearchParams(window.location.search).get("invite");
  if (!invitationToken) return showMessage("邀请链接缺少必要信息，请向项目创建者重新索取。");
  const data = new FormData(formalInvitationAcceptForm);
  try {
    const response = await window.diagnosticApi.acceptInvitation(invitationToken, {
      email: String(data.get("email") || "").trim(),
      name: String(data.get("name") || "").trim(),
    });
    state.formalSessionActive = true;
    state.formalProjectId = response.projectId;
    window.history.replaceState({}, "", formalUiContract.invitationUrlAfterAccept(window.location.href));
    if (response.role === "employee") {
      await loadFormalEmployeeTask(response.projectId);
      return;
    }
    if (response.role === "verifier") {
      await loadFormalVerifierWorkspace(response.projectId);
      return;
    }
    if (response.role === "owner") return loadFormalOwnerWorkspace(response.projectId);
    showMessage("该邀请对应的工作台尚未开放。");
  } catch (error) {
    showMessage("无法确认邀请：" + error.message);
  }
}

function renderRoute(route) {
  if (route === "project-list-view") renderProjectList();
  if (route === "diagnostic-workbench-view") renderWorkbench();
  if (route === "verifier-workbench-view") renderVerifierWorkbench();
  if (route === "owner-review-view") renderOwnerReview();
  if (route === "employee-workbench-view") renderEmployeeWorkbench();
}

function showRoleRoute(role) {
  if (!state.visibleWorkspaces.includes(role)) {
    showMessage("当前邀请未分配可用职责，请联系项目负责人。" );
    return;
  }
  state.role = role;
  clearMessage();
  const route = resolveRoleRoute(role);
  sidebarItems.forEach((item) => item.classList.toggle("is-active", item.dataset.role === role || (role === "external_builder" && item.dataset.action === "show-project-list")));
  renderRoute(route);
  showView(route);
}

function switchDemoRole(role) {
  const step = state.demoFlow.find((entry) => entry.role === role);
  if (!step) return;
  showRoleRoute(role);
  showMessage(`已切换到“${step.label}”演示视角。这里是本地演示切换，不代表真实权限。`);
}

function appendActivity({ actor, actorLabel, action, impact, itemId = "" }) {
  if (state.activityEvents.some((event) => event.actor === actor && event.action === action && (!itemId || event.itemId === itemId))) {
    return;
  }

  state.activityEvents.push({
    id: `EVT-${String(state.activityEvents.length + 1).padStart(3, "0")}`,
    actor,
    actorLabel,
    action,
    impact,
    itemId,
    occurredAt: new Date().toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  });
}

function appendHandoffEvent({ workItemId, fromRole, toRole, reason, targetStage }) {
  const events = state.domainModel.handoffEvents;
  if (events.some((event) => event.workItemId === workItemId && event.fromRole === fromRole && event.toRole === toRole && event.targetStage === targetStage)) return;
  events.push({
    id: `HANDOFF-${String(events.length + 1).padStart(3, "0")}`,
    projectId: state.domainModel.project.id,
    workItemId,
    fromRole,
    toRole,
    reason,
    targetStage,
    createdAt: new Date().toISOString(),
  });
}

appendActivity({
  actor: "system",
  actorLabel: "系统",
  action: "诊断项目已创建",
  impact: "已进入材料与事实阶段，等待模拟 Agent 开始分析。",
});

function stageById(id) {
  return state.stages.find((stage) => stage.id === id);
}

// 正式模式下的角色与项目名，用于顶栏身份条。
const FORMAL_ROLE_LABELS = {
  employee: "一线员工",
  verifier: "流程核验人员",
  owner: "企业负责人",
  account: "外部改造方",
  external_builder: "外部改造方",
};

function renderFormalIdentity(viewId) {
  const strip = document.querySelector("#formal-identity");
  if (!strip) return;
  const isRoleView = ["formal-employee-view", "formal-verifier-view", "formal-owner-view", "formal-builder-view"].includes(viewId);
  strip.hidden = !isRoleView;
  if (!isRoleView) return;
  const role = document.querySelector(`#${viewId}`)?.dataset.formalRole || "";
  const roleEl = document.querySelector("#formal-identity-role");
  const projectEl = document.querySelector("#formal-identity-project");
  const nameEl = document.querySelector("#formal-identity-name");
  if (roleEl) roleEl.textContent = FORMAL_ROLE_LABELS[role] || "项目成员";
  const envEl = document.querySelector("#formal-identity-env");
  if (projectEl) {
    const name = state.formalProjectName || state.domainModel?.project?.name || "客户交接流程诊断";
    projectEl.textContent = name;
    // B2-02：正式业务环境标识。文案只陈述"运行模式 + 当前项目"这一可验证事实，
    // 不使用"所有数据真实""数据绝对安全"之类未经验证的承诺。
    if (envEl) envEl.textContent = `正式业务 · 当前项目：${name}`;
  }
  if (nameEl) nameEl.textContent = state.formalBuilderName || "";
}

function showView(viewId) {
  const formalActive = ["formal-entry-view", "formal-builder-view", "formal-employee-view", "formal-verifier-view", "formal-owner-view"].includes(viewId);
  document.body.classList.toggle("formal-active", formalActive);
  // 顶栏保留：登录后仍需要知道“我是谁、在哪个项目、怎么退出”。
  document.querySelector(".app-header").hidden = viewId === "formal-entry-view";
  renderFormalIdentity(viewId);
  document.querySelector("#workspace-sidebar").hidden = formalActive;
  document.querySelector(".global-boundary").hidden = formalActive;
  document.body.classList.toggle("workspace-active", !formalActive && viewId !== "invitation-gate-view");
  views.forEach((view) => {
    view.hidden = view.id !== viewId;
    view.classList.remove("is-entering");
  });
  const activeView = document.querySelector(`#${viewId}`);
  if (activeView) {
    window.requestAnimationFrame(() => activeView.classList.add("is-entering"));
  }
  const heading = document.querySelector(`#${viewId} h1`);
  if (heading) heading.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function projectScopeSummary(project) {
  const scope = String(project.scope || "").trim();
  return scope.length > 86 ? scope.slice(0, 86) + "…" : scope;
}

function renderFormalBuilderWorkspace() {
  if (!formalProjectList) return;
  const projects = state.formalProjects || [];
  const createButton = formalProjectForm?.querySelector('button[type="submit"]');
  if (createButton) {
    createButton.disabled = state.formalProjectSubmitting;
    createButton.textContent = state.formalProjectSubmitting ? "正在创建…" : "创建项目";
  }
  if (!projects.length) {
    formalProjectList.innerHTML = '<p class="queue-empty">还没有项目。创建后再邀请员工、核验人员和企业负责人。</p>';
    if (formalInvitationPanel) formalInvitationPanel.hidden = true;
    return;
  }
  const selected = state.formalProjectId || projects[0].id;
  state.formalProjectId = selected;
  formalProjectList.innerHTML = projects.map((project) => {
    const active = project.id === selected;
    const buttonClass = active ? "primary-button" : "secondary-button";
    const buttonText = active ? "正在管理" : "管理邀请";
    return '<article class="formal-project-row"><div><strong>' + escapeMarkup(project.name) + '</strong><span>' + escapeMarkup(projectScopeSummary(project)) + '</span></div><button class="' + buttonClass + '" type="button" data-action="select-formal-project" data-project-id="' + escapeMarkup(project.id) + '">' + buttonText + '</button></article>';
  }).join("");
  if (formalInvitationPanel) formalInvitationPanel.hidden = false;
  renderFormalBuilderControl();
  renderFormalBuilderDecisionPanel();
}

function renderFormalBuilderControl() {
  if (!formalBuilderControl || !state.formalProjectId) return;
  formalBuilderControl.hidden = false;
  const control = state.formalBuilderControl || {};
  const project = control.project || state.formalProjects.find((entry) => entry.id === state.formalProjectId) || {};
  const authorizations = control.authorizations || [];
  const invitations = state.formalInvitations || [];
  const members = control.members || [];
  const task = control.revisionBlocker || control.tasks?.find((entry) => entry.status !== "complete") || null;
  const authorization = authorizations[0] || null;
  const materials = state.formalBuilderMaterials || [];
  const authorized = authorizations.filter((entry) => entry.status === "authorized");
  const authorizationInProgress = authorizations.some((entry) => entry.status === "pending");
  const authorizationRows = authorizations.map((entry) => `<tr><td>${escapeMarkup(entry.label || entry.name)}</td><td>${escapeMarkup(entry.authorizerName || entry.authorizer_name || "")}</td><td>${escapeMarkup(formalUiContract.statusLabel(entry.status))}</td><td>${escapeMarkup(formalUiContract.statusLabel(entry.deliveryStatus || entry.confirmation_delivery_status))}</td><td>${entry.status === "pending" || (entry.deliveryStatus || entry.confirmation_delivery_status) === "failed" ? `<button class="text-button" type="button" data-action="resend-formal-authorization" data-authorization-id="${escapeMarkup(entry.id)}" ${state.formalBuilderPendingAction ? "disabled" : ""}>重新发送</button>` : "—"}</td></tr>`).join("");
  const authorizationTable = authorizationRows ? `<div class="formal-table-wrap"><table class="formal-table"><thead><tr><th>授权</th><th>确认人</th><th>状态</th><th>投递</th><th>操作</th></tr></thead><tbody>${authorizationRows}</tbody></table></div>` : "";
  const authorizationForm = !authorized.length && !authorizationInProgress ? `${authorizationTable}<form id="formal-authorization-form" class="formal-operation-form"><p class="panel-label">${authorizations.length ? "原授权未通过，请重新登记" : "先取得企业具名授权"}</p><div class="formal-form-grid"><label>授权名称<input name="label" required placeholder="例如：OA 审批记录只读导出"></label><label>企业确认人<input name="authorizerName" required></label><label>确认人邮箱<input name="authorizerEmail" type="email" required></label><label>授权范围<input name="scope" required placeholder="只读、字段范围、有效期"></label><label class="span-full">企业侧记录引用<input name="reference" required placeholder="例如：approval://AUTH-2026-08"></label></div><button class="primary-button" type="submit" ${state.formalBuilderPendingAction ? "disabled" : ""}>${state.formalBuilderPendingAction === "authorization-create" ? "正在登记…" : "登记并发送确认"}</button></form>` : authorizationTable;
  const workItemOptions = (control.tasks || []).map((entry) => `<option value="${escapeMarkup(entry.id)}">${escapeMarkup(entry.title)} · ${escapeMarkup(entry.id)}</option>`).join("");
  const authorizationOptions = authorized.map((entry) => `<option value="${escapeMarkup(entry.id)}">${escapeMarkup(entry.label || entry.name)}</option>`).join("");
  const materialRows = materials.map((entry) => {
    const authorizationStatus = entry.authorization_status || entry.authorizationStatus;
    const unboundSupplement = !entry.authorization_record_id && !entry.authorizationRecordId && String(entry.materialKey || entry.material_key || "").startsWith("SUPMAT-");
    const binding = unboundSupplement && authorized.length ? `<div class="material-binding"><select aria-label="选择材料授权记录" data-binding-select="${escapeMarkup(entry.id)}">${authorizationOptions}</select><button class="text-button" type="button" data-action="bind-formal-material-authorization" data-material-id="${escapeMarkup(entry.id)}" ${state.formalBuilderPendingAction ? "disabled" : ""}>绑定授权</button></div>` : escapeMarkup(formalUiContract.statusLabel(authorizationStatus));
    return `<tr><td>${escapeMarkup(entry.label)}</td><td>${escapeMarkup(entry.materialKey || entry.material_key)}</td><td>v${escapeMarkup(entry.version)}</td><td>${escapeMarkup(entry.sourceType || entry.source_type)}</td><td>${binding}</td><td>${escapeMarkup(formalUiContract.statusLabel(entry.integrity_status || entry.integrityStatus))}</td></tr>`;
  }).join("");
  const materialForm = authorized.length ? `<form id="formal-material-form" class="formal-operation-form"><p>材料登记后进入“待完整性复核”，只能由被指派的核验人员复核。</p><div class="formal-form-grid"><label>材料名称<input name="label" required></label><label>来源类型<select name="sourceType" required><option value="pdf">PDF</option><option value="image">图片</option><option value="csv">CSV</option><option value="xlsx">Excel</option><option value="text">文本</option></select></label><label>关联任务<select name="workItemId" required><option value="">选择任务</option>${workItemOptions}</select></label><label>可见范围<select name="visibility" required><option value="verifier">核验人员</option><option value="project">项目成员</option></select></label><label class="span-full">材料引用<input name="reference" required placeholder="例如：oa://exports/2026-08"></label><label class="span-full">补充信息（可选 JSON）<textarea name="metadata" rows="2" placeholder='{"batch":"2026-08"}'></textarea></label></div><input type="hidden" name="authorizationRecordId" value="${escapeMarkup(authorized[0].id)}"><button class="primary-button" type="submit" ${state.formalBuilderPendingAction ? "disabled" : ""}>${state.formalBuilderPendingAction === "material-create" ? "正在登记…" : "登记材料"}</button></form>` : `<p class="queue-empty">企业确认授权后，材料登记入口才会开放。</p>`;
  const manualHandoffPanel = state.formalManualAuthorizationLink
    ? `<div class="manual-handoff" role="status"><p class="panel-label">人工转交确认链接</p><p>${escapeMarkup(state.formalManualAuthorizationWarning)}</p><label class="employee-label" for="formal-manual-link">给企业确认人的链接</label><div class="manual-handoff-row"><input id="formal-manual-link" class="employee-draft" readonly value="${escapeMarkup(state.formalManualAuthorizationLink)}"><button class="secondary-button" type="button" data-action="copy-formal-authorization-link">复制链接</button></div><p class="manual-handoff-note">复制后发给企业确认人，由其打开并选择“授权/拒绝”。</p></div>`
    : "";
  const invitationRows = invitations.map((entry) => `<tr><td>${escapeMarkup(entry.email)}</td><td>${escapeMarkup(formalUiContract.roleLabel(entry.role))}</td><td>${escapeMarkup(formalUiContract.statusLabel(entry.status))}</td><td>${escapeMarkup(entry.expiresAt || "")}</td><td>${entry.status === "pending" ? `<button class="text-button" type="button" data-action="revoke-formal-invitation" data-invitation-id="${escapeMarkup(entry.id)}">撤回</button>` : "—"}</td></tr>`).join("");
  const assignableTasks = (control.tasks || []).filter((entry) => entry.stage === "facts" && entry.assigneeRole === "verifier" && ["awaiting_verification", "blocked"].includes(entry.status));
  const reassignmentRows = assignableTasks.map((entry) => {
    const verifierName = entry.assignedVerifierName || entry.assigneeLabel || "尚未具名";
    return `<article class="reassignment-task"><div><strong>${escapeMarkup(entry.title)}</strong><span>当前具名核验人：${escapeMarkup(verifierName)}</span><small>${escapeMarkup(formalUiContract.statusLabel(entry.status))} · 责任版本 v${escapeMarkup(entry.assignmentVersion || 1)}</small></div><button class="secondary-button" type="button" data-action="open-formal-reassignment" data-item-id="${escapeMarkup(entry.id)}" ${state.formalBuilderPendingAction ? "disabled" : ""}>重新分配</button></article>`;
  }).join("");
  const receipt = state.formalReassignmentReceipt;
  const reassignmentReceipt = receipt ? `<div class="reassignment-receipt" role="status"><strong>已重新分配：${escapeMarkup(receipt.fromVerifierName)} → ${escapeMarkup(receipt.toVerifierName)}</strong><span>仅未完成核验责任已转移 · 责任版本 v${escapeMarkup(receipt.assignmentVersion)}</span></div>` : "";
  const reassignment = state.formalReassignment;
  const candidateOptions = reassignment.candidates.map((entry) => `<option value="${escapeMarkup(entry.accountId)}" ${entry.accountId === reassignment.targetVerifierId ? "selected" : ""}>${escapeMarkup(entry.name)}</option>`).join("");
  const reassignmentDialog = reassignment.open ? `<dialog id="formal-reassignment-dialog" class="reassignment-dialog" aria-labelledby="formal-reassignment-title"><form id="formal-reassignment-form" method="dialog"><div class="dialog-heading"><div><p class="panel-label">任务责任调整</p><h2 id="formal-reassignment-title">重新分配具名核验人</h2></div><button class="icon-button" type="button" data-action="close-formal-reassignment" aria-label="关闭重新分配对话框">×</button></div><p class="reassignment-current">当前核验人：<strong>${escapeMarkup(reassignment.currentVerifierName)}</strong></p><label>新的核验人<select name="targetVerifierId" required ${reassignment.loading || reassignment.pending ? "disabled" : ""}><option value="">${reassignment.loading ? "正在读取候选人…" : "选择同项目在岗核验人"}</option>${candidateOptions}</select></label><label>重新分配原因<textarea name="reason" required rows="3" ${reassignment.pending ? "disabled" : ""}>${escapeMarkup(reassignment.reason)}</textarea></label><p class="reassignment-boundary">仅转移这项任务尚未完成的核验责任。已有判断、证据、截止时间和事实状态保持不变。</p>${reassignment.error ? `<p class="error-feedback" role="alert">${escapeMarkup(reassignment.error)}</p>` : ""}<div class="reassignment-actions"><button class="secondary-button" type="button" data-action="close-formal-reassignment" ${reassignment.pending ? "disabled" : ""}>取消</button><button class="primary-button" type="submit" ${reassignment.loading || reassignment.pending || !reassignment.candidates.length ? "disabled" : ""}>${reassignment.pending ? "正在重新分配…" : "确认重新分配"}</button></div></form></dialog>` : "";
  formalBuilderControl.innerHTML = `
    <div class="control-summary">
      <div><span>项目范围</span><strong>${escapeMarkup(project.scope || "尚未设定")}</strong></div>
      <div><span>企业授权人</span><strong>${authorization ? escapeMarkup(authorization.authorizer_name || authorization.authorizerName) : "等待登记"}</strong><small>${authorization ? escapeMarkup(formalUiContract.statusLabel(authorization.status)) : "由企业方具名确认"}</small></div>
      <div><span>项目成员</span><strong>${members.length} 人</strong><small>${members.map((entry) => escapeMarkup(entry.name || entry.email)).join("、") || "等待接受邀请"}</small></div>
      <div><span>处理时限</span><strong>核验 ${control.sla?.verificationBusinessDays || 2} 个工作日</strong><small>补证 ${control.sla?.supplementBusinessDays || 5} 个工作日 · 决策 ${control.sla?.ownerDecisionBusinessDays || 5} 个工作日</small></div>
    </div>
    <div class="control-task"><p class="panel-label">现在只处理这一项</p><h2>${task ? escapeMarkup(task.title) : "当前没有改造方待办"}</h2><p>${task ? escapeMarkup(task.revisionReason || task.description) : "成员正在完成各自任务，新的阻塞会出现在这里。"}</p>${task ? `<dl class="receipt-grid"><div><dt>来源版本</dt><dd>${task.revisionFromVersion ? `v${escapeMarkup(task.revisionFromVersion)}` : "—"}</dd></div><div><dt>当前状态</dt><dd>${escapeMarkup(formalUiContract.statusLabel(task.status))}</dd></div><div><dt>接收人</dt><dd>${escapeMarkup(task.assigneeLabel)}</dd></div><div><dt>当前阻塞</dt><dd>${escapeMarkup(task.blockingReason || task.blocking_reason || "无")}</dd></div><div><dt>完成条件</dt><dd>${escapeMarkup(task.nextAction)}</dd></div></dl>` : ""}</div>
    <div class="control-history"><p class="panel-label">未完成核验责任</p>${reassignmentReceipt}${reassignmentRows || '<p class="queue-empty">当前没有可重新分配的核验任务。</p>'}</div>
    <div class="control-history"><p class="panel-label">企业授权</p>${authorizationForm}${manualHandoffPanel}</div>
    <div class="control-history"><p class="panel-label">证据材料</p>${materialForm}${materialRows ? `<div class="formal-table-wrap"><table class="formal-table"><thead><tr><th>材料</th><th>稳定 ID</th><th>版本</th><th>类型</th><th>授权</th><th>完整性</th></tr></thead><tbody>${materialRows}</tbody></table></div>` : ""}</div>
    <div class="control-history"><p class="panel-label">邀请生命周期</p>${invitationRows ? `<div class="formal-table-wrap"><table class="formal-table"><thead><tr><th>成员</th><th>职责</th><th>状态</th><th>有效期</th><th>操作</th></tr></thead><tbody>${invitationRows}</tbody></table></div>` : "<p>还没有邀请记录。</p>"}</div>
    <div class="control-history"><p class="panel-label">最近事件</p><p>${control.latestEvent ? `${escapeMarkup(control.latestEvent.type)} · ${escapeMarkup(control.latestEvent.createdAt)}` : "暂无事件"}</p></div>${reassignmentDialog}`;
  formalBuilderControl.querySelector("#formal-authorization-form")?.addEventListener("submit", submitFormalAuthorization);
  formalBuilderControl.querySelector("#formal-material-form")?.addEventListener("submit", submitFormalMaterial);
  formalBuilderControl.querySelector("#formal-reassignment-form")?.addEventListener("submit", submitFormalReassignment);
  const dialog = formalBuilderControl.querySelector("#formal-reassignment-dialog");
  if (dialog) {
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeFormalReassignment(); });
    if (!dialog.open) dialog.showModal();
  }
}

async function openFormalReassignment(itemId) {
  if (state.formalBuilderPendingAction) return;
  const item = state.formalBuilderControl?.tasks?.find((entry) => entry.id === itemId);
  if (!item) return showMessage("没有找到这项待核验任务，请刷新后重试。");
  state.formalReassignment = {
    open: true, itemId, currentVerifierId: item.assignedVerifierId || item.assigneeAccountId || "",
    currentVerifierName: item.assignedVerifierName || item.assigneeLabel || "尚未具名", assignmentVersion: Number(item.assignmentVersion || 1),
    targetVerifierId: "", reason: "", candidates: [], loading: true, pending: false, error: "", idempotencyKey: "",
  };
  state.formalBuilderPendingAction = "reassignment-candidates";
  renderFormalBuilderControl();
  try {
    const response = await window.diagnosticApi.listVerifierCandidates(state.formalProjectId);
    state.formalReassignment.candidates = (response.candidates || []).filter((entry) => entry.accountId !== state.formalReassignment.currentVerifierId);
    if (!state.formalReassignment.candidates.length) state.formalReassignment.error = "当前项目没有其他在岗核验人员。";
  } catch (error) {
    state.formalReassignment.error = "候选核验人没有加载：" + error.message;
  } finally {
    state.formalReassignment.loading = false;
    state.formalBuilderPendingAction = "";
    renderFormalBuilderControl();
  }
}

function closeFormalReassignment() {
  if (state.formalReassignment.pending || state.formalReassignment.loading) return;
  state.formalReassignment = { ...state.formalReassignment, open: false, error: "", idempotencyKey: "" };
  renderFormalBuilderControl();
}

async function submitFormalReassignment(event) {
  event.preventDefault();
  if (state.formalReassignment.pending || state.formalBuilderPendingAction) return;
  const data = new FormData(event.currentTarget);
  const targetVerifierId = String(data.get("targetVerifierId") || "").trim();
  const reason = String(data.get("reason") || "").trim();
  state.formalReassignment.targetVerifierId = targetVerifierId;
  state.formalReassignment.reason = reason;
  state.formalReassignment.error = "";
  if (!targetVerifierId || !reason) {
    state.formalReassignment.error = "请选择新的核验人并填写重新分配原因。";
    return renderFormalBuilderControl();
  }
  if (!state.formalReassignment.idempotencyKey) state.formalReassignment.idempotencyKey = window.crypto.randomUUID();
  state.formalReassignment.pending = true;
  state.formalBuilderPendingAction = `reassignment:${state.formalReassignment.itemId}`;
  renderFormalBuilderControl();
  try {
    const response = await window.diagnosticApi.reassignWorkItem(state.formalReassignment.itemId, {
      targetVerifierId, assignmentVersion: state.formalReassignment.assignmentVersion, reason,
    }, state.formalReassignment.idempotencyKey);
    state.formalReassignmentReceipt = response.reassignment;
    state.formalReassignment = { ...state.formalReassignment, open: false, idempotencyKey: "" };
    await loadFormalBuilderWorkspace();
    showMessage(`已重新分配：${response.reassignment.fromVerifierName} → ${response.reassignment.toVerifierName}。仅未完成核验责任发生转移。`);
  } catch (error) {
    state.formalReassignment.error = "重新分配没有完成：" + error.message;
    if (error.payload?.assignment) {
      state.formalReassignment.currentVerifierId = error.payload.assignment.assignedVerifierId || "";
      state.formalReassignment.currentVerifierName = error.payload.assignment.assignedVerifierName || error.payload.assignment.assigneeLabel || "尚未具名";
      state.formalReassignment.assignmentVersion = Number(error.payload.assignment.assignmentVersion || 1);
      state.formalReassignment.candidates = state.formalReassignment.candidates.filter((entry) => entry.accountId !== state.formalReassignment.currentVerifierId);
    }
  } finally {
    state.formalReassignment.pending = false;
    state.formalBuilderPendingAction = "";
    renderFormalBuilderControl();
  }
}

function renderFormalBuilderDecisionPanel() {
  if (!formalBuilderDecisionPanel || !state.formalProjectId) return;
  formalBuilderDecisionPanel.hidden = false;
  const packet = state.formalDecisionPacket;
  const revisionTask = state.formalBuilderControl?.revisionBlocker;
  if (packet?.status === "verifier_checked") {
    formalBuilderDecisionPanel.innerHTML = `<p class="panel-label">第三步 · 已完成事实引用核验</p><h2>发布给企业负责人</h2><p>${escapeMarkup(packet.riskSummary)}</p><button class="primary-button" type="button" data-action="publish-formal-packet" data-packet-id="${escapeMarkup(packet.id)}">发布决策摘要</button>`;
    return;
  }
  if (packet?.status === "draft") {
    formalBuilderDecisionPanel.innerHTML = `<p class="panel-label">第三步 · 等待核验人员</p><h2>风险与试点草稿已保存</h2><p>核验人员确认事实引用后，你才能发布给企业负责人。</p>`;
    return;
  }
  if (packet?.status === "revision_requested" && revisionTask) {
    formalBuilderDecisionPanel.innerHTML = `<p class="panel-label">负责人退回 · 从 v${escapeMarkup(revisionTask.revisionFromVersion)} 生成新版本</p><h2>按退回理由修订</h2><p>${escapeMarkup(revisionTask.revisionReason)}</p>${renderFormalDecisionDraftForm("生成 v" + (Number(revisionTask.revisionFromVersion) + 1) + " 并交核验")}`;
    formalBuilderDecisionPanel.querySelector("form")?.addEventListener("submit", submitFormalDecisionPacket);
    return;
  }
  if (!state.formalConfirmedFacts.length) {
    formalBuilderDecisionPanel.innerHTML = `<p class="panel-label">第三步</p><h2>等待已确认事实</h2><p>员工提交并由核验人员确认后，这里会开放风险与试点建议起草。</p>`;
    return;
  }
  formalBuilderDecisionPanel.innerHTML = `<p class="panel-label">第三步 · 基于 ${state.formalConfirmedFacts.length} 条已确认事实</p><h2>起草风险与影子试点建议</h2>${renderFormalDecisionDraftForm("保存并交给核验人员")}`;
  formalBuilderDecisionPanel.querySelector("form")?.addEventListener("submit", submitFormalDecisionPacket);
}

function renderFormalDecisionDraftForm(buttonLabel) {
  const prior = state.formalDecisionDraftPayload || state.formalDecisionPacket || {};
  const pending = state.formalBuilderPendingAction === "decision-draft";
  return `<form id="formal-decision-packet-form" class="formal-owner-form"><label>核心风险<textarea name="riskSummary" required>${escapeMarkup(prior.riskSummary || "")}</textarea></label><label>影子试点范围<textarea name="pilotScope" required>${escapeMarkup(prior.pilotScope || "")}</textarea></label><label>约束条件<input name="constraints" required value="${escapeMarkup((prior.constraints || []).join("；"))}" placeholder="例如：不写入生产系统"></label><label>成功指标<input name="successMetrics" required value="${escapeMarkup((prior.successMetrics || []).join("；"))}" placeholder="例如：平均等待时长下降"></label><label>停止条件<input name="stopConditions" required value="${escapeMarkup((prior.stopConditions || []).join("；"))}" placeholder="例如：错误率上升"></label><label>后续责任人<input name="downstreamOwner" required value="${escapeMarkup(prior.downstreamOwner || "")}"></label><button class="primary-button" type="submit" ${pending ? "disabled" : ""}>${pending ? "正在保存…" : escapeMarkup(buttonLabel)}</button></form>`;
}

// 一键进演示：后端把演示项目建到可用状态并直接发会话，前端按身份落到对应工作台。
async function enterDemo(demoRole) {
  const status = document.querySelector("#demo-entry-status");
  const buttons = [...document.querySelectorAll('[data-action="demo-enter"]')];
  buttons.forEach((button) => { button.disabled = true; });
  if (status) status.textContent = "正在准备演示项目…";
  try {
    const result = await window.diagnosticApi.demoEnter(demoRole);
    state.formalSessionActive = true;
    state.formalProjectId = result.projectId || "";
    state.formalProjectName = result.projectName || "";
    state.formalBuilderName = result.account?.name || "";
    state.formalInterviewLedger = null;
    state.formalAgentQuestion = null;
    // 换身份等于换一次会话：清掉入场计数，让第一屏正常淡入。
    ["#formal-employee-thread", "#verifier-thread", "#owner-thread"].forEach((sel) =>
      resetFadeTracking(document.querySelector(sel)));
    state.role = result.role || demoRole;
    // 会话已写入 cookie；清掉地址里的参数，避免刷新后重复进入。
    window.history.replaceState({}, "", window.location.pathname);
    if (result.role === "employee") return loadFormalEmployeeTask(result.projectId);
    if (result.role === "verifier") return loadFormalVerifierWorkspace(result.projectId);
    if (result.role === "owner") return loadFormalOwnerWorkspace(result.projectId);
    return loadFormalBuilderWorkspace();
  } catch (error) {
    if (status) status.textContent = `进入演示失败：${error.message}`;
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function loadFormalBuilderWorkspace() {
  showView("formal-builder-view");
  if (!state.formalSessionActive) return;
  try {
    const response = await window.diagnosticApi.listFormalProjects();
    state.formalProjects = response.projects || [];
    if (!state.formalProjectId && state.formalProjects[0]) state.formalProjectId = state.formalProjects[0].id;
    if (state.formalProjectId) {
      const [facts, packet, control, invitations, events, materials] = await Promise.all([
        window.diagnosticApi.listConfirmedFacts(state.formalProjectId).catch(() => ({ facts: [] })),
        window.diagnosticApi.getFormalDecisionPacket(state.formalProjectId).catch(() => ({ packet: null })),
        window.diagnosticApi.getFormalProject(state.formalProjectId),
        window.diagnosticApi.listFormalInvitations(state.formalProjectId).catch(() => ({ invitations: [] })),
        window.diagnosticApi.listFormalEvents(state.formalProjectId).catch(() => ({ events: [] })),
        window.diagnosticApi.listFormalMaterials(state.formalProjectId).catch(() => ({ materials: [] })),
      ]);
      state.formalConfirmedFacts = facts.facts || [];
      state.formalDecisionPacket = packet.packet || null;
      state.formalBuilderControl = control;
      state.formalInvitations = invitations.invitations || [];
      state.formalBuilderEvents = events.events || [];
      state.formalBuilderMaterials = materials.materials || [];
    }
    renderFormalBuilderWorkspace();
  } catch (error) {
    if (formalProjectList) formalProjectList.innerHTML = '<p class="error-feedback">无法读取项目：' + escapeMarkup(error.message) + '</p>';
  }
}

async function submitFormalDecisionPacket(event) {
  event.preventDefault(); const data = new FormData(event.currentTarget);
  if (state.formalBuilderPendingAction) return;
  const list = (name) => String(data.get(name) || "").split("；").map((v) => v.trim()).filter(Boolean);
  if (!state.formalDecisionDraftKey) state.formalDecisionDraftKey = window.crypto.randomUUID();
  const draftPayload = state.formalDecisionDraftPayload || { factRefs: state.formalConfirmedFacts.map(({ factId, materialStatus }) => ({ factId, materialStatus })), riskSummary: String(data.get("riskSummary") || ""), pilotScope: String(data.get("pilotScope") || ""), constraints: list("constraints"), successMetrics: list("successMetrics"), stopConditions: list("stopConditions"), downstreamOwner: String(data.get("downstreamOwner") || "") };
  state.formalDecisionDraftPayload = draftPayload;
  state.formalBuilderPendingAction = "decision-draft";
  renderFormalBuilderDecisionPanel();
  try {
    const response = await window.diagnosticApi.createFormalDecisionPacket(state.formalProjectId, draftPayload, state.formalDecisionDraftKey);
    state.formalDecisionDraftKey = "";
    state.formalDecisionDraftPayload = null;
    state.formalDecisionPacket = response.packet; renderFormalBuilderDecisionPanel();
  } catch (error) {
    if (error.status === 409 || (error.status >= 400 && error.status < 500)) { state.formalDecisionDraftKey = ""; state.formalDecisionDraftPayload = null; }
    showMessage("决策包草稿没有保存：" + error.message);
  } finally {
    state.formalBuilderPendingAction = "";
    renderFormalBuilderDecisionPanel();
  }
}

async function publishFormalDecisionPacket(packetId) {
  try { await window.diagnosticApi.publishFormalDecisionPacket(packetId); state.formalDecisionPacket = null; renderFormalBuilderDecisionPanel(); showMessage("已发布给企业负责人。负责人现在可以进入决策工作台。"); }
  catch (error) { showMessage("尚未发布：" + error.message); }
}

async function submitFormalBuilderLogin(event) {
  event.preventDefault();
  const formData = new FormData(formalBuilderLoginForm);
  const enterpriseName = String(formData.get("enterpriseName") || "").trim();
  const email = String(formData.get("email") || "").trim();
  const name = String(formData.get("name") || "").trim();
  const bootstrapToken = String(formData.get("bootstrapToken") || "").trim();
  try {
    const response = await window.diagnosticApi.authorizeBuilder({ email, enterpriseName, name, bootstrapToken });
    state.formalSessionActive = true;
    state.formalBuilderName = response.account.name || name;
    state.formalBuilderEnterprise = response.enterprise.name;
    await loadFormalBuilderWorkspace();
  } catch (error) {
    if (error.status === 409 && /已有账号/.test(error.message)) {
      // An existing builder is a returning member, not a failed signup. Request
      // the current environment's one-time link immediately so the user does not
      // have to switch tabs and repeat the same email manually.
      showMessage("该邮箱已有账号，正在生成本环境的登录链接…");
      showFormalEntryMode("member");
      if (formalMemberLoginForm?.elements?.email) formalMemberLoginForm.elements.email.value = email;
      try {
        const login = await window.diagnosticApi.requestMemberLogin(email);
        if (formalMemberLoginStatus) {
          if (login?.loginUrl) {
            formalMemberLoginStatus.innerHTML = `已生成本环境的一次性登录链接：<a href="${escapeMarkup(login.loginUrl)}" class="primary-button">点击登录</a>，或打开：<code>${escapeMarkup(login.loginUrl)}</code>`;
          } else {
            formalMemberLoginStatus.textContent = "登录链接已发送到登记邮箱，请使用最新的一封邮件。";
          }
        }
      } catch (_loginError) {
        if (formalMemberLoginStatus) formalMemberLoginStatus.textContent = "登录链接生成失败，请稍后重试。";
      }
      return;
    }
    showMessage("无法进入项目控制台：" + error.message);
  }
}

function showFormalEntryMode(mode) {
  const builderMode = mode !== "member";
  if (formalBuilderLoginForm) formalBuilderLoginForm.hidden = !builderMode;
  if (formalMemberLoginForm) formalMemberLoginForm.hidden = builderMode;
  document.querySelectorAll(".formal-entry-mode-switch [role=tab]").forEach((tab) => {
    const selected = (tab.dataset.action === "show-member-login") === !builderMode;
    tab.setAttribute("aria-selected", String(selected));
    tab.classList.toggle("is-selected", selected);
  });
}

async function submitFormalMemberLogin(event) {
  event.preventDefault();
  const email = String(new FormData(formalMemberLoginForm).get("email") || "").trim();
  if (formalMemberLoginStatus) formalMemberLoginStatus.textContent = "正在检查登记状态…";
  try {
    const response = await window.diagnosticApi.requestMemberLogin(email);
    if (formalMemberLoginStatus) {
      if (response?.loginUrl) {
        formalMemberLoginStatus.innerHTML = `未配置邮件投递：已生成直接登录链接。<a href="${escapeMarkup(response.loginUrl)}" class="primary-button">点击登录</a>，或打开：<code>${escapeMarkup(response.loginUrl)}</code>`;
      } else {
        formalMemberLoginStatus.textContent = "如果邮箱符合条件，系统会尝试发送验证链接。请在 15 分钟内完成验证。";
      }
    }
  } catch (error) {
    if (formalMemberLoginStatus) formalMemberLoginStatus.textContent = error.status === 0 ? "网络暂时不可用，请稍后重试。" : "请求未能完成，请稍后重试。";
  }
}

async function consumeFormalMemberToken(token) {
  if (!token) return;
  if (formalMemberLoginStatus) formalMemberLoginStatus.textContent = "正在验证…";
  try {
    const response = await window.diagnosticApi.consumeMemberLogin(token);
    const memberships = response.memberships || [];
    if (memberships.length > 1) {
      const options = memberships.map((entry, index) => `<option value="${escapeMarkup(String(index))}">${escapeMarkup(entry.project?.name || entry.projectId)} · ${escapeMarkup(formalUiContract.roleLabel(entry.role))}</option>`).join("");
      if (formalMemberLoginStatus) formalMemberLoginStatus.innerHTML = `<label>选择要进入的项目<select id="formal-member-project-choice">${options}</select></label><button class="secondary-button" type="button" data-action="choose-member-project">进入所选项目</button>`;
      state.formalPendingMemberships = memberships;
      return;
    }
    const membership = memberships[0];
    state.formalSessionActive = true;
    state.formalProjectId = membership?.projectId || "";
    state.formalBuilderName = response.account?.name || "";
    if (membership?.role === "employee" && state.formalProjectId) return loadFormalEmployeeTask(state.formalProjectId);
    if (membership?.role === "verifier" && state.formalProjectId) return loadFormalVerifierWorkspace(state.formalProjectId);
    if (membership?.role === "owner" && state.formalProjectId) return loadFormalOwnerWorkspace(state.formalProjectId);
    return loadFormalBuilderWorkspace();
  } catch (error) {
    if (formalMemberLoginStatus) formalMemberLoginStatus.textContent = error.status === 0 ? "网络暂时不可用，请稍后重试。" : "验证链接已过期或已使用，请重新请求。";
  }
}

async function consumeFormalMemberTestToken() {
  const token = String(new FormData(formalMemberLoginForm).get("testToken") || "").trim();
  await consumeFormalMemberToken(token);
}

async function enterMemberProject(index) {
  const membership = state.formalPendingMemberships?.[Number(index)];
  if (!membership) return;
  state.formalPendingMemberships = null;
  state.formalProjectId = membership.projectId;
  try { await window.diagnosticApi.selectMemberProject(membership.projectId); } catch (error) { if (formalMemberLoginStatus) formalMemberLoginStatus.textContent = "项目恢复失败，请刷新后重试。"; return; }
  if (membership.role === "employee") return loadFormalEmployeeTask(membership.projectId);
  if (membership.role === "verifier") return loadFormalVerifierWorkspace(membership.projectId);
  if (membership.role === "owner") return loadFormalOwnerWorkspace(membership.projectId);
  return loadFormalBuilderWorkspace();
}

async function submitFormalProject(event) {
  event.preventDefault();
  if (state.formalProjectSubmitting) return;
  const formData = new FormData(formalProjectForm);
  const name = String(formData.get("name") || "").trim();
  const scope = String(formData.get("scope") || "").trim();
  const payload = { name, scope };
  if (!state.formalProjectCreateKey || JSON.stringify(state.formalProjectCreatePayload) !== JSON.stringify(payload)) {
    state.formalProjectCreateKey = window.crypto.randomUUID();
    state.formalProjectCreatePayload = payload;
  }
  state.formalProjectSubmitting = true;
  renderFormalBuilderWorkspace();
  try {
    const response = await window.diagnosticApi.createFormalProject(payload, state.formalProjectCreateKey);
    state.formalProjectCreateKey = "";
    state.formalProjectCreatePayload = null;
    state.formalProjectId = response.project.id;
    formalProjectForm.reset();
    formalProjectForm.querySelector('[name="name"]').value = "客户交接流程诊断";
    await loadFormalBuilderWorkspace();
    showMessage("项目已创建。下一步邀请一线员工、流程核验人员和企业负责人。");
  } catch (error) {
    if (error.status >= 400 && error.status < 500) { state.formalProjectCreateKey = ""; state.formalProjectCreatePayload = null; }
    showMessage("项目没有创建：" + error.message);
  } finally {
    state.formalProjectSubmitting = false;
    renderFormalBuilderWorkspace();
  }
}

async function bindFormalMaterialConsent(materialId) {
  if (state.formalBuilderPendingAction) return;
  const authorizationRecordId = document.querySelector(`[data-binding-select="${CSS.escape(materialId)}"]`)?.value || "";
  if (!authorizationRecordId) return showMessage("请选择具名授权记录。");
  state.formalBuilderPendingAction = `material-bind:${materialId}`;
  renderFormalBuilderControl();
  try {
    await window.diagnosticApi.bindFormalMaterialConsent(state.formalProjectId, materialId, authorizationRecordId, window.crypto.randomUUID());
    showMessage("补证材料已绑定企业具名授权，等待核验人员复核完整性。");
    await loadFormalBuilderWorkspace();
  } catch (error) {
    showMessage("材料授权没有绑定：" + error.message);
  } finally {
    state.formalBuilderPendingAction = "";
    renderFormalBuilderControl();
  }
}

async function submitFormalInvitation(event) {
  event.preventDefault();
  const projectId = state.formalProjectId;
  if (!projectId) return showMessage("请先创建并选择一个项目。");
  const formData = new FormData(formalInvitationForm);
  const email = String(formData.get("email") || "").trim();
  const role = String(formData.get("role") || "");
  try {
    const response = await window.diagnosticApi.createInvitation(projectId, { email, role, expiresInSeconds: 7 * 24 * 3600 });
    const invitation = response.invitation;
    const inviteUrl = window.location.origin + window.location.pathname + "?invite=" + encodeURIComponent(invitation.token);
    formalInvitationResult.innerHTML = '<div class="formal-invitation-link"><strong>邀请已生成：' + escapeMarkup(email) + '</strong><span>请将此链接发送给受邀人；打开后由邀请确定其项目和职责。</span><code>' + escapeMarkup(inviteUrl) + '</code></div>';
    formalInvitationForm.reset();
  } catch (error) {
    showMessage("邀请没有生成：" + error.message);
  }
}

async function submitFormalAuthorization(event) {
  event.preventDefault();
  if (state.formalBuilderPendingAction) return;
  const data = new FormData(event.currentTarget);
  if (!state.formalAuthorizationKey) state.formalAuthorizationKey = window.crypto.randomUUID();
  state.formalBuilderPendingAction = "authorization-create";
  renderFormalBuilderControl();
  try {
    const result = await window.diagnosticApi.createEnterpriseConsent(state.formalProjectId, {
      label: String(data.get("label") || "").trim(), authorizerName: String(data.get("authorizerName") || "").trim(), authorizerEmail: String(data.get("authorizerEmail") || "").trim(), scope: String(data.get("scope") || "").trim(), reference: String(data.get("reference") || "").trim(),
    }, state.formalAuthorizationKey);
    state.formalAuthorizationKey = "";
    if (result?.confirmationUrl || result?.code === "authorization_manual_handoff") {
      // No email provider bound: the builder must hand the confirmation link over.
      state.formalManualAuthorizationLink = result.confirmationUrl || "";
      state.formalManualAuthorizationWarning = result.warning || "未配置企业授权确认投递通道：请把确认链接人工转交给企业确认人。";
      showMessage("授权登记已保存。当前未配置邮件投递，请把确认链接人工转交给企业确认人。");
    } else {
      state.formalManualAuthorizationLink = "";
      state.formalManualAuthorizationWarning = "";
      showMessage("授权记录已保存，并已发送给企业具名确认人。");
    }
    await loadFormalBuilderWorkspace();
  } catch (error) {
    if (error.status >= 400 && error.status < 500 && error.status !== 409) state.formalAuthorizationKey = "";
    showMessage("授权登记没有完成：" + error.message);
    if (error.payload?.authorization) { state.formalAuthorizationKey = ""; await loadFormalBuilderWorkspace(); }
  } finally {
    state.formalBuilderPendingAction = "";
    renderFormalBuilderControl();
  }
}

async function resendFormalAuthorization(authorizationId) {
  if (state.formalBuilderPendingAction) return;
  state.formalBuilderPendingAction = `authorization-resend:${authorizationId}`;
  renderFormalBuilderControl();
  try {
    await window.diagnosticApi.resendEnterpriseConsent(state.formalProjectId, authorizationId);
    showMessage("授权确认已重新发送。");
    await loadFormalBuilderWorkspace();
  } catch (error) {
    showMessage("授权确认没有重发：" + error.message);
    if (error.status === 503) await loadFormalBuilderWorkspace();
  } finally {
    state.formalBuilderPendingAction = "";
    renderFormalBuilderControl();
  }
}

async function submitFormalMaterial(event) {
  event.preventDefault();
  if (state.formalBuilderPendingAction) return;
  const data = new FormData(event.currentTarget);
  let metadata = {};
  try { metadata = formalUiContract.buildSupplementPayload({ metadataText: data.get("metadata") }).metadata; }
  catch (error) { return showMessage(error.message); }
  state.formalBuilderPendingAction = "material-create";
  renderFormalBuilderControl();
  try {
    await window.diagnosticApi.createFormalMaterial(state.formalProjectId, {
      authorizationRecordId: String(data.get("authorizationRecordId") || ""), workItemId: String(data.get("workItemId") || ""), label: String(data.get("label") || "").trim(), reference: String(data.get("reference") || "").trim(), sourceType: String(data.get("sourceType") || ""), visibility: String(data.get("visibility") || "verifier"), metadata,
    });
    showMessage("材料已登记，等待指定核验人员复核完整性。");
    await loadFormalBuilderWorkspace();
  } catch (error) {
    showMessage("材料没有登记：" + error.message);
  } finally {
    state.formalBuilderPendingAction = "";
    renderFormalBuilderControl();
  }
}

function showMessage(text) {
  statusMessage.textContent = text;
  statusMessage.hidden = false;
}

function clearMessage() {
  statusMessage.hidden = true;
  statusMessage.textContent = "";
}

function outputStatusLabel(status) {
  return { pending: "待生成", blocked: "因待人工确认阻塞", ready: "已产出" }[status];
}

function simulationLabel() {
  return { idle: "尚未开始模拟", running: "模拟 Agent 运行中", complete: "已完成本轮模拟" }[state.simulationState];
}

function renderDemoFlow(activeRole) {
  // 本地演示路线可进入负责人审阅；正式核验工作台不渲染此导航。
  return `
    <nav class="demo-flow" aria-label="本地演示路线">
      <div class="demo-flow__heading">
        <p class="panel-label">本地演示路线</p>
        <strong>员工摸排 → 事实核验 → 负责人审阅</strong>
      </div>
      <div class="demo-flow__steps">
        ${state.demoFlow.map((step, index) => `
          <button class="demo-flow-step ${step.role === activeRole ? "is-active" : ""}" type="button" data-action="switch-role" data-role="${step.role}" ${step.role === activeRole ? 'aria-current="step" disabled' : ""}>
            <span>0${index + 1}</span>
            <strong>${step.title}</strong>
            <em>${step.label} · ${step.note}</em>
          </button>
        `).join("")}
      </div>
      <p class="demo-flow__boundary">这条路线只用于演示角色关系，不是企业真实权限入口。</p>
    </nav>
  `;
}

function renderProjectList() {
  const stage = stageById(state.project.currentStage);
  projectList.innerHTML = `
    <article class="project-row">
      <div class="project-row__main">
        <div>
          <p class="row-kicker">${state.evidenceLevel} 合成模拟项目</p>
          <h2>${state.project.name}</h2>
          <p>${state.project.description}</p>
        </div>
        <dl class="project-meta">
          <div><dt>当前阶段</dt><dd>${stage.label}</dd></div>
          <div><dt>当前负责人</dt><dd>${stage.owner}</dd></div>
          <div><dt>待人工确认</dt><dd>${state.simulationState === "complete" ? `${state.confirmationItems.filter((item) => item.status !== "resolved").length} 项` : "尚未运行"}</dd></div>
        </dl>
      </div>
      <button class="primary-button" type="button" data-action="open-workbench">继续诊断</button>
    </article>
  `;
}

function renderStage(stage) {
  const current = stage.id === state.project.currentStage;
  return `
    <li class="stage stage--${stage.status}" ${current ? 'aria-current="step"' : ""}>
      <span class="stage__dot" aria-hidden="true"></span>
      <div><strong>${stage.label}</strong><span>负责人：${stage.owner}</span></div>
    </li>
  `;
}

function renderFacts() {
  if (state.simulationState === "idle" || state.simulationState === "running") {
    return `
      <section class="panel panel--facts">
        <p class="panel-label">需要先完成的动作</p>
        <h2>当前已确认事实</h2>
        <p>开始模拟后，系统才会展示根据模拟访谈和材料整理出的事实及证据来源。</p>
      </section>
    `;
  }

  return `
    <section class="panel panel--facts">
      <p class="panel-label">E5预置事实 · 仅供本地演示</p>
      <h2>当前已确认事实</h2>
      <div class="fact-list">
        ${state.confirmedFacts.map((fact) => `
          <article class="fact">
            <p>${fact.text}</p>
            <span class="evidence-tag">证据来源：${fact.sourceLabel} · ${fact.sourceType} · ${fact.version}</span>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderAgentState() {
  if (state.simulationState === "idle") {
    return `
      <section class="panel panel--agent">
        <p class="panel-label">本地固定模拟</p>
        <h2>模拟 Agent 分析</h2>
        <p>尚未开始模拟诊断。开始后会按既有 Skill 规则展示事实整理、问题识别和建议，不调用大模型。</p>
        <button class="primary-button" type="button" data-action="start-simulation">开始模拟诊断</button>
      </section>
    `;
  }

  if (state.simulationState === "running") {
    return `
      <section class="panel panel--agent">
        <p class="panel-label">本地固定模拟</p>
        <h2>模拟 Agent 分析</h2>
        <p class="simulation-running" role="status">模拟 Agent 正在整理材料与证据…</p>
      </section>
    `;
  }

  return `
    <section class="panel panel--agent">
      <p class="panel-label">仅供人工审阅</p>
      <h2>模拟 Agent 分析</h2>
      <h3>识别到的问题</h3>
      ${state.agentFindings.map((item) => `<p class="agent-finding">${item}</p>`).join("")}
      <h3>可选建议</h3>
      ${state.agentRecommendations.map((item) => `<p class="agent-recommendation">${item}</p>`).join("")}
    </section>
  `;
}

function renderConfirmation() {
  if (state.simulationState !== "complete") return "";
  const hasOpenItems = state.confirmationItems.some((item) => item.status !== "resolved");

  return `
    <section class="confirmation-card--${hasOpenItems ? "blocked" : "resolved"}">
      <div class="panel-heading">
        <div><p class="panel-label">${hasOpenItems ? "系统停止自动判断" : "已完成本轮人工确认"}</p><h2>${hasOpenItems ? "待人工确认" : "人工确认已记录"}</h2></div>
        <span class="${hasOpenItems ? "warning-chip" : "success-chip"}">${hasOpenItems ? "需要处理" : "已确认"}</span>
      </div>
      ${state.confirmationItems.map((item) => `
        <article class="confirmation-item">
          <h3>${item.title}</h3>
          <p class="pause-reason">${item.pauseReason}</p>
          <dl>
            <div><dt>系统已核对</dt><dd>${item.facts}</dd></div>
            <div><dt>证据来源</dt><dd>${item.sourceLabel}</dd></div>
            <div><dt>建议确认人</dt><dd>${item.suggestedRole}</dd></div>
          </dl>
          ${item.status === "resolved"
            ? '<p class="resolved-note"><strong>确认结果：该记录将进入断点与风险清单。</strong><br>已记录人工确认。本地演示不会修改客户记录。</p>'
            : item.status === "needs_evidence"
              ? `<div class="button-group">
                  <button class="primary-button" type="button" data-action="provide-evidence" data-item-id="${item.id}">补充模拟材料</button>
                </div>`
              : `<div class="button-group">
                <button class="primary-button" type="button" data-action="resolve-confirmation" data-item-id="${item.id}">确认并纳入风险清单</button>
                <button class="secondary-button" type="button" data-action="request-evidence" data-item-id="${item.id}">要求补充材料</button>
              </div>`}
        </article>
      `).join("")}
      ${state.blockingMessage ? `<p class="blocking-message">${state.blockingMessage}</p>` : ""}
    </section>
  `;
}

function renderOutputs() {
  return `
    <section class="output-panel">
      <div><p class="panel-label">当前阶段完成后</p><h2>下一阶段产出</h2></div>
      <div class="output-grid">
        ${state.outputs.map((output) => `
          <article>
            <h3>${output.label}</h3>
            <span class="output-status output-status--${output.status}">${outputStatusLabel(output.status)}</span>
          </article>
        `).join("")}
      </div>
      ${state.project.currentStage === "risks"
        ? `<div class="output-actions">
            <button class="secondary-button output-link" type="button" data-action="view-risks">查看断点与风险</button>
            <button class="primary-button output-link" type="button" data-action="view-proposal">查看改造方案初稿</button>
          </div>`
        : ""}
    </section>
  `;
}

function renderWorkbenchGuide() {
  if (state.simulationState === "idle") {
    return `
      <section class="workbench-guide" aria-label="当前操作提示">
        <strong>你现在只需要做一件事</strong>
        <span>点击“开始模拟诊断”，先看系统根据模拟材料整理出的事实；遇到无法判断的记录，再由你确认。</span>
      </section>
    `;
  }
  if (state.simulationState === "running") {
    return '<section class="workbench-guide workbench-guide--running" aria-label="当前操作提示"><strong>系统正在整理材料</strong><span>请稍候，结果出来后会明确告诉你哪里需要人工确认。</span></section>';
  }
  if (state.project.currentStage === "risks") {
    return `
      <section class="workbench-guide workbench-guide--ready" aria-label="当前操作提示">
        <strong>下一步：查看断点与风险</strong>
        <span>事实已经确认，系统已把这条记录纳入风险清单。点击下方“查看断点与风险”，继续看问题、影响和改造方向。</span>
        <button class="primary-button" type="button" data-action="view-risks">查看断点与风险</button>
      </section>
    `;
  }
  return "";
}

function renderRiskDetails() {
  if (state.project.currentStage !== "risks") return "";
  return `
    <section id="risk-details" class="risk-details workbench-wide" aria-labelledby="risk-details-title">
      <div class="panel-heading">
        <div><p class="panel-label">已解锁 · 流程核验人员查看</p><h2 id="risk-details-title">断点与风险</h2></div>
        <span class="success-chip">本阶段可查看</span>
      </div>
      <div class="risk-grid">
        <article><strong>断点</strong><p>审批结束与 CRM 归属变更之间没有明确回执，交接是否完成无法被及时确认。</p></article>
        <article><strong>风险</strong><p>相似客户或缺少唯一编号时，人工搜索和逐条修改可能造成漏改、误改。</p></article>
        <article><strong>建议动作</strong><p>先补齐唯一客户编号和逐条处理回执，再决定是否进入自动化改造验证。</p></article>
      </div>
    </section>
  `;
}

function renderProposalDetails() {
  if (state.project.currentStage !== "risks") return "";
  return `
    <section id="proposal-details" class="proposal-details workbench-wide" aria-labelledby="proposal-details-title">
      <div class="panel-heading">
        <div><p class="panel-label">诊断建议 · 需企业负责人评审</p><h2 id="proposal-details-title">改造方案初稿</h2></div>
        <span class="warning-chip">不是生产执行指令</span>
      </div>
      <p class="proposal-intro">这份方案回答“可以怎么改”，不直接替企业改 OA、CRM 或 ERP。企业负责人评审后，才决定是否进入后续验证。</p>
      <div class="proposal-grid">
        <article><strong>方案一：补齐唯一标识</strong><p>把客户唯一编号设为交接清单必填项；缺失时暂停该条记录，先补证再继续。</p><span>预期解决：相似客户、人工搜索、误改风险。</span></article>
        <article><strong>方案二：增加逐条回执</strong><p>每条 CRM 归属变更都生成处理结果，并关联原 OA 单据和人工确认记录。</p><span>预期解决：审批结束但执行未完成、漏改无法发现。</span></article>
        <article><strong>方案三：先做小范围验证</strong><p>用少量脱敏样本离线验证规则，确认通过率、阻断率和人工复核成本后再决定是否接入系统。</p><span>预期解决：避免直接改生产系统带来的风险。</span></article>
      </div>
      <div class="proposal-footer"><strong>下一步由谁做：</strong>企业负责人评审方案，流程核验人员补齐验证口径；当前版本只展示建议，不执行系统改造。</div>
    </section>
  `;
}

function renderActivityLog() {
  return `
    <section class="activity-panel" aria-labelledby="activity-log-title">
      <div class="activity-panel__heading">
        <div>
          <p class="panel-label">只读本地演示记录</p>
          <h2 id="activity-log-title">诊断过程记录</h2>
        </div>
        <span class="activity-note">刷新页面后重置</span>
      </div>
      ${state.activityEvents.length === 0
        ? '<p class="activity-empty">完成诊断动作后，这里会显示系统、模拟 Agent 和人工的过程记录。</p>'
        : `<ol class="activity-timeline">
            ${state.activityEvents.map((event) => `
              <li class="activity-event activity-event--${event.actor}">
                <div class="activity-event__marker" aria-hidden="true"></div>
                <div class="activity-event__body">
                  <div class="activity-event__meta">
                    <span class="activity-actor">${event.actorLabel}</span>
                    <time>${event.occurredAt}</time>
                  </div>
                  <strong>${event.action}</strong>
                  <p>${event.impact}</p>
                </div>
              </li>
            `).join("")}
          </ol>`}
    </section>
  `;
}

function renderWorkbench() {
  workbenchState.textContent = simulationLabel();
  workbenchState.className = `state-chip state-chip--${state.simulationState}`;
  diagnosticWorkbench.innerHTML = `
    ${renderWorkbenchGuide()}
    <div class="workbench-layout">
      <aside class="stage-rail">
        <p class="rail-label">诊断阶段</p>
        <ol>${state.stages.map(renderStage).join("")}</ol>
        <div class="rail-output">
          <strong>本阶段产出</strong>
          <span>${stageById(state.project.currentStage).output}</span>
        </div>
      </aside>
      <div class="workbench-main">
        ${renderFacts()}
        ${renderAgentState()}
        <div class="workbench-wide">${renderConfirmation()}</div>
        <div class="workbench-wide">${renderOutputs()}</div>
        ${renderRiskDetails()}
        ${renderProposalDetails()}
        <div class="workbench-wide">${renderActivityLog()}</div>
      </div>
    </div>
  `;
}

function renderEmployeeWorkbench() {
  const task = state.employeeTask;
  const question = task.questions[state.employeeInterviewStep] || task.questions[task.questions.length - 1];
  const interviewDone = state.employeeInterviewAnswers.length >= task.questions.length;
  const submissionNote = state.employeeSubmissionState === "saved"
    ? '<p class="employee-status" role="status">草稿已保存在本地演示状态中，还可以继续修改。</p>'
    : state.employeeSubmissionState === "submitted"
      ? '<div class="employee-status employee-status--submitted" role="status"><span>这一段已提交到本地演示记录，下一步可以切到核验人员视角。</span><button class="text-button flow-next-link" type="button" data-action="switch-role" data-role="verifier">进入核验人员视角</button></div>'
      : "";
  employeeWorkbench.innerHTML = `
    ${renderDemoFlow("employee")}
    <div class="employee-layout">
      <section class="employee-task-panel">
        <p class="panel-label">Agent 引导摸排 · ${Math.min(state.employeeInterviewStep + 1, task.questions.length)} / ${task.questions.length}</p>
        <h2>${task.title}</h2>
        <div class="agent-interview"><span class="agent-interview__marker">AI</span><div><strong>Agent 正在提问 · ${question.label}</strong><p>${question.prompt}</p></div></div>
        <div class="interview-progress" aria-label="摸排进度"><i style="width:${Math.round((state.employeeInterviewAnswers.length / task.questions.length) * 100)}%"></i></div>
        <p class="employee-example"><strong>可以这样写：</strong>${task.example}</p>
        <label class="employee-label" for="employee-draft">工作描述草稿 · 回答这一问</label>
        <textarea id="employee-draft" class="employee-draft" rows="6" placeholder="按你真实做过的一次工作来回答，不需要写成报告……"></textarea>
        <div class="employee-actions">
          <button class="secondary-button" type="button" data-action="save-employee-draft">保存草稿</button>
          <button class="primary-button" type="button" data-action="continue-employee-interview">${interviewDone ? "提交摸排结果" : "回答并继续"}</button>
        </div>
        ${submissionNote}
      </section>
      <aside class="employee-side-note">
        <p class="panel-label">材料提示 · 不是上传入口</p>
        <h2>想到什么就补充什么</h2>
        <p>下面只是帮助你回忆的例子。原型不会读取文件，材料也都是合成示例；草稿仅在本地保存。</p>
        <ul class="employee-materials">
          ${task.materials.map((material) => `<li><strong>${material.label}</strong><span>${material.detail}</span></li>`).join("")}
        </ul>
        <div class="employee-boundary">
          <strong>你的职责边界</strong>
          <span>你只需要描述工作实际怎么发生；不需要判断整个流程、不审批改造方案，也不修改生产系统。</span>
        </div>
      </aside>
    </div>
  `;
  const draft = employeeWorkbench.querySelector("#employee-draft");
  if (draft) draft.value = state.employeeDraft;
}

// PILOT-04/D1：必须与后端 QUESTION_BANK（functions/api/agent/_adapter.js）**键集合一致**。
// 此前前端只有 5 题而后端要 7 维，handoff/burden 永远采集不到且缺失被静默接受。
// 离线降级（无模型密钥）时按此数组顺序提问；有模型时由 Agent 决定顺序。
const formalEmployeeQuestions = [
  { key: "trigger", label: "从哪里开始", prompt: "这项工作通常由什么事情触发？你先收到谁的什么信息？" },
  { key: "inputs", label: "先看什么", prompt: "开始处理前，你需要看哪些信息、表格或系统页面？" },
  { key: "steps", label: "实际怎么做", prompt: "从收到信息到完成交接，你通常按什么顺序操作？" },
  { key: "judgments", label: "哪些情况不能自己决定", prompt: "遇到什么情况时，你必须找别人确认？" },
  { key: "exceptions", label: "卡住后怎么办", prompt: "出现缺失、冲突或等待时，你通常怎么处理？" },
  { key: "handoff", label: "交给谁", prompt: "这项工作的结果最终交给谁？由谁接手、继续处理？" },
  { key: "burden", label: "大约多久", prompt: "做一次通常大概要多久、几个人参与？" },
];

function formalEmployeeCard() {
  const answers = state.formalEmployeeAnswers;
  return {
    trigger: answers.trigger || "",
    inputs: answers.inputs || "",
    steps: answers.steps || "",
    judgments: answers.judgments || "",
    exceptions: answers.exceptions || "",
    // PILOT-04/D1+N1：这两个维度必须进流程卡，否则服务端既不会校验、
    // 也不会把它们写进候选事实，核验人将完全看不到"交给谁""耗时多少"。
    handoff: answers.handoff || "",
    burden: answers.burden || "",
    materialIndex: formalUiContract.employeeMaterialLabel(state.formalEmployeeMaterialStatus),
  };
}

// ── 证据等级模型 ─────────────────────────────────────────────
// 与 enterprise-material-analysis/references/evidence-model.md 一致。
// 关键在"不能支持"那一列：等级的意义不是给证据打分，而是划清射程。
// 一个流畅的陈述和一个有文件支撑的陈述，差别不在可信度，在来源。
const EVIDENCE_LEVELS = {
  E1: {
    source: "观察到的操作、系统记录、执行日志或真实样本",
    supports: "该观察项与周期内的流程事实",
    cannot: "所有情况、因果解释、员工意图、ROI",
  },
  E2: {
    source: "材料上相互独立的角色或来源印证同一具体主张",
    supports: "经印证的陈述",
    cannot: "实际执行情况（除非其中一方本身是 E1）",
  },
  E3: {
    source: "单个员工、管理者、客户或供应商的陈述",
    supports: "该人报告的内容",
    cannot: "全公司事实、测得的数量",
  },
  E4: {
    source: "SOP、制度、表单、规范或应有流程的文件",
    supports: "应有的规则、设计或要求",
    cannot: "实际合规性、执行频率",
  },
  E5: {
    source: "模型推断或分析师假设",
    supports: "一条待验证的线索",
    cannot: "事实、冲突结论、对外主张",
  },
};
// E5 的强制标签。校验器会拒收没有这个标签的 E5 记录。
const E5_LABEL = "AI假设，待验证";

/**
 * 最小补证请求：想从 E3 往上走，最少需要拿到什么。
 *
 * 原则是"按性价比排序"——不是列出所有能有帮助的材料，
 * 而是排出一份"拿到哪一份，能升哪几条，代价多大"的清单。
 * 每一项都必须写明它能升到几级、以及现在是否可行：
 * 一份拿不到的材料写进清单，只会让人以为还有希望。
 */
function buildEvidenceRequests(ctx) {
  const out = [];
  const { hasMaterial, unresolvedCount, judgments, steps, exceptions } = ctx;

  if (!hasMaterial) {
    out.push({
      id: "REQ-1",
      what: "本人手上任何一份与该工作相关的书面材料（通知、邮件、制度、系统截图）",
      upgrades: "该材料覆盖的条目 → E4 候选（需先经企业具名确认人核其权威性）",
      feasible: "取决于本人是否仍能接触",
    });
  }

  if (judgments) {
    out.push({
      id: "REQ-2",
      what: "当时那位审批人（主管 / 归属人）确认本卡中涉及他的那部分",
      upgrades: "相关条目从 E3 升 E2 —— 但必须是材料上独立的第二个人，不是转述",
      feasible: "需本人与该同事仍有联系",
    });
  }

  if (steps || exceptions) {
    out.push({
      id: "REQ-3",
      what: "系统操作日志或流程量导出（OA / CRM）",
      upgrades: "操作顺序与数量从陈述升 E1 —— 这是唯一能把「时间与工作量」从估算变成事实的路径",
      feasible: "需企业方配合导出",
    });
  }

  if (unresolvedCount) {
    out.push({
      id: "REQ-4",
      what: `补充说明没能还原的 ${unresolvedCount} 项`,
      upgrades: "这些项目前无法定级；补上后至少进入 E3",
      feasible: "本人即可提供",
    });
  }

  return out;
}

// 定级只看来源，不看语气。本人的口头陈述一律 E3 ——
// 即使他说"这是制度规定的"，没有文件也只能是 E3。
function levelBadge(level, note) {
  const label = level === "E5" ? `${level} · ${E5_LABEL}` : level;
  return `<span class="wfc-level wfc-level--${level.toLowerCase()}" title="${escapeMarkup((EVIDENCE_LEVELS[level] || {}).source || "")}">` +
    `${escapeMarkup(label)}${note ? ` · ${escapeMarkup(note)}` : ""}</span>`;
}

function renderFormalWorkflowCard() {
  const card = formalEmployeeCard();
  const agentDims = state.formalAgentFlowCard?.dimensions || {};
  const unresolved = (state.formalAgentFlowCard?.unresolved || []).filter((u) => u && (u.key || u.dimension));
  const unresolvedKeys = new Set(unresolved.map((u) => u.key || u.dimension));
  const evidence = state.formalAgentFlowCard?.evidence || [];
  const task = state.formalEmployeeTask || {};
  const materialStatus = state.formalEmployeeMaterialStatus;

  // 已答出来的值；没答出来的如实标注，不留空 —— 留空看起来像渲染坏了
  const value = (key) => {
    const fromAgent = agentDims[key] && String(agentDims[key]).trim() ? agentDims[key] : "";
    const fromClient = card[key] && String(card[key]).trim() ? card[key] : "";
    const text = fromAgent || fromClient;
    return text ? escapeMarkup(text) : '<span class="wfc-missing">未还原 · 待核验人员确认</span>';
  };
  const raw = (key) => {
    const fromAgent = agentDims[key] && String(agentDims[key]).trim() ? agentDims[key] : "";
    return fromAgent || card[key] || "";
  };
  const has = (key) => String(raw(key)).trim().length > 0;

  const answeredCount = ["trigger", "inputs", "steps", "judgments", "exceptions"].filter(has).length;
  const materialLabel = materialStatus === "provided" ? "员工声明有已授权材料"
    : materialStatus === "none_available" ? "员工声明暂无可提供材料" : "尚未选择";

  // ── 基本信息 ──────────────────────────────────────────────
  const basic = [
    ["本次还原的工作", escapeMarkup(task.workName || "客户交接流程")],
    ["所属项目", escapeMarkup(task.projectScope || state.formalProjectName || "—")],
    ["还原人", escapeMarkup(state.formalBuilderName || "本人") + " · 该流程的实际执行人"],
    ["由谁发起", has("trigger") ? value("trigger") : '<span class="wfc-missing">未还原</span>'],
    ["结果交给谁", has("handoff") ? value("handoff") : '<span class="wfc-missing">未还原</span>'],
    ["需要先看什么", has("inputs") ? value("inputs") : '<span class="wfc-missing">未还原</span>'],
  ].map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("");

  // ── 工作流程：按维度铺成一段可读的走法 ────────────────────
  const flowNodes = [];
  if (has("trigger")) flowNodes.push(`<span class="wfc-node">${escapeMarkup(raw("trigger"))}</span>`);
  if (has("inputs")) flowNodes.push(`<span class="wfc-arrow">→</span><span class="wfc-node">${escapeMarkup(raw("inputs"))}</span>`);
  if (has("steps")) flowNodes.push(`<span class="wfc-arrow">→</span><span class="wfc-node wfc-node--main">${escapeMarkup(raw("steps"))}</span>`);
  if (has("handoff")) flowNodes.push(`<span class="wfc-arrow">→</span><span class="wfc-node wfc-node--ok">${escapeMarkup(raw("handoff"))}</span>`);
  const flowLine = flowNodes.length
    ? flowNodes.join("")
    : '<span class="wfc-missing">本次没有还原出可展示的走法。</span>';

  // ── 步骤明细：每个维度一行，异常的判断单独成列 ──────────────
  const stepRows = [
    ["1", "接收与触发", "本人", "trigger", "上游流程到位"],
    ["2", "取所需信息", "本人", "inputs", "信息是否齐全"],
    ["3", "实际执行", "本人", "steps", "按既定顺序操作"],
    ["4", "无法自行决定时", "本人 / 上级", "judgments", "是否超出本人权限"],
    ["5", "卡住或被退回时", "本人", "exceptions", "资料缺失 / 冲突"],
  ].map(([no, stage, who, key, basis]) =>
    `<tr${has(key) ? "" : ' class="wfc-row--missing"'}>` +
    `<td class="wfc-num">${no}</td><td>${stage}</td><td>${who}</td>` +
    `<td>${value(key)}</td><td class="wfc-dim">${basis}</td>` +
    `<td class="wfc-dim">${has(key) ? "见上文" : '<span class="wfc-missing">待确认</span>'}</td>` +
    `<td>${levelBadge("E3", "本人陈述")}</td></tr>`).join("");

  // ── 证据清单：Agent 引用的材料 + 放弃的维度 ────────────────
  const evidenceRows = [
    ...evidence.map((e, i) =>
      `<tr><td>CARD-${String(i + 1).padStart(2, "0")}</td>` +
      `<td>${escapeMarkup(e.ref || "已登记材料")}</td>` +
      `<td>${levelBadge(String(e.level || "E4").toUpperCase())}</td>` +
      `<td class="wfc-dim">员工引用 · 待核验</td></tr>`),
    ...unresolved.map((u, i) =>
      `<tr class="wfc-row--missing"><td>CARD-M${i + 1}</td>` +
      `<td>${escapeMarkup((u.dimension || u.key) + "：" + (u.reason || "重复追问后仍不明确"))}</td>` +
      `<td class="wfc-dim">—</td><td><strong>待人工核验</strong></td></tr>`),
  ].join("") || `<tr><td colspan="4" class="wfc-dim">本次没有引用材料，也没有放弃的维度。</td></tr>`;

  const unresolvedNote = unresolved.length
    ? `<div class="wfc-note wfc-note--warn"><strong>有 ${unresolved.length} 项没能还原</strong>` +
      `${escapeMarkup(unresolved.map((u) => (u.dimension || u.key) + "（" + (u.reason || "仍不明确") + "）").join("、"))}。` +
      `这些项不会进入事实核验，需要人工补充。</div>`
    : "";

  // ── AI 推断逐条判定 ────────────────────────────────────────
  // 这一段是整张卡的闸门：AI 对工作的理解总比本人口述多一点，
  // 多出来的部分若无标记就会被当成事实。所以每条推断都要求本人
  // 明确"符合"或写下更正，未判定的推断不得进入核验。
  const inferences = state.formalAgentInferences || [];
  const verdicts = state.formalInferenceVerdicts || {};
  // PILOT-09C/IMPLEMENT-2D（U1–U3）：判定态与计数一律以**服务端盖章版本**为准。
  const capacityMarker = formalInferenceCapacityMarker();
  const visibleInferences = formalVisibleInferences();
  const inferenceSummary = formalInferenceSummary(visibleInferences, verdicts);
  const judgedCount = inferenceSummary.valid;            // ★ stale 不计入"已完成"
  const needCorrection = inferenceSummary.corrections;
  const pendingVerdicts = state.formalInferencePending || {};
  const priorVerdicts = state.formalInferencePriorVerdicts || {};
  const verdictLabel = (value) => (value === "correct" ? "需要更正" : "符合实际");
  const jstateBadge = (jstate) => {
    if (jstate === "valid") return `<span class="wfc-jstate wfc-jstate--valid" style="display:inline-block;margin-top:6px;padding:2px 8px;border-radius:10px;background:#e7f6ec;color:#1b6b3a;font-size:12px;">已完成判定</span>`;
    if (jstate === "stale") return `<span class="wfc-jstate wfc-jstate--stale" style="display:inline-block;margin-top:6px;padding:2px 8px;border-radius:10px;background:#fff4e5;color:#8a4b00;font-size:12px;font-weight:600;">依据已更新，请重新确认</span>`;
    return `<span class="wfc-jstate wfc-jstate--unjudged" style="display:inline-block;margin-top:6px;padding:2px 8px;border-radius:10px;background:#fdecea;color:#8a1c12;font-size:12px;">尚未判定</span>`;
  };

  const inferenceRows = visibleInferences.map((inf) => {
    const jstate = formalInferenceJudgmentState(inf, verdicts);
    const pending = pendingVerdicts[inf.id] || null;
    // stale 时单选框**不预选**：员工必须重新表态，旧判定不得靠"再提交一次"变成有效。
    const effective = pending || (jstate === "valid" ? verdicts[inf.id] : null);
    const effectiveVerdict = effective ? effective.verdict : "";
    const prior = priorVerdicts[inf.id] || ((jstate === "stale") ? verdicts[inf.id] : null);
    const quoteText = inf.quote && String(inf.quote).trim();
    // U1：有 quote 才展示"你的原话"；没有 quote 时**明确说明没有引用**，绝不伪造来源。
    const quoteHtml = quoteText
      ? `<div class="wfc-quote" style="margin-top:6px;padding:6px 8px;border-left:3px solid #c9d6e3;background:#f7f9fb;font-size:13px;">你的原话：「${escapeMarkup(quoteText)}」</div>`
      : `<div class="wfc-quote wfc-quote--none" style="margin-top:6px;padding:6px 8px;border-left:3px solid #e3e3e3;background:#fafafa;font-size:13px;color:#666;">该推断不引用你的原话（由 AI 归纳，没有员工原话证据）</div>`;
    const staleHint = (jstate === "stale" && prior)
      ? `<div class="wfc-stale-hint" style="margin-top:6px;font-size:12px;color:#8a4b00;">上次判定：${escapeMarkup(verdictLabel(prior.verdict))}（依据已更新，需重新确认）</div>`
      : "";
    const pendingHint = pending
      ? `<div class="wfc-pending-hint" style="margin-top:6px;font-size:12px;color:#555;">已选择「${escapeMarkup(verdictLabel(pending.verdict))}」，尚未保存</div>`
      : "";
    // FIX-3B：被服务端拒绝（版本冲突）的选择 —— 保留「你上次选了什么」，但不计入已完成
    const rejectedEntry = (state.formalInferenceRejected || {})[inf.id] || null;
    const rejectedHint = rejectedEntry
      ? `<div class="wfc-rejected-hint" style="margin-top:6px;font-size:12px;color:#8a1c12;">上次选择「符合实际/需要更正」<strong>未保存</strong>：该推断的依据已更新，请重新确认。</div>`
      : "";
    const rowClass = jstate === "valid" ? "" : (jstate === "stale" ? "wfc-row--stale" : "wfc-row--missing");
    return `<tr class="${rowClass}">` +
      `<td>${escapeMarkup(inf.text || "")}` +
      quoteHtml +
      `<div class="wfc-basis">依据你的「${escapeMarkup(inf.basis || "")}」回答 · ${escapeMarkup(inf.assumes || "")}</div>` +
      jstateBadge(jstate) + staleHint + pendingHint + rejectedHint + `</td>` +
      `<td class="wfc-judge">` +
      `<label class="wfc-verdict"><input type="radio" name="inference-${escapeMarkup(inf.id)}" value="agree" data-inference-id="${escapeMarkup(inf.id)}" ${effectiveVerdict === "agree" ? "checked" : ""}>符合实际</label>` +
      `<label class="wfc-verdict"><input type="radio" name="inference-${escapeMarkup(inf.id)}" value="correct" data-inference-id="${escapeMarkup(inf.id)}" ${effectiveVerdict === "correct" ? "checked" : ""}>需要更正</label>` +
      (effectiveVerdict === "correct"
        ? `<input class="wfc-correction" data-inference-correction="${escapeMarkup(inf.id)}" value="${escapeMarkup((effective && effective.correction) || "")}" placeholder="写下实际情况">`
        : "") +
      `</td></tr>`;
  }).join("");

  // §六：容量阻塞提示 —— 必须与普通"未判定条目"区分，且**不提供清除操作**。
  const capacityNotice = capacityMarker
    ? `<div class="wfc-capacity-block" style="margin:12px 0;padding:10px 12px;border:1px solid #e0b4b4;border-radius:8px;background:#fdf3f2;color:#8a1c12;font-size:13px;">` +
      `<strong>当前诊断存在未处理的推断，暂时无法提交，请联系管理员。</strong>` +
      `<div style="margin-top:6px;color:#7a3b36;">有 ${escapeMarkup(String(capacityMarker.capacityBlockedCount || 0))} 条新的 AI 推断因容量限制未能保存（历史判定已保留）。此阻塞需人工处理，本界面不提供清除操作。</div></div>`
    : "";
  const summaryParts = [];
  if (inferenceSummary.stale) summaryParts.push(`${inferenceSummary.stale} 条依据已更新需重新确认`);
  if (inferenceSummary.unjudged) summaryParts.push(`${inferenceSummary.unjudged} 条未判定`);
  const summaryWarn = (inferenceSummary.valid < inferenceSummary.total || inferenceSummary.stale > 0) ? "wfc-note--warn" : "";
  const inferenceSection = (visibleInferences.length || capacityMarker)
    ? `<section class="wfc-sec">
    <h3 class="wfc-h">AI 推断 · 请逐条判定</h3>
    <p class="wfc-dim">下面是 AI 在整理时做的推断，不是你原话。每条下方标注「你的原话」的才是你的原话；未标注原话的是 AI 归纳。它们大多数时候对，但对的部分会成为事实，错的部分会成为假事实 —— 所以需要你逐条确认。</p>
    ${capacityNotice}
    ${visibleInferences.length ? `<table class="wfc-table wfc-table--grid">
      <tr><th>AI 的推断 · 你的原话 · 判定状态</th><th>你的判定</th></tr>
      ${inferenceRows}
    </table>` : ""}
    <div class="wfc-note wfc-inference-summary ${summaryWarn}">
      已完成判定 ${inferenceSummary.valid} / ${inferenceSummary.total} 条${needCorrection ? ` · 其中 ${needCorrection} 条已确认更正` : ""}。
      ${summaryParts.length ? `还有 ${summaryParts.join("、")}。未完成判定的推断不会进入事实核验。` : "全部推断均已按当前依据完成判定。"}
    </div>
  </section>`
    : "";

  // ── 本卡的证据射程 ────────────────────────────────────────
  // 等级的价值不在给证据打分，而在划清"这份文件不能拿来支持什么"。
  // 员工还原阶段只有本人陈述，所以整卡封顶 E3；
  // 有材料登记时材料本身进入 E4 候选，但未核验前不得当作合规依据。
  const hasMaterial = materialStatus === "provided" || evidence.length > 0;
  const cardLevel = "E3";
  const scopeRows = [
    ["来源", EVIDENCE_LEVELS[cardLevel].source],
    ["能支持", EVIDENCE_LEVELS[cardLevel].supports],
    ["不能支持", EVIDENCE_LEVELS[cardLevel].cannot],
  ].map(([k, v]) => `<tr><th>${k}</th><td>${escapeMarkup(v)}</td></tr>`).join("");

  // ── 最小补证请求 ──────────────────────────────────────────
  const requests = buildEvidenceRequests({
    hasMaterial,
    unresolvedCount: unresolved.length,
    judgments: has("judgments"),
    steps: has("steps"),
    exceptions: has("exceptions"),
  });
  const requestRows = requests.map((r) => `<tr>` +
    `<td>${escapeMarkup(r.what)}</td>` +
    `<td>${escapeMarkup(r.upgrades)}</td>` +
    `<td class="wfc-dim">${escapeMarkup(r.feasible)}</td>` +
    `</tr>`).join("");

  const requestSection = `<section class="wfc-sec">
    <h3 class="wfc-h">最小补证请求</h3>
    <p class="wfc-dim">要让这张卡走出 E3，最少需要上面这些。按性价比排序 —— 拿到哪一份，能升哪几条，代价多大。</p>
    <table class="wfc-table wfc-table--grid">
      <tr><th>需要拿到什么</th><th>能升到什么</th><th>是否可行</th></tr>
      ${requestRows}
    </table>
    <div class="wfc-note">
      <strong>注意</strong>
      补证只提升等级，不改变本卡已记录的内容。若补到的材料与本卡描述不符，
      差异会作为冲突记录，而不是覆盖本卡。
    </div>
  </section>`;

  // ── 本轮修订 ──────────────────────────────────────────────
  // 被要求修订时，必须写清"从哪一版来、谁提的、改什么"。
  // 否则本人只看到一张新卡，不知道为什么要重填。
  const revisionSection = task.revisionReason
    ? `<section class="wfc-sec">
    <h3 class="wfc-h">本轮修订</h3>
    <table class="wfc-table">
      <tr><th>来源版本</th><td>v${escapeMarkup(task.revisionFromVersion || Number(task.flowCardVersion || 1) - 1)}</td></tr>
      <tr><th>当前版本</th><td>v${escapeMarkup(task.flowCardVersion || 1)}（待本人重新确认）</td></tr>
      <tr><th>修订理由</th><td>${escapeMarkup(task.revisionReason)}</td></tr>
    </table>
    <div class="wfc-note">
      <strong>说明</strong>
      上一版已确认的内容保留在案。本次修订只改变上面这些条目，其余部分沿用 v${escapeMarkup(task.revisionFromVersion || Number(task.flowCardVersion || 1) - 1)}。
    </div>
  </section>`
    : "";

  // ── 制度对照：现在没有制度文件，就如实说没有 ────────────────
  // 空的对照表比没有对照表更危险 —— 它看起来像"制度与实际一致"。
  const policySection = `<section class="wfc-sec">
    <h3 class="wfc-h">制度与实际</h3>
    <div class="wfc-note wfc-note--warn">
      <strong>本卡不含制度对照</strong>
      尚未取得任何制度文件，因此无法对照「制度怎么要求」与「实际怎么做」。
      本卡记录的只是本人报告的实际做法（E3）。<strong>这里的空白不代表两者一致</strong> ——
      它只代表制度文件还没有拿到。拿到之后再补对照，不要在此处推断。
    </div>
  </section>`;

  const scopeSection = `<section class="wfc-sec">
    <h3 class="wfc-h">本卡的证据射程</h3>
    <div class="wfc-levelrow">${levelBadge(cardLevel, "本人单方陈述")}${
      inferences.length ? levelBadge("E5", `${inferences.length} 条 AI 推断`) : ""}</div>
    <table class="wfc-table">${scopeRows}</table>
    <div class="wfc-note wfc-note--warn">
      <strong>守门结论</strong>
      ${hasMaterial
        ? "已登记材料，但材料本身尚未核验。材料进入核验之前，本卡不因有材料而升为 E4。"
        : "尚未取得任何书面材料。本卡全部内容来自本人单方陈述（E3）。"}
      「制度规定是这样」在没有文件时也仍然是本人对制度的陈述 —— 无法区分「制度真是这样」与「本人记忆中的制度是这样」。
      因此本卡<strong>不得升为 E4</strong>，也不得据此产生数量、效率或收益结论。
    </div>
  </section>`;

  return `
<div class="wfc">
  <header class="wfc-head">
    <p class="wfc-kicker">岗位工作流程确认卡</p>
    <h2 class="wfc-title">${escapeMarkup(task.workName || "客户交接流程")}</h2>
    <p class="wfc-sub">项目 <code>${escapeMarkup(state.formalProjectId || "—")}</code> · 由本人逐问还原 · 尚未核验</p>
    <div class="wfc-badges">
      <span class="wfc-badge wfc-badge--wait">待本人确认</span>
      <span class="wfc-badge">流程卡 第 ${escapeMarkup(task.flowCardVersion || 1)} 版</span>
      <span class="wfc-badge">进度 ${answeredCount} / 5 项</span>
      <span class="wfc-badge">证据等级 ${cardLevel}（本人陈述）</span>
      <span class="wfc-badge ${materialStatus === "provided" ? "wfc-badge--ok" : "wfc-badge--warn"}">${escapeMarkup(materialLabel)}</span>
    </div>
  </header>

  ${revisionSection}

  <section class="wfc-sec">
    <h3 class="wfc-h">基本信息</h3>
    <table class="wfc-table">${basic}</table>
  </section>

  <section class="wfc-sec">
    <h3 class="wfc-h">工作流程</h3>
    <div class="wfc-flow">${flowLine}</div>
    ${has("judgments") ? `<div class="wfc-note"><strong>不能自己决定的情况</strong>${value("judgments")}</div>` : ""}
    ${has("exceptions") ? `<div class="wfc-note"><strong>卡住或被退回时</strong>${value("exceptions")}</div>` : ""}
    ${has("burden") ? `<div class="wfc-note"><strong>耗时与工作量</strong>${value("burden")}</div>` : ""}
  </section>

  <section class="wfc-sec">
    <h3 class="wfc-h">步骤明细</h3>
    <table class="wfc-table wfc-table--grid">
      <tr><th>#</th><th>环节</th><th>谁做</th><th>实际操作</th><th>判断依据</th><th>异常怎么办</th><th>证据</th></tr>
      ${stepRows}
    </table>
  </section>

  <section class="wfc-sec">
    <h3 class="wfc-h">证据清单</h3>
    <table class="wfc-table wfc-table--grid">
      <tr><th>编号</th><th>内容</th><th>等级</th><th>状态</th></tr>
      ${evidenceRows}
    </table>
    ${unresolvedNote}
  </section>

  ${policySection}

  ${scopeSection}

  ${requestSection}

  ${inferenceSection}

  ${formalStatementHistorySection()}

  <section class="wfc-sec wfc-sec--confirm">
    <h3 class="wfc-h">本人确认</h3>
    <p class="wfc-dim">请逐项核对。确认后这份描述会交给流程核验人员，用授权材料核对关键事实。</p>
    <label class="wfc-check"><input id="formal-card-confirmed" type="checkbox">我已检查，以上描述符合我的实际工作</label>
  </section>
</div>`;
}

function formatFormalTime(value) {
  if (!value) return "尚未提交";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}

function renderFormalEmployeeReceipt({ waiting = false } = {}) {
  const task = state.formalEmployeeTask || {};
  const receipt = state.formalEmployeeReceipt || {};
  const card = task.workflowCard || formalEmployeeCard();
  const currentStage = formalUiContract.employeeStageForStatus(task.status);
  const receiverSummary = currentStage.complete ? "流程已关闭" : (waiting ? (task.assignmentOwner || "外部改造方项目负责人") : (receipt.assignedVerifierName || "流程核验人员"));
  const trail = waiting
    ? [["流程卡已保存", "完成"], ["核验人员分配", "等待"], ["事实核验", "尚未开始"]]
    : [["流程卡已提交", "完成"], ["事实核验", ["awaiting_decision", "owner_decided", "complete"].includes(task.status) ? "完成" : "处理中"], ["负责人决策", task.status === "awaiting_decision" ? "等待" : (["owner_decided", "complete"].includes(task.status) ? "完成" : "尚未开始")], ["流程关闭", task.status === "complete" ? "完成" : "尚未完成"]];
  return `<section class="persistent-receipt" aria-labelledby="employee-receipt-title"><div class="panel-heading"><div><p class="panel-label">同一任务 · 持续回执</p><h2 id="employee-receipt-title">${waiting ? "提交暂未完成" : (currentStage.complete ? "这项流程已经完成" : "流程描述已保存")}</h2></div><span class="status-label ${waiting ? "status-label--blocked" : ""}">${escapeMarkup(waiting ? (receipt.handoffStatus || task.handoffStatus || "not_submitted") : currentStage.label)}</span></div>
    <p>${waiting ? `系统没有找到可接收的核验人员，因此没有虚假显示“已交接”。负责人：${escapeMarkup(task.assignmentOwner || "外部改造方项目负责人")}。` : (currentStage.complete ? "该任务已闭环，没有下一位待接收人。你可以安全关闭页面，重新登录后仍会看到完成回执。" : `接收人：${escapeMarkup(receipt.assignedVerifierName || receipt.assignedVerifierLabel || "具名核验人员")}。你可以安全关闭页面，重新登录后仍会回到这项任务。`)}</p>
    <dl class="receipt-grid"><div><dt>任务</dt><dd>${escapeMarkup(task.workName || task.title || task.id)}</dd></div><div><dt>流程卡版本</dt><dd>v${escapeMarkup(receipt.flowCardVersion || task.flowCardVersion || 1)}</dd></div><div><dt>提交版本</dt><dd>v${escapeMarkup(receipt.submissionVersion || task.submissionVersion || 0)}</dd></div><div><dt>提交时间</dt><dd>${escapeMarkup(formatFormalTime(receipt.submittedAt || task.submittedAt))}</dd></div><div><dt>材料状态</dt><dd>${escapeMarkup(formalUiContract.materialStatusLabel(receipt.materialStatus || task.materialStatus || "undecided"))}</dd></div><div><dt>下一位接收人</dt><dd>${escapeMarkup(currentStage.complete ? "已闭环" : receiverSummary)}</dd></div></dl>
    <details class="receipt-summary"><summary>查看已保存的流程摘要</summary><dl class="workflow-card"><div><dt>开始条件</dt><dd>${escapeMarkup(card.trigger || "")}</dd></div><div><dt>主要操作</dt><dd>${escapeMarkup(card.steps || "")}</dd></div><div><dt>异常处理</dt><dd>${escapeMarkup(card.exceptions || "")}</dd></div></dl></details>
    <ol class="receipt-trail">${trail.map(([label, status]) => `<li><span>${escapeMarkup(label)}</span><strong>${escapeMarkup(status)}</strong></li>`).join("")}</ol></section>`;
}

// ── 三栏外壳：工作区 / 对话区 / 轨迹区 / 输入框 ──────────────────────────
// 每一栏只承担一件事。左栏回答“我在哪”，中栏是对话，右栏是证据，
// 底部输入框是唯一承载操作的地方。整页不再因为内容变长。

const EMPLOYEE_STEPS = [
  { key: "mapping", name: "还原实际工作", note: "由你本人完成" },
  { key: "facts", name: "核验候选事实", note: "流程核验人员" },
  { key: "decision", name: "负责人决策", note: "企业负责人" },
];

// 侧栏/轨迹栏每个区块都有图标 —— 纯文字的区块标题看起来像网页，不像应用面板。
const BLOCK_ICONS = {
  "本步进度": '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 13V9.4M8 13V5M13 13V7.4"/></svg>',
  "你看到什么": '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M1.8 8s2.4-4 6.2-4 6.2 4 6.2 4-2.4 4-6.2 4S1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.7"/></svg>',
  "已完成判断": '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M3 8.4l3.4 3.3L13 4.8"/></svg>',
  "证据材料": '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M4 2.4h5l3 3v8.2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1z"/><path d="M9 2.4v3h3"/></svg>',
  "证据": '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M4 2.4h5l3 3v8.2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1z"/><path d="M9 2.4v3h3"/></svg>',
  "流程卡（边答边生成）": '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="2" y="3.4" width="12" height="9.2" rx="2"/><path d="M5 6.8h6M5 9.4h3.6"/></svg>',
  "已确认事实": '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><circle cx="8" cy="8" r="5.6"/><path d="M5.4 8.2l1.8 1.7 3.4-3.6"/></svg>',
  "你的职责": '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.8"/><path d="M8 7.2v3.6M8 5.2v.6" stroke-linecap="round"/></svg>',
  "你的职责边界": '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="5.8"/><path d="M8 7.2v3.6M8 5.2v.6" stroke-linecap="round"/></svg>',
};
function blockTitle(text, cls = "pane-block__title") {
  const icon = BLOCK_ICONS[text];
  return `<div class="${cls}">${icon ? `<span class="pane-block__icon" aria-hidden="true">${icon}</span>` : ""}${text}</div>`;
}

function employeeStepIndex(task) {
  const status = task?.status || "";
  if (["awaiting_decision", "owner_decided", "complete"].includes(status)) return 2;
  if (["awaiting_verification", "blocked", "blocked_draft"].includes(status)) return 1;
  return 0;
}

function renderFormalEmployeeNav() {
  const task = state.formalEmployeeTask || {};
  const stepsEl = document.querySelector("#formal-employee-steps");
  const taskEl = document.querySelector("#formal-employee-task");
  const metaEl = document.querySelector("#formal-employee-nav-meta");
  const progressEl = document.querySelector("#formal-employee-nav-progress");
  const current = employeeStepIndex(task);

  if (metaEl) metaEl.textContent = `第 ${current + 1} / ${EMPLOYEE_STEPS.length} 步`;

  if (stepsEl) {
    stepsEl.innerHTML = EMPLOYEE_STEPS.map((step, index) => {
      const cls = index < current ? "is-done" : index === current ? "is-current" : "";
      return `<li class="${cls}"><span class="step-rail__dot">${index < current ? "✓" : index + 1}</span>` +
             `<span><span class="step-rail__name">${escapeMarkup(step.name)}</span>` +
             `<span class="step-rail__note">${escapeMarkup(step.note)}</span></span></li>`;
    }).join("");
  }

  if (taskEl) {
    taskEl.innerHTML =
      `<p class="task-name">${escapeMarkup(task.workName || task.title || "还原客户交接工作")}</p>` +
      `<p class="task-scope">${escapeMarkup(task.projectScope || "")}</p>`;
  }

  if (progressEl) {
    // PILOT-07/S6：进度以**服务端覆盖裁决**为准（已处理维度 / 必填维度），
    // 而不是前端"填了几个框"。固定题库降级时回落到计数口径。
    const coverage = state.formalCoverage;
    const answered = formalEmployeeQuestions.filter((q) => String(state.formalEmployeeAnswers[q.key] || "").trim()).length;
    const total = formalEmployeeQuestions.length;
    let label;
    let pct;
    if (coverage && coverage.dimensions) {
      const required = Object.entries(coverage.dimensions).filter(([, v]) => v.required !== false);
      const handled = required.filter(([, v]) => v.status && v.status !== "absent").length;
      pct = required.length ? Math.round((handled / required.length) * 100) : 0;
      label = `已了解 ${handled} / ${required.length} 个方面`;
    } else {
      pct = Math.round((answered / total) * 100);
      label = `已回答 ${answered} / ${total} 个问题`;
    }
    progressEl.innerHTML =
      `${blockTitle("本步进度", "pane-block__title")}` +
      `<div class="meter"><div class="meter__bar"><div class="meter__fill" style="width:${pct}%"></div></div>` +
      `<div class="meter__label">${escapeMarkup(label)}</div></div>` +
      formalEmployeeCoverageList() +
      formalEmployeeEndingNote() +
      // PILOT-04/D8：保存状态必须可见 —— 只有服务端确认后才显示"已保存"。
      formalEmployeeSaveBadge();
  }
}

/**
 * PILOT-07/S6：七维覆盖清单（业务化措辞，不暴露内部状态机术语）。
 * 员工只看到"已了解 / 还要说清楚 / 待他人确认"。
 */
function formalEmployeeCoverageList() {
  const coverage = state.formalCoverage;
  if (!coverage || !coverage.dimensions) return "";
  const business = {
    absent: "还没聊到",
    insufficient: "还需要说清楚",
    sufficient: "已了解",
    conflict_pending: "有地方对不上，待澄清",
    unknown_stated: "你说不确定",
    needs_external: "需要别人确认",
  };
  const rows = formalEmployeeQuestions
    .filter((q) => coverage.dimensions[q.key] && coverage.dimensions[q.key].required !== false)
    .map((q) => {
      const status = coverage.dimensions[q.key].status || "absent";
      const cls = status === "sufficient" ? "is-done" : status === "insufficient" || status === "absent" ? "is-todo" : "is-warn";
      return `<li class="coverage-row ${cls}"><span>${escapeMarkup(q.label)}</span><span>${escapeMarkup(business[status] || status)}</span></li>`;
    })
    .join("");
  if (!rows) return "";
  return `<ul class="coverage-list">${rows}</ul>`;
}

/** PILOT-07/S6：模型建议结束但服务端判定信息不足时，明确说明缺口。 */
function formalEmployeeEndingNote() {
  const note = state.formalEndingNote;
  if (!note) return "";
  return `<p class="ending-note">${escapeMarkup(note)}</p>`;
}

/**
 * PILOT-07/S6：引擎标识。
 * 固定题库只是**降级**机制；使用时不得让员工误以为是 AI 自主访谈。
 */
function formalEmployeeEngineBadge() {
  const engine = state.formalInterviewEngine;
  if (engine === "fixture") return '<span class="engine-badge is-fallback">固定问题模式（AI 暂不可用）</span>';
  if (engine === "harness" || engine === "model") return '<span class="engine-badge is-ai">AI 自主提问</span>';
  return "";
}

/**
 * PILOT-04/D8：自动保存状态徽标。
 * 只有服务端确认保存成功才显示"已保存"；失败必须显式可见，绝不静默。
 */
function formalEmployeeSaveBadge() {
  const stateName = state.formalEmployeeSaveState || "idle";
  const map = {
    idle:   { cls: "is-idle",   text: "尚未保存" },
    saving: { cls: "is-saving", text: "保存中…" },
    saved:  { cls: "is-saved",  text: "已保存" },
    error:  { cls: "is-error",  text: "保存失败，请重试" },
    stale:  { cls: "is-error",  text: "已在别处更新，请刷新" },
    conflict: { cls: "is-error", text: "保存冲突：已在别处更新，请刷新" },
  };
  const entry = map[stateName] || map.idle;
  const at = state.formalEmployeeSavedAt
    ? ` · ${new Date(state.formalEmployeeSavedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`
    : "";
  return `<span class="save-badge ${entry.cls}" role="status" aria-live="polite">${escapeMarkup(entry.text)}${escapeMarkup(at)}</span>`;
}

function renderFormalEmployeeThread() {
  const threadEl = document.querySelector("#formal-employee-thread");
  const metaEl = document.querySelector("#formal-employee-thread-meta");
  const task = state.formalEmployeeTask;
  if (!threadEl) return;

  // 回执 / 等待 / 补证 等状态仍然整段显示在对话区，不拆散。
  if (state.formalEmployeeStep === "waiting") {
    if (metaEl) metaEl.textContent = "等待核验人员";
    threadEl.innerHTML = renderFormalEmployeeReceipt({ waiting: true }) +
      `<p>核验人员就绪后，可从同一任务继续提交，不需要重新填写。</p>`;
    return;
  }
  if (state.formalEmployeeStep === "submitted") {
    const supplement = task?.supplementation;
    if (task?.status === "blocked" && supplement?.status === "waiting") {
      if (metaEl) metaEl.textContent = "待补充材料";
      threadEl.innerHTML = renderFormalEmployeeReceipt() +
        `<p class="panel-label">补充材料请求</p><h2>补充后将恢复同一事实核验</h2>` +
        `<p>核验人员暂时无法确认，不是要求你重新填写流程。请只补充下面这项已获授权的佐证说明。</p>` +
        `<dl class="workflow-card"><div><dt>需要补什么</dt><dd>${escapeMarkup(supplement.requestedMaterial)}</dd></div>` +
        `<div><dt>责任人</dt><dd>${escapeMarkup(supplement.responsiblePerson)}</dd></div>` +
        `<div><dt>截止时间</dt><dd>${escapeMarkup(supplement.deadline)}</dd></div></dl>` +
        `<label class="employee-label" for="formal-employee-supplement">我有材料可以提供</label>` +
        `<p class="field-help">这是员工提供的线索，不代表平台已经确认材料真实或可用于核验。</p>` +
        `<textarea id="formal-employee-supplement" rows="4" placeholder="例如：已授权的 OA 审批导出，包含申请编号和审批完成时间"></textarea>` +
        `<label class="employee-label" for="formal-employee-supplement-source">材料来源标识</label>` +
        `<input id="formal-employee-supplement-source" placeholder="例如：oa://exports/2026-08">`;
      return;
    }
    if (metaEl) metaEl.textContent = "已提交";
    threadEl.innerHTML = renderFormalEmployeeReceipt() +
      `<p>核验人员会核对关键事实；如需补证，本页会显示一项明确的材料请求。</p>`;
    return;
  }
  if (state.formalEmployeeStep === "card") {
    if (metaEl) metaEl.textContent = "流程卡";
    threadEl.innerHTML = renderFormalWorkflowCard();
    return;
  }
  if (state.formalEmployeeStep === "intro") {
    if (metaEl) metaEl.textContent = "未开始";
    threadEl.innerHTML =
      threadDivider("项目邀请 · 企业授权已确认") +
      `<div class="msg"><span class="msg__avatar">AI</span><div>` +
      `<div class="msg__head">为什么邀请你</div><div class="msg__text">${escapeMarkup(task?.invitationReason || "")}</div></div></div>` +
      `<div class="msg"><span class="msg__avatar">AI</span><div>` +
      `<div class="msg__head">要还原的工作</div><div class="msg__text">${escapeMarkup(task?.workName || "")}\n${escapeMarkup(task?.projectScope || "")}</div></div></div>` +
      `<div class="msg msg--pending"><span class="msg__avatar">AI</span><div>` +
      `<div class="msg__head">Agent 会先问</div><div class="msg__text">${escapeMarkup(task?.firstQuestion || "")}</div></div></div>`;
    return;
  }

  // 正常摸排：把已答的每一轮都留在对话里，当前问题挂在最后。
  const agentQuestion = state.formalAgentQuestion;
  const fallbackIndex = Math.max(0, formalUiContract.employeeQuestionIndex(
    state.formalEmployeeAnswers, state.formalEmployeeEditIndex, formalEmployeeQuestions.length));
  const question = agentQuestion || formalEmployeeQuestions[fallbackIndex];

  const answered = formalEmployeeQuestions
    .map((q, index) => ({ q, index, answer: String(state.formalEmployeeAnswers[q.key] || "").trim() }))
    .filter((entry) => entry.answer);

  if (metaEl) {
    metaEl.textContent = agentQuestion
      ? `第 ${answered.length + 1} 问 · 自适应`
      : `第 ${fallbackIndex + 1} / ${formalEmployeeQuestions.length} 问`;
  }

  const history = answered.map((entry) =>
    `<div class="msg msg--me"><span class="msg__avatar">我</span><div>` +
    `<div class="msg__step">第 ${entry.index + 1} 问 · ${escapeMarkup(entry.q.label)}</div>` +
    `<div class="msg__text">${escapeMarkup(entry.answer)}</div></div></div>`
  ).join("");

  const currentMsg =
    `<div class="msg"><span class="msg__avatar">AI</span><div>` +
    `<div class="msg__step">第 ${agentQuestion ? answered.length + 1 : fallbackIndex + 1} 问</div>` +
    `<div class="msg__head">${escapeMarkup(question.label)}</div>` +
    `<div class="msg__text">${escapeMarkup(question.prompt)}</div></div></div>`;

  const divider = answered.length
    ? threadDivider(`本轮摸排 · 已答 ${answered.length} 问`)
    : threadDivider("摸排开始 · 自适应提问");

  threadEl.innerHTML = divider + (history || `<p class="thread-empty">共 ${formalEmployeeQuestions.length} 个问题，一次只问一个。</p>`) + currentMsg +
    (state.formalAgentThinking
      ? `<div class="msg msg--pending"><span class="msg__avatar">AI</span><div><div class="msg__text">正在根据你的回答追问…</div></div></div>`
      : "");
}

function renderFormalEmployeeTrace() {
  const traceEl = document.querySelector("#formal-employee-trace");
  if (!traceEl) return;
  const task = state.formalEmployeeTask || {};
  const materialStatus = state.formalEmployeeMaterialStatus;

  const materialLabel = materialStatus === "provided" ? "员工声明有已授权材料"
    : materialStatus === "none_available" ? "员工声明暂无可提供材料" : "尚未选择";

  const cardFields = [
    ["trigger", "触发条件"],
    ["inputs", "先看什么"],
    ["steps", "实际怎么做"],
    ["judgments", "不能自己决定的情况"],
    ["exceptions", "卡住后怎么办"],
  ];

  const cardCards = cardFields.map(([key, label]) => {
    const value = String(state.formalEmployeeAnswers[key] || "").trim();
    return `<div class="trace-card ${value ? "" : "trace-card--pending"}">` +
      `<div class="trace-card__label">${escapeMarkup(label)}` +
      `${value ? '<span class="trace-badge trace-badge--done">已还原</span>' : '<span class="trace-badge">待还原</span>'}</div>` +
      `<div class="trace-card__value">${value ? escapeMarkup(value) : "还没有回答"}</div></div>`;
  }).join("");

  traceEl.innerHTML =
    `<div class="trace-block">${blockTitle("证据材料", "trace-block__title")}` +
    `<div class="trace-card"><div class="trace-card__label">材料状态</div>` +
    `<div class="trace-card__value">${escapeMarkup(materialLabel)}</div></div>` +
    `<div class="trace-card trace-card--pending"><div class="trace-card__value">` +
    `已登记的材料会显示在核验人员一侧；这里的描述只是线索，不构成已确认事实。</div></div></div>` +
    `<div class="trace-block">${blockTitle("流程卡（边答边生成）", "trace-block__title")}${cardCards}</div>`;
}

// 只有真正在输入的状态才显示状态条，避免在 intro / 流程卡步骤留下空条。
// 居中的阶段分隔，像桌面客户端的日期分隔一样，把长对话切成可读的段落。
// ── 入场动效只作用于"新出现"的内容 ──────────────────────────────
// 这几个面板每次都用 innerHTML 整段重建，浏览器因此认为所有元素都是新的，
// CSS 里的入场动画会在每次回答后对整段对话重播一遍 —— 用户看到的就是
// "每答一题页面刷新一次"。这里的做法是记住上一次渲染的元素个数，
// 对已经存在过的元素直接把动画关掉，只让新增的那几条入场。
const FADE_TRACK = new WeakMap();
// ── 对话区自动贴底 ───────────────────────────────────────────
// 核验人的内容比可视区高时，"你的判断"会被切在屏幕外，
// 而它是这一屏唯一要操作的东西。所以渲染后自动贴底；
// 但用户主动往上翻过就不要抢他的位置。
const THREAD_AT_BOTTOM = new WeakMap();
function noteThreadScroll(container) {
  if (!container) return;
  THREAD_AT_BOTTOM.set(container, container.scrollHeight - container.scrollTop - container.clientHeight < 80);
}
document.addEventListener("scroll", (event) => {
  const el = event.target;
  if (el && el.classList && el.classList.contains("pane-body")) noteThreadScroll(el);
}, true);

function keepThreadPinned(container) {
  if (!container) return;
  if (THREAD_AT_BOTTOM.get(container) === false) return;
  container.scrollTop = container.scrollHeight;
  THREAD_AT_BOTTOM.set(container, true);
}

function fadeOnlyNew(container, selector = ":scope > *") {
  if (!container) return;
  const items = Array.from(container.querySelectorAll(selector));
  // 按"内容"而不是"位置"判断是不是新出现的。
  // 一次操作会触发多次渲染，按位置判断会把刚加进来的那条也误判成旧的，
  // 结果新内容完全没有入场动效。
  const previous = FADE_TRACK.get(container) || [];
  const signature = (el) => (el.innerText || "").replace(/\s+/g, " ").slice(0, 120);
  const current = items.map(signature);
  items.forEach((el, index) => {
    if (previous.includes(current[index])) el.style.animation = "none";
  });
  FADE_TRACK.set(container, current);
}
function resetFadeTracking(container) {
  if (container) FADE_TRACK.delete(container);
}

function threadDivider(text) {
  return `<div class="thread-divider"><span>${escapeMarkup(text)}</span></div>`;
}

function needsStatusBar() {
  return !["intro", "waiting", "card", "submitted"].includes(state.formalEmployeeStep);
}

// 就地刷新"已判定 n / N 条"，避免为了一个数字重绘整份流程卡。
function updateInferenceSummary() {
  const inferences = state.formalAgentInferences || [];
  if (!inferences.length) return;
  // U5：汇总计数必须与 U2 使用**同一判定有效性规则**（stale 不计入已完成）。
  const summary = formalInferenceSummary(formalVisibleInferences(), state.formalInferenceVerdicts || {});
  const note = document.querySelector(".wfc-inference-summary");
  if (!note) return;
  note.classList.toggle("wfc-note--warn", summary.valid < summary.total || summary.stale > 0);
  const parts = [];
  if (summary.stale) parts.push(`${summary.stale} 条依据已更新需重新确认`);
  if (summary.unjudged) parts.push(`${summary.unjudged} 条未判定`);
  note.textContent = `已完成判定 ${summary.valid} / ${summary.total} 条` +
    (summary.corrections ? ` · 其中 ${summary.corrections} 条已确认更正` : "") + "。" +
    (parts.length ? `还有 ${parts.join("、")}。未完成判定的推断不会进入事实核验。` : "全部推断均已按当前依据完成判定。");
}

function renderFormalEmployeeComposer() {
  const actionsEl = document.querySelector("#formal-employee-composer-actions");
  const input = document.querySelector("#formal-employee-answer");
  if (!actionsEl) return;

  let buttons = "";
  if (state.formalEmployeeStep === "intro") {
    buttons = `<button class="primary-button" type="button" data-action="start-formal-employee">开始还原我的工作</button>`;
  } else if (state.formalEmployeeStep === "waiting") {
    buttons = `<button class="primary-button" type="button" data-action="recheck-formal-employee" ${state.formalEmployeeRechecking ? "disabled" : ""}>${state.formalEmployeeRechecking ? "正在检查…" : "重新检查并继续提交"}</button>`;
  } else if (state.formalEmployeeStep === "submitted") {
    const supplement = state.formalEmployeeTask?.supplementation;
    if (state.formalEmployeeTask?.status === "blocked" && supplement?.status === "waiting") {
      buttons = `<button class="primary-button" type="button" data-action="submit-formal-employee-supplement" ${state.formalEmployeeSupplementing ? "disabled" : ""}>${state.formalEmployeeSupplementing ? "正在提交…" : "提交补充材料"}</button>`;
    } else {
      buttons = `<button class="secondary-button" type="button" data-action="refresh-formal-employee">刷新当前任务</button>`;
    }
  } else if (state.formalEmployeeStep === "card") {
    // 材料状态必须在这里也能选：提交守卫要求它不是 undecided，
    // 而问答步骤才渲染这个选择器时，用户到这一步会被静默挡住，界面毫无反应。
    buttons = `<fieldset class="composer__material"><legend>材料状态</legend>` +
      `<label><input type="radio" name="formal-material-status" value="provided" ${state.formalEmployeeMaterialStatus === "provided" ? "checked" : ""}> 有已授权材料</label>` +
      `<label><input type="radio" name="formal-material-status" value="none_available" ${state.formalEmployeeMaterialStatus === "none_available" ? "checked" : ""}> 暂时没有</label>` +
      `</fieldset>` +
      `<button class="secondary-button" type="button" data-action="edit-formal-employee">返回修改</button>` +
      `<button class="primary-button" type="button" data-action="submit-formal-employee" ${(state.formalEmployeeSubmitting || formalInferenceCapacityMarker()) ? "disabled" : ""}>${state.formalEmployeeSubmitting ? "正在提交…" : (formalInferenceCapacityMarker() ? "存在未处理推断，暂不可提交" : "确认并提交核验")}</button>`;
  } else {
    buttons = `<fieldset class="composer__material"><legend>材料状态</legend>` +
      `<label><input type="radio" name="formal-material-status" value="provided" ${state.formalEmployeeMaterialStatus === "provided" ? "checked" : ""}> 有已授权材料</label>` +
      `<label><input type="radio" name="formal-material-status" value="none_available" ${state.formalEmployeeMaterialStatus === "none_available" ? "checked" : ""}> 暂时没有</label>` +
      `</fieldset>` +
      `<button class="secondary-button" type="button" data-action="save-formal-employee-draft" ${state.formalEmployeeSaving ? "disabled" : ""}>${state.formalEmployeeSaving ? "保存中…" : "保存草稿"}</button>` +
      `<button class="primary-button" type="button" data-action="continue-formal-employee" ${state.formalAgentThinking || state.formalEmployeeSaving ? "disabled" : ""}>${state.formalAgentThinking ? "追问中…" : "回答并继续"}</button>`;
  }
  // 底部状态条：像桌面客户端那样把"当前状态 + 快捷键"常驻在输入区，
  // 而不是让用户从占位文字里去找。
  // PILOT-04/D1：维度已补齐为 7 个（与后端 QUESTION_BANK 一致），
  // 因此计数与总数同源，不会再出现"已完成 7 / 5 问"这种矛盾读数。
  const totalQuestions = formalEmployeeQuestions.length;
  const answeredCount = formalEmployeeQuestions
    .filter((q) => String(state.formalEmployeeAnswers?.[q.key] || "").trim()).length;
  const statusBar = needsStatusBar()
    ? `<div class="composer__status">` +
      `<span class="composer__status-item"><span class="composer__dot"></span>已完成 ${answeredCount} / ${totalQuestions} 问</span>` +
      `<span class="composer__status-sep"></span>` +
      formalEmployeeEngineBadge() +
      `<span class="composer__status-item">Enter 发送 · Shift + Enter 换行</span>` +
      formalEmployeeSaveBadge() +
      `</div>`
    : "";
  actionsEl.innerHTML = buttons + statusBar;

  // 输入框只在真正需要输入的状态出现
  const needsInput = !["intro", "waiting", "card"].includes(state.formalEmployeeStep) &&
    !(state.formalEmployeeStep === "submitted");
  if (input) {
    input.hidden = !needsInput;
    if (needsInput && document.activeElement !== input) {
      const agentQuestion = state.formalAgentQuestion;
      const fallbackIndex = Math.max(0, formalUiContract.employeeQuestionIndex(
        state.formalEmployeeAnswers, state.formalEmployeeEditIndex, formalEmployeeQuestions.length));
      const question = agentQuestion || formalEmployeeQuestions[fallbackIndex];
      const editing = Number.isInteger(state.formalEmployeeEditIndex) && state.formalEmployeeEditIndex >= 0;
      // 只有“回到某条历史回答去改”时才回填；正常前进时留空。
      // 否则 Agent 追问同一题时会把上一轮的答案又填回来，用户以为没提交成功。
      input.value = editing ? (state.formalEmployeeAnswers[question.key] || "") : "";
    }
  }
}

function renderFormalEmployeeWorkbench() {
  const nav = document.querySelector(".shell-pane--nav");
  const thread = document.querySelector(".shell-pane--thread");
  const trace = document.querySelector(".shell-pane--trace");
  const composer = document.querySelector("#formal-employee-composer");
  const ready = Boolean(state.formalEmployeeTask) && state.formalEmployeeStep !== "loading";

  if (nav) nav.hidden = !ready;
  if (thread) thread.hidden = !ready;
  if (trace) trace.hidden = !ready;
  // 确认流程卡时这是屏幕上最重要的东西：收掉左右两栏，
  // 把宽度让给七列的步骤明细，否则每一格都被挤成三五个字一行。
  const shell = document.querySelector("#formal-employee-view .app-shell");
  if (shell) shell.classList.toggle("app-shell--document", ready && state.formalEmployeeStep === "card");
  if (composer) composer.hidden = !ready;

  if (!ready) {
    const target = document.querySelector("#formal-employee-thread") || formalEmployeeWorkbench;
    if (target) target.innerHTML = '<p role="status">正在读取你的摸排任务…</p>';
    return;
  }
  renderFormalEmployeeNav();
  renderFormalEmployeeThread();
  renderFormalEmployeeTrace();
  renderFormalEmployeeComposer();
  // 只让新消息入场，否则每次回答都会把整段对话重播一遍动画。
  fadeOnlyNew(document.querySelector("#formal-employee-thread"), ".msg, .thread-divider");
  keepThreadPinned(document.querySelector("#formal-employee-thread"));
  fadeOnlyNew(document.querySelector("#formal-employee-trace"), ".trace-block");
}


/**
 * PILOT-08E/D1：判定词汇边界映射（服务端 → 前端）。
 *
 * 服务端在边界处把判定规范化为 confirmed / corrected / unjudged
 * （PILOT-07C/R2，避免前后端词汇漂移）。但前端渲染模板与事件处理器用的是
 * agree / correct 两个值。此前回填时**直接沿用服务端值**，导致：
 *   · 单选按钮的 checked 判据（v.verdict === "agree" / "correct"）永远不成立；
 *   · 刷新后判定"看起来丢了"（其实服务端一直在）。
 * 这里在回填边界统一翻译，让前端状态重新回到自己的词汇。
 */
function formalVerdictToClientVerdict(serverVerdict) {
  const v = String(serverVerdict || "");
  if (v === "confirmed") return "agree";
  if (v === "corrected") return "correct";
  return "";   // unjudged / 未知 → 视为未判定，绝不猜测
}

// ── PILOT-09C/IMPLEMENT-2D：推断的**展示态** ─────────────────────────────────
// 有效性 = 服务端盖章版本 与 当前条目版本 一致。两侧字段都来自服务端，
// 客户端不自行宣布 valid（U6）；stale = 依据已更新、必须重新确认（U3）。
function formalIsCapacityMarker(entry) {
  return Boolean(entry && (entry.source === "capacity_block" || entry.isCapacityMarker === true));
}
function formalInferenceJudgmentState(entry, verdicts, priorVerdicts) {
  if (!entry || !entry.id) return "unjudged";
  if (formalIsCapacityMarker(entry)) return "capacity_block";
  const v = (verdicts || {})[entry.id];
  if (v && v.verdict) {
    const verdictVersion = Number.isInteger(v.contentVersion) ? v.contentVersion : null;
    if (verdictVersion === null) return "stale";            // 旧数据无版本信息 → 不得认定有效
    const entryVersion = Number.isInteger(entry.contentVersion) ? entry.contentVersion : null;
    if (entryVersion !== null && verdictVersion !== entryVersion) return "stale";
    const entryTemplate = entry.templateVersion === undefined ? null : entry.templateVersion;
    const verdictTemplate = v.templateVersion === undefined ? null : v.templateVersion;
    if (entryTemplate !== null && verdictTemplate !== entryTemplate) return "stale";
    // F03：判定还必须绑定推断的证据版本；答案变化后旧裁决必须显示为"依据已更新"。
    if (Number.isInteger(entry.evidenceVersion)) {
      const verdictEvidenceVersion = Number.isInteger(v.evidenceVersion) ? v.evidenceVersion : null;
      if (verdictEvidenceVersion === null || verdictEvidenceVersion !== entry.evidenceVersion) return "stale";
    }
    return "valid";
  }
  // PILOT-09C/FIX-2F（D-2）：过期判定被**移出有效镜像**（防止再次保存时被按新版本重新盖章），
  // 但它的**展示信息必须保留** —— 否则界面会从"依据已更新"退回"尚未判定"，U3 要求落空。
  // 因此这里再查一次"过期判定"表：只要该条目存在过期判定，就仍然是 stale。
  const priorMap = priorVerdicts !== undefined ? priorVerdicts : (state.formalInferencePriorVerdicts || {});
  const prior = priorMap[entry.id];
  if (prior && prior.verdict) return "stale";
  return "unjudged";
}
function formalInferenceCapacityMarker() {
  return (state.formalAgentInferences || []).find(formalIsCapacityMarker) || null;
}
/** 界面上可判定的条目：排除容量标记与溢出条目（溢出条目服务端不允许在界面判定） */
/**
 * PILOT-09C/IMPLEMENT-3D（H-1）：员工陈述历史 —— **只读展示**。
 *
 * 目的：让"早期陈述 / 明确不知道 / 补充 / 纠正 / 冲突"在界面上可追溯，
 * 而不是只在数据库里存在。该区块**只读**，不参与判定、覆盖与提交门禁。
 */
const FORMAL_HISTORY_DIMENSION_LABELS = {
  trigger: "触发条件", inputs: "看什么", steps: "实际怎么做",
  judgments: "卡住怎么判断", exceptions: "不能自己决定的情况",
  handoff: "卡住后怎么办", burden: "耗时与人力",
};
const FORMAL_HISTORY_KIND_LABELS = {
  initial: "首次陈述", supplement: "补充", correction: "明确纠正",
  unknown: "明确不知道", conflict_pending: "存在冲突待澄清",
};
function formalStatementHistorySection() {
  const task = state.formalEmployeeTask || {};
  const ledger = task.draftLedger || task.draft?.ledger || null;
  const history = ledger && Array.isArray(ledger.statementHistory) ? ledger.statementHistory : [];
  if (!history.length) return "";
  const byDimension = new Map();
  for (const entry of history) {
    if (!entry || !entry.dimension || !entry.text) continue;
    const bucket = byDimension.get(entry.dimension) || [];
    bucket.push(entry);
    byDimension.set(entry.dimension, bucket);
  }
  // 只展示"有故事"的维度：多轮，或出现「不知道 / 纠正 / 冲突」
  const notable = [...byDimension.entries()].filter(([, entries]) => entries.length > 1
    || entries.some((e) => ["unknown", "correction", "conflict_pending"].includes(e.kind)));
  if (!notable.length) return "";
  const rows = notable.map(([dimension, entries]) => {
    const label = FORMAL_HISTORY_DIMENSION_LABELS[dimension] || dimension;
    const items = entries.map((entry) => {
      const kindLabel = FORMAL_HISTORY_KIND_LABELS[entry.kind] || entry.kind;
      const rev = Number.isInteger(entry.turnRevision) ? `第 ${entry.turnRevision + 1} 轮` : "";
      return `<li style="margin:2px 0;"><span style="font-size:12px;padding:1px 6px;border-radius:8px;background:#eef2f7;color:#334;">${escapeMarkup(kindLabel)}</span> <span style="color:#555;font-size:12px;">${escapeMarkup(rev)}</span> 「${escapeMarkup(entry.text)}」</li>`;
    }).join("");
    return `<li style="margin:6px 0;"><strong>${escapeMarkup(label)}</strong><ul style="margin:4px 0 0 16px;padding:0;list-style:disc;">${items}</ul></li>`;
  }).join("");
  return `<section class="wfc-sec">
<h3 class="wfc-h">你的陈述历史</h3>
<p class="wfc-dim">同一个维度你回答过多次时，之前的原话不会被覆盖 —— 下面是服务端保存的完整记录（只读）。</p>
<ul style="margin:0;padding:0;list-style:none;">${rows}</ul>
</section>`;
}

function formalVisibleInferences() {
  return (state.formalAgentInferences || []).filter((e) => e && e.id && !formalIsCapacityMarker(e) && e.listed !== false);
}
function formalInferenceSummary(inferences, verdicts) {
  const list = (Array.isArray(inferences) ? inferences : formalVisibleInferences())
    .filter((e) => e && e.id && !formalIsCapacityMarker(e) && e.listed !== false);
  let valid = 0; let stale = 0; let unjudged = 0; let corrections = 0;
  for (const entry of list) {
    const jstate = formalInferenceJudgmentState(entry, verdicts);
    if (jstate === "valid") {
      valid += 1;
      const v = (verdicts || {})[entry.id];
      if (v && v.verdict === "correct") corrections += 1;
    } else if (jstate === "stale") stale += 1;
    else unjudged += 1;
  }
  return { total: list.length, valid, stale, unjudged, corrections };
}
/** 由**服务端返回**的盖章判定重建本地镜像（U6）；stale 不进入权威镜像，避免被再次提交"变有效" */
function applyServerInferenceVerdicts(rawVerdicts) {
  const source = rawVerdicts && typeof rawVerdicts === "object" ? rawVerdicts : {};
  const byId = new Map((state.formalAgentInferences || []).map((e) => [e && e.id, e]));
  state.formalInferenceVerdicts = {};
  state.formalInferencePriorVerdicts = {};
  for (const [id, entry] of Object.entries(source)) {
    if (!entry || typeof entry !== "object" || typeof entry.verdict !== "string") continue;
    const clientVerdict = formalVerdictToClientVerdict(entry.verdict);
    if (!clientVerdict) continue;
    state.formalInferenceVerdicts[id] = { verdict: clientVerdict, correction: entry.correction || "" };
    // 版本字段只做**只读镜像**（服务端盖章值），客户端不会回传它们参与裁决
    state.formalInferenceVerdicts[id].contentVersion =
      Number.isInteger(entry.contentVersion) ? entry.contentVersion : null;
    state.formalInferenceVerdicts[id].templateVersion =
      Number.isInteger(entry.templateVersion) ? entry.templateVersion : null;
    state.formalInferenceVerdicts[id].evidenceHash = entry.evidenceHash || null;
    state.formalInferenceVerdicts[id].evidenceVersion =
      Number.isInteger(entry.evidenceVersion) ? entry.evidenceVersion : null;
    const target = byId.get(id);
    const displayState = target ? formalInferenceJudgmentState(target, state.formalInferenceVerdicts) : "stale";
    if (displayState === "stale") {
      // 过期判定**移出权威镜像**（仅作为"上次判定"提示保留），否则下一次保存会把它
      // 按当前版本重新盖章，"未重新确认"就变成了有效 —— 正是 U4/§八-3 要杜绝的。
      state.formalInferencePriorVerdicts[id] = state.formalInferenceVerdicts[id];
      delete state.formalInferenceVerdicts[id];
    }
  }
  state.formalInferencePending = {};
}

/** 只发送"判定动作"；版本字段一律由服务端盖章（§五） */
function formalVerdictsPayload() {
  // PILOT-09C/FIX-3B（S-1）：只发送**待保存判定**，并回显"员工在界面上看到的版本"。
  // 回显字段是**待验证声明**：服务端会与库中条目逐字段比对，不一致则不盖章。
  // 已保存的有效判定不再重复发送（服务端按既有记录结转），避免无意义的重新盖章。
  const pending = state.formalInferencePending || {};
  const byId = new Map((state.formalAgentInferences || []).map((e) => [e && e.id, e]));
  const out = {};
  for (const [id, entry] of Object.entries(pending)) {
    const target = byId.get(id);
    if (!entry || !entry.verdict || !target) continue;
    out[id] = {
      verdict: entry.verdict,
      correction: entry.correction || "",
      // 只读镜像（来自服务端下发的条目），不是客户端自造的版本
      contentVersion: Number.isInteger(target.contentVersion) ? target.contentVersion : null,
      templateVersion: target.templateVersion === undefined ? null : target.templateVersion,
      evidenceHash: target.evidenceHash || null,
      // F03：证据版本回显（服务端逐字段校验；不一致则不盖章，旧裁决不得自动升级）
      evidenceVersion: Number.isInteger(target.evidenceVersion) ? target.evidenceVersion : null,
    };
  }
  return out;
}

function applyFormalEmployeeTaskPayload(payload) {
  const task = payload.task;
  // PILOT-04/N3：draftAnswers 已由服务端归一化（_shared.js normalizeEmployeeDraft），
  // 这里只按题目键取值 —— 不再整体展开草稿对象。旧版扁平格式由服务端兼容，
  // 因此历史数据不会读坏；ledger 等内部状态走 draftLedger，绝不进入答案集。
  const draftAnswers = task.draftAnswers || {};
  const draftLedger = task.draftLedger || null;
  const workflowCard = task.workflowCard || {};
  state.formalEmployeeTask = task;
  state.formalEmployeeReceipt = payload.receipt || null;
  // ── PILOT-09C/FIX-CODEX-02B（F02）：把服务端真实草稿版本恢复为本地并发基准 ──
  // 旧实现从不从 task.draftRevision 初始化（恒为 0）：页面加载/刷新后既不能正确携带版本，
  // 也无法在冲突后重新获得服务端当前 revision。这里以服务端下发值为唯一来源。
  if (Number.isInteger(task.draftRevision)) state.formalInterviewRevision = task.draftRevision;
  const restored = {};
  for (const { key } of formalEmployeeQuestions) restored[key] = draftAnswers[key] || workflowCard[key] || "";
  state.formalEmployeeAnswers = restored;
  // 恢复访谈上下文：追问计数与未解决项必须一起回来，否则刷新后 Agent 会从头追问。
  state.formalInterviewLedger = draftLedger || null;
  // PILOT-07/S6：切换任务/刷新时清空上一任务的覆盖裁决与结束提示，
  // 避免把旧任务的进度显示到新任务上。真实进度由下一轮服务端裁决填充。
  state.formalCoverage = null;
  state.formalEndingNote = "";
  state.formalInterviewEngine = "";
  // ── PILOT-08E/D1：从**服务端权威基线**恢复 AI 推断列表 ────────────────
  // PILOT-09C/IMPLEMENT-2D：恢复时**必须保留服务端下发的证据与版本字段**
  // （quote / source / contentVersion / templateVersion / evidenceHash / listed）。
  // 旧实现只挑 id/text/basis/assumes，会把 quote 与版本全部丢掉，
  // 导致界面既看不到证据、也无法判断判定是否过期。
  const baselineInferences = (() => {
    const ledger = task.draftLedger || task.draft?.ledger || null;
    return ledger && Array.isArray(ledger.authoritativeInferences) ? ledger.authoritativeInferences : [];
  })();
  if (baselineInferences.length) {
    state.formalAgentInferences = baselineInferences
      .filter((entry) => entry && entry.id && entry.text)
      .map((entry) => ({
        id: entry.id,
        text: entry.text,
        basis: entry.basis || null,
        assumes: entry.assumes || null,
        // ★ 服务端可信字段，原样镜像（客户端不修改、不回传参与裁决）
        source: entry.source === "server_template" || entry.source === "capacity_block" ? entry.source : "model",
        quote: entry.quote || null,
        evidenceHash: entry.evidenceHash || null,
        contentVersion: Number.isInteger(entry.contentVersion) ? entry.contentVersion : null,
        templateVersion: Number.isInteger(entry.templateVersion) ? entry.templateVersion : null,
        evidenceVersion: Number.isInteger(entry.evidenceVersion) ? entry.evidenceVersion : null,
        listed: entry.listed !== false,
        isCapacityMarker: entry.isCapacityMarker === true,
        capacityBlockedCount: Number.isInteger(entry.capacityBlockedCount) ? entry.capacityBlockedCount : 0,
      }));
  }
  // U6/§五：以服务端盖章判定重建本地镜像（必须在基线恢复之后，才能比对版本）
  applyServerInferenceVerdicts(task.draftInferenceVerdicts);
  state.formalEmployeeMaterialStatus = task.materialStatus || "undecided";
}

async function loadFormalEmployeeTask(projectId) {
  state.formalSessionActive = true;
  state.formalProjectId = projectId;
  showView("formal-employee-view");
  try {
    const payload = await window.diagnosticApi.getEmployeeTask(projectId);
    applyFormalEmployeeTaskPayload(payload);
    // PILOT-09C/FIX-CODEX-02B（F02）：重新加载任务 = 接受服务端最新状态，解除冲突闩锁。
    // （只有这条路径可以解除：冲突后禁止自动重试并覆盖服务端较新内容。）
    state.formalEmployeeConflict = false;
    state.formalEmployeeSaveState = "idle";
    state.formalEmployeeStep = formalUiContract.employeeStepForTask(payload.task, payload.receipt || {});
    // PILOT-08C/B7：刷新恢复。`employeeStepForTask` 只区分 intro/submitted/waiting，
    // 永远不会给出 "card" —— 于是**刷新后始终回到 intro**，员工此前完成的流程卡与
    // 逐条推断判定再也看不到（PILOT-08B B7）。这里按"答案是否齐全"补一次判定：
    // 齐全即回到流程卡，让已落库的判定/更正重新可见、可继续提交；
    // 未齐全仍留在 intro/questions，不会跳过任何采集步骤。
    if (state.formalEmployeeStep === "intro") {
      const reloadAnswers = state.formalEmployeeAnswers || {};
      const allAnswered = formalEmployeeQuestions.every(({ key }) => String(reloadAnswers[key] || "").trim());
      if (allAnswered) state.formalEmployeeStep = "card";
    }
    renderFormalEmployeeWorkbench();
  } catch (error) {
    const target = document.querySelector("#formal-employee-thread");
    if (target) target.innerHTML = `<div role="alert"><h2>暂时无法打开任务</h2><p>${escapeMarkup(error.message)}</p></div>`;
  }
}

async function recheckFormalEmployeeAssignment() {
  if (state.formalEmployeeRechecking) return;
  state.formalEmployeeRechecking = true;
  renderFormalEmployeeWorkbench();
  try {
    const payload = await window.diagnosticApi.getEmployeeTask(state.formalProjectId);
    applyFormalEmployeeTaskPayload(payload);
    // F02：主动重新检查 = 重新取得服务端版本，解除冲突闩锁。
    state.formalEmployeeConflict = false;
    state.formalEmployeeSaveState = "idle";
    const hasCompleteCard = formalEmployeeQuestions.every(({ key }) => state.formalEmployeeAnswers[key]);
    if (!payload.task.submissionReady) {
      state.formalEmployeeStep = "waiting";
      showMessage("核验人员尚未加入，流程卡已继续保留。请稍后重新检查。");
    } else {
      state.formalEmployeeStep = hasCompleteCard ? "card" : "questions";
      showMessage(hasCompleteCard ? "核验人员已就绪，请再次确认流程卡并提交。" : "核验人员已就绪，请补全流程描述后提交。");
    }
  } catch (error) {
    showMessage(`暂时无法重新检查：${error.message}`);
  } finally {
    state.formalEmployeeRechecking = false;
    renderFormalEmployeeWorkbench();
  }
}

function renderFormalOwnerWorkspace() {
  const packet = state.formalOwnerPacket;
  const stepsEl = document.querySelector("#owner-steps");
  const taskEl = document.querySelector("#owner-task");
  const navMeta = document.querySelector("#owner-nav-meta");
  const navNote = document.querySelector("#owner-nav-note");
  const threadEl = document.querySelector("#owner-thread");
  const threadMeta = document.querySelector("#owner-thread-meta");
  const traceEl = document.querySelector("#owner-trace");
  const composerEl = document.querySelector("#owner-composer-inner");
  if (!threadEl) return;

  if (stepsEl) {
    stepsEl.innerHTML = EMPLOYEE_STEPS.map((step, index) => {
      const cls = index < 2 ? "is-done" : index === 2 ? "is-current" : "";
      return `<li class="${cls}"><span class="step-rail__dot">${index < 2 ? "✓" : index + 1}</span>` +
             `<span><span class="step-rail__name">${escapeMarkup(step.name)}</span>` +
             `<span class="step-rail__note">${escapeMarkup(step.note)}</span></span></li>`;
    }).join("");
  }

  const paintNav = (title, scope, note) => {
    if (navMeta) navMeta.textContent = "第 3 / 3 步";
    if (taskEl) taskEl.innerHTML = `<p class="task-name">${escapeMarkup(title)}</p>` +
      (scope ? `<p class="task-scope">${escapeMarkup(scope)}</p>` : "");
    if (navNote) {
      navNote.innerHTML = note
        ? `${blockTitle("你看到什么", "pane-block__title")}<div class="trace-card"><div class="trace-card__value">${escapeMarkup(note)}</div></div>`
        : "";
    }
  };

  if (!packet) {
    const viewState = formalUiContract.ownerWorkspaceState(state.formalOwnerError || new Error("还没有可审阅的决策摘要"));
    paintNav("待决策事项", "", "只审阅已确认事实形成的摘要，不展示原始材料。");
    if (threadMeta) threadMeta.textContent = viewState.kind === "empty" ? "暂无事项" : "加载失败";
    threadEl.innerHTML = `<div class="msg"><span class="msg__avatar">AI</span><div>` +
      `<div class="msg__head">${escapeMarkup(viewState.title)}</div>` +
      `<div class="msg__text">${escapeMarkup(viewState.message)}</div></div></div>`;
    if (traceEl) traceEl.innerHTML = `<div class="trace-block">${blockTitle("已确认事实", "trace-block__title")}<div class="trace-card trace-card--pending"><div class="trace-card__value">还没有已确认的事实。</div></div></div>`;
    if (composerEl) {
      composerEl.innerHTML = viewState.kind === "error"
        ? `<div class="composer__actions"><button class="secondary-button" type="button" data-action="retry-formal-owner">重新加载</button></div>`
        : "";
    }
    return;
  }

  const receipt = state.formalOwnerReceipt || packet.decisionReceipt;
  const facts = packet.confirmedFacts || [];
  paintNav("审阅决策摘要", packet.pilotScope, "只审阅已确认事实形成的风险与影子试点摘要，不展示原始材料。");
  if (threadMeta) threadMeta.textContent = `已发布摘要 · v${escapeMarkup(packet.version)}`;

  // 中栏：要决策的那件事
  // V0.1 B-01/B-02：依据失效时必须先看到失效告知，再看到原摘要。
  // 历史决策记录保留，但绝不能让人误以为它仍然有效。
  const invalidationNotice = packet.invalidation?.stale
    ? `<div class="stale-banner" role="alert"><strong>${escapeMarkup("本摘要的依据已失效")}</strong>` +
      `<span>${escapeMarkup(packet.invalidation.notice || "所依据的事实已被修正或撤回，不能继续作为决策依据。")}</span>` +
      (packet.invalidation.reason ? `<small>${escapeMarkup(`原因：${packet.invalidation.reason}`)}</small>` : "") +
      `</div>`
    : "";
  threadEl.innerHTML =
    invalidationNotice +
    `<div class="msg"><span class="msg__avatar">AI</span><div>` +
    `<div class="msg__head">风险摘要</div><div class="msg__text">${escapeMarkup(packet.riskSummary)}</div></div></div>` +
    `<div class="msg"><span class="msg__avatar">AI</span><div>` +
    `<div class="msg__head">影子试点范围</div><div class="msg__text">${escapeMarkup(packet.pilotScope)}</div></div></div>` +
    `<div class="msg msg--me"><span class="msg__avatar">摘</span><div>` +
    `<div class="msg__head">约束与判据</div><div class="msg__text">` +
    `<dl class="receipt-grid">` +
    `<div><dt>成功指标</dt><dd>${packet.successMetrics.map(escapeMarkup).join("；")}</dd></div>` +
    `<div><dt>停止条件</dt><dd>${packet.stopConditions.map(escapeMarkup).join("；")}</dd></div>` +
    `<div><dt>执行约束</dt><dd>${packet.constraints.map(escapeMarkup).join("；")}</dd></div>` +
    `<div><dt>方案责任人</dt><dd>${escapeMarkup(packet.downstreamOwner)}</dd></div>` +
    `</dl></div></div></div>`;

  // 右栏：只给已确认事实（V0.1-01：每条事实必须带证据等级，E5 必须带 AI 假设标记）
  if (traceEl) {
    traceEl.innerHTML = `<div class="trace-block">${blockTitle("已确认事实", "trace-block__title")}` +
      (facts.length
        ? facts.map((fact) => {
            const level = String(fact.evidenceLevel || "").toUpperCase();
            const levelBadge = `<span class="evidence-level" title="证据等级">${level ? escapeMarkup(level) : "未定级"}</span>`;
            const aiBadge = (level === "E5" || fact.requiresAiLabel)
              ? `<span class="evidence-ai-label">${escapeMarkup(fact.aiLabel || E5_LABEL)}</span>`
              : "";
            return `<div class="trace-card"><div class="trace-card__label">已确认 ${levelBadge}${aiBadge}</div>` +
              `<div class="trace-card__value">${escapeMarkup(fact.claim)}${fact.correction ? `\n修正：${escapeMarkup(fact.correction)}` : ""}</div></div>`;
          }).join("")
        : `<div class="trace-card trace-card--pending"><div class="trace-card__value">决策包未返回可展示的事实摘要。</div></div>`) +
      `</div>` +
      `<div class="trace-block">${blockTitle("你的职责", "trace-block__title")}` +
      `<div class="trace-card"><div class="trace-card__value">你看到的是已确认事实形成的摘要，不是原始材料。决定是否进入小范围影子试点，并承担最终责任。</div></div></div>`;
  }

  // 底栏：决策，或已作出的回执
  if (composerEl) {
    if (receipt) {
      composerEl.innerHTML =
        `<div class="composer__fields"><div class="trace-card"><div class="trace-card__label">` +
        `决策回执 · ${escapeMarkup(formalUiContract.ownerDecisionLabel(receipt.decision))}</div>` +
        `<div class="trace-card__value">理由：${escapeMarkup(receipt.reason)}\n` +
        `决策包版本：v${escapeMarkup(receipt.packetVersion)} · 决策时间：${escapeMarkup(formatFormalTime(receipt.decidedAt))}\n` +
        `下游责任人：${escapeMarkup(receipt.downstreamOwner)}</div></div>` +
        `<p class="field-help">该决定已保存。重新进入时仍会显示这份回执。</p></div>`;
    } else {
      composerEl.innerHTML =
        `<form id="formal-owner-decision-form" class="formal-owner-form composer__fields">` +
        `<label>决策理由<textarea name="reason" required placeholder="说明你为什么这样决定。"></textarea></label>` +
        `<div class="owner-inline-fields">` +
        `<label>确认范围<input name="scope" required value="${escapeMarkup(packet.pilotScope)}"></label>` +
        `<label>后续责任人<input name="downstreamOwner" required value="${escapeMarkup(packet.downstreamOwner)}"></label>` +
        `</div>` +
        `<div class="composer__actions">` +
        `<button class="text-button" type="submit" data-decision="pause" ${state.formalOwnerSubmitting ? "disabled" : ""}>暂不推进</button>` +
        `<button class="secondary-button" type="submit" data-decision="revision" ${state.formalOwnerSubmitting ? "disabled" : ""}>要求修改</button>` +
        `<button class="primary-button" type="submit" data-decision="continue" ${state.formalOwnerSubmitting ? "disabled" : ""}>${state.formalOwnerSubmitting ? "正在保存…" : "同意进入试点"}</button>` +
        `</div></form>`;
      composerEl.querySelector("#formal-owner-decision-form")?.addEventListener("submit", submitFormalOwnerDecision);
    }
  }
}

async function loadFormalOwnerWorkspace(projectId) {
  state.formalSessionActive = true; state.formalProjectId = projectId;
  state.role = "owner";
  showView("formal-owner-view");
  try {
    const response = await window.diagnosticApi.getFormalOwnerPacket(projectId);
    state.formalOwnerPacket = response.packet;
    state.formalOwnerReceipt = response.packet.decisionReceipt || null;
    state.formalOwnerError = null;
  } catch (error) {
    state.formalOwnerPacket = null;
    state.formalOwnerReceipt = null;
    state.formalOwnerError = error;
  }
  renderFormalOwnerWorkspace();
  fadeOnlyNew(document.querySelector("#owner-thread"), ".msg, .thread-divider");
  keepThreadPinned(document.querySelector("#owner-thread"));
  fadeOnlyNew(document.querySelector("#owner-trace"), ".trace-block");
}

async function submitFormalOwnerDecision(event) {
  event.preventDefault(); const form = event.currentTarget; const decision = event.submitter?.dataset.decision;
  const packet = state.formalOwnerPacket; if (!packet || !decision) return;
  const data = new FormData(form);
  if (state.formalOwnerSubmitting) return;
  state.formalOwnerSubmitting = true; renderFormalOwnerWorkspace();
  try { const result = await window.diagnosticApi.submitFormalOwnerDecision(packet.id, { decision, reason: String(data.get("reason") || ""), scope: String(data.get("scope") || ""), constraints: packet.constraints, successMetrics: packet.successMetrics, stopConditions: packet.stopConditions, downstreamOwner: String(data.get("downstreamOwner") || "") }); state.formalOwnerReceipt = result.receipt; renderFormalOwnerWorkspace(); }
  catch (error) { showMessage("决策没有保存：" + error.message); }
  finally { state.formalOwnerSubmitting = false; renderFormalOwnerWorkspace(); }
}

async function saveFormalEmployeeDraft() {
  if (state.formalEmployeeSaving || !state.formalEmployeeTask) return;
  const question = formalEmployeeQuestions.find((entry) => !state.formalEmployeeAnswers[entry.key]);
  const answer = document.querySelector("#formal-employee-answer");
  if (question && answer?.value.trim()) state.formalEmployeeAnswers[question.key] = answer.value.trim();
  state.formalEmployeeSaving = true;
  renderFormalEmployeeWorkbench();
  try {
      // PILOT-04/D8：手动保存与自动保存走同一条路径，确保 ledger 与推断判定
      // 一并落库 —— 否则「手动保存过的草稿」仍会在刷新后丢掉追问状态。
      const saved = await persistFormalEmployeeDraftNow();
      if (saved) showMessage("草稿已保存。下次打开邀请可从这里继续。");
  } finally {
    state.formalEmployeeSaving = false;
    renderFormalEmployeeWorkbench();
  }
}

// ── PILOT-09C/FIX-CODEX-04A（R04-01）：等待态成功响应的唯一判定入口 ──────────
// BEGIN R04-01 VERIFIER-NOT-READY VALIDATOR
/**
 * 判断一个 409 响应是否可以安全地当作"核验人未就绪 → 等待态提交成功"处理。
 *
 * 旧实现用 `409 && payload.receipt` 判定，但 submission_conflict（旧版本 / 核验人
 * 已就绪 / 并发 CAS 失败）同样携带 task + receipt，导致真实冲突被误当等待态成功：
 * 页面会静默采用服务端新 draftRevision 并继续用旧答案保存，从而绕过 F02 的冲突保护。
 *
 * 因此这里要求**同时**满足：
 *   · 业务错误码必须是 verifier_not_ready（receipt 不是充分条件）；
 *   · task / receipt 结构完整且与本页任务一致；
 *   · 状态转换前提：服务端已写成 blocked_draft + waiting_assignment；
 *   · revision 只能保持（幂等重放）或恰好 +1（首次等待态提交），不得跳跃或回退。
 * 任一不满足 ⇒ 返回 null，由调用方按真实冲突处理（置冲突闩锁、不采用服务端版本、
 * 保留本地未保存内容）。
 */
function confirmedVerifierNotReadyPayload(payload, localTaskId, localRevision) {
  if (!payload || payload.code !== "verifier_not_ready") return null;
  const task = payload.task;
  const receipt = payload.receipt;
  if (!task || typeof task !== "object" || !receipt || typeof receipt !== "object") return null;
  if (!localTaskId || task.id !== localTaskId) return null;
  if (!Number.isInteger(task.draftRevision) || task.draftRevision < 0) return null;
  if (!Number.isInteger(localRevision) || localRevision < 0) return null;
  if (task.status !== "blocked_draft") return null;
  if (task.handoffStatus !== "waiting_assignment" || receipt.handoffStatus !== "waiting_assignment") return null;
  if (receipt.workItemId !== localTaskId) return null;
  // 首次等待态提交：N→N+1；同一载荷幂等重放：保持 N。其余一律视为冲突。
  if (task.draftRevision !== localRevision && task.draftRevision !== localRevision + 1) return null;
  return { task, receipt };
}
// END R04-01 VERIFIER-NOT-READY VALIDATOR

async function submitFormalEmployee() {
  if (state.formalEmployeeSubmitting) return;
  // AI 推断必须逐条判定后才能提交。推断如果带着"未判定"进入核验，
  // 就会被下游当成事实——这正是这张卡要拦住的东西。
  // U4：不得再用"verdict 存在 = 已判定"。必须区分 valid / stale / unjudged。
  const capacityMarker = formalInferenceCapacityMarker();
  if (capacityMarker) {
    showMessage("当前诊断存在未处理的推断，暂时无法提交，请联系管理员。");
    return;
  }
  const preflight = (() => {
    const summary = formalInferenceSummary(formalVisibleInferences(), {
      ...(state.formalInferenceVerdicts || {}), ...(state.formalInferencePending || {}),
    });
    return summary;
  })();
  if (preflight.valid < preflight.total || preflight.stale > 0) {
    const parts = [];
    if (preflight.stale) parts.push(`${preflight.stale} 条依据已更新，需要重新确认`);
    if (preflight.unjudged) parts.push(`${preflight.unjudged} 条尚未判定`);
    showMessage(`还有 ${parts.join("、")}，请先完成后再提交。`);
    return;
  }
  if (!document.querySelector("#formal-card-confirmed")?.checked) {
    showMessage("请先确认流程卡符合你的实际工作。");
    return;
  }
  if (state.formalEmployeeMaterialStatus === "undecided") {
    showMessage("请选择已提供材料或目前没有可提供材料。");
    return;
  }
  const card = formalEmployeeCard();
  const text = formalEmployeeQuestions.map((question) => `${question.label}：${state.formalEmployeeAnswers[question.key]}`).join("\n\n");
  if (!state.formalEmployeeSubmissionKey) state.formalEmployeeSubmissionKey = window.crypto.randomUUID();
  state.formalEmployeeSubmitting = true;
  renderFormalEmployeeWorkbench();
  try {
    // PILOT-09C/IMPLEMENT-2D：**先把判定保存到草稿**，再提交。
    // 服务端自 IMPLEMENT-2B 起以"库中已保存的草稿判定"为唯一可信来源，
    // 请求体里的判定不参与裁决 —— 因此不先保存就会出现"界面显示已完成、服务端却说未判定"（§八-4）。
    state.formalEmployeeSubmitting = false;
    const flushed = await persistFormalEmployeeDraftNow({ verdictsOnly: true });
    state.formalEmployeeSubmitting = true;
    if (!flushed) {
      showMessage("判定尚未保存成功，请重试后再提交。");
      return;
    }
    // 以保存成功后的**服务端状态**复核一次（stale 不得因为保存动作而变成有效）
    const serverSummary = formalInferenceSummary(formalVisibleInferences(), state.formalInferenceVerdicts || {});
    if (serverSummary.stale > 0 || serverSummary.valid < serverSummary.total) {
      showMessage("判定状态已更新（依据可能已变化），请按最新状态重新确认后再提交。");
      return;
    }
    // PILOT-08E/D1：只提交**员工判定动作**（按服务端推断 ID），不提交原文、也不提交版本字段。
    // PILOT-09C/FIX-CODEX-03A（R03-01）：提交必须携带本页所见草稿版本（baseRevision）；
    // 服务端会校验正常提交与等待核验人分支，过期/缺失一律拒绝，不写任何提交状态。
    const result = await window.diagnosticApi.submitFormalEmployee(
      state.formalEmployeeTask.id, text, card, state.formalEmployeeMaterialStatus, state.formalEmployeeSubmissionKey,
      {
        inferences: [], inferenceVerdicts: formalVerdictsPayload(),
        baseRevision: Number.isInteger(state.formalInterviewRevision) ? state.formalInterviewRevision : undefined,
      },
    );
    state.formalEmployeeTask = result.item;
    // R03-06/要求 7：正常提交成功后同样以服务端返回值为准同步本地草稿修订号。
    if (Number.isInteger(result.item?.draftRevision)) state.formalInterviewRevision = result.item.draftRevision;
    state.formalEmployeeReceipt = result.receipt || null;
    state.formalEmployeeSubmissionKey = "";
    state.formalEmployeeStep = "submitted";
    renderFormalEmployeeWorkbench();
  } catch (error) {
    // PILOT-09C/FIX-CODEX-04A（R04-01）：**只有通过业务错误码 + 响应结构 + 状态转换
    // 前提三重校验的 verifier_not_ready 才允许进入等待核验人流程**。
    // 旧实现以 `409 && payload.receipt` 为判据；而 submission_conflict
    //（stale_base_revision / verifier_ready / 并发 CAS 失败）同样携带 task+receipt，
    // 于是真实冲突被当成等待态成功：页面静默采用新 draftRevision、放弃冲突闩锁，
    // "旧答案 + 新 revision"的后续保存会覆盖其他页面已保存的新答案。
    // receipt 只是回执快照，不是等待态成功的充分条件；必须以 code 与状态转换前提判定。
    let failureNotice = "";
    const waitingPayload = error.status === 409
      ? confirmedVerifierNotReadyPayload(error.payload, state.formalEmployeeTask?.id, state.formalInterviewRevision)
      : null;
    if (waitingPayload) {
      state.formalEmployeeTask = waitingPayload.task;
      // R03-06/要求 7：确认后的等待态提交恰好推进一次 draftRevision（N→N+1）；
      // 幂等重放则保持不变。校验器已把 revision 变化限制在这两种合法情况内。
      state.formalInterviewRevision = waitingPayload.task.draftRevision;
      state.formalEmployeeReceipt = waitingPayload.receipt;
      state.formalEmployeeStep = "waiting";
      state.formalEmployeeSubmissionKey = "";
      renderFormalEmployeeWorkbench();
    } else if (error.status === 409) {
      // R03-01/R04-01：提交因版本/并发/核验状态冲突被拒绝时，**不得**静默采用服务端
      // revision 后立即重试（页面上的卡片/材料可能仍基于旧答案）。置冲突闩锁并要求
      // 刷新重新确认，同时保留本地未保存输入。
      // 例外：同一 Idempotency-Key 复用了不同载荷（客户端错误），只需更换请求键，不必锁页面。
      if (error.payload?.code !== "idempotency_key_reuse") {
        state.formalEmployeeConflict = true;
        state.formalEmployeeSaveState = "conflict";
        failureNotice = "提交冲突：服务器已有更新的草稿版本。已保留你本地未保存的内容，但为免覆盖较新回答，本次未采用服务器版本、也未重试。请刷新页面重新确认后再提交。";
      }
      state.formalEmployeeSubmissionKey = "";
    } else if (error.status >= 400 && error.status < 500) {
      state.formalEmployeeSubmissionKey = "";
    }
    showMessage(failureNotice || `提交没有完成：${error.message}`);
  } finally {
    state.formalEmployeeSubmitting = false;
    if (state.formalEmployeeStep !== "submitted") renderFormalEmployeeWorkbench();
  }
}

async function submitFormalEmployeeSupplement() {
  if (state.formalEmployeeSupplementing) return;
  const task = state.formalEmployeeTask;
  const material = document.querySelector("#formal-employee-supplement")?.value.trim() || "";
  const reference = document.querySelector("#formal-employee-supplement-source")?.value.trim() || "";
  const sourceType = document.querySelector("#formal-employee-supplement-type")?.value || "";
  const metadataText = document.querySelector("#formal-employee-supplement-metadata")?.value || "";
  if (!task || !material || !reference) return showMessage("请填写补充的材料说明和材料来源标识。");
  let payload;
  try { payload = formalUiContract.buildSupplementPayload({ material, reference, sourceType, metadataText }); }
  catch (error) { return showMessage(error.message); }
  state.formalEmployeeSupplementing = true;
  renderFormalEmployeeWorkbench();
  try {
    await window.diagnosticApi.provideFormalSupplement(task.id, payload);
    showMessage("补充材料已提交，核验人员将复核同一条事实。");
    await loadFormalEmployeeTask(state.formalProjectId);
  } catch (error) {
    showMessage(`补充材料没有提交：${error.message}`);
  } finally {
    state.formalEmployeeSupplementing = false;
    renderFormalEmployeeWorkbench();
  }
}

function advanceFormalEmployeeFixed() {
  if (state.formalEmployeeEditIndex !== null) {
    state.formalEmployeeEditIndex += 1;
    if (state.formalEmployeeEditIndex >= formalEmployeeQuestions.length) {
      state.formalEmployeeEditIndex = null;
      state.formalEmployeeStep = "card";
    }
  } else if (formalEmployeeQuestions.every((entry) => state.formalEmployeeAnswers[entry.key])) {
    state.formalEmployeeStep = "card";
  } else {
    state.formalAgentQuestion = null;
  }
}

function resumeFormalAgentQuestion() {
  const index = Math.max(0, formalUiContract.employeeQuestionIndex(state.formalEmployeeAnswers, null, formalEmployeeQuestions.length));
  return formalEmployeeQuestions[index];
}

async function continueFormalEmployeeAgent(question, text) {
  if (state.formalAgentThinking) return;              // 客户端单飞（服务端另有陈旧轮次防护）
  state.formalAgentThinking = true;
  state.formalEmployeeSaveState = "saving";
  renderFormalEmployeeWorkbench();
  try {
    // ── PILOT-07C/R6：先落库"推断判定"，再请求下一轮模型 ────────────────
    // PILOT-07B 已复现：员工刚更正推断就进入下一轮时，自动保存尚未完成，
    // employee-turn 读到的是**旧**草稿，模型本轮看不到该更正。
    // 这里按"保存纠正 → 等待 CAS 成功 → 再请求下一轮"的顺序执行：
    //   · 只推判定，不推 ledger（避免覆盖服务端 pendingQuestion 锚点）；
    //   · 保存失败 / 409 冲突 → **不继续推理**，避免模型继续使用已被否定的推断。
    const verdictFlushed = await persistFormalEmployeeDraftNow({ verdictsOnly: true });
    if (!verdictFlushed) {
      state.formalEmployeeSaveState = state.formalEmployeeSaveState === "conflict" ? "conflict" : "error";
      renderFormalEmployeeWorkbench();
      showMessage("推断判定尚未保存，已暂停本轮提问。请按提示处理后重试。");
      return;
    }

    const turnPayload = {
      workItemId: state.formalEmployeeTask.id,
      questionKey: question.key,
      questionLabel: question.label || "",
      questionPrompt: question.prompt || "",
      answer: text,
      answers: state.formalEmployeeAnswers,
      materialStatus: state.formalEmployeeMaterialStatus,
      mode: "auto",
      // 适配器无状态：追问计数靠这份 ledger 跨轮保留，否则会无限追问同一题。
      ledger: state.formalInterviewLedger || null,
      // PILOT-04B/A：把上次见到的草稿修订号带回，服务端据此拒绝过期上下文。
      baseRevision: Number.isInteger(state.formalInterviewRevision) ? state.formalInterviewRevision : undefined,
    };

    // ── PILOT-08C/R2：锚点身份问题的**受控**恢复 ────────────────────────
    // 安全修复后，回答必须绑定服务端签发的问题身份。以下两类身份问题属于
    // **当前授权任务内**、且服务端明确允许恢复的情况：
    //   · question_anchor_missing   —— 还没有锚点（首次/旧草稿/清缓存）+ recoverable
    //   · question_identity_mismatch —— 本地问题已过期（例如上一轮模型调用失败）
    //                                 且服务端回报了属于七维的 expectedKey
    // 恢复只做一件事：请服务端**重新签发**当前该问的问题，然后用同一段员工回答
    // 在同一轮内重试。客户端**不指定维度**，不跳过 revision 校验，不重复保存回答。
    // 其余 409（跨项目/跨任务/权限/伪造身份等）一律**不自动恢复**，交给上层拒绝。
    const RECOVERABLE_CODES = new Set(['question_anchor_missing', 'question_identity_mismatch']);
    const DIMENSION_KEYS = new Set(['trigger', 'inputs', 'steps', 'judgments', 'exceptions', 'handoff', 'burden']);
    const canRecoverQuestionIdentity = (error) => {
      if (!error || error.status !== 409) return false;
      if (!RECOVERABLE_CODES.has(error.code)) return false;
      // 必须由服务端显式标明可恢复，或给出属于七维的 expectedKey —— 二者之一。
      const payload = error.payload || {};
      if (payload.recoverable === true) return true;
      return DIMENSION_KEYS.has(String(payload.expectedKey || ''));
    };
    const recoverIssuedQuestion = async () => {
      const issued = await window.diagnosticApi.agentTurn(state.formalProjectId, {
        workItemId: state.formalEmployeeTask.id,
        recover: true,
        answers: state.formalEmployeeAnswers,
        materialStatus: state.formalEmployeeMaterialStatus,
        mode: 'auto',
        baseRevision: Number.isInteger(state.formalInterviewRevision) ? state.formalInterviewRevision : undefined,
      });
      const q = issued?.turn?.nextQuestion;
      if (!q?.key) return null;                       // 服务端未签发 → fail-closed
      if (Number.isInteger(issued.draftRevision)) state.formalInterviewRevision = issued.draftRevision;
      return q;
    };
    let result;
    try {
      result = await window.diagnosticApi.agentTurn(state.formalProjectId, turnPayload);
    } catch (error) {
      // 每轮**最多恢复一次**：既避免无限重试，也避免掩盖真正的服务端拒绝。
      if (!canRecoverQuestionIdentity(error)) throw error;
      const issuedQuestion = await recoverIssuedQuestion();
      if (!issuedQuestion) throw error;
      result = await window.diagnosticApi.agentTurn(state.formalProjectId, {
        ...turnPayload,
        questionKey: issuedQuestion.key,
        questionLabel: issuedQuestion.label || '',
        questionPrompt: issuedQuestion.prompt || '',
        baseRevision: Number.isInteger(state.formalInterviewRevision) ? state.formalInterviewRevision : undefined,
      });
    }

    const turn = result.turn || {};
    // 服务端在需要时会回报更高修订号（本次已落库则取之，否则以权威库值为基准）。
    if (Number.isInteger(result.draftRevision)) state.formalInterviewRevision = result.draftRevision;
    if (turn.interviewState?.ledger) state.formalInterviewLedger = turn.interviewState.ledger;
    // AI 对这段工作的推断。必须原样带给本人逐条判定，不能直接当事实写进流程卡。
    if (Array.isArray(turn.alternativeExplanations)) state.formalAgentInferences = turn.alternativeExplanations;
    // PILOT-07/S6：服务端覆盖裁决 —— 进度与"还缺什么"以它为准，而不是前端计数。
    if (turn.coverage) state.formalCoverage = turn.coverage;
    // 模型建议结束但被服务端拒绝时，明确告诉员工还缺什么（不得静默）。
    if (turn.endingProposal && turn.endingProposal.accepted === false && turn.endingProposal.missingNote) {
      state.formalEndingNote = turn.endingProposal.missingNote;
    } else if (turn.turnKind === "draft") {
      state.formalEndingNote = "";
    }
    // 记录本轮实际使用的引擎，供界面区分"AI 自主访谈"与"固定题库降级"。
    if (turn.executionMode) state.formalInterviewEngine = turn.executionMode;
    if (turn.turnKind === "draft" && turn.flowCard) {
      state.formalAgentFlowCard = turn.flowCard;
      state.formalAgentQuestion = null;
      state.formalEmployeeStep = "card";
    } else if (turn.nextQuestion) {
      state.formalAgentQuestion = turn.nextQuestion;
    } else {
      advanceFormalEmployeeFixed();
    }
    // PILOT-04/D8：每轮有效回答后自动保存。只有保存成功才显示"已保存"，
    // 失败必须可见 —— 绝不能静默丢掉员工刚说的话。
    await persistFormalEmployeeDraftNow();
  } catch (error) {
    // 陈旧轮次：不是错误，是另一个标签页推进了状态；提示刷新即可，不覆盖本地。
    if (error.status === 409 && error.code === "stale_turn") {
      state.formalEmployeeSaveState = "stale";
      showMessage("访谈已在别处更新，请刷新页面后继续。");
    } else {
      state.formalEmployeeSaveState = "error";
      advanceFormalEmployeeFixed();
      showMessage(`自适应追问暂不可用，已切回固定问题：${error.message}`);
    }
  } finally {
    state.formalAgentThinking = false;
    renderFormalEmployeeWorkbench();
  }
}

/**
 * PILOT-04/D8：把当前 answers + ledger + 推断判定写入服务端草稿。
 * 返回 true 表示服务端确认保存成功（此时界面才允许显示"已保存"）。
 */
/**
 * PILOT-08C/R3：推断判定的去抖自动保存。
 *
 * 为什么必须自动保存：
 *   · 员工在流程卡上勾选「符合实际 / 需要更正」后，若不手动点保存就刷新，
 *     判定会静默丢失（PILOT-08B 已复现）；
 *   · 提交核验的守卫要求「所有推断已判定」，若判定未落库，服务端与客户端会不一致。
 * 约束：
 *   · 只推判定（verdictsOnly），不推 ledger / answers，避免覆盖服务端锚点与员工答案；
 *   · 去抖合并连续勾选，避免每次点击都打一次请求；
 *   · 同一时刻只允许一次在途请求；失败只提示，不阻塞后续操作。
 */
let inferenceVerdictFlushTimer = null;
let inferenceVerdictFlushInFlight = false;
function scheduleInferenceVerdictFlush() {
  if (inferenceVerdictFlushTimer) clearTimeout(inferenceVerdictFlushTimer);
  inferenceVerdictFlushTimer = setTimeout(() => {
    inferenceVerdictFlushTimer = null;
    void flushInferenceVerdictsNow();
  }, 800);
}
async function flushInferenceVerdictsNow() {
  if (inferenceVerdictFlushInFlight) return false;
  if (!state.formalEmployeeTask || state.formalEmployeeSaving) return false;
  // 轮次进行中不要插一次判定保存：轮次自身会推进 revision（服务端签发锚点），
  // 此时再写草稿会撞上 stale_turn / draft_conflict。等轮次结束由它自己的保存路径落库。
  if (state.formalAgentThinking) return false;
  inferenceVerdictFlushInFlight = true;
  try {
    return await persistFormalEmployeeDraftNow({ verdictsOnly: true });
  } catch (error) {
    state.formalEmployeeSaveState = 'error';
    showMessage('推断判定未能保存：' + (error.message || '请重试'));
    renderFormalEmployeeWorkbench();
    return false;
  } finally {
    inferenceVerdictFlushInFlight = false;
  }
}

async function persistFormalEmployeeDraftNow(options = {}) {
  if (!state.formalEmployeeTask?.id) return false;
  // PILOT-09C/FIX-CODEX-02B（F02）：冲突未解除前禁止任何自动/手动保存。
  // 必须刷新页面重新取得服务端 revision 后才能继续，否则旧页面数据会再次覆盖新内容。
  if (state.formalEmployeeConflict) {
    state.formalEmployeeSaveState = "conflict";
    showMessage("存在未解决的版本冲突：请刷新页面获取最新内容后再继续编辑。");
    return false;
  }
  const verdictsOnly = options.verdictsOnly === true;
  try {
    const result = await window.diagnosticApi.saveEmployeeDraft(
      state.formalEmployeeTask.id,
      state.formalEmployeeAnswers,
      state.formalEmployeeMaterialStatus,
      {
        // PILOT-07C/R6：verdictsOnly 模式只推"推断判定"，不推 ledger / answers。
        // 原因：ledger 里带着上一轮服务端写入的 pendingQuestion，如果提前推一份
        // 旧的 ledger，会覆盖服务端权威锚点、导致本轮回答被判为"问题身份不符"。
        // 判定数据与提问锚点必须分开推进。
        ledger: verdictsOnly ? undefined : (state.formalInterviewLedger || null),
        // PILOT-09C/FIX-2F（D-1）：必须合并「已保存判定 + 本轮未保存的待保存判定」。
        // 旧实现只发 formalInferenceVerdicts，导致页面上刚选的判定永远不落库。
        // formalVerdictsPayload() 输出判定动作 + 回显版本（服务端逐字段校验后才盖章）。
        inferenceVerdicts: formalVerdictsPayload(),
        baseRevision: Number.isInteger(state.formalInterviewRevision) ? state.formalInterviewRevision : undefined,
      },
    );
    if (result?.task) state.formalEmployeeTask = result.task;
    // U6：判定是否有效**只能由服务端答复**。保存成功后用服务端返回的盖章判定
    // 重建本地镜像（含"依据已更新 → stale"的判定），客户端不得自行宣布 valid。
    if (result?.task) applyServerInferenceVerdicts(result.task.draftInferenceVerdicts);
    // PILOT-09C/FIX-3B（S-1）：服务端逐项拒绝（版本冲突）必须**明确告知**。
    // 处理：保留用户选择的展示、不增加已完成数量、**不自动按新版本重试**、
    //       刷新服务端状态后要求员工重新确认。
    const rejectedVerdicts = Array.isArray(result?.verdictResult?.rejected) ? result.verdictResult.rejected : [];
    if (rejectedVerdicts.length) {
      state.formalInferenceRejected = Object.fromEntries(rejectedVerdicts.map((entry) => [entry.id, entry]));
      // 用服务端最新状态刷新条目版本与过期态（pending 会被清空 —— 不自动重试）
      applyFormalEmployeeTaskPayload({ task: result.task || state.formalEmployeeTask });
      state.formalEmployeeSaveState = "conflict";
      state.formalEmployeeSaveError = "判定版本冲突：依据已更新。";
      showMessage(`有 ${rejectedVerdicts.length} 条判定未保存：该推断的依据已更新，请重新确认后再保存。`);
      return false;
    }
    state.formalInferenceRejected = {};
    // 保存成功后本地修订号推进 —— 下次 Agent 轮与草稿写入都以它为基准。
    if (Number.isInteger(result?.task?.draftRevision)) state.formalInterviewRevision = result.task.draftRevision;
    state.formalEmployeeSaveState = "saved";
    state.formalEmployeeSavedAt = Date.now();
    state.formalEmployeeSaveError = "";
    return true;
  } catch (error) {
    // PILOT-04B/A：并发冲突必须明确提示"刷新或恢复"，绝不静默覆盖较新回答。
    if (error.status === 409 && error.code === "draft_conflict") {
      // PILOT-09C/FIX-CODEX-02B（F02）：不采用服务端当前 revision（否则后续保存会以
      // 旧页面状态覆盖较新内容）；改为置冲突闩锁，保留本地未保存输入，要求刷新恢复。
      state.formalEmployeeConflict = true;
      state.formalEmployeeSaveState = "conflict";
      state.formalEmployeeSaveError = error.payload?.detail || "访谈状态已在别处更新。";
      showMessage("访谈状态已在别处更新。已保留你尚未保存的内容，但为免覆盖较新回答，请刷新页面后再继续。");
      return false;
    }
    state.formalEmployeeSaveState = "error";
    state.formalEmployeeSaveError = error.message || "保存失败";
    showMessage(`回答未能保存：${state.formalEmployeeSaveError}。请检查网络后重试，不要关闭页面。`);
    return false;
  }
}

window.loadFormalEmployeeTask = loadFormalEmployeeTask;

async function loadFormalVerifierWorkspace(projectId) {
  state.formalSessionActive = true;
  state.formalProjectId = projectId;
  state.role = "verifier";
  state.verifierDecision = "";
  state.verifierReason = "";
  state.verifierCorrection = "";
  state.verifierState = "loading";
  document.documentElement.classList.add("verifier-active");
  showView("formal-verifier-view");
  renderVerifierWorkbench();
  try {
    const response = await window.diagnosticApi.getFormalVerifierFacts(projectId);
    const items = response.facts || [];
    state.verifierFacts = items;
    state.verifierProgress = response.progress || { current: items.length ? 1 : 0, total: items.length, completed: 0 };
    state.verifierResponsibleMembers = response.responsibleMembers || [];
    state.verifierHistory = response.history || [];
    state.verifierFact = items[0] || null;
    state.verifierSourceRefs = state.verifierFact?.sourceRefs ? [...state.verifierFact.sourceRefs] : [];
    if (!state.verifierFact) {
      const packet = await window.diagnosticApi.getFormalDecisionPacket(projectId).catch(() => ({ packet: null }));
      state.verifierPacket = packet.packet;
    }
    state.verifierState = state.verifierFact ? (state.verifierFact.status === "blocked" ? "waiting" : "ready") : (state.verifierPacket ? "packet" : "empty");
  } catch (error) {
    state.verifierFact = null;
    state.verifierState = "error";
    showMessage(`暂时无法打开核验事项：${error.message}`);
  }
  renderVerifierWorkbench();
}

window.loadFormalVerifierWorkspace = loadFormalVerifierWorkspace;

// ── 核验人的三栏外壳 ────────────────────────────────────────────────
// 核验天然是「逐条确认」：中栏是要判断的那一条事实，右栏是判断所需的证据，
// 左栏回答“我在哪一条、还剩几条”，底部是唯一的操作区。
/**
 * V0.1-01 / D-1：正式核验人界面的证据等级控件。
 *
 * 等级是「来源强度」，与「是否已确认」是两个正交维度：等级只说明这条事实的证据
 * 来自哪里，不代表它已被核实。E1–E5 的语义不在前端重新定义，只做展示与选择。
 * E5（AI 推断/分析假设）必须始终带「AI假设，待验证」标记，且不得作为已核实事实
 * 进入正式结论——该限制由服务端在决策包处强制。
 */
const FORMAL_EVIDENCE_LEVELS = [
  ["E1", "E1 系统记录 / 直接运行证据"],
  ["E2", "E2 来源独立的相互印证"],
  ["E3", "E3 单一口述（不等于已核实）"],
  ["E4", "E4 制度或 SOP 要求（不代表实际执行）"],
  ["E5", "E5 AI 推断或分析假设（AI假设，待验证）"],
];

function formalVerifierLevelControl(task = {}) {
  const serverLevel = String(task.evidenceLevel || "").toUpperCase();
  // 已存在的服务端等级用来说明"当前等级"；
  // 选择框的值必须优先取用户本次已选（draft），否则每次重绘（勾选依据、选判断）
  // 都会把核验人刚选的等级丢掉。
  const draft = String(state.verifierEvidenceLevel || "").toUpperCase();
  const selectedValue = draft || serverLevel;
  const currentLabel = serverLevel || "未定级";
  const sourceNote = task.evidenceLevelSource === "verifier_correction"
    ? "（已修正）"
    : (task.evidenceLevelUpdatedAt ? "（已定级）" : "");
  const options = FORMAL_EVIDENCE_LEVELS
    .map(([value, label]) => `<option value="${value}" ${selectedValue === value ? "selected" : ""}>${escapeMarkup(label)}</option>`)
    .join("");
  return (
    `<label class="field-label" for="verifier-evidence-level">证据等级（来源强度，与是否已确认相互独立）</label>` +
    `<p class="field-help" id="verifier-evidence-current">当前等级：` +
    `<span class="evidence-level">${escapeMarkup(currentLabel)}</span>${escapeMarkup(sourceNote)}` +
    (task.requiresAiLabel ? `<span class="evidence-ai-label">${escapeMarkup(task.aiLabel || E5_LABEL)}</span>` : "") +
    `</p>` +
    `<select id="verifier-evidence-level">` +
    `<option value="">未定级（本次不定级）</option>${options}</select>` +
    `<p class="field-help">等级只表示来源强度；「已确认」由你的判断决定。选 E5 时该事实不得作为已核实事实进入正式结论。</p>`
  );
}

/**
 * PILOT-08C/R3+R6：把"AI 推断 + 员工判定"渲染成核验人看得懂的条目。
 *
 * 为什么必须渲染判定：员工判定（符合实际 / 需要更正 + 更正原文）在
 * PILOT-07C 就已经落库并随核验接口返回，但核验人界面此前**只显示推断原文**，
 * 把 verdict / correction 丢掉了 —— 于是员工写的更正永远到不了核验人眼前
 * （PILOT-08B 的 R3/R6 断点）。这里补上，且只做展示，不改变任何核验语义。
 */
function formalAlternativeItem(item) {
  if (!item || typeof item !== "object") return `<li>${escapeMarkup(item || "")}</li>`;
  // PILOT-09C/IMPLEMENT-2D（U7）：核验人必须能区分「员工原话 / 模型推断 / 员工判定」，
  // 且不得把模型推断伪装成员工原话；没有 quote 时**不编造引用**。
  const isTemplate = item.source === "server_template";
  const quoteText = item.quote && String(item.quote).trim();
  const sourceBadge = isTemplate
    ? `<span class="alt-source" style="display:inline-block;margin-right:6px;padding:1px 6px;border-radius:8px;background:#eef3f8;color:#2b4a6b;font-size:11px;">AI 推断 · 基于员工原话</span>`
    : `<span class="alt-source" style="display:inline-block;margin-right:6px;padding:1px 6px;border-radius:8px;background:#f2f2f2;color:#555;font-size:11px;">AI 推断 · 模型归纳（无员工原话）</span>`;
  const quoteHtml = quoteText
    ? `<div class="alt-quote" style="margin-top:6px;padding:6px 8px;border-left:3px solid #c9d6e3;background:#f7f9fb;font-size:13px;">员工原话：「${escapeMarkup(quoteText)}」</div>`
    : "";
  const verdict = String(item.verdict || "");
  let verdictHtml;
  if (verdict === "corrected") {
    verdictHtml = `<div class="alt-verdict alt-verdict--corrected">员工更正：${escapeMarkup(item.correction || "（未填写更正原文）")}</div>`;
  } else if (verdict === "confirmed") {
    verdictHtml = `<div class="alt-verdict alt-verdict--confirmed">员工已确认符合实际</div>`;
  } else {
    verdictHtml = `<div class="alt-verdict alt-verdict--unjudged">员工尚未判定 —— 不得当作事实</div>`;
  }
  if (String(item.judgmentState || "") === "stale") {
    verdictHtml += `<div class="alt-verdict alt-verdict--stale" style="color:#8a4b00;">判定已过期：该推断依据后来更新过，员工需重新确认后才可作事实依据。</div>`;
  }
  return `<li>${sourceBadge}<div class="alt-text" style="margin-top:6px;">${escapeMarkup(item.text || "")}</div>${quoteHtml}${verdictHtml}</li>`;
}

function renderFormalVerifierShell() {
  const nav = document.querySelector(".shell-pane--nav");
  const stepsEl = document.querySelector("#verifier-steps");
  const taskEl = document.querySelector("#verifier-task");
  const navMeta = document.querySelector("#verifier-nav-meta");
  const navProgress = document.querySelector("#verifier-nav-progress");
  const historyEl = document.querySelector("#verifier-nav-history");
  const threadEl = document.querySelector("#verifier-thread");
  const threadMeta = document.querySelector("#verifier-thread-meta");
  const traceEl = document.querySelector("#verifier-trace");
  const composerEl = document.querySelector("#verifier-composer-inner");
  if (!threadEl) return;

  const setSteps = (current) => {
    if (!stepsEl) return;
    stepsEl.innerHTML = EMPLOYEE_STEPS.map((step, index) => {
      const cls = index < current ? "is-done" : index === current ? "is-current" : "";
      return `<li class="${cls}"><span class="step-rail__dot">${index < current ? "✓" : index + 1}</span>` +
             `<span><span class="step-rail__name">${escapeMarkup(step.name)}</span>` +
             `<span class="step-rail__note">${escapeMarkup(step.note)}</span></span></li>`;
    }).join("");
  };

  const historyRows = (state.verifierHistory || []).map((entry) =>
    `<li><div><strong>${escapeMarkup(entry.workItemTitle || entry.workItemId)}</strong>` +
    `<span>${escapeMarkup(formalUiContract.statusLabel(entry.decision) || entry.decision)} · ${escapeMarkup(entry.createdAt || "")}</span></div>` +
    `<p>${escapeMarkup(entry.reason || "已记录判断")}</p>` +
    `<small>署名：${escapeMarkup(entry.signedByName || "当前核验人")} · 事实 ${escapeMarkup(entry.factId || "")}</small></li>`).join("");

  const renderHistory = () => {
    if (!historyEl) return;
    historyEl.innerHTML = historyRows
      ? `${blockTitle("已完成判断", "pane-block__title")}<ol class="verifier-history">${historyRows}</ol>`
      : "";
  };

  // ① 决策包确认态
  if (state.verifierState === "packet" && state.verifierPacket) {
    const packet = state.verifierPacket;
    setSteps(1);
    if (navMeta) navMeta.textContent = "确认事实引用";
    if (taskEl) taskEl.innerHTML = `<p class="task-name">决策包事实引用</p><p class="task-scope">风险与试点建议将引用 ${packet.factRefs.length} 条已确认事实。</p>`;
    if (navProgress) navProgress.innerHTML = "";
    renderHistory();
    if (threadMeta) threadMeta.textContent = "待确认引用";
    threadEl.innerHTML =
      `<div class="msg"><span class="msg__avatar">AI</span><div>` +
      `<div class="msg__head">风险与试点建议引用了这些已确认事实</div>` +
      `<div class="msg__text">${escapeMarkup(packet.riskSummary)}</div></div></div>` +
      `<div class="msg"><span class="msg__avatar">AI</span><div>` +
      `<div class="msg__head">试点范围</div><div class="msg__text">${escapeMarkup(packet.pilotScope)}</div></div></div>`;
    if (traceEl) {
      traceEl.innerHTML = `<div class="trace-block">${blockTitle("你的职责边界", "trace-block__title")}` +
        `<div class="trace-card"><div class="trace-card__value">这里只确认事实引用是否准确，不替企业负责人做最终决策。</div></div></div>`;
    }
    if (composerEl) {
      composerEl.innerHTML = `<div class="composer__actions">` +
        `<button class="primary-button" type="button" data-action="verify-formal-packet" data-packet-id="${escapeMarkup(packet.id)}">确认引用无误</button></div>`;
    }
    return;
  }

  const task = state.verifierFact;

  // ② 空队列
  if (!task || state.verifierState === "empty") {
    setSteps(1);
    if (navMeta) navMeta.textContent = "无待办";
    if (taskEl) taskEl.innerHTML = `<p class="task-name">没有分配给你的待核验事实</p>`;
    if (navProgress) navProgress.innerHTML = "";
    renderHistory();
    if (threadMeta) threadMeta.textContent = "无待办";
    threadEl.innerHTML = `<p class="thread-empty">${historyRows
      ? "新的任务会进入队列；左侧保留了你已完成的判断署名记录。"
      : "新的员工流程描述提交后，系统会把分配给你的候选事实显示在这里。"}</p>`;
    if (traceEl) traceEl.innerHTML = `<div class="trace-block">${blockTitle("证据", "trace-block__title")}<div class="trace-card trace-card--pending"><div class="trace-card__value">当前没有需要核对的材料。</div></div></div>`;
    if (composerEl) composerEl.innerHTML = `<div class="composer__actions"><button class="secondary-button" type="button" data-action="refresh-formal-verifier">刷新队列</button></div>`;
    return;
  }

  // ③ 正常核验
  const evidence = task.eligibleMaterials || task.evidenceItems || task.evidencePair || [];
  const sourceRefs = state.verifierSourceRefs;
  const evidenceGateMet = sourceRefs.length > 0 && sourceRefs.every((ref) =>
    evidence.some((entry) => (entry.materialId || entry.id) === ref &&
      entry.authorizationStatus === "authorized" && entry.integrityStatus === "verified"));

  const evidenceRows = evidence.map((entry, index) => {
    const label = entry.label || entry.title || `证据 ${String.fromCharCode(65 + index)}`;
    const detail = entry.detail || entry.source || entry.claim || "当前版本证据";
    const materialId = entry.materialId || entry.id || "";
    const eligible = entry.authorizationStatus === "authorized" && entry.integrityStatus === "verified";
    const review = entry.integrityStatus === "pending"
      ? `<div class="material-review"><label for="material-review-reason-${escapeMarkup(materialId)}">完整性复核理由</label>` +
        `<input id="material-review-reason-${escapeMarkup(materialId)}" placeholder="例如：校验值与企业导出记录一致">` +
        `<div class="action-row"><button class="secondary-button" type="button" data-action="review-formal-material" data-material-id="${escapeMarkup(materialId)}" data-review-decision="verified" ${state.verifierReviewingMaterial ? "disabled" : ""}>通过</button>` +
        `<button class="text-button" type="button" data-action="review-formal-material" data-material-id="${escapeMarkup(materialId)}" data-review-decision="rejected" ${state.verifierReviewingMaterial ? "disabled" : ""}>拒绝</button></div></div>`
      : "";
    // 右栏只做"参考"：引用哪份材料是判断动作的一部分，放在中栏选中区。
    return `<div class="trace-card"><div class="trace-card__label">${escapeMarkup(label)}` +
      `${eligible ? '<span class="trace-badge trace-badge--done">可引用</span>' : '<span class="trace-badge">不可引用</span>'}</div>` +
      `<div class="trace-card__value">${escapeMarkup(detail)}</div>` +
      `<div class="trace-card__value trace-card__meta">${escapeMarkup(entry.materialKey || materialId)} · v${escapeMarkup(entry.version || 1)}</div>` +
      review + `</div>`;
  }).join("");

  const eligibleList = evidence.filter((entry) =>
    entry.authorizationStatus === "authorized" && entry.integrityStatus === "verified");
  const citationPicker = eligibleList.length
    ? `<div class="citation-picker"><div class="citation-picker__title">这次判断依据哪些材料</div>` +
      eligibleList.map((entry) => {
        const materialId = entry.materialId || entry.id || "";
        const selected = sourceRefs.includes(materialId);
        return `<label class="citation-option ${selected ? "is-selected" : ""}">` +
          `<input type="checkbox" name="verifier-source-ref" value="${escapeMarkup(materialId)}" ${selected ? "checked" : ""}>` +
          `<span>${escapeMarkup(entry.label || entry.materialKey || materialId)}</span></label>`;
      }).join("") + `</div>`
    : `<p class="citation-hint">没有可引用的材料。请选择「证据不足，等待补证」。</p>`;

  const decision = state.verifierDecision;
  const insufficient = decision === "insufficient_evidence";
  const secondConfirmation = task.secondConfirmationAction === "second_confirmation";
  const positiveDecisionBlocked = decision !== "insufficient_evidence" && !evidenceGateMet;
  const progress = state.verifierProgress || {};

  setSteps(1);
  if (navMeta) navMeta.textContent = `第 ${progress.current || 1} / ${progress.total || 1} 条`;
  if (taskEl) {
    taskEl.innerHTML = `<p class="task-name">${escapeMarkup(task.workItemTitle || "还原客户交接工作")}</p>` +
      `<p class="task-scope">${escapeMarkup(task.factType || "")}</p>`;
  }
  if (navProgress) {
    const total = Number(progress.total || 1);
    const done = Math.max(0, Number(progress.completed || 0));
    navProgress.innerHTML = `<div class="pane-block__title">核验进度</div>` +
      `<div class="meter"><div class="meter__bar"><div class="meter__fill" style="width:${Math.round((done / total) * 100)}%"></div></div>` +
      `<div class="meter__label">已确认 ${done} / ${total} 条</div></div>`;
  }
  renderHistory();

  // 中栏：要判断的那一条
  if (threadMeta) threadMeta.textContent = secondConfirmation ? "独立二次确认" : `第 ${progress.current || 1} 条`;
  const alternatives = (task.alternativeExplanations || []).map(formalAlternativeItem).join("") || "<li>暂无替代解释</li>";
  // 中栏只放"你要判的那一条"。参考资料（流程卡版本、替代解释）
  // 全部移到右栏 —— 之前四样东西争垂直空间，事实本身被挤出屏幕。
  threadEl.innerHTML =
    `<div class="msg"><span class="msg__avatar">AI</span><div>` +
    `<div class="msg__step">${escapeMarkup(task.factId || task.candidateFactId || "")} · 待核验事实</div>` +
    `<div class="msg__head">${escapeMarkup(task.claim || task.question || task.title || "待核验事实")}</div>` +
    `<div class="msg__text">只显示分配给你的候选事实、员工流程卡版本和已授权证据。替代解释仅供比较，不等于事实。</div></div></div>` +
    (secondConfirmation
      ? `<div class="msg msg--pending"><span class="msg__avatar">AI</span><div><div class="msg__head">高影响事实 · 独立二次确认</div>` +
        `<div class="msg__text">首次核验已经完成。请独立核对同一材料版本并填写你的复核理由。</div>` +
        `<div class="msg__text"><strong>此事项需要另一名核验人独立确认。首次核验人不能完成第二次确认。</strong></div></div></div>`
      : `<div class="msg"><span class="msg__avatar">AI</span><div><div class="msg__head">先指明依据</div>` +
        citationPicker + `</div></div>`);

  // 右栏：判断所需的证据
  if (traceEl) {
    traceEl.innerHTML =
      `<div class="trace-block"><div class="trace-block__title">这条事实的来源</div>` +
      `<div class="trace-card"><div class="trace-card__label">员工流程卡 v${escapeMarkup(task.flowCardVersion || "1")}</div>` +
      `<div class="trace-card__value">证据版本 v${escapeMarkup(task.evidenceVersion || "1")} · 由员工本人逐问还原</div></div></div>` +
      `<div class="trace-block"><div class="trace-block__title">替代解释</div>` +
      `<div class="trace-card trace-card--pending"><div class="trace-card__value"><ul>${alternatives}</ul></div></div></div>` +
      `<div class="trace-block"><div class="trace-block__title">证据门禁</div>` +
      `<div class="trace-card ${evidenceGateMet ? "" : "trace-card--pending"}"><div class="trace-card__value">` +
      `${evidenceGateMet ? "已满足：材料版本、授权和完整性均可核对。" : "未满足：不能确认事实，只能要求补证。"}</div></div></div>` +
      `<div class="trace-block">${blockTitle("证据材料", "trace-block__title")}${evidenceRows || '<div class="trace-card trace-card--pending"><div class="trace-card__value">暂无可用证据。</div></div>'}</div>` +
      `<div class="trace-block"><div class="trace-block__title">核验职责边界</div>` +
      `<div class="trace-card"><div class="trace-card__value">你确认的是一个业务判断版本，不审批最终改造方案，也不修改 CRM。证据不足时保持等待，可从恢复入口提交新版本。</div></div></div>`;
  }

  // 底部：唯一的操作区
  if (composerEl) {
    // 判断放在底栏与理由同处：中栏只留"要判什么"（事实 + 依据），
    // 否则三样东西争垂直空间，事实会被挤出屏幕 —— 而那正是要判的东西。
    const verdictBlock = secondConfirmation ? "" :
      `<div class="composer__verdict"><div class="composer__verdict-title">你的判断</div>` +
      [["same", "相同", "员工流程卡与证据指向同一业务事实"],
       ["different_with_correction", "不同，带修正", "保留差异并写明正确口径"],
       ["insufficient_evidence", "证据不足，等待补证", "暂停，不生成风险或负责人决策"]]
        .map(([value, label, detail]) =>
          `<label class="verifier-outcome ${decision === value ? "is-selected" : ""}">` +
          `<input type="radio" name="verifier-decision" value="${value}" data-action="verifier-decision" ${decision === value ? "checked" : ""} ${value !== "insufficient_evidence" && !evidenceGateMet ? "disabled" : ""}>` +
          `<strong>${label}</strong><span>${detail}</span></label>`).join("") +
      `</div>`;
    // B2-04 / U-1：高影响事实在**首次核验时**就必须提前告知"还需另一名核验人"，
    // 而不是等提交后被服务端 403 才让核验人知道。仅为提示，不改变任何安全规则。
    const needsSecondVerifierNotice = !secondConfirmation &&
      String(task.impactLevel || "").toLowerCase() === "high" &&
      String(task.secondConfirmationStatus || "") !== "confirmed";
    composerEl.innerHTML =
      verdictBlock +
      (needsSecondVerifierNotice
        ? `<p class="second-verifier-notice" role="note">此事项需要另一名核验人独立确认。首次核验人不能完成第二次确认。</p>`
        : "") +
      `<div class="composer__fields">` +
      `<label class="field-label" for="verifier-reason">${secondConfirmation ? "独立复核理由" : "判断理由"}（必填）</label>` +
      `<textarea id="verifier-reason" rows="2" placeholder="说明你依据哪些证据做出判断。">${escapeMarkup(state.verifierReason)}</textarea>` +
      // V0.1-01 / D-1：正式三栏核验界面必须能「看到并设置」证据等级。
      // 等级只表示来源强度，与「是否已确认」正交；E5 必须带 AI 假设标记。
      // 二次确认处不改等级（避免与首次核验人的定级冲突）。
      (insufficient || secondConfirmation ? "" : formalVerifierLevelControl(task)) +
      (decision === "different_with_correction"
        ? '<label class="field-label" for="verifier-correction">修正内容（必填）</label><textarea id="verifier-correction" rows="2" placeholder="填写正确的业务口径。">' + escapeMarkup(state.verifierCorrection) + "</textarea>"
        : "") +
      (insufficient
        ? `<fieldset class="supplement-fields"><legend>补证请求</legend>` +
          `<label>需要补什么材料<input id="supplement-material" value="${escapeMarkup(state.verifierSupplement.requestedMaterial)}"></label>` +
          `<label>补证责任人<select id="supplement-owner"><option value="">选择项目成员</option>` +
          state.verifierResponsibleMembers.map((member) => `<option value="${escapeMarkup(member.account_id)}">${escapeMarkup(member.name || member.account_id)} · ${escapeMarkup(member.role)}</option>`).join("") +
          `</select></label><p class="field-help">截止日由系统按 5 个工作日自动计算；补齐后恢复同一事实。</p></fieldset>`
        : "") +
      `</div>` +
      (positiveDecisionBlocked
        ? `<p class="composer__blocked">还不能提交：这条判断必须先指明依据的材料（在中栏「先指明依据」里勾选）。若确实无法确认，请选「证据不足，等待补证」。</p>`
        : (!decision && !secondConfirmation ? `<p class="composer__blocked">还不能提交：请先在上方选一种判断。</p>` : "")) +
      `<div class="composer__actions">` +
      `<button class="primary-button" type="button" data-action="submit-verifier-judgment" ${(!secondConfirmation && (!decision || positiveDecisionBlocked)) || state.verifierSubmitting ? "disabled" : ""}>` +
      `${state.verifierSubmitting ? "正在保存…" : (secondConfirmation ? "完成独立二次确认" : "提交判断并处理下一事实")}</button></div>`;
  }
}

function renderVerifierWorkbench() {
  // 正式会话走三栏外壳；演示夹具路径保留原有渲染。
  if (state.formalSessionActive && document.querySelector("#verifier-thread")) {
    renderFormalVerifierShell();
    fadeOnlyNew(document.querySelector("#verifier-thread"), ".msg, .thread-divider");
    keepThreadPinned(document.querySelector("#verifier-thread"));
    fadeOnlyNew(document.querySelector("#verifier-trace"), ".trace-block");
    return;
  }
  const formalVerifier = false;
  const target = demoVerifierWorkbench;
  if (!target) return;
  const task = formalVerifier
    ? state.verifierFact
    : state.verifierFact || state.workItems.find((entry) => entry.assigneeRole === "verifier" && entry.stage === "facts") || state.verifierQuestion;
  if (state.verifierState === "packet" && state.verifierPacket) {
    const packet = state.verifierPacket;
    target.innerHTML = `<section class="verifier-question-panel"><p class="panel-label">待确认事实引用</p><h2>风险与试点建议将引用 ${packet.factRefs.length} 条已确认事实</h2><p>${escapeMarkup(packet.riskSummary)}</p><p><strong>试点范围：</strong>${escapeMarkup(packet.pilotScope)}</p><button class="primary-button" type="button" data-action="verify-formal-packet" data-packet-id="${escapeMarkup(packet.id)}">确认引用无误</button><div class="verifier-boundary"><strong>你的职责边界</strong><span>这里只确认事实引用是否准确，不替企业负责人做最终决策。</span></div></section>`;
    return;
  }
  if (!task || state.verifierState === "empty") {
    const historyRows = (state.verifierHistory || []).map((entry) => `<li><div><strong>${escapeMarkup(entry.workItemTitle || entry.workItemId)}</strong><span>${escapeMarkup(formalUiContract.statusLabel(entry.decision) || entry.decision)} · ${escapeMarkup(entry.createdAt || "")}</span></div><p>${escapeMarkup(entry.reason || "已记录判断")}</p><small>署名：${escapeMarkup(entry.signedByName || "当前核验人")} · 事实 ${escapeMarkup(entry.factId || "")}</small></li>`).join("");
    target.innerHTML = `<section class="verifier-question-panel verifier-workbench--assigned"><p class="panel-label">待我确认</p><h2>当前没有待核验事实</h2><p>${historyRows ? "新的任务会进入上方队列；以下是你已完成的判断署名记录，只读保留。" : "新的员工流程描述提交后，系统会把分配给你的候选事实显示在这里。"}</p>${historyRows ? `<section class="verifier-history" aria-labelledby="verifier-history-title"><h3 id="verifier-history-title">已完成判断</h3><ol>${historyRows}</ol></section>` : ""}</section>`;
    return;
  }
  const evidence = task.eligibleMaterials || task.evidenceItems || task.evidencePair || [];
  const sourceRefs = formalVerifier ? state.verifierSourceRefs : (task.sourceRefs || []);
  const evidenceGateMet = sourceRefs.length > 0 && sourceRefs.every((ref) => evidence.some((entry) => (entry.materialId || entry.id) === ref && entry.authorizationStatus === "authorized" && entry.integrityStatus === "verified"));
  const evidenceRows = evidence.map((entry, index) => {
    const label = entry.label || entry.title || `证据 ${String.fromCharCode(65 + index)}`;
    const detail = entry.detail || entry.source || entry.claim || "当前版本证据";
    const materialId = entry.materialId || entry.id || "";
    const eligible = entry.authorizationStatus === "authorized" && entry.integrityStatus === "verified";
    const selected = sourceRefs.includes(materialId);
    const review = entry.integrityStatus === "pending" ? `<div class="material-review"><label for="material-review-reason-${escapeMarkup(materialId)}">完整性复核理由</label><input id="material-review-reason-${escapeMarkup(materialId)}" placeholder="例如：校验值与企业导出记录一致"><div class="action-row"><button class="secondary-button" type="button" data-action="review-formal-material" data-material-id="${escapeMarkup(materialId)}" data-review-decision="verified" ${state.verifierReviewingMaterial ? "disabled" : ""}>通过</button><button class="text-button" type="button" data-action="review-formal-material" data-material-id="${escapeMarkup(materialId)}" data-review-decision="rejected" ${state.verifierReviewingMaterial ? "disabled" : ""}>拒绝</button></div></div>` : "";
    return `<article class="evidence-row"><div><p class="panel-label">${escapeMarkup(label)}</p><p>${escapeMarkup(detail)}</p>${eligible ? `<label class="material-selector"><input type="checkbox" name="verifier-source-ref" value="${escapeMarkup(materialId)}" ${selected ? "checked" : ""}>使用精确材料 ID ${escapeMarkup(materialId)} 作为本次依据</label>` : ""}${review}</div><dl><div><dt>材料 ID</dt><dd>${escapeMarkup(entry.materialKey || materialId || "待登记")}</dd></div><div><dt>版本</dt><dd>v${escapeMarkup(entry.version || 1)}</dd></div><div><dt>授权</dt><dd>${escapeMarkup(formalUiContract.statusLabel(entry.authorizationStatus || "pending"))}</dd></div><div><dt>完整性</dt><dd>${escapeMarkup(formalUiContract.statusLabel(entry.integrityStatus || "pending"))}</dd></div></dl></article>`;
  }).join("");
  const decision = state.verifierDecision;
  const insufficient = decision === "insufficient_evidence";
  const secondConfirmation = task.secondConfirmationAction === "second_confirmation";
  const positiveDecisionBlocked = decision !== "insufficient_evidence" && !evidenceGateMet;
  target.innerHTML = `
    <section class="verifier-question-panel verifier-workbench--assigned" aria-labelledby="verifier-question-title">
      <div class="panel-heading">
        <div>
          <p class="panel-label">事实组 ${escapeMarkup(state.verifierProgress.current)} / ${escapeMarkup(state.verifierProgress.total)} · ${escapeMarkup(task.factId || task.candidateFactId || task.id || "")}</p>
          <h2 id="verifier-question-title">${escapeMarkup(task.claim || task.question || task.title || "待核验事实")}</h2>
        </div>
        <span class="warning-chip">${escapeMarkup(task.statusLabel || formalUiContract.statusLabel(task.status) || "等待核验")}</span>
      </div>
      <p class="verifier-intro">只显示分配给你的候选事实、员工流程卡版本和已授权证据。替代解释仅供比较，不等于事实。</p>
      <section class="verifier-card-context"><p class="panel-label">员工流程卡</p><p>版本 v${escapeMarkup(task.flowCardVersion || "1")} · 证据版本 v${escapeMarkup(task.evidenceVersion || "1")}</p></section>
      <div class="evidence-register">${evidenceRows || "<p>暂无可用证据。</p>"}</div>
      <p class="evidence-gate ${evidenceGateMet ? "is-ready" : "is-blocked"}" role="status">${evidenceGateMet ? "证据门禁已满足：材料版本、授权和完整性均可核对。" : "证据门禁未满足：不能确认事实，只能要求补证。"}</p>
      <section class="alternative-explanations"><p class="panel-label">替代解释</p><ul>${(task.alternativeExplanations || []).map(formalAlternativeItem).join("") || "<li>暂无替代解释</li>"}</ul></section>
      ${secondConfirmation ? `<section class="second-confirmation"><p class="panel-label">高影响事实 · 独立二次确认</p><p>首次核验已经完成。请独立核对同一材料版本并填写你的复核理由。</p></section>` : `<div class="verifier-outcomes">
        <p class="panel-label">三种互斥判断</p>
        <div class="outcome-grid">
          ${[["same", "相同", "员工流程卡与证据指向同一业务事实"], ["different_with_correction", "不同，带修正", "保留差异并写明正确口径"], ["insufficient_evidence", "证据不足，等待补证", "暂停，不生成风险或负责人决策"]].map(([value, label, detail]) => `<label class="verifier-outcome ${decision === value ? "is-selected" : ""}"><input type="radio" name="verifier-decision" value="${value}" data-action="verifier-decision" ${decision === value ? "checked" : ""} ${value !== "insufficient_evidence" && !evidenceGateMet ? "disabled" : ""}><strong>${label}</strong><span>${detail}</span></label>`).join("")}
        </div>
      </div>`}
      <label class="field-label" for="verifier-reason">${secondConfirmation ? "独立复核理由" : "判断理由"}（必填）</label><textarea id="verifier-reason" rows="3" placeholder="说明你依据哪些证据做出判断。">${escapeMarkup(state.verifierReason)}</textarea>
      ${decision === "different_with_correction" ? '<label class="field-label" for="verifier-correction">修正内容（必填）</label><textarea id="verifier-correction" rows="3" placeholder="填写正确的业务口径。">' + escapeMarkup(state.verifierCorrection) + '</textarea>' : ""}
      ${insufficient ? `<fieldset class="supplement-fields"><legend>补证请求</legend><label>需要补什么材料<input id="supplement-material" value="${escapeMarkup(state.verifierSupplement.requestedMaterial)}"></label><label>补证责任人<select id="supplement-owner"><option value="">选择项目成员</option>${state.verifierResponsibleMembers.map((member) => `<option value="${escapeMarkup(member.account_id)}">${escapeMarkup(member.name || member.account_id)} · ${escapeMarkup(member.role)}</option>`).join("")}</select></label><p>截止日由系统按 5 个工作日自动计算；补齐后恢复同一事实。</p></fieldset>` : ""}
      ${secondConfirmation ? "" : `<label class="field-label" for="verifier-evidence-level">证据等级（来源强度，与是否已确认相互独立）</label>
      <select id="verifier-evidence-level">
        <option value="">未定级（保持不评级）</option>
        ${[["E1", "E1 可追溯的系统记录或直接运行证据"], ["E2", "E2 来源独立的相互印证"], ["E3", "E3 单一口述（默认，不等于已核实）"], ["E4", "E4 制度、SOP 或规定要求（不代表实际执行）"], ["E5", "E5 AI 推断或分析假设（必须标记：AI假设，待验证）"]].map(([value, label]) => `<option value="${value}" ${String(state.verifierEvidenceLevel || "").toUpperCase() === value ? "selected" : ""}>${label}</option>`).join("")}
      </select>
      <p class="field-help">等级只表示来源强度；“已确认”由你的判断决定。E5 不得作为已核实事实进入正式结论。</p>`}
      <button class="primary-button" type="button" data-action="submit-verifier-judgment" ${(!secondConfirmation && (!decision || positiveDecisionBlocked)) || state.verifierSubmitting ? "disabled" : ""}>${state.verifierSubmitting ? "正在保存…" : (secondConfirmation ? "完成独立二次确认" : "提交判断并处理下一事实")}</button>
      <div class="verifier-boundary">
        <strong>核验职责边界</strong>
        <span>你确认的是一个业务判断版本，不审批最终改造方案，也不修改 CRM。证据不足时保持 waiting，可从恢复入口提交新版本。</span>
      </div>
      ${state.verifierState === "waiting" ? '<div class="verifier-status" role="status">等待你的判断；未确认事实不会进入风险或负责人决策。</div>' : ""}
    </section>
  `;
}

function renderOwnerReview() {
  const review = state.ownerReview;
  const selectedDecision = state.ownerDecision
    ? `<p class="owner-status" role="status">已记录“${state.ownerDecision}”。演示闭环已完成，本地演示不会写入生产系统。</p>`
    : "";
  ownerReviewWorkbench.innerHTML = `
    ${renderDemoFlow("owner")}
    <section class="owner-review-panel" aria-labelledby="owner-review-panel-title">
      <div class="panel-heading">
        <div>
          <p class="panel-label">企业负责人审阅</p>
          <h2 id="owner-review-panel-title">${review.title}</h2>
        </div>
        <span class="state-chip state-chip--complete">等待决策</span>
      </div>
      <p class="owner-summary">${review.summary}</p>
      <div class="owner-grid">
        <section class="owner-card owner-card--facts">
          <p class="panel-label">已确认事实</p>
          <ul class="owner-list">
            ${review.verifiedFacts.map((fact) => `<li><strong>${fact.label}</strong><span>${fact.text}</span></li>`).join("")}
          </ul>
        </section>
        <section class="owner-card owner-card--risks">
          <p class="panel-label">核心风险</p>
          <ul class="owner-list">
            ${review.coreRisks.map((risk) => `<li><strong>${risk.label}</strong><span>${risk.text}</span></li>`).join("")}
          </ul>
        </section>
      </div>
      <section class="owner-pilot">
        <div>
          <p class="panel-label">小范围影子试点</p>
          <h3>${review.shadowPilot.title}</h3>
        </div>
        <p>${review.shadowPilot.text}</p>
      </section>
      <details class="owner-evidence">
        <summary>已核验依据（折叠）</summary>
        <p>这里保留的是摘要，不展开全部原始材料。</p>
        <ul>
          ${review.evidenceSummary.map((item) => `<li>${item}</li>`).join("")}
        </ul>
      </details>
      <div class="owner-actions">
        ${review.decisions.map((decision, index) => `
          <button class="${index === 0 ? "primary-button" : "secondary-button"} owner-action owner-action--${decision.tone} ${state.ownerDecision === decision.label ? "is-selected" : ""}" type="button" data-action="owner-decision" data-decision="${decision.label}" aria-pressed="${state.ownerDecision === decision.label}">
            <strong>${decision.label}</strong><span>${decision.detail}</span>
          </button>
        `).join("")}
      </div>
      <div class="owner-boundary">
        <strong>页面边界</strong>
        <span>${review.boundary}</span>
      </div>
      ${selectedDecision}
    </section>
  `;
}

function saveEmployeeDraft() {
  const draft = document.querySelector("#employee-draft");
  if (!draft) return;
  state.employeeDraft = draft.value;
  state.employeeSubmissionState = "saved";
  showMessage("草稿已保存在本地演示状态中。没有上传或外部写入。" );
  renderEmployeeWorkbench();
}

async function submitEmployeeSegment() {
  const draft = document.querySelector("#employee-draft");
  if (!draft || !draft.value.trim()) {
    showMessage("先写下一个具体工作片段，再提交这一段。" );
    draft?.focus();
    return;
  }
  state.employeeDraft = draft.value;
  await persistEmployeeSubmission("WI-001", state.employeeDraft);
  renderEmployeeWorkbench();
}

async function continueEmployeeInterview() {
  const draft = document.querySelector("#employee-draft");
  if (!draft || !draft.value.trim()) {
    showMessage("先回答 Agent 的这个问题，再继续摸排。");
    draft?.focus();
    return;
  }
  state.employeeInterviewAnswers[state.employeeInterviewStep] = draft.value.trim();
  state.employeeDraft = "";
  if (state.employeeInterviewStep < state.employeeTask.questions.length - 1) {
    state.employeeInterviewStep += 1;
    showMessage("已记录这一段，Agent 会继续追问下一步。");
    renderEmployeeWorkbench();
    return;
  }
  const transcript = state.employeeTask.questions
    .map((question, index) => `${question.label}：${state.employeeInterviewAnswers[index]}`)
    .join("\n\n");
  state.employeeDraft = transcript;
  await persistEmployeeSubmission("WI-001", transcript);
  renderEmployeeWorkbench();
}

function renderWizardPanel() {
  const step = wizardContent[state.wizardStep];
  wizardSteps.forEach((item, index) => {
    item.classList.toggle("is-active", index === state.wizardStep);
    item.classList.toggle("is-complete", index < state.wizardStep);
  });
  wizardPanel.innerHTML = `
    <p class="wizard-count">第 ${state.wizardStep + 1} 步，共 4 步</p>
    <h3>${step.title}</h3>
    <p>${step.text}</p>
    <div class="wizard-selection">${step.selection}</div>
    ${state.wizardStep === 3 ? '<aside class="wizard-boundary"><strong>演示边界</strong><span>当前使用 E5 合成模拟材料，不会读取您企业的真实数据，也不连接企业系统。</span></aside>' : ""}
  `;
  wizardBackButton.disabled = state.wizardStep === 0;
  wizardNextButton.textContent = state.wizardStep === 3 ? "创建并进入工作台" : "下一步";
}

function openProjectWizard() {
  state.wizardStep = 0;
  renderWizardPanel();
  wizardDialog.showModal();
}

function closeProjectWizard() {
  wizardDialog.close();
}

function advanceWizard() {
  if (state.wizardStep < wizardContent.length - 1) {
    state.wizardStep += 1;
    renderWizardPanel();
    return;
  }
  const session = {
    authenticated: state.authenticated,
    role: state.role,
    simulationRunToken: state.simulationRunToken + 1,
  };
  Object.assign(state, cloneFixture(), { ...session, projectCreated: true, wizardStep: 0, blockingMessage: "" });
  state.activityEvents = [];
  appendActivity({
    actor: "system",
    actorLabel: "系统",
    action: "诊断项目已创建",
    impact: "已进入材料与事实阶段，等待模拟 Agent 开始分析。",
  });
  wizardDialog.close();
  clearMessage();
  renderProjectList();
  showView("diagnostic-workbench-view");
  renderWorkbench();
}

function startSimulation() {
  const runToken = state.simulationRunToken + 1;
  state.simulationRunToken = runToken;
  state.simulationState = "running";
  appendActivity({
    actor: "agent",
    actorLabel: "模拟 Agent",
    action: "模拟 Agent 开始分析",
    impact: "正在整理 E5 合成材料、事实来源和岗位信息。",
  });
  clearMessage();
  renderWorkbench();

  window.setTimeout(() => {
    if (state.simulationRunToken !== runToken || state.simulationState !== "running") return;
    runDiagnostic({ projectId: state.project.id, stageId: state.project.currentStage }).then((result) => {
      if (state.simulationRunToken !== runToken || state.simulationState !== "running") return;
      state.simulationState = "complete";
      state.confirmedFacts = result.facts;
      state.candidateInterpretations = result.candidateInterpretations;
      state.alternativeExplanations = result.alternativeExplanations;
      state.unresolvedQuestions = result.unresolvedQuestions;
      state.agentFindings = result.findings;
      state.agentRecommendations = result.recommendations;
      state.confirmationItems = result.confirmationItems;
      state.outputs = result.outputs.map((output) => ({ ...output, status: "blocked" }));
      if (state.confirmationItems.length > 0) {
        appendActivity({
          actor: "agent",
          actorLabel: "模拟 Agent",
          action: "发现证据冲突并暂停",
          impact: `生成 ${state.confirmationItems.length} 项待人工确认事项，阻塞下一阶段产出。`,
        });
      }
      renderProjectList();
      renderWorkbench();
    }).catch(() => {
      if (state.simulationRunToken !== runToken || state.simulationState !== "running") return;
      state.simulationState = "idle";
      showMessage("模拟诊断未完成，请稍后重试。当前仍为本地演示状态。");
      appendActivity({
        actor: "system",
        actorLabel: "系统",
        action: "模拟 Agent 运行失败",
        impact: "本轮模拟未产出结果，未改变任何业务数据。",
      });
      renderProjectList();
      renderWorkbench();
    });
  }, 600);
}

function unlockRiskStage() {
  const previousStage = stageById(state.project.currentStage);
  previousStage.status = "done";
  const risks = stageById("risks");
  risks.status = "active";
  state.project.currentStage = "risks";
  state.outputs = state.outputs.map((output) => ({ ...output, status: "ready" }));
  appendActivity({
    actor: "system",
    actorLabel: "系统",
    action: "断点与风险阶段已解锁",
    impact: "当前诊断阶段已推进到断点与风险。",
  });
  appendActivity({
    actor: "system",
    actorLabel: "系统",
    action: "三类诊断产出已就绪",
    impact: "断点清单、改造建议和验证路线已标记为已产出。",
  });
}

function resolveConfirmation(itemId) {
  const item = state.confirmationItems.find((entry) => entry.id === itemId);
  if (!item) return;
  if (item.status === "needs_evidence") return;
  item.status = "resolved";
  appendActivity({
    actor: "human",
    actorLabel: "人工",
    action: "人工确认事实",
    impact: "已记录本地演示确认，不修改客户业务记录。",
    itemId,
  });
  state.blockingMessage = "";
  if (state.confirmationItems.every((entry) => entry.status === "resolved")) {
    unlockRiskStage();
    showMessage("已记录人工确认。下一阶段已解锁，仍仅改变本地演示状态。");
  }
  renderProjectList();
  renderWorkbench();
}

function requestMoreEvidence(itemId) {
  const item = state.confirmationItems.find((entry) => entry.id === itemId);
  if (!item) return;
  item.status = "needs_evidence";
  appendActivity({
    actor: "human",
    actorLabel: "人工",
    action: "人工要求补充材料",
    impact: "当前确认事项保持阻塞，等待补充模拟材料。",
    itemId,
  });
  state.blockingMessage = "未确认事项尚未处理：请补充材料后再继续。";
  renderProjectList();
  renderWorkbench();
}

function provideEvidence(itemId) {
  const item = state.confirmationItems.find((entry) => entry.id === itemId);
  if (!item || item.status !== "needs_evidence") return;
  item.status = "evidence_provided";
  appendActivity({
    actor: "system",
    actorLabel: "系统",
    action: "模拟材料已补充",
    impact: "已补充模拟材料，等待人工核对后确认事实。",
    itemId,
  });
  state.blockingMessage = "已补充一份模拟材料，请核对后再确认事实。";
  renderProjectList();
  renderWorkbench();
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;

  if (button.dataset.roleChoice) {
    roleInput.value = button.dataset.roleChoice;
    roleOptions.forEach((option) => {
      const selected = option.dataset.roleChoice === roleInput.value;
      option.classList.toggle("is-selected", selected);
      option.setAttribute("aria-checked", String(selected));
    });
    return;
  }

  if (button.dataset.action === "open-project-wizard") openProjectWizard();
  if (button.dataset.action === "enter-demo") {
    const demoUrl = window.location.pathname + "?demo=1";
    window.location.assign(demoUrl);
  }
  if (button.dataset.action === "show-builder-login") showFormalEntryMode("builder");
  if (button.dataset.action === "demo-enter") enterDemo(button.dataset.demoRole);
  if (button.dataset.action === "refresh-formal-verifier") {
    if (state.formalProjectId) loadFormalVerifierWorkspace(state.formalProjectId);
  }
  if (button.dataset.action === "formal-logout") {
    // 退出后回到统一的正式入口，并清掉本地保存的项目名与身份。
    state.formalSessionActive = false;
    state.formalProjectId = "";
    state.formalProjectName = "";
    state.formalBuilderName = "";
    window.diagnosticApi?.logout?.().catch(() => {}).finally(() => {
      window.location.href = window.location.pathname;
    });
    return;
  }
  if (button.dataset.action === "show-member-login") showFormalEntryMode("member");
  if (button.dataset.action === "consume-member-test-token") consumeFormalMemberTestToken();
  if (button.dataset.action === "choose-member-project") enterMemberProject(document.querySelector("#formal-member-project-choice")?.value);
  if (button.dataset.action === "select-formal-project") {
    state.formalProjectId = button.dataset.projectId;
    state.formalAuthorizationKey = "";
    state.formalDecisionDraftKey = "";
    state.formalDecisionDraftPayload = null;
    loadFormalBuilderWorkspace();
  }
  if (button.dataset.action === "open-formal-reassignment") openFormalReassignment(button.dataset.itemId);
  if (button.dataset.action === "close-formal-reassignment") closeFormalReassignment();
  if (button.dataset.action === "publish-formal-packet") publishFormalDecisionPacket(button.dataset.packetId);
  if (button.dataset.action === "resend-formal-authorization") resendFormalAuthorization(button.dataset.authorizationId);
  if (button.dataset.action === "copy-formal-authorization-link") {
    const link = document.querySelector("#formal-manual-link")?.value || "";
    if (!link) return;
    (navigator.clipboard?.writeText ? navigator.clipboard.writeText(link) : Promise.reject()).then(() => showMessage("确认链接已复制，可发给企业确认人。")).catch(() => showMessage("复制失败，请手动选中链接复制。"));
  }
  if (button.dataset.action === "review-formal-material") reviewFormalMaterial(button.dataset.materialId, button.dataset.reviewDecision);
  if (button.dataset.action === "bind-formal-material-authorization") bindFormalMaterialConsent(button.dataset.materialId);
  if (button.dataset.action === "refresh-formal-employee") loadFormalEmployeeTask(state.formalProjectId);
  if (button.dataset.action === "revoke-formal-invitation") {
    const invitationId = button.dataset.invitationId;
    if (!state.formalBuilderPendingAction && invitationId) {
      state.formalBuilderPendingAction = invitationId;
      button.disabled = true;
      window.diagnosticApi.revokeInvitation(invitationId)
        .then(() => loadFormalBuilderWorkspace())
        .catch((error) => showMessage("邀请未能撤回：" + error.message))
        .finally(() => { state.formalBuilderPendingAction = ""; });
    }
  }
  if (button.dataset.action === "verify-formal-packet") {
    window.diagnosticApi.verifyFormalDecisionPacket(button.dataset.packetId, state.verifierPacket.factRefs)
      .then(() => { state.verifierPacket = null; state.verifierState = "empty"; renderVerifierWorkbench(); showMessage("事实引用已确认，已交回外部改造方发布。"); })
      .catch((error) => showMessage("未能确认决策包：" + error.message));
  }
  if (button.dataset.action === "close-project-wizard") closeProjectWizard();
  if (button.dataset.action === "wizard-back" && state.wizardStep > 0) {
    state.wizardStep -= 1;
    renderWizardPanel();
  }
  if (button.dataset.action === "wizard-next") advanceWizard();
  if (button.dataset.action === "open-workbench") {
    clearMessage();
    showView("diagnostic-workbench-view");
    renderWorkbench();
  }
  if (button.dataset.action === "show-project-list") {
    clearMessage();
    showView("project-list-view");
  }
  if (button.dataset.action === "start-simulation") startSimulation();
  if (button.dataset.action === "resolve-confirmation") resolveConfirmation(button.dataset.itemId);
  if (button.dataset.action === "request-evidence") requestMoreEvidence(button.dataset.itemId);
  if (button.dataset.action === "provide-evidence") provideEvidence(button.dataset.itemId);
  if (button.dataset.action === "save-employee-draft") saveEmployeeDraft();
  if (button.dataset.action === "submit-employee-segment") submitEmployeeSegment();
  if (button.dataset.action === "continue-employee-interview") continueEmployeeInterview();
  if (button.dataset.action === "start-formal-employee") {
    state.formalEmployeeEditIndex = null;
    state.formalAgentQuestion = resumeFormalAgentQuestion();
    state.formalAgentFlowCard = null;
    state.formalEmployeeStep = "questions";
    renderFormalEmployeeWorkbench();
  }
  if (button.dataset.action === "continue-formal-employee") {
    const question = state.formalAgentQuestion || formalEmployeeQuestions[Math.max(0, formalUiContract.employeeQuestionIndex(state.formalEmployeeAnswers, state.formalEmployeeEditIndex, formalEmployeeQuestions.length))];
    const answer = document.querySelector("#formal-employee-answer");
    const text = answer?.value?.trim() || "";
    if (!question || !text) {
      showMessage("先回答 Agent 的问题，再继续。");
    } else {
      state.formalEmployeeAnswers[question.key] = text;
      // 提交即清空。渲染时的“输入框有焦点就不动它”保护会跳过清空，
      // 所以必须在这里清；否则用户看到旧答案还以为没提交成功。
      if (answer) answer.value = "";
      continueFormalEmployeeAgent(question, text);
    }
  }
  if (button.dataset.action === "save-formal-employee-draft") saveFormalEmployeeDraft();
  // 头部工具：回到最新一问。对话长了以后用户常常停在上面看不到新内容。
  if (button.dataset.action === "scroll-thread-bottom") {
    const thread = document.querySelector("#formal-employee-thread");
    if (thread) thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" });
  }
  if (button.dataset.action === "recheck-formal-employee") recheckFormalEmployeeAssignment();
  if (button.dataset.action === "edit-formal-employee") {
    state.formalEmployeeSubmissionKey = "";
    state.formalEmployeeEditIndex = 0;
    state.formalAgentQuestion = resumeFormalAgentQuestion();
    state.formalAgentFlowCard = null;
    state.formalEmployeeStep = "questions";
    renderFormalEmployeeWorkbench();
  }
  if (button.dataset.action === "submit-formal-employee") submitFormalEmployee();
  if (button.dataset.action === "submit-formal-employee-supplement") submitFormalEmployeeSupplement();
  if (button.dataset.action === "switch-role") switchDemoRole(button.dataset.role);
  if (button.dataset.action === "owner-decision") {
    persistOwnerDecision("WI-005", button.dataset.decision).then(renderOwnerReview);
  }
  if (button.dataset.action === "verifier-outcome") {
    persistVerification("WI-002", button.dataset.outcome).then(renderVerifierWorkbench);
  }
  if (button.dataset.action === "submit-verifier-judgment") submitVerifierJudgment();
  if (button.dataset.action === "view-risks") {
    document.querySelector("#risk-details")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (button.dataset.action === "view-proposal") {
    document.querySelector("#proposal-details")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
});

invitationForm.addEventListener("submit", enterFromInvitation);
formalBuilderLoginForm?.addEventListener("submit", submitFormalBuilderLogin);
formalMemberLoginForm?.addEventListener("submit", submitFormalMemberLogin);
formalInvitationAcceptForm?.addEventListener("submit", submitFormalInvitationAccept);
formalProjectForm?.addEventListener("submit", submitFormalProject);
formalInvitationForm?.addEventListener("submit", submitFormalInvitation);

document.addEventListener("input", (event) => {
  if (event.target.id === "employee-draft") state.employeeDraft = event.target.value;
  if (event.target.id === "verifier-reason") state.verifierReason = event.target.value;
  if (event.target.dataset && event.target.dataset.inferenceCorrection) {
    const id = event.target.dataset.inferenceCorrection;
    // U6：更正原文属于"尚未保存的判定动作"，写入 pending；保存成功后以服务端返回值为准。
    state.formalInferencePending = state.formalInferencePending || {};
    state.formalInferencePending[id] = { verdict: "correct", correction: event.target.value };
  }
  if (event.target.id === "verifier-correction") state.verifierCorrection = event.target.value;
  if (event.target.id === "verifier-evidence-level") state.verifierEvidenceLevel = event.target.value;
  const supplementMap = { "supplement-material": "requestedMaterial", "supplement-owner": "responsiblePerson", "supplement-deadline": "deadline", "supplement-recovery": "recoveryEntry" };
  if (supplementMap[event.target.id]) state.verifierSupplement[supplementMap[event.target.id]] = event.target.value;
});

document.addEventListener("change", (event) => {
  if (event.target.name === "formal-material-status") state.formalEmployeeMaterialStatus = event.target.value;
  // AI 推断的逐条判定。
  // 这里不重绘整张卡：点一个单选框就重绘会让整份文档重新入场，
  // 手感上和"页面刷新"一样糟。只就地显示/隐藏更正输入框。
  if (event.target.dataset && event.target.dataset.inferenceId) {
    const id = event.target.dataset.inferenceId;
    // U6：选择动作先进入 pending；**不直接写可信判定**，权威状态以保存后的服务端返回为准。
    const prior = (state.formalInferencePending || {})[id] || (state.formalInferenceVerdicts || {})[id] || {};
    state.formalInferencePending = state.formalInferencePending || {};
    state.formalInferencePending[id] = { verdict: event.target.value, correction: prior.correction || "" };
    updateInferenceSummary();
    const row = event.target.closest("tr");
    if (row) {
      row.classList.remove("wfc-row--missing");
      row.classList.remove("wfc-row--stale");
      const cell = row.querySelector(".wfc-judge") || row.lastElementChild;
      let input = cell && cell.querySelector("[data-inference-correction]");
      if (event.target.value === "correct") {
        if (cell && !input) {
          input = document.createElement("input");
          input.className = "wfc-correction";
          input.dataset.inferenceCorrection = id;
          input.placeholder = "写下实际情况";
          input.value = prior.correction || "";
          cell.appendChild(input);
        }
        if (input) input.focus();
      } else if (input) {
        input.remove();
      }
    }
    updateInferenceSummary();
    // PILOT-08C/R3：判定必须在**员工选择的那一刻**落库，
    // 而不是等他某次显式点「保存草稿」。否则：① 提交核验时判定可能从未持久化；
    // ② 刷新/切卡会丢失未保存的更正。这里做去抖自动保存（与手动保存同一路径）。
    scheduleInferenceVerdictFlush();
    return;
  }
  if (event.target.name === "verifier-source-ref") {
    const value = event.target.value;
    state.verifierSourceRefs = event.target.checked ? [...new Set([...state.verifierSourceRefs, value])] : state.verifierSourceRefs.filter((entry) => entry !== value);
    renderVerifierWorkbench();
  }
  if (event.target.name === "verifier-decision") {
    state.verifierDecision = event.target.value;
    state.verifierState = "editing";
    renderVerifierWorkbench();
  }
});

wizardDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeProjectWizard();
});

renderProjectList();
renderWorkbench();
renderEmployeeWorkbench();
renderVerifierWorkbench();
renderOwnerReview();
const startupParams = new URLSearchParams(window.location.search);
if (startupParams.get("demo") === "1") {
  // B2-02：?demo=1 只决定是否渲染演示容器 —— 这是前端路由，不授予任何后端权限。
  // 进入具体演示身份仍必须由服务端 /api/demo/enter 判定（非显式 development 即 403）。
  showView("demo-entry-view");
} else {
  openFormalEntry();
}

const workspaceOverviewElement = document.querySelector("#workspace-overview");
const workQueueElement = document.querySelector("#work-queue");
const detailDrawerElement = document.querySelector("#detail-drawer");
const drawerScrimElement = document.querySelector("#drawer-scrim");
const bulkActionBarElement = document.querySelector("#bulk-action-bar");
const workspaceRoleLabel = document.querySelector("#workspace-role-label");
const workspaceSubtitle = document.querySelector("#workspace-subtitle");
const backendStatusElement = document.querySelector("#backend-status");
const backendStatusLabel = document.querySelector("#backend-status-label");
let drawerTrigger = null;

Object.assign(state, {
  activeNav: "overview",
  filters: { query: "", stage: "all", status: "all", evidence: "all", mineOnly: true },
  selectedWorkItemIds: [],
  openWorkItemId: "",
  queueState: "ready",
  feedback: null,
  page: 1,
  pageSize: 6,
  backendConnection: "idle",
  backendError: "",
  backendEvents: [],
  pendingAction: "",
});

const navigationStage = {
  mapping: "mapping",
  facts: "facts",
  risks: "risk",
  decisions: "decision",
};

function escapeMarkup(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function currentRolePolicy() {
  return state.rolePolicy[state.role] || state.rolePolicy.owner;
}

function renderRoleNavigation() {
  const allowedNavigation = currentRolePolicy().navigation || ["overview"];
  sidebarItems.forEach((item) => {
    const visible = allowedNavigation.includes(item.dataset.nav);
    item.hidden = !visible;
    item.disabled = !visible;
    item.classList.toggle("is-active", visible && item.dataset.nav === state.activeNav);
  });
}

const apiStageLabels = {
  mapping: "流程摸排",
  facts: "材料与事实",
  risk: "风险与建议",
  decision: "审阅决策",
};

const apiStatusLabels = {
  needs_input: "待补充流程",
  awaiting_verification: "等待人工核验",
  blocked: "证据不足",
  analysis_ready: "分析已就绪",
  awaiting_decision: "等待负责人审阅",
  complete: "已完成",
};

function adaptApiWorkItem(item) {
  const presentation = fixture.workItems.find((entry) => entry.id === item.id) || {};
  return {
    ...presentation,
    ...item,
    stageLabel: apiStageLabels[item.stage] || item.stage,
    statusLabel: apiStatusLabels[item.status] || item.status,
    updatedAt: item.updatedAt || "刚刚",
    candidateFacts: presentation.candidateFacts || [],
    evidenceSources: presentation.evidenceSources || [],
  };
}

function adaptApiEvent(event) {
  const actionLabels = {
    employee_submitted: "员工提交流程描述",
    handoff: "任务已转交下一职责",
    fact_confirmed: "人工确认事实",
    evidence_insufficient: "人工要求补充材料",
    owner_decision: "负责人完成审阅",
  };
  const actorLabels = { employee: "一线员工", verifier: "核验人员", owner: "企业负责人" };
  return {
    id: event.event_id || event.id,
    actor: event.actorRole,
    actorLabel: actorLabels[event.actorRole] || "系统",
    action: actionLabels[event.type] || event.type,
    impact: event.type === "handoff" ? "事项已进入下一职责的任务队列。" : "处理结果已保存到本地数据库。",
    itemId: event.workItemId || "",
    occurredAt: event.createdAt ? new Date(event.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "刚刚",
  };
}

function renderBackendStatus() {
  if (!backendStatusElement || !backendStatusLabel) return;
  const preview = window.diagnosticApi?.isCloudflarePreview;
  const labels = {
    idle: "E5合成数据 · 等待进入项目",
    loading: "正在连接本地数据库",
    connected: "本地数据库已连接",
    error: isDirectFileMode ? "请使用本地服务入口" : "本地服务不可用",
  };
  if (preview) {
    labels.loading = "正在加载线上预览数据";
    labels.connected = "Cloudflare D1 · 已连接";
    labels.error = "Cloudflare 后端不可用";
  }
  backendStatusElement.dataset.state = state.backendConnection;
  backendStatusLabel.textContent = labels[state.backendConnection];
  const retry = backendStatusElement.querySelector('[data-action="retry-backend"]');
  if (retry) retry.hidden = state.backendConnection !== "error";
}

async function loadBackendWorkspace() {
  state.backendConnection = "loading";
  state.backendError = "";
  state.queueState = "loading";
  renderBackendStatus();
  renderWorkspace();
  window.diagnosticApi.setIdentity(state.role);
  try {
    const projectId = state.domainModel.project.id;
    const [workItemPayload, eventPayload] = await Promise.all([
      window.diagnosticApi.listWorkItems(projectId),
      window.diagnosticApi.listEvents(projectId),
    ]);
    state.workItems = workItemPayload.items.map(adaptApiWorkItem);
    state.backendEvents = eventPayload.events.map(adaptApiEvent);
    state.activityEvents = state.backendEvents;
    state.backendConnection = "connected";
    state.queueState = "ready";
    renderBackendStatus();
    renderWorkspace();
  } catch (error) {
    state.backendConnection = "error";
    state.backendError = error.message;
    state.queueState = "error";
    renderBackendStatus();
    renderWorkspace();
  }
}

async function runBackendAction(itemId, action, successMessage) {
  state.pendingAction = itemId;
  renderWorkspace();
  try {
    await action();
    setFeedback("success", successMessage);
    return true;
  } catch (error) {
    setFeedback("error", `处理结果没有保存：${error.message}`);
    return false;
  } finally {
    state.pendingAction = "";
    renderWorkspace();
  }
}

async function persistEmployeeSubmission(itemId, text) {
  const saved = await runBackendAction(
    itemId,
    () => window.diagnosticApi.submitEmployee(itemId, text),
    "这一段已保存，并提交给核验人员。",
  );
  if (!saved) return false;
  state.employeeDraft = text;
  state.employeeSubmissionState = "submitted";
  if (state.openWorkItemId) closeDetail();
  await loadBackendWorkspace();
  return true;
}

async function persistVerification(itemId, outcome) {
  const decisions = {
    "同一个客户": "same",
    "不同客户": "different",
    "暂时无法判断": "insufficient",
  };
  const saved = await runBackendAction(
    itemId,
    () => window.diagnosticApi.verify(itemId, decisions[outcome]),
    `已保存“${outcome}”。`,
  );
  if (!saved) return false;
  state.verifierOutcome = outcome;
  if (state.openWorkItemId) closeDetail();
  await loadBackendWorkspace();
  return true;
}

async function submitVerifierJudgment() {
  const item = state.verifierFact || state.workItems.find((entry) => entry.assigneeRole === "verifier" && entry.stage === "facts");
  const secondConfirmation = item?.secondConfirmationAction === "second_confirmation";
  if (!item || (!secondConfirmation && !state.verifierDecision) || state.verifierSubmitting) return;
  const reason = document.querySelector("#verifier-reason")?.value.trim() || state.verifierReason.trim();
  const correction = document.querySelector("#verifier-correction")?.value.trim() || state.verifierCorrection.trim();
  state.verifierReason = reason;
  state.verifierCorrection = correction;
  if (!reason) return showMessage("请填写判断理由。");
  if (secondConfirmation) {
    state.verifierSubmitting = true;
    renderVerifierWorkbench();
    const workItemId = item.workItemId || item.id;
    const result = await runBackendAction(workItemId, () => window.diagnosticApi.verifyFormal(workItemId, { factId: item.factId, action: "second_confirmation", secondConfirmationReason: reason }), "二次确认已保存，状态已更新。");
    state.verifierSubmitting = false;
    if (result) await loadFormalVerifierWorkspace(state.formalProjectId);
    else renderVerifierWorkbench();
    return;
  }
  if (state.verifierDecision === "different_with_correction" && !correction) return showMessage("请填写修正内容。");
  const supplement = state.verifierDecision === "insufficient_evidence"
    ? {
        requestedMaterial: document.querySelector("#supplement-material")?.value.trim() || "",
        responsibleAccountId: document.querySelector("#supplement-owner")?.value.trim() || "",
        authorizationScope: "project",
        sourceRefs: item.sourceRefs || [],
      }
    : {};
  if (state.verifierDecision === "insufficient_evidence" && (!supplement.requestedMaterial || !supplement.responsibleAccountId)) return showMessage("请说明需要补什么，并选择项目中的补证责任人。");
  // D-1：legacy 演示壳与正式三栏壳各有一个同名控件（历史遗留），必须限定在
  // 当前可见的容器内读取，否则会读到隐藏的 legacy 控件而漏掉核验人的选择。
  const levelScopes = ["#verifier-composer-inner", "#verifier-composer"];
  let levelEl = null;
  for (const scope of levelScopes) {
    const found = document.querySelector(`${scope} #verifier-evidence-level`);
    if (found) { levelEl = found; break; }
  }
  const evidenceLevel = (levelEl?.value || "").trim().toUpperCase();
  const verify = state.formalSessionActive
    ? window.diagnosticApi.verifyFormal.bind(window.diagnosticApi)
    : window.diagnosticApi.verify.bind(window.diagnosticApi);
  state.verifierSubmitting = true;
  renderVerifierWorkbench();
  const workItemId = item.workItemId || item.id;
  const result = await runBackendAction(workItemId, () => verify(workItemId, {
    factId: item.factId || item.candidateFactId,
    decision: state.verifierDecision,
    reason,
    evidenceLevel: evidenceLevel || undefined,
    correction: correction || undefined,
    sourceRefs: state.formalSessionActive ? state.verifierSourceRefs : (item.sourceRefs || item.evidenceItems?.map((entry) => entry.materialId || entry.id || entry.sourceRef).filter(Boolean) || []),
    ...supplement,
  }), "判断已保存，状态已更新。");
  if (result) {
    state.verifierState = state.verifierDecision === "insufficient_evidence" ? "waiting" : "submitted";
    if (state.formalSessionActive) await loadFormalVerifierWorkspace(state.formalProjectId);
    else {
      await loadBackendWorkspace();
      renderVerifierWorkbench();
    }
  }
  state.verifierSubmitting = false;
  renderVerifierWorkbench();
}

async function reviewFormalMaterial(materialId, decision) {
  if (!materialId || state.verifierReviewingMaterial) return;
  const reason = document.getElementById(`material-review-reason-${materialId}`)?.value.trim() || "";
  if (!reason) return showMessage("请填写材料完整性复核理由。");
  state.verifierReviewingMaterial = materialId;
  renderVerifierWorkbench();
  try {
    await window.diagnosticApi.reviewFormalMaterial(state.formalProjectId, materialId, { decision, reason });
    showMessage(decision === "verified" ? "材料完整性已确认，可以选择为事实依据。" : "材料已拒绝，不能用于事实确认。");
    await loadFormalVerifierWorkspace(state.formalProjectId);
  } catch (error) {
    showMessage("材料复核没有保存：" + error.message);
  } finally {
    state.verifierReviewingMaterial = "";
    renderVerifierWorkbench();
  }
}

async function persistOwnerDecision(itemId, label) {
  const decisions = {
    "继续影子试点": "continue_pilot",
    "要求修改": "request_revision",
    "暂不推进": "pause",
  };
  const saved = await runBackendAction(
    itemId,
    () => window.diagnosticApi.decide(itemId, decisions[label]),
    `已保存“${label}”。`,
  );
  if (!saved) return false;
  state.ownerDecision = label;
  if (state.openWorkItemId) closeDetail();
  await loadBackendWorkspace();
  return true;
}

function visibleWorkItems({ ignoreFilters = false } = {}) {
  const policy = currentRolePolicy();
  const navStage = navigationStage[state.activeNav];
  return state.workItems.filter((item) => {
    const roleVisible = policy.queueStages.includes(item.stage);
    if (!roleVisible) return false;
    if (navStage && item.stage !== navStage) return false;
    if (ignoreFilters) return true;
    const haystack = `${item.title} ${item.assigneeLabel} ${item.statusLabel} ${item.blockingReason}`;
    const queryMatch = !state.filters.query || haystack.toLowerCase().includes(state.filters.query.toLowerCase());
    const stageMatch = state.filters.stage === "all" || item.stage === state.filters.stage;
    const statusMatch = state.filters.status === "all" || item.status === state.filters.status;
    const evidenceMatch = state.filters.evidence === "all"
      || (state.filters.evidence === "low" && item.evidenceCompleteness < 70)
      || (state.filters.evidence === "medium" && item.evidenceCompleteness >= 70 && item.evidenceCompleteness < 100)
      || (state.filters.evidence === "complete" && item.evidenceCompleteness === 100);
    const mineMatch = !state.filters.mineOnly || item.assigneeRole === state.role;
    return queryMatch && stageMatch && statusMatch && evidenceMatch && mineMatch;
  });
}

function roleQueueCounts() {
  return {
    mapping: state.workItems.filter((item) => item.stage === "mapping" && item.status !== "complete").length,
    facts: state.workItems.filter((item) => item.stage === "facts" && item.status !== "complete").length,
    decision: state.workItems.filter((item) => item.stage === "decision" && item.status !== "complete").length,
  };
}

function renderWorkspaceOverview() {
  if (!workspaceOverviewElement) return;
  const items = visibleWorkItems({ ignoreFilters: true });
  const next = items.find((item) => item.status !== "complete") || items[0];
  const counts = roleQueueCounts();
  const activeStageIndex = Math.max(0, state.stages.findIndex((stage) => stage.id === state.project.currentStage));
  workspaceOverviewElement.innerHTML = `
    <article class="overview-primary">
      <div class="overview-primary__top">
        <span class="workspace-eyebrow">当前优先事项</span>
        <span class="status-label ${next?.status === "blocked" ? "status-label--blocked" : ""}">${next ? escapeMarkup(next.statusLabel) : "暂无待办"}</span>
      </div>
      <h2>${next ? escapeMarkup(next.title) : "当前角色的任务已处理完毕"}</h2>
      <p>${next ? `阻塞原因：${escapeMarkup(next.blockingReason)}` : "你可以查看项目进度和最近活动。"}</p>
      <div class="stage-progress" aria-label="项目阶段进度">
        ${state.stages.map((stage, index) => `<span class="${index < activeStageIndex ? "is-done" : index === activeStageIndex ? "is-active" : ""}" title="${escapeMarkup(stage.label)}"></span>`).join("")}
      </div>
    </article>
    <div class="overview-metric"><span>待摸排</span><strong>${counts.mapping}</strong></div>
    <div class="overview-metric"><span>待核验</span><strong>${counts.facts}</strong></div>
    <div class="overview-metric"><span>待决策</span><strong>${counts.decision}</strong></div>
  `;
}

function activeFilterLabels() {
  const labels = [];
  if (state.filters.query) labels.push(`搜索：${state.filters.query}`);
  if (state.filters.stage !== "all") labels.push(`阶段：${{ mapping: "流程摸排", facts: "材料与事实", risk: "风险与建议", decision: "审阅决策" }[state.filters.stage]}`);
  if (state.filters.status !== "all") labels.push(`状态：${state.filters.status}`);
  if (state.filters.evidence !== "all") labels.push(`证据：${{ low: "不足 70%", medium: "70%-99%", complete: "完整" }[state.filters.evidence]}`);
  if (state.filters.mineOnly) labels.push("只看我的任务");
  return labels;
}

function renderQueueToolbar(resultCount) {
  const filters = activeFilterLabels();
  return `
    <div class="queue-toolbar" aria-label="任务筛选">
      <input id="queue-search" type="search" value="${escapeMarkup(state.filters.query)}" placeholder="搜索流程、岗位或事项" aria-label="搜索任务">
      <select id="queue-stage-filter" aria-label="按阶段筛选">
        <option value="all">全部阶段</option><option value="mapping">流程摸排</option><option value="facts">材料与事实</option><option value="risk">风险与建议</option><option value="decision">审阅决策</option>
      </select>
      <select id="queue-status-filter" aria-label="按状态筛选">
        <option value="all">全部状态</option><option value="needs_input">待补充</option><option value="awaiting_verification">待核验</option><option value="blocked">已阻塞</option><option value="awaiting_decision">待决策</option><option value="complete">已完成</option>
      </select>
      <select id="queue-evidence-filter" aria-label="按证据完整度筛选">
        <option value="all">证据完整度</option><option value="low">不足 70%</option><option value="medium">70%-99%</option><option value="complete">完整</option>
      </select>
      <label class="mine-toggle"><input id="queue-mine-only" type="checkbox" ${state.filters.mineOnly ? "checked" : ""}>只看我的任务</label>
      <span class="filter-spacer"></span>
      <button class="text-button" type="button" data-action="clear-filters">清除全部</button>
    </div>
    ${filters.length ? `<div class="active-filters">${filters.map((label) => `<button class="filter-chip" type="button" data-action="clear-filters">${escapeMarkup(label)} ×</button>`).join("")}<span class="queue-count">${resultCount} 条结果</span></div>` : ""}
  `;
}

function renderWorkItemRow(item) {
  const selected = state.selectedWorkItemIds.includes(item.id);
  return `
    <tr class="${selected ? "is-selected" : ""}" data-item-row="${item.id}">
      <td><input type="checkbox" data-action="toggle-work-item" data-item-id="${item.id}" aria-label="选择 ${escapeMarkup(item.title)}" ${selected ? "checked" : ""}></td>
      <td><button class="queue-title-button" type="button" data-action="open-detail" data-item-id="${item.id}">${escapeMarkup(item.title)}</button><span class="queue-subtext">${item.id}</span></td>
      <td><span class="status-label ${item.status === "blocked" ? "status-label--blocked" : ""}">${escapeMarkup(item.stageLabel)}</span></td>
      <td>${escapeMarkup(item.assigneeLabel)}</td>
      <td><span class="evidence-meter"><i style="--evidence:${item.evidenceCompleteness}%"></i><b>${item.evidenceCompleteness}%</b></span></td>
      <td>${escapeMarkup(item.blockingReason)}</td>
      <td>${escapeMarkup(item.updatedAt)}</td>
      <td><button class="row-action" type="button" data-action="open-detail" data-item-id="${item.id}">${escapeMarkup(item.nextAction)}</button></td>
    </tr>
  `;
}

function renderPagination(total) {
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  if (state.page > pages) state.page = pages;
  return `
    <div class="pagination"><span>每页 ${state.pageSize} 条 · 共 ${total} 条</span><div class="pagination-controls">
      ${Array.from({ length: pages }, (_, index) => `<button type="button" data-action="queue-page" data-page="${index + 1}" ${state.page === index + 1 ? 'aria-current="page"' : ""}>${index + 1}</button>`).join("")}
    </div></div>
  `;
}

function renderQueueState() {
  if (state.queueState === "loading") {
    return `<div class="queue-state queue-loading" role="status"><div><h3>正在加载任务</h3>${Array.from({ length: 5 }, () => '<div class="skeleton-row"></div>').join("")}</div></div>`;
  }
  if (state.queueState === "error") {
    const action = isDirectFileMode
      ? '<button class="primary-button" type="button" data-action="open-local-app">打开正确入口</button>'
      : '<button class="secondary-button" type="button" data-action="retry-backend">重新连接</button>';
    return `<div class="queue-state queue-error" role="alert"><div><h3>${isDirectFileMode ? "请使用本地服务入口" : "本地服务不可用"}</h3><p>${escapeMarkup(state.backendError || "数据库连接没有建立，页面不会假装保存成功。")}</p>${action}</div></div>`;
  }
  return "";
}

function renderWorkQueue() {
  if (!workQueueElement) return;
  const filtered = visibleWorkItems();
  const roleItems = visibleWorkItems({ ignoreFilters: true });
  const start = (state.page - 1) * state.pageSize;
  const pageItems = filtered.slice(start, start + state.pageSize);
  const pageSelected = pageItems.length > 0 && pageItems.every((item) => state.selectedWorkItemIds.includes(item.id));
  const stateMarkup = renderQueueState();
  let body = stateMarkup;
  if (!body && filtered.length === 0) {
    body = roleItems.length === 0
      ? '<div class="queue-state queue-empty"><div><h3>当前没有需要你处理的任务</h3><p>项目仍在推进，你可以查看上方进度和最近活动。</p></div></div>'
      : '<div class="queue-state queue-empty"><div><h3>没有符合条件的任务</h3><p>当前筛选条件没有结果，清除条件后可以继续查看。</p><button class="secondary-button" type="button" data-action="clear-filters">清除筛选</button></div></div>';
  }
  if (!body) {
    body = `
      <div class="queue-table-wrap"><table class="queue-table">
        <thead><tr><th scope="col"><input type="checkbox" data-action="toggle-page-items" aria-label="选择当前页任务" ${pageSelected ? "checked" : ""}></th><th scope="col">流程 / 事项</th><th scope="col">当前阶段</th><th scope="col">当前处理人</th><th scope="col">证据完整度</th><th scope="col">阻塞原因</th><th scope="col">最近更新</th><th scope="col">下一步动作</th></tr></thead>
        <tbody>${pageItems.map(renderWorkItemRow).join("")}</tbody>
      </table></div>${renderPagination(filtered.length)}`;
  }
  workQueueElement.innerHTML = `
    <header class="queue-header"><div><h2 id="work-queue-title">任务队列</h2><p>按当前职责连续处理事项；打开详情不会丢失筛选和列表位置。</p></div><span class="queue-count">${filtered.length} 条</span></header>
    ${renderQueueToolbar(filtered.length)}${body}
  `;
  const stageFilter = document.querySelector("#queue-stage-filter");
  const statusFilter = document.querySelector("#queue-status-filter");
  const evidenceFilter = document.querySelector("#queue-evidence-filter");
  if (stageFilter) stageFilter.value = state.filters.stage;
  if (statusFilter) statusFilter.value = state.filters.status;
  if (evidenceFilter) evidenceFilter.value = state.filters.evidence;
  renderBulkActionBar();
}

function renderRoleActions(item) {
  const policy = currentRolePolicy();
  const actionDisabled = state.pendingAction === item.id ? "disabled" : "";
  if (state.role === "employee") {
    return `
      <div class="drawer-action-panel"><h3>请描述这项工作实际是怎么发生的</h3><p>不需要判断整个流程，也不审批改造方案。</p>
      <textarea id="drawer-employee-draft" placeholder="写下你实际怎么做、哪里需要找人确认"></textarea>
      <div class="button-group"><button class="secondary-button" type="button" data-action="drawer-save-draft" ${actionDisabled}>保存草稿</button><button class="primary-button" type="button" data-action="drawer-submit-segment" data-item-id="${item.id}" ${actionDisabled}>${actionDisabled ? "正在保存" : "提交这一段"}</button></div></div>`;
  }
  if (state.role === "verifier") {
    if (item.assigneeRole !== "verifier") {
      return `<div class="permission-notice"><strong>只读查看</strong><p>该事项属于${escapeMarkup(item.assigneeLabel)}。你可以查看摸排或风险上下文，但不能代替当前处理人操作。</p></div>`;
    }
    if (item.assigneeRole === "owner") {
      return `
        <div class="drawer-action-panel"><h3>核验已完成</h3><p>事实判断已经记录，系统已整理为负责人可审阅的决策摘要。</p>
        <div class="permission-notice"><strong>下一步由企业负责人处理</strong><p>负责人只看已确认事实、风险摘要和小范围试点建议，不需要重新核对原始材料。</p></div>
        <div class="button-group"><button class="primary-button" type="button" data-action="handoff-to-owner">交给负责人审阅</button></div></div>`;
    }
    return `
      <div class="drawer-action-panel"><h3>请确认一个具体业务判断</h3><p>这两条客户记录，实际指的是同一个客户吗？</p>
      <div class="button-group"><button class="primary-button" type="button" data-action="drawer-verifier-outcome" data-outcome="同一个客户" data-item-id="${item.id}" ${actionDisabled}>同一个客户</button><button class="secondary-button" type="button" data-action="drawer-verifier-outcome" data-outcome="不同客户" data-item-id="${item.id}" ${actionDisabled}>不同客户</button><button class="secondary-button" type="button" data-action="drawer-verifier-outcome" data-outcome="暂时无法判断" data-item-id="${item.id}" ${actionDisabled}>证据不足</button></div></div>`;
  }
  if (state.role === "owner") {
    return `
      <div class="drawer-action-panel"><h3>审阅与决策</h3><p>这是决策摘要，不是任务清单；不会修改生产系统。</p>
      <div class="button-group"><button class="primary-button" type="button" data-action="drawer-owner-decision" data-decision="继续影子试点" data-item-id="${item.id}" ${actionDisabled}>继续影子试点</button><button class="secondary-button" type="button" data-action="drawer-owner-decision" data-decision="要求修改" data-item-id="${item.id}" ${actionDisabled}>要求修改</button><button class="secondary-button" type="button" data-action="drawer-owner-decision" data-decision="暂不推进" data-item-id="${item.id}" ${actionDisabled}>暂不推进</button></div></div>`;
  }
  return `<div class="permission-notice"><strong>${escapeMarkup(policy.label)}</strong><p>当前职责只能查看进度和组织任务，不能确认企业事实或替负责人做最终决策。</p></div>`;
}

function renderDetailDrawer() {
  if (!detailDrawerElement) return;
  const item = state.workItems.find((entry) => entry.id === state.openWorkItemId);
  if (!item) {
    detailDrawerElement.innerHTML = "";
    return;
  }
  const activity = state.activityEvents.filter((event) => !event.itemId || event.itemId === item.id).slice(-4).reverse();
  detailDrawerElement.innerHTML = `
    <header class="drawer-header"><div><p class="workspace-eyebrow">${escapeMarkup(item.stageLabel)} · ${item.id}</p><h2 id="detail-drawer-title" tabindex="-1">${escapeMarkup(item.title)}</h2></div><button class="icon-button" type="button" data-action="close-detail" aria-label="关闭详情">×</button></header>
    <div class="drawer-body">
      <section class="drawer-section"><span class="status-label ${item.status === "blocked" ? "status-label--blocked" : ""}">${escapeMarkup(item.statusLabel)}</span><h3>当前需要完成</h3><p>${escapeMarkup(item.nextAction)}。${item.blockingReason !== "无" ? `暂停原因：${escapeMarkup(item.blockingReason)}` : "当前没有阻塞。"}</p></section>
      <section class="drawer-section"><h3>员工描述的实际流程</h3><p>${escapeMarkup(item.employeeDescription)}</p></section>
      <section class="drawer-section"><h3>Agent 整理出的候选事实</h3><ul class="drawer-facts">${item.candidateFacts.map((fact) => `<li>${escapeMarkup(fact)}</li>`).join("")}</ul></section>
      <section class="drawer-section"><h3>证据来源</h3><ul class="drawer-evidence">${item.evidenceSources.map((source, index) => `<li><strong>证据 ${index + 1}</strong>${escapeMarkup(source)} · E5 合成模拟材料</li>`).join("")}</ul></section>
      <section class="drawer-section"><h3>诊断过程记录</h3>${activity.length ? `<ol class="activity-timeline">${activity.map((event) => `<li class="activity-event"><span class="activity-event__marker"></span><div class="activity-event__body"><div class="activity-event__meta"><span>${escapeMarkup(event.actorLabel)}</span><time>${escapeMarkup(event.occurredAt)}</time></div><strong>${escapeMarkup(event.action)}</strong><p>${escapeMarkup(event.impact)}</p></div></li>`).join("")}</ol>` : '<p>当前事项还没有单独的处理记录。</p>'}</section>
      <section class="drawer-section">${renderRoleActions(item)}</section>
    </div>`;
  const draft = detailDrawerElement.querySelector("#drawer-employee-draft");
  if (draft) draft.value = state.employeeDraft;
}

function openDetail(itemId, trigger = null) {
  if (!state.workItems.some((item) => item.id === itemId)) return;
  drawerTrigger = trigger || document.activeElement;
  state.openWorkItemId = itemId;
  renderDetailDrawer();
  drawerScrimElement.hidden = false;
  detailDrawerElement.setAttribute("aria-hidden", "false");
  window.requestAnimationFrame(() => {
    detailDrawerElement.classList.add("is-open");
    detailDrawerElement.querySelector("h2")?.focus({ preventScroll: true });
  });
}

function closeDetail() {
  detailDrawerElement.classList.remove("is-open");
  detailDrawerElement.setAttribute("aria-hidden", "true");
  drawerScrimElement.hidden = true;
  state.openWorkItemId = "";
  drawerTrigger?.focus?.({ preventScroll: true });
}

function renderBulkActionBar() {
  if (!bulkActionBarElement) return;
  const count = state.selectedWorkItemIds.length;
  bulkActionBarElement.hidden = count === 0;
  if (!count) return;
  bulkActionBarElement.innerHTML = `<span>已选择 ${count} 项</span><button type="button" data-action="bulk-request-evidence">请求材料</button><button type="button" data-action="bulk-assign-reviewer">分配核验人</button><button type="button" data-action="bulk-export-summary">导出摘要</button><button type="button" data-action="clear-selection">取消选择</button>`;
}

function setFeedback(type, message) {
  state.feedback = { type, message, id: Date.now() };
  document.querySelector("#workspace-feedback")?.remove();
  const feedback = document.createElement("div");
  feedback.id = "workspace-feedback";
  feedback.className = type === "error" ? "error-feedback" : "success-feedback";
  feedback.setAttribute("role", type === "error" ? "alert" : "status");
  feedback.textContent = message;
  document.body.append(feedback);
  window.setTimeout(() => feedback.remove(), 3200);
}

function runLocalAction(action, successMessage) {
  try {
    action();
    setFeedback("success", successMessage);
  } catch (error) {
    setFeedback("error", "操作没有完成，已保留当前内容，请重试。");
  }
}

function updateWorkItem(itemId, changes, activity) {
  const item = state.workItems.find((entry) => entry.id === itemId);
  if (!item) return;
  Object.assign(item, changes, { updatedAt: "刚刚" });
  if (activity) appendActivity({ ...activity, itemId });
}

function renderWorkspace() {
  const policy = currentRolePolicy();
  workspaceRoleLabel.textContent = `${policy.label}工作台`;
  workspaceSubtitle.textContent = policy.subtitle;
  renderRoleNavigation();
  renderWorkspaceOverview();
  renderWorkQueue();
  if (state.openWorkItemId) renderDetailDrawer();
}

function showRoleRoute(role) {
  if (!state.visibleWorkspaces.includes(role)) {
    showMessage("当前邀请未分配可用职责，请联系项目负责人。");
    return;
  }
  if (role === "external_builder") {
    // The builder's project setup is a formal flow, not a management queue.
    // Keep the demo switch as an entry point to that redesigned surface.
    state.formalSessionActive = false;
    state.formalProjectId = "";
    openFormalEntry();
    return;
  }
  state.role = role;
  state.activeNav = "overview";
  state.filters = { query: "", stage: "all", status: "all", evidence: "all", mineOnly: ["employee", "owner"].includes(role) };
  state.selectedWorkItemIds = [];
  state.page = 1;
  clearMessage();
  if (role === "verifier") {
    // Formal verifier entry is a single assigned-facts workbench. It has no
    // role switcher, E5 banner, or shared stage rail.
    document.documentElement.classList.add("verifier-active");
    showView("verifier-workbench-view");
    state.verifierState = "loading";
    renderVerifierWorkbench();
    loadVerifierWorkspace();
    return;
  }
  document.documentElement.classList.remove("verifier-active");
  showView("workspace-dashboard-view");
  renderWorkspace();
  loadBackendWorkspace();
}

async function loadVerifierWorkspace() {
  state.verifierState = "loading";
  renderVerifierWorkbench();
  try {
    const projectId = state.domainModel.project.id;
    const response = window.diagnosticApi.listVerifierFacts
      ? await window.diagnosticApi.listVerifierFacts(projectId)
      : await window.diagnosticApi.listWorkItems(projectId);
    const items = response.facts || response.items || [];
    state.verifierFact = items[0] || state.workItems.find((entry) => entry.assigneeRole === "verifier" && entry.stage === "facts") || null;
    state.verifierState = state.verifierFact?.status === "blocked" ? "waiting" : "ready";
  } catch (_error) {
    state.verifierFact = state.workItems.find((entry) => entry.assigneeRole === "verifier" && entry.stage === "facts") || null;
    state.verifierState = state.verifierFact ? "ready" : "error";
  }
  renderVerifierWorkbench();
}

function selectCurrentPage(checked) {
  const filtered = visibleWorkItems();
  const pageItems = filtered.slice((state.page - 1) * state.pageSize, state.page * state.pageSize).map((item) => item.id);
  state.selectedWorkItemIds = checked
    ? Array.from(new Set([...state.selectedWorkItemIds, ...pageItems]))
    : state.selectedWorkItemIds.filter((id) => !pageItems.includes(id));
  renderWorkQueue();
}

function exportSelectedSummaries() {
  const items = state.workItems.filter((item) => state.selectedWorkItemIds.includes(item.id));
  const text = items.map((item) => `${item.title}\n阶段：${item.stageLabel}\n状态：${item.statusLabel}\n下一步：${item.nextAction}`).join("\n\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "诊断任务摘要.txt";
  link.click();
  URL.revokeObjectURL(url);
}

document.addEventListener("click", async (event) => {
  const control = event.target.closest("button, input[type='checkbox']");
  if (!control || control.disabled) return;
  const action = control.dataset.action;
  if (action === "workspace-nav") {
    const allowedNavigation = currentRolePolicy().navigation || ["overview"];
    if (!allowedNavigation.includes(control.dataset.nav)) return;
    state.activeNav = control.dataset.nav;
    state.page = 1;
    renderWorkspace();
  }
  if (action === "focus-search") document.querySelector("#queue-search")?.focus();
  if (action === "open-next-task") {
    const next = visibleWorkItems().find((item) => item.status !== "complete");
    if (next) openDetail(next.id, control);
    else setFeedback("success", "当前角色没有待处理任务。");
  }
  if (action === "open-detail") openDetail(control.dataset.itemId, control);
  if (action === "close-detail") closeDetail();
  if (action === "clear-filters") {
    state.filters = { query: "", stage: "all", status: "all", evidence: "all", mineOnly: false };
    state.page = 1;
    renderWorkQueue();
  }
  if (action === "toggle-work-item") {
    const id = control.dataset.itemId;
    state.selectedWorkItemIds = control.checked ? [...state.selectedWorkItemIds, id] : state.selectedWorkItemIds.filter((entry) => entry !== id);
    renderWorkQueue();
  }
  if (action === "toggle-page-items") selectCurrentPage(control.checked);
  if (action === "queue-page") {
    state.page = Number(control.dataset.page);
    renderWorkQueue();
  }
  if (action === "retry-queue" || action === "retry-backend") loadBackendWorkspace();
  if (action === "open-local-app") window.location.assign(localAppUrl);
  if (action === "simulate-state-menu") {
    state.queueState = state.queueState === "ready" ? "loading" : state.queueState === "loading" ? "error" : "ready";
    renderWorkQueue();
  }
  if (action === "clear-selection") {
    state.selectedWorkItemIds = [];
    renderWorkQueue();
  }
  if (action === "bulk-request-evidence") runLocalAction(() => {
    state.selectedWorkItemIds
      .filter((id) => state.workItems.find((item) => item.id === id)?.status !== "complete")
      .forEach((id) => updateWorkItem(id, { status: "blocked", statusLabel: "等待补充材料", nextAction: "跟进材料" }, { actor: "human", actorLabel: "人工", action: "人工要求补充材料", impact: "已向相关参与人发出本地模拟材料请求。" }));
    renderWorkspace();
  }, "已为可处理的选中事项记录材料请求。");
  if (action === "bulk-assign-reviewer") runLocalAction(() => {
    state.selectedWorkItemIds.forEach((id) => updateWorkItem(id, { assigneeLabel: "流程核验人员" }, { actor: "human", actorLabel: "人工", action: "已分配核验人员", impact: "仅更新本地演示任务责任人。" }));
    renderWorkspace();
  }, "已为选中事项分配核验人员。");
  if (action === "bulk-export-summary") runLocalAction(exportSelectedSummaries, "已生成选中事项的本地摘要。");
  if (action === "drawer-save-draft") runLocalAction(() => {
    state.employeeDraft = detailDrawerElement.querySelector("#drawer-employee-draft")?.value || "";
    state.employeeSubmissionState = "saved";
  }, "草稿已保存在当前浏览器会话中。");
  if (action === "drawer-submit-segment") {
    state.employeeDraft = detailDrawerElement.querySelector("#drawer-employee-draft")?.value || "";
    if (!state.employeeDraft.trim()) setFeedback("error", "先写下一个具体工作片段，再提交这一段。");
    else await persistEmployeeSubmission(control.dataset.itemId, state.employeeDraft);
  }
  if (action === "drawer-verifier-outcome") await persistVerification(control.dataset.itemId, control.dataset.outcome);
  if (action === "handoff-to-owner") {
    closeDetail();
    showRoleRoute("owner");
    setFeedback("success", "核验事项已交给企业负责人审阅。");
  }
  if (action === "drawer-owner-decision") await persistOwnerDecision(control.dataset.itemId, control.dataset.decision);
});

document.addEventListener("input", (event) => {
  if (event.target.id === "queue-search") {
    state.filters.query = event.target.value;
    state.page = 1;
    renderWorkQueue();
    document.querySelector("#queue-search")?.focus();
  }
  if (event.target.id === "drawer-employee-draft") state.employeeDraft = event.target.value;
});

document.addEventListener("change", (event) => {
  const mapping = { "queue-stage-filter": "stage", "queue-status-filter": "status", "queue-evidence-filter": "evidence" };
  if (mapping[event.target.id]) {
    state.filters[mapping[event.target.id]] = event.target.value;
    state.page = 1;
    renderWorkQueue();
  }
  if (event.target.id === "queue-mine-only") {
    state.filters.mineOnly = event.target.checked;
    state.page = 1;
    renderWorkQueue();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.openWorkItemId) closeDetail();
});

// 摸排输入框的回车发送：聊天类界面的默认行为。
// Enter 发送；Shift+Enter 换行，便于写多段回答。
document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!target || target.id !== "formal-employee-answer") return;
  if (event.key !== "Enter" || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  const button = document.querySelector('#formal-employee-composer-actions [data-action="continue-formal-employee"]');
  if (button && !button.disabled) button.click();
});
