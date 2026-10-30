/**
 * V0.2 suggestions — frontend contract runtime (no browser, no server).
 *
 * Verifies the pure UI helpers and the API client calls that the builder / verifier /
 * owner screens use. Static string checks confirm the screens are wired to those actions;
 * they are not a substitute for a real browser run (not available without wrangler).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const requests = [];
const context = {
  URL, URLSearchParams, setTimeout, clearTimeout,
  crypto: { randomUUID: () => "generated-key" },
  fetch: async (url, options = {}) => {
    requests.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, packet: null, suggestions: [] }) };
  },
  window: { location: { protocol: "https:", hostname: "example.invalid" }, crypto: { randomUUID: () => "generated-key" } },
};
context.window.window = context.window;
context.window.fetch = context.fetch;
context.globalThis = context.window;
vm.createContext(context);
vm.runInContext(readFileSync(new URL("../formal-ui-contract.js", import.meta.url), "utf8"), context);
vm.runInContext(readFileSync(new URL("../api-client.js", import.meta.url), "utf8"), context);

const contract = context.window.formalUiContract;
const api = context.window.diagnosticApi;

assert.equal(contract.suggestionPriorityLabel("high"), "高");
assert.equal(contract.suggestionPriorityLabel("medium"), "中");
assert.equal(contract.suggestionPriorityLabel("low"), "低");
assert.equal(contract.suggestionDraftKindLabel("internal"), "内部待核实初稿");
assert.equal(contract.suggestionDraftKindLabel("formal"), "正式诊断建议");
assert.equal(contract.suggestionFactLine({ factId: "F-1", status: "open", evidenceLevel: "E3", eligible: false }), "F-1 · 待核验 · E3 · 不可正式交付");
assert.equal(contract.suggestionFactLine({ factId: "F-2", status: "confirmed", evidenceLevel: null }), "F-2 · 已确认 · 未定级");

const packet = (overrides = {}) => ({
  status: "draft", draftKind: "formal", suggestionReview: null,
  suggestions: [{ id: "SUG-1", problem: "p", opportunity: "o", factIds: ["F-1"], priority: "high", priorityReason: "r", pendingConditions: [] }],
  ...overrides,
});
assert.equal(contract.suggestionDeliveryState(packet()), "unreviewed");
assert.equal(contract.suggestionDeliveryState(packet({ suggestionReview: { contentHash: "h" } })), "reviewed");
assert.equal(contract.suggestionDeliveryState(packet({ status: "internal_draft", draftKind: "internal" })), "internal");
assert.equal(contract.suggestionDeliveryState(packet({ status: "published" })), "published");
assert.equal(contract.suggestionDeliveryState(packet({ suggestionsInvalidated: { invalidated: true } })), "invalidated");
assert.equal(contract.suggestionDeliveryState({ suggestions: [] }), "none");

await api.getFormalDecisionPacket("PRJ-1", "internal");
assert.equal(requests.at(-1).url, "/api/formal/projects/PRJ-1/decision-packet?scope=internal");
await api.listConfirmedFacts("PRJ-1", "internal");
assert.equal(requests.at(-1).url, "/api/formal/projects/PRJ-1/confirmed-facts?scope=internal");
await api.generateDiagnosisSuggestions("PRJ-1", "formal", "KEY-1");
let sent = requests.at(-1);
assert.equal(sent.url, "/api/formal/projects/PRJ-1/diagnosis-suggestions");
assert.equal(sent.options.method, "POST");
assert.equal(sent.options.headers["Idempotency-Key"], "KEY-1");
assert.deepEqual(JSON.parse(sent.options.body), { scope: "formal" });
await api.reviewFormalSuggestionContent("PRJ-1", "PKT-1", 3, "2");
sent = requests.at(-1);
assert.equal(sent.url, "/api/formal/projects/PRJ-1/decision-packets/draft");
assert.deepEqual(JSON.parse(sent.options.body), { action: "content_review", packetId: "PKT-1", baseVersion: 3, contentKey: "2" });

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
for (const marker of [
  'data-action="generate-suggestions"', 'data-action="review-formal-suggestions"',
  'data-action="update-suggestions"', 'suggestionFacts', 'verifier-fact',
  "internal-draft-banner", "renderVerifierSuggestionBlock",
  'listConfirmedFacts(state.formalProjectId, "internal")',
  "suggestionsInvalidated", "renderSuggestionCards",
]) {
  assert.ok(app.includes(marker), `app.js is missing ${marker}`);
}

console.log("V0.2 suggestions frontend runtime: ok (helpers + API wiring + static screen wiring)");
