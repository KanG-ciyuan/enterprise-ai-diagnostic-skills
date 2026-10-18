(function () {
  const app = document.getElementById("authorization-confirmation-app");
  const form = document.getElementById("authorization-confirmation-form");
  const error = document.getElementById("authorization-confirmation-error");
  const status = document.getElementById("authorization-confirmation-status");
  const summary = document.getElementById("authorization-summary");
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const capability = params.get("capability") || "";
  const projectId = params.get("projectId") || "";
  const authorizationId = params.get("authorizationId") || "";
  history.replaceState(null, "", location.pathname + location.search);
  if (!capability || !projectId || !authorizationId) { error.textContent = "确认链接无效或已失效，请联系改造方重新发送。"; return; }
  fetch(`/api/projects/${encodeURIComponent(projectId)}/authorizations/${encodeURIComponent(authorizationId)}/confirm`, { headers: { "X-Authorization-Capability": capability, "cache-control": "no-store" } }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || body.message || "确认链接无效或已失效。");
    const item = body.authorization;
    summary.innerHTML = `<div><dt>项目</dt><dd>${escapeHtml(item.projectName)}</dd></div><div><dt>授权范围</dt><dd>${escapeHtml(item.scope)}</dd></div><div><dt>授权人</dt><dd>${escapeHtml(item.authorizerName)}</dd></div><div><dt>链接状态</dt><dd>${escapeHtml(item.deliveryStatus)}</dd></div>`;
    summary.hidden = false; form.hidden = false;
  }).catch((e) => { error.textContent = e.message; });
  function escapeHtml(value) { return String(value || "").replace(/[&<>\"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c])); }
  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    const decision = document.getElementById("authorization-decision").value;
    const reason = document.getElementById("authorization-reason").value.trim();
    if (!decision || !reason) { status.textContent = "请选择确认意见并填写理由。"; return; }
    const button = form.querySelector("button"); button.disabled = true; status.textContent = "正在提交…";
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/authorizations/${encodeURIComponent(authorizationId)}/confirm`, { method: "POST", headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify({ confirmationToken: capability, decision, reason }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.message || "提交失败，请稍后重试。");
      form.hidden = true; status.textContent = decision === "authorized" ? "已确认授权，可以关闭此页面。" : "已记录暂不同意，改造方会收到结果。";
    } catch (e) { button.disabled = false; status.textContent = e.message; }
  });
})();
