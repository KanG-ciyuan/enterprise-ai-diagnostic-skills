import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const requests = [];
const context = {
  URL,
  URLSearchParams,
  setTimeout,
  clearTimeout,
  crypto: { randomUUID: () => "generated-key" },
  fetch: async (url, options = {}) => {
    requests.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  },
  window: {
    location: { protocol: "https:", hostname: "example.invalid" },
    crypto: { randomUUID: () => "generated-key" },
  },
};
context.window.window = context.window;
context.window.fetch = context.fetch;
context.globalThis = context.window;
vm.createContext(context);
vm.runInContext(readFileSync(new URL("../formal-ui-contract.js", import.meta.url), "utf8"), context);
vm.runInContext(readFileSync(new URL("../api-client.js", import.meta.url), "utf8"), context);

const contract = context.window.formalUiContract;
const api = context.window.diagnosticApi;

const supplement = contract.buildSupplementPayload({
  material: "Authorized OA export",
  reference: "oa://export/4",
  sourceType: "pdf",
  metadataText: '{"approvalId":"OA-4"}',
});
assert.deepEqual(JSON.parse(JSON.stringify(supplement)), {
  material: "Authorized OA export",
  reference: "oa://export/4",
  sourceType: "pdf",
  metadata: { approvalId: "OA-4" },
});
await api.provideFormalSupplement("WI-4", supplement);
let sent = requests.at(-1);
assert.equal(sent.url, "/api/work-items/WI-4/evidence-supplement");
assert.deepEqual(JSON.parse(sent.options.body), JSON.parse(JSON.stringify(supplement)));

assert.equal(contract.employeeStepForTask({ status: "awaiting_verification" }, {}), "submitted");
assert.equal(contract.employeeStepForTask({ status: "awaiting_decision" }, {}), "submitted");
assert.equal(contract.employeeStepForTask({ status: "owner_decided" }, {}), "submitted");
assert.equal(contract.employeeStepForTask({ status: "complete" }, {}), "submitted");
assert.equal(contract.employeeStageForStatus("awaiting_decision").label, "等待负责人决策");
assert.equal(contract.employeeStageForStatus("owner_decided").label, "负责人已决定");
assert.equal(contract.employeeStageForStatus("complete").label, "流程已完成");

const completedAnswers = { trigger: "a", inputs: "b", steps: "c", judgments: "d", exceptions: "e" };
assert.equal(contract.employeeQuestionIndex(completedAnswers, 0, 5), 0);
assert.equal(contract.employeeQuestionIndex(completedAnswers, 3, 5), 3);
assert.equal(contract.employeeQuestionIndex(completedAnswers, null, 5), -1);
assert.equal(contract.employeeMaterialLabel("undecided"), "尚未选择");
assert.equal(contract.employeeMaterialLabel("none_available"), "目前没有可提供的材料");
assert.equal(contract.materialStatusLabel("provided"), "员工声明有材料可提供");
assert.equal(contract.materialStatusLabel("none_available"), "目前没有可提供材料");
assert.equal(contract.ownerDecisionLabel("continue"), "同意进入试点");
assert.equal(contract.ownerDecisionLabel("revision"), "要求修改");
assert.equal(contract.ownerDecisionLabel("pause"), "暂不推进");
assert.equal(contract.statusLabel("open"), "待核验");
assert.equal(contract.statusLabel("awaiting_second_confirmation"), "等待第二位核验人确认");
assert.equal(contract.statusLabel("authorized"), "已授权");
assert.equal(contract.statusLabel("verified"), "完整性已复核");
assert.equal(contract.roleLabel("employee"), "一线员工");
assert.equal(contract.roleLabel("verifier"), "流程核验人员");
assert.deepEqual(JSON.parse(JSON.stringify(contract.ownerWorkspaceState({ status: 404, message: "暂无已发布决策包" }))), {
  kind: "empty",
  title: "当前没有待决策事项",
  message: "暂无已发布决策包",
});
assert.deepEqual(JSON.parse(JSON.stringify(contract.ownerWorkspaceState({ status: 403, message: "无权访问" }))), {
  kind: "permission",
  title: "无法查看这项决策",
  message: "无权访问",
});
assert.deepEqual(JSON.parse(JSON.stringify(contract.ownerWorkspaceState({ status: 500, message: "服务异常" }))), {
  kind: "error",
  title: "决策事项暂时加载失败",
  message: "服务异常",
});
assert.equal(contract.formalEntryMode({ invitationToken: "invite-1", hasSession: true }), "invite");
assert.equal(contract.formalEntryMode({ invitationToken: "", hasSession: true }), "restore");
assert.equal(contract.invitationUrlAfterAccept("https://example.invalid/?invite=invite-1&source=email#task"), "https://example.invalid/?source=email#task");

