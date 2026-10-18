/**
 * FINAL-F01 / FINAL-F02: natural dependency establishment, withdrawal/restore,
 * explicit [] vs omitted proposal, fail-closed scope, append-only audit/capacity.
 * Full HTTP/stub/D1 evidence is archived with FINAL-FIX-01; this suite needs no DB.
 */
import assert from "node:assert/strict";
import { normalizeEmployeeDraft } from "../functions/_shared.js";
import { mergeAuthoritativeInferences, normalizeInference, resolveInferenceJudgment } from "../functions/api/agent/_adapter.js";
import { ANSWER_DIMENSIONS, applyAnswerEvidence, validateSubmissionEvidence } from "../functions/api/agent/_evidence.js";

const answers = Object.fromEntries(ANSWER_DIMENSIONS.map((d) => [d, `员工陈述的实际业务信息：${d}`]));
const proposal = (hints) => ({ source: "model", text: "耗时估计依赖输入与执行步骤", basis: "burden", proposedDependencyDimensions: hints });
let count = 0;
function check(name, run) { run(); count++; console.log(`PASS ${name}`); }
async function update(draft, patch = {}, proposed = null) {
  const inferences = proposed === null ? null : mergeAuthoritativeInferences(draft.ledger?.authoritativeInferences, proposed, 40);
  const result = await applyAnswerEvidence({ existing: draft, answersPatch: patch, authoritativeInferences: inferences });
  assert.equal(result.ok, true);
  return { ...draft, answers: result.answers, revision: draft.revision + 1,
    ledger: { ...draft.ledger, evidence: result.evidence, statementHistory: result.history, authoritativeInferences: result.authoritativeInferences } };
}
const entry = (d) => d.ledger.authoritativeInferences[0];
function judged(d) {
  const e = entry(d);
  return { ...d, inferenceVerdicts: { [e.id]: { verdict: "confirmed", contentVersion: e.contentVersion,
    evidenceVersion: e.evidenceVersion, templateVersion: e.templateVersion, evidenceHash: e.evidenceHash } } };
}
const state = (d) => resolveInferenceJudgment(entry(d), d.inferenceVerdicts);
const initial = async (hints) => update(normalizeEmployeeDraft({}), answers, [proposal(hints)]);
const clone = (v) => structuredClone(v);

