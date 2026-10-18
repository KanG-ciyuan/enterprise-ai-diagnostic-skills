(function createFormalUiContract(global) {
  const submittedStatuses = new Set(["awaiting_verification", "blocked", "awaiting_decision", "owner_decided", "complete"]);
  const stageByStatus = {
    awaiting_verification: { label: "等待事实核验", complete: false },
    blocked: { label: "等待补充材料", complete: false },
    awaiting_decision: { label: "等待负责人决策", complete: false },
    owner_decided: { label: "负责人已决定", complete: false },
    complete: { label: "流程已完成", complete: true },
  };

  function metadataFromText(value) {
    const text = String(value || "").trim();
    if (!text) return {};
    const parsed = JSON.parse(text);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("材料补充信息必须是 JSON 对象");
    return parsed;
  }

  function buildSupplementPayload({ material, reference, sourceType, metadataText }) {
    return {
      material: String(material || "").trim(),
      reference: String(reference || "").trim(),
      sourceType: String(sourceType || "").trim(),
      metadata: metadataFromText(metadataText),
    };
  }

  function employeeStepForTask(task = {}, receipt = {}) {
    if (task.status === "blocked_draft" || receipt.handoffStatus === "waiting_assignment") return "waiting";
    return submittedStatuses.has(task.status) ? "submitted" : "intro";
  }

  function employeeStageForStatus(status) {
    return stageByStatus[status] || { label: "准备摸排", complete: false };
  }

  function employeeQuestionIndex(answers = {}, editIndex = null, questionCount = 0) {
    if (Number.isInteger(editIndex) && editIndex >= 0 && editIndex < questionCount) return editIndex;
    return Object.values(answers).slice(0, questionCount).findIndex((answer) => !String(answer || "").trim());
  }

  function employeeMaterialLabel(status) {
    if (status === "provided") return "员工已说明有材料，等待登记";
    if (status === "none_available") return "目前没有可提供的材料";
    return "尚未选择";
  }

  function materialStatusLabel(status) {
    if (status === "provided") return "员工声明有材料可提供";
    if (status === "none_available") return "目前没有可提供材料";
    return "尚未选择";
  }

  function ownerDecisionLabel(decision) {
    return { continue: "同意进入试点", revision: "要求修改", pause: "暂不推进" }[decision] || String(decision || "");
  }

  function statusLabel(status) {
    return {
      open: "待核验",
      pending: "待确认",
      needs_input: "等待补充信息",
      queued: "已排队",
      dispatching: "发送中",
      failed_terminal: "发送失败",
      superseded: "已被新链接替代",
      consumed: "已使用",
      accepted: "已接受",
      revoked: "已撤回",
      expired: "已过期",
      authorized: "已授权",
      denied: "未授权",
      delivered: "已送达",
      failed: "发送失败",
      provider_retrying: "发送重试中",
      verified: "完整性已复核",
      rejected: "完整性未通过",
      awaiting_verification: "等待事实核验",
      awaiting_second_confirmation: "等待第二位核验人确认",
      insufficient_evidence: "证据不足",
      blocked: "等待补充材料",
      blocked_draft: "等待核验人分配",
      awaiting_decision: "等待负责人决策",
      owner_decided: "负责人已决定",
      revision_requested: "等待改造方修改",
      verifier_checked: "核验完成",
      published: "已发布",
      confirmed: "已确认",
      complete: "已完成",
      assigned: "已分配",
      waiting_assignment: "等待分配",
      not_submitted: "尚未提交",
    }[status] || "状态待更新";
  }

  function roleLabel(role) {
    return { employee: "一线员工", verifier: "流程核验人员", owner: "企业负责人", external_builder: "外部改造方" }[role] || String(role || "—");
  }

  function ownerWorkspaceState(error = {}) {
    const message = String(error.message || "请求未完成，请稍后重试。");
    if (error.status === 404) return { kind: "empty", title: "当前没有待决策事项", message };
    if ([401, 403].includes(error.status)) return { kind: "permission", title: "无法查看这项决策", message };
    return { kind: "error", title: "决策事项暂时加载失败", message };
  }

  function formalEntryMode({ invitationToken, hasSession }) {
    if (String(invitationToken || "").trim()) return "invite";
    return hasSession ? "restore" : "login";
  }

  function invitationUrlAfterAccept(value) {
    const url = new URL(value);
    url.searchParams.delete("invite");
    return url.toString();
  }

  global.formalUiContract = { buildSupplementPayload, employeeStepForTask, employeeStageForStatus, employeeQuestionIndex, employeeMaterialLabel, materialStatusLabel, ownerDecisionLabel, statusLabel, roleLabel, ownerWorkspaceState, formalEntryMode, invitationUrlAfterAccept };
})(window);
