(function createDiagnosticApi(global) {
  const isDirectFileMode = window.location.protocol === "file:";
  const isLocalHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const isCloudflarePreview = !isDirectFileMode && !isLocalHost;
  const formalBaseUrl = "";
  const demoBaseUrl = isLocalHost ? "http://127.0.0.1:8000" : "";
  let identity = { role: "owner", userId: "demo-owner" };

  class DiagnosticApiError extends Error {
    constructor(message, status = 0, payload = {}) {
      super(message);
      this.name = "DiagnosticApiError";
      this.status = status;
      this.payload = payload;
      this.code = payload.code || "";
    }
  }

  function setIdentity(role, userId = `demo-${role}`) {
    identity = { role, userId };
  }

  async function formalRequest(path, options = {}) {
    let response;
    const method = String(options.method || "GET").toUpperCase();
    const generatedKey = method === "GET" ? "" : (global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
    try {
      response = await fetch(`${formalBaseUrl}${path}`, {
        ...options,
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": options.idempotencyKey || generatedKey,
          ...options.headers,
        },
      });
    } catch (_error) {
      throw new DiagnosticApiError("无法连接员工摸排服务，请稍后重试。", 0);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        throw new DiagnosticApiError("登录会话已失效，请重新打开邀请链接后恢复。", 401, payload);
      }
      throw new DiagnosticApiError(payload.detail || "员工摸排请求未完成。", response.status, payload);
    }
    return payload;
  }

  async function publicFormalRequest(path, options = {}) {
    let response;
    try {
      response = await fetch(formalBaseUrl + path, {
        ...options,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...options.headers },
      });
    } catch (_error) {
      throw new DiagnosticApiError("无法连接平台服务，请稍后重试。", 0);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new DiagnosticApiError(payload.detail || "请求未完成。", response.status, payload);
    return payload;
  }

  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(`${demoBaseUrl}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "X-Demo-Role": identity.role,
          "X-Demo-User": identity.userId,
          ...options.headers,
        },
      });
    } catch (_error) {
      if (isDirectFileMode) {
        throw new DiagnosticApiError("当前页面是直接打开的文件，请使用本地服务入口。", 0);
      }
      throw new DiagnosticApiError(isCloudflarePreview ? "无法连接线上诊断服务，请稍后重试。" : "无法连接本地诊断服务，请确认后端已启动。", 0);
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new DiagnosticApiError(payload.detail || "本地诊断服务暂时无法完成请求。", response.status, payload);
    }
    return payload;
  }

  window.diagnosticApi = {
    DiagnosticApiError,
    isCloudflarePreview,
    setIdentity,
    restoreSession() {
      return formalRequest("/api/auth/session");
    },
    logout() {
      return formalRequest("/api/auth/logout", { method: "POST" });
    },
    authorizeBuilder({ email, enterpriseName, name, bootstrapToken }) {
      return publicFormalRequest("/api/auth/authorize", {
        method: "POST",
        body: JSON.stringify({ email, enterpriseName, name, bootstrapToken }),
      });
    },
    demoEnter(role) {
      return publicFormalRequest("/api/demo/enter", {
        method: "POST",
        body: JSON.stringify({ role }),
      });
    },
    requestMemberLogin(email) {      return publicFormalRequest("/api/auth/login-request", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
    },
    consumeMemberLogin(token) {
      return publicFormalRequest("/api/auth/login-consume", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
    },
    selectMemberProject(projectId) {
      return formalRequest("/api/auth/select-project", { method: "POST", body: JSON.stringify({ projectId }) });
    },
    createFormalProject({ name, scope }, idempotencyKey) {
      return formalRequest("/api/projects", {
        method: "POST",
        idempotencyKey,
        body: JSON.stringify({ name, scope }),
      });
    },
    listFormalProjects() {
      return formalRequest("/api/projects");
    },
    getFormalProject(projectId) { return formalRequest(`/api/projects/${projectId}`); },
    listFormalInvitations(projectId) { return formalRequest(`/api/projects/${projectId}/invitations`); },
    listFormalWorkItems(projectId) { return formalRequest(`/api/projects/${projectId}/work-items`); },
    listVerifierCandidates(projectId) { return formalRequest(`/api/projects/${projectId}/verifier-candidates`); },
    reassignWorkItem(itemId, payload, idempotencyKey) {
      return formalRequest(`/api/work-items/${itemId}/reassignment`, { method: "POST", idempotencyKey, body: JSON.stringify(payload) });
    },
    listFormalEvents(projectId) { return formalRequest(`/api/projects/${projectId}/events`); },
    listEnterpriseConsents(projectId) {
      return formalRequest(`/api/projects/${projectId}/authorizations`);
    },
    createEnterpriseConsent(projectId, { label, authorizerName, authorizerEmail, scope, reference }, idempotencyKey) {
      return formalRequest(`/api/projects/${projectId}/authorizations`, {
        method: "POST", idempotencyKey,
        body: JSON.stringify({ label, authorizerName, authorizerEmail, scope, reference }),
      });
    },
    resendEnterpriseConsent(projectId, authorizationId) {
      return formalRequest(`/api/projects/${projectId}/authorizations/${authorizationId}/resend`, { method: "POST" });
    },
    listFormalMaterials(projectId) {
      return formalRequest(`/api/projects/${projectId}/materials`);
    },
    createFormalMaterial(projectId, payload) {
      return formalRequest(`/api/projects/${projectId}/materials`, { method: "POST", body: JSON.stringify(payload) });
    },
    reviewFormalMaterial(projectId, materialId, payload) {
      return formalRequest(`/api/projects/${projectId}/materials/${materialId}/review`, { method: "POST", body: JSON.stringify(payload) });
    },
    bindFormalMaterialConsent(projectId, materialId, authorizationRecordId, idempotencyKey) {
      return formalRequest(`/api/projects/${projectId}/materials/${materialId}/authorization-binding`, {
        method: "POST", idempotencyKey, body: JSON.stringify({ authorizationRecordId }),
      });
    },
    listConfirmedFacts(projectId) { return formalRequest(`/api/formal/projects/${projectId}/confirmed-facts`); },
    getFormalDecisionPacket(projectId) { return formalRequest(`/api/formal/projects/${projectId}/decision-packet`); },
    createFormalDecisionPacket(projectId, payload, idempotencyKey) { return formalRequest(`/api/formal/projects/${projectId}/decision-packets/draft`, { method: "POST", idempotencyKey, body: JSON.stringify(payload) }); },
    verifyFormalDecisionPacket(packetId, factRefs) { return formalRequest(`/api/formal/decision-packets/${packetId}/verify`, { method: "POST", body: JSON.stringify({ factRefs }) }); },
    publishFormalDecisionPacket(packetId) { return formalRequest(`/api/formal/decision-packets/${packetId}/publish`, { method: "POST" }); },
    createInvitation(projectId, { email, role, expiresInSeconds }) {
      return formalRequest("/api/projects/" + projectId + "/invitations", {
        method: "POST",
        body: JSON.stringify({ email, role, expiresInSeconds }),
      });
    },
    acceptInvitation(invitationRef, { email, name }) {      return publicFormalRequest("/api/invitations/" + invitationRef + "/accept", {
        method: "POST",
        body: JSON.stringify({ email, name }),
      });
    },
    revokeInvitation(invitationRef) {
      return formalRequest("/api/invitations/" + invitationRef + "/revoke", { method: "POST" });
    },
    getEmployeeTask(projectId) {
      return formalRequest(`/api/projects/${projectId}/employee-task`);
    },
    agentTurn(projectId, payload) {
      return formalRequest(`/api/agent/employee-turn`, {
        method: "POST",
        body: JSON.stringify({ projectId, ...payload }),
      });
    },
    saveEmployeeDraft(itemId, answers, materialStatus, extras = {}) {
      // PILOT-04/D8+N3：会话状态（ledger）与推断判定随草稿一起持久化。
      // PILOT-09C/FIX-CODEX-02B（F02）：必须把调用方所见版本（baseRevision）真实发到服务端。
      // 旧实现丢弃了 extras.baseRevision，导致服务端只能以"当前版本"兜底，旧页面会覆盖新页面。
      // 这里不做任何数值兜底：非整数时保留 undefined（JSON 序列化会省略该字段），
      // 由服务端按 fail-closed 拒绝。
      return formalRequest(`/api/work-items/${itemId}/employee-draft`, {
        method: "PUT",
        body: JSON.stringify({
          answers,
          materialStatus,
          ledger: extras.ledger || null,
          inferenceVerdicts: extras.inferenceVerdicts || {},
          baseRevision: Number.isInteger(extras.baseRevision) ? extras.baseRevision : undefined,
        }),
      });
    },
    submitFormalEmployee(itemId, text, workflowCard, materialStatus, idempotencyKey, extras = {}) {
      // PILOT-04/D7：携带 AI 推断原文与员工判定，使核验人能看到"员工否认了哪条推断"。
      // PILOT-09C/FIX-CODEX-03A（R03-01）：提交必须携带调用方所见草稿版本；
      // 非整数时保留 undefined（JSON 省略字段），由服务端 fail-closed 拒绝，
      // 绝不在客户端或服务端用“当前版本”兜底。
      return formalRequest(`/api/work-items/${itemId}/employee-submission`, {
        method: "POST",
        idempotencyKey,
        body: JSON.stringify({
          text, workflowCard, materialStatus,
          inferences: extras.inferences || [],
          inferenceVerdicts: extras.inferenceVerdicts || {},
          baseRevision: Number.isInteger(extras.baseRevision) ? extras.baseRevision : undefined,
        }),
      });
    },
    listWorkItems(projectId) {
      return request(`/api/projects/${projectId}/work-items`);
    },
    listEvents(projectId) {
      return request(`/api/projects/${projectId}/events`);
    },
    submitEmployee(itemId, text) {
      return request(`/api/work-items/${itemId}/employee-submission`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
    },
    verify(itemId, decision, details = {}) {
      const payload = typeof decision === "object"
        ? decision
        : { decision, ...details };
      return request(`/api/work-items/${itemId}/verification`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    listVerifierFacts(projectId) {
      return request(`/api/projects/${projectId}/verifier-facts`);
    },
    getFormalVerifierFacts(projectId) {
      return formalRequest(`/api/formal/projects/${projectId}/verifier-facts`);
    },
    verifyFormal(itemId, decision, details = {}) {
      const payload = typeof decision === "object"
        ? decision
        : { decision, ...details };
      return formalRequest(`/api/work-items/${itemId}/verification`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    provideSupplement(itemId, supplement) {
      return request(`/api/work-items/${itemId}/supplement`, {
        method: "POST",
        body: JSON.stringify(supplement),
      });
    },
    provideFormalSupplement(itemId, supplement) {
      return formalRequest(`/api/work-items/${itemId}/evidence-supplement`, {
        method: "POST",
        body: JSON.stringify(supplement),
      });
    },
    getFormalOwnerPacket(projectId) {
      return formalRequest(`/api/formal/projects/${projectId}/owner-packet`);
    },
    submitFormalOwnerDecision(packetId, payload) {
      return formalRequest(`/api/formal/decision-packets/${packetId}/owner-decision`, { method: "POST", body: JSON.stringify(payload) });
    },
    getSupplement(itemId) {
      return request(`/api/work-items/${itemId}/supplement`);
    },
    decide(itemId, decision) {
      return request(`/api/work-items/${itemId}/owner-decision`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
    },
  };
})(window);