let d = judged(await initial(["steps"]));
check("natural rule refs and valid verdict", () => {
  assert.equal(entry(d).dependencySource, "server_rule");
  assert.deepEqual(entry(d).evidenceRefs.map((r) => r.dimension), ["burden", "steps"]);
  assert.equal(state(d), "valid");
});
const before = clone(d);
d = await update(d, { steps: "" });
check("withdrawal advances EV and preserves null relationship", () => {
  assert.equal(entry(d).evidenceVersion, entry(before).evidenceVersion + 1);
  assert.equal(entry(d).evidenceRefs.find((r) => r.dimension === "steps").digest, null);
  assert.equal(state(d), "stale");
});
check("normalization and turn merge preserve null rule refs", () => {
  assert.deepEqual(normalizeInference(entry(d)).evidenceRefs, entry(d).evidenceRefs);
  assert.deepEqual(mergeAuthoritativeInferences([entry(d)], [proposal(["steps"])])[0].evidenceRefs, entry(d).evidenceRefs);
});
d = judged(d);
const absent = clone(d);
d = await update(d, { steps: answers.steps }, [proposal(["steps"])]);
check("turn restore advances EV; withdrawn-context verdict stays stale", () => {
  assert.equal(entry(d).evidenceVersion, entry(absent).evidenceVersion + 1);
  assert.equal(state(d), "stale");
  assert.equal(entry(d).evidenceRefs.find((r) => r.dimension === "steps").digest, d.ledger.evidence.dimensions.steps.digest);
});
check("restore audit appends complete null-to-digest transition", () => {
  const a = entry(d).invalidations.at(-1);
  assert.deepEqual(entry(d).invalidations.slice(0, -1), entry(absent).invalidations);
  assert.equal(a.verdictStateWas, "valid");
  assert.equal(a.previousEvidenceVersion, entry(absent).evidenceVersion);
  assert.equal(a.newEvidenceVersion, entry(d).evidenceVersion);
  assert.ok(a.changed.some((c) => c.dimension === "steps" && c.oldDigest === null && c.newDigest === d.ledger.evidence.dimensions.steps.digest));
});
const complete = clone(d);
for (const [name, corrupt] of [
  ["missing rule dimension", (e) => { e.evidenceRefs = e.evidenceRefs.filter((r) => r.dimension !== "steps"); }],
  ["wrong rule ID", (e) => { e.evidenceRefs.find((r) => r.dimension === "steps").ruleId = "invalid-rule"; }],
  ["duplicate rule ref", (e) => { e.evidenceRefs.push(clone(e.evidenceRefs[1])); }],
  ["missing basis", (e) => { e.evidenceRefs = e.evidenceRefs.filter((r) => r.dimension !== "burden"); }],
  ["null rule digest after restore", (e) => { e.evidenceRefs.find((r) => r.dimension === "steps").digest = null; }],
]) {
  const damaged = judged(clone(complete)); corrupt(entry(damaged));
  const gate = await validateSubmissionEvidence({ draft: damaged });
  check(`gate rejects ${name} despite current verdict`, () => {
    assert.equal(gate.ok, false); assert.equal(gate.code, "dependency_metadata_missing");
  });
  const repaired = await update(damaged);
  check(`rebuild ${name} invalidates old verdict`, () => {
    assert.equal(entry(repaired).evidenceVersion, entry(damaged).evidenceVersion + 1);
    assert.equal(state(repaired), "stale");
    assert.deepEqual(entry(repaired).evidenceRefs, entry(complete).evidenceRefs);
  });
}
let e = judged(await initial(["inputs"]));
const original = clone(e);
e = await update(e, { handoff: "同一轮没有返回目标推断" }, []);
check("omitted inference preserves suggestions, EV, audit and verdict", () => {
  assert.deepEqual(entry(e), entry(original)); assert.equal(state(e), "valid");
});
const prior = clone(e);
e = await update(e, { handoff: "明确返回空依赖建议" }, [proposal([])]);
check("explicit [] updates proposal identity and conservative scope", () => {
  assert.deepEqual(entry(e).proposedDependencyDimensions, []);
  assert.equal(entry(e).dependencyProposalKey, JSON.stringify({ basis: "burden", hints: [] }));
  assert.equal(entry(e).dependencySource, "model_conservative_potential");
  assert.deepEqual(entry(e).evidenceRefs.map((r) => r.dimension), ANSWER_DIMENSIONS);
});
check("explicit [] advances only evidence version, invalidates verdict, appends audit", () => {
  assert.equal(entry(e).evidenceVersion, entry(prior).evidenceVersion + 1);
  assert.equal(entry(e).contentVersion, entry(prior).contentVersion);
  assert.equal(state(e), "stale");
  assert.deepEqual(entry(e).invalidations.slice(0, -1), entry(prior).invalidations);
  assert.equal(entry(e).invalidations.at(-1).reason, "dependency_proposal_changed");
  assert.equal(entry(e).invalidations.at(-1).verdictStateWas, "valid");
});
const repeat = await update(e, {}, [proposal([])]);
check("repeated identical empty proposal is idempotent", () => assert.deepEqual(entry(repeat), entry(e)));
const capacity = judged(clone(absent));
entry(capacity).invalidations = Array.from({ length: 20 }, (_, i) => ({ ...entry(capacity).invalidations.at(-1), seq: i + 1 }));
const capacityBefore = clone(capacity);
const overflow = await applyAnswerEvidence({ existing: capacity, answersPatch: { steps: answers.steps },
  authoritativeInferences: mergeAuthoritativeInferences(capacity.ledger.authoritativeInferences, [proposal(["steps"])]) });
check("restore at audit capacity fails closed without mutating source", () => {
  assert.equal(overflow.ok, false); assert.equal(overflow.code, "dependency_audit_overflow"); assert.deepEqual(capacity, capacityBefore);
});
const accepted = await validateSubmissionEvidence({ draft: judged(e) });
check("rejudged complete evidence passes evidence gate", () => assert.equal(accepted.ok, true));
console.log(`PASS=${count} FAIL=0`);