await api.createFormalMaterial("PRJ-4", {
  authorizationRecordId: "AUTH-4",
  workItemId: "WI-4",
  label: "CRM export",
  reference: "crm://export/4",
  sourceType: "csv",
  visibility: "verifier",
  metadata: { batch: "4" },
});
sent = requests.at(-1);
assert.equal(sent.url, "/api/projects/PRJ-4/materials");
assert.equal(JSON.parse(sent.options.body).workItemId, "WI-4");
assert.equal(JSON.parse(sent.options.body).visibility, "verifier");

await api.reviewFormalMaterial("PRJ-4", "MAT-4", { decision: "verified", reason: "Hash matched source export" });
sent = requests.at(-1);
assert.equal(sent.url, "/api/projects/PRJ-4/materials/MAT-4/review");
assert.deepEqual(JSON.parse(sent.options.body), { decision: "verified", reason: "Hash matched source export" });

await api.verifyFormal("WI-4", {
  factId: "FACT-4",
  decision: "same",
  reason: "Matched material MAT-4",
  sourceRefs: ["MAT-4"],
});
sent = requests.at(-1);
assert.deepEqual(JSON.parse(sent.options.body).sourceRefs, ["MAT-4"]);

await api.createFormalDecisionPacket("PRJ-4", { factRefs: [{ factId: "FACT-4" }] }, "draft-logical-key");
sent = requests.at(-1);
assert.equal(sent.options.headers["Idempotency-Key"], "draft-logical-key");

await api.listVerifierCandidates("PRJ-4");
sent = requests.at(-1);
assert.equal(sent.url, "/api/projects/PRJ-4/verifier-candidates");

await api.reassignWorkItem("WI-4", { targetVerifierId: "VER-B", assignmentVersion: 3, reason: "Queue coverage" }, "reassignment-logical-key");
sent = requests.at(-1);
assert.equal(sent.url, "/api/work-items/WI-4/reassignment");
assert.equal(sent.options.headers["Idempotency-Key"], "reassignment-logical-key");
assert.deepEqual(JSON.parse(sent.options.body), { targetVerifierId: "VER-B", assignmentVersion: 3, reason: "Queue coverage" });

const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");
for (const requiredCall of [
  "formalUiContract.buildSupplementPayload",
  "formalUiContract.employeeStepForTask",
  "formalUiContract.statusLabel",
  "formalUiContract.roleLabel",
  "createFormalMaterial",
  "reviewFormalMaterial",
  "eligibleMaterials",
  "listVerifierCandidates",
  "reassignWorkItem",
  "仅转移这项任务尚未完成的核验责任",
  "data-action=\"open-formal-reassignment\"",
  "openFormalReassignment(button.dataset.itemId)",
  "closeFormalReassignment()",
  "dialog.addEventListener(\"cancel\"",
  "state.formalReassignment.targetVerifierId = targetVerifierId",
  "state.formalReassignment.reason = reason",
  "state.verifierHistory = response.history || []",
  "已完成判断",
  "signedByName",
]) assert.ok(appSource.includes(requiredCall), `app.js must consume ${requiredCall}`);

const stylesSource = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
assert.ok(stylesSource.includes(".reassignment-dialog"));
assert.ok(stylesSource.includes("100dvh"), "mobile reassignment sheet must have a viewport-relative scroll boundary");

console.log("formal frontend request and state runtime: ok");
