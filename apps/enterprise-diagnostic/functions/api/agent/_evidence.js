/**
 * PILOT-09C/IMPLEMENT-05B（F03）：服务端统一证据写入与证据一致性校验。
 *
 * 设计原则（模型提议，服务端裁决）：
 *   · 客户端只提交"操作意图"（改了哪些答案 / 对哪条推断做了什么判定）；
 *   · 服务端读取当前可信草稿，在**一次 CAS 写入**内完成：
 *     答案变化 → 追加 statementHistory → 更新 answersDigest/维度摘要/evidenceSeq
 *     → 使受影响推断的证据版本失效（模板条目的引用文本由服务端确定性重建）
 *     → 保留/盖章人工裁决 → 落库；
 *   · 正式提交时按同一套规则重新校验（不可绕过、不可静默清空）。
 *
 * 证据身份分层（不得混用）：
 *   draft.revision       并发控制（CAS）
 *   answersDigest        七维答案快照身份（SHA-256）
 *   evidence.seq         证据变化序号
 *   inference.contentVersion  推断内容版本（内容签名变化时推进）
 *   inference.evidenceVersion 推断所绑定证据版本（依赖维度答案变化时推进）
 */
import { G14_DIMENSIONS, G14_RULE_VERSION, MAX_DEPENDENCY_AUDIT, MAX_EVIDENCE_HISTORY, appendStatementHistory, buildInferences, inferenceDependencyProposalKey, matchG14DependencyRule, normalizeInference, resolveInferenceJudgment } from "./_adapter.js";
import { casWriteEmployeeDraft, normalizeEmployeeDraft, serializeEmployeeDraft } from "../../_shared.js";

export const ANSWER_DIMENSIONS = ["trigger", "inputs", "steps", "judgments", "exceptions", "handoff", "burden"];
export const EVIDENCE_SCHEMA_VERSION = 1;
export const EVIDENCE_DIMENSIONS_LABEL = {
  trigger: "从哪里开始", inputs: "先看什么", steps: "实际怎么做",
  judgments: "哪些情况不能自己决定", exceptions: "卡住后怎么办",
  handoff: "交给谁", burden: "大约多久",
};
const STATEMENT_HISTORY_LIMIT = 200;

export const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
};

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export const normalizeAnswerText = (value) => String(value === undefined || value === null ? "" : value)
  .normalize("NFC").replace(/\r\n/g, "\n").trim();

/** 七维答案规范化（只保留七个正式维度；空值删除）。 */
export function normalizeAnswers(answers) {
  const out = {};
  for (const key of ANSWER_DIMENSIONS) {
    const text = normalizeAnswerText(answers && answers[key]);
    if (text) out[key] = text;
  }
  return out;
}

/** 维度摘要：对规范化后的单维答案做 SHA-256；空答案 = null。 */
export async function computeDimensionDigests(answers) {
  const normalized = normalizeAnswers(answers);
  const dims = {};
  for (const key of ANSWER_DIMENSIONS) {
    dims[key] = normalized[key] ? await sha256Hex(normalized[key]) : null;
  }
  return dims;
}

export async function computeAnswersDigest(answers) {
  return sha256Hex(canonicalJson(normalizeAnswers(answers)));
}

/**
 * 由当前答案 + 既有证据状态派生**新的证据元数据**。
 * changedDimensions 为空时保持既有 seq 不变（幂等保存不制造证据变化）。
 */
export async function buildEvidenceState(answers, priorEvidence, changedDimensions = [], revision = null) {
  const normalized = normalizeAnswers(answers);
  const dims = await computeDimensionDigests(normalized);
  const prior = priorEvidence && typeof priorEvidence === "object" ? priorEvidence : null;
  const priorSeq = prior && Number.isInteger(prior.seq) && prior.seq >= 0 ? prior.seq : 0;
  const changed = Array.isArray(changedDimensions) ? changedDimensions.filter((key) => ANSWER_DIMENSIONS.includes(key)) : [];
  const seq = changed.length ? priorSeq + 1 : priorSeq;
  const dimensions = {};
  for (const key of ANSWER_DIMENSIONS) {
    const priorDim = prior && prior.dimensions && prior.dimensions[key] && typeof prior.dimensions[key] === "object" ? prior.dimensions[key] : null;
    const priorDimDigest = priorDim && typeof priorDim.digest === "string" ? priorDim.digest : null;
    const priorDimSeq = priorDim && Number.isInteger(priorDim.seq) && priorDim.seq >= 0 ? priorDim.seq : 0;
    const changedNow = changed.includes(key) && priorDimDigest !== dims[key];
    dimensions[key] = { digest: dims[key], seq: changedNow ? seq : priorDimSeq };
  }
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    seq,
    answersDigest: await computeAnswersDigest(normalized),
    dimensions,
    revision,
    updatedAt: new Date().toISOString(),
    // FIX-06A：服务端维护的证据来源标记必须跨更新保留（客户端不可写）。
    source: prior && typeof prior.source === "string" ? prior.source : "interview",
    legacyInitialized: prior && prior.legacyInitialized === true,
    ruleVersion: G14_RULE_VERSION,
  };
}

/** 由证据元数据反查维度摘要（无元数据时返回 null）。 */
export function dimensionDigestOf(evidence, dimension) {
  const entry = evidence && evidence.dimensions ? evidence.dimensions[dimension] : null;
  return entry && typeof entry.digest === "string" ? entry.digest : null;
}

// ── PILOT-09C/G14（IMPLEMENT-01）：依赖建立/失效 ──────────────────────────
const DEPENDENCY_ALLOWED_SOURCES = new Set(["server_template_fixed", "server_rule", "model_conservative_potential", "legacy_reestablished"]);
const DEPENDENCY_ALLOWED_STATUSES = new Set(["server_established", "server_template_fixed", "model_rule_validated", "model_conservative_potential"]);

/** 服务端保守潜在依赖集合：模型未声明/部分未验证时绑定全部可验证维度，避免漏失效。 */
function potentialDependencyRefs(evidence) {
  return G14_DIMENSIONS
    .map((dimension) => ({ dimension, digest: dimensionDigestOf(evidence, dimension), source: "model_conservative_potential", ruleId: null }))
    .filter((ref) => Boolean(ref.digest));
}

/** 为推断建立服务端依赖（客户端不可调用；只在服务端状态缺失/规则升级时调用）。 */
function establishDependencies(entry, evidence) {
  const basis = G14_DIMENSIONS.includes(entry && entry.basis) ? entry.basis : null;
  const rejected = [];
  const proposalKey = inferenceDependencyProposalKey(entry);
  if (entry && entry.source === "server_template") {
    const refs = basis && dimensionDigestOf(evidence, basis)
      ? [{ dimension: basis, digest: dimensionDigestOf(evidence, basis), source: "server_template_fixed", ruleId: null }]
      : [];
    return { refs, dependencyRuleVersion: G14_RULE_VERSION, dependencySource: "server_template_fixed",
             dependencyRuleStatus: "server_template_fixed", dependencyHintsRejected: [], dependencyProposalKey: proposalKey };
  }
  const hints = Array.isArray(entry && entry.proposedDependencyDimensions)
    ? [...new Set(entry.proposedDependencyDimensions.filter((dimension) => G14_DIMENSIONS.includes(dimension)))].slice(0, 3)
    : [];
  const accepted = [];
  for (const dimension of hints) {
    const rule = basis ? matchG14DependencyRule(basis, dimension) : null;
    if (!rule) { rejected.push({ dimension, reason: "no_rule" }); continue; }
    const digest = dimensionDigestOf(evidence, dimension);
    if (!digest) { rejected.push({ dimension, reason: "no_digest" }); continue; }
    accepted.push({ dimension, digest, source: "server_rule", ruleId: rule.ruleId });
  }
  if (basis && dimensionDigestOf(evidence, basis)) accepted.unshift({ dimension: basis, digest: dimensionDigestOf(evidence, basis), source: "basis", ruleId: null });
  // G14-F01：只有"模型明确提过依赖建议且全部通过服务端规则/证据校验"才允许使用窄的
  // server_rule 范围；任何建议被拒（无规则/维度尚未回答）都不得把范围当作完整，
  // 必须回退保守潜在依赖集合（宁可过度失效、不可漏失效）。
  if (hints.length > 0 && rejected.length === 0 && accepted.length > 1) {
    return { refs: accepted, dependencyRuleVersion: G14_RULE_VERSION, dependencySource: "server_rule",
             dependencyRuleStatus: "model_rule_validated", dependencyHintsRejected: rejected, dependencyProposalKey: proposalKey };
  }
  const potential = potentialDependencyRefs(evidence);
  return { refs: potential.length ? potential : accepted, dependencyRuleVersion: G14_RULE_VERSION,
           dependencySource: "model_conservative_potential", dependencyRuleStatus: "model_conservative_potential",
           dependencyHintsRejected: rejected, dependencyProposalKey: proposalKey };
}

/** 维度集合键（用于保守范围扩缩容判断）。 */
function dependencyDimensionSet(refs) {
  return [...new Set((Array.isArray(refs) ? refs : []).filter((ref) => ref && G14_DIMENSIONS.includes(ref.dimension)).map((ref) => ref.dimension))].sort().join("|");
}

/** 规则关系独立于摘要存在：撤回可保留 null，但不得漏掉 basis/建议对应的可信规则引用。 */
function hasCompleteRuleDependencies(entry) {
  const basis = G14_DIMENSIONS.includes(entry.basis) ? entry.basis : null;
  const hints = Array.isArray(entry.proposedDependencyDimensions) ? [...new Set(entry.proposedDependencyDimensions)] : [];
  if (!basis || !hints.length) return false;
  const expected = [{ dimension: basis, source: "basis", ruleId: null }];
  for (const dimension of hints) {
    const rule = matchG14DependencyRule(basis, dimension);
    if (!rule) return false;
    expected.push({ dimension, source: "server_rule", ruleId: rule.ruleId });
  }
  const refs = Array.isArray(entry.evidenceRefs) ? entry.evidenceRefs : [];
  return refs.length === expected.length && expected.every((wanted) =>
    refs.filter((ref) => ref && ref.dimension === wanted.dimension
      && ref.source === wanted.source && ref.ruleId === wanted.ruleId).length === 1);
}

/** 依赖范围差异（审计用）：返回维度并集里 old/new digest 不同的条目。 */
function dependencyRefDifference(before, after) {
  const oldMap = new Map((Array.isArray(before) ? before : []).filter((ref) => ref && G14_DIMENSIONS.includes(ref.dimension)).map((ref) => [ref.dimension, ref.digest || null]));
  const newMap = new Map((Array.isArray(after) ? after : []).filter((ref) => ref && G14_DIMENSIONS.includes(ref.dimension)).map((ref) => [ref.dimension, ref.digest || null]));
  const out = [];
  for (const dimension of new Set([...oldMap.keys(), ...newMap.keys()])) {
    const oldDigest = oldMap.has(dimension) ? oldMap.get(dimension) : null;
    const newDigest = newMap.has(dimension) ? newMap.get(dimension) : null;
    if (oldDigest !== newDigest) out.push({ dimension, oldDigest, newDigest });
  }
  return out;
}
/**
 * 使受影响推断失效并刷新模板引用。
 *
 * 规则：
 *   1. 推断的 evidenceRefs 记录它依赖的维度与当时的维度摘要；当前摘要变化 ⇒ evidenceVersion+1；
 *   2. server_template 推断的 quote/text 由服务端按**当前答案**确定性重建（contentVersion 推进）；
 *   3. model 推断只推进 evidenceVersion（文本是模型提议，不由服务端改写），要求人工重新确认；
 *   4. 无法确定依赖范围（无 basis 且无 refs）的条目：保守失效（evidenceVersion+1）；
 *   5. 永不删除旧条目；evidenceHistory / verdict history 保留用于审计。
 */
export async function refreshInferencesForEvidence({ inferences, answers, evidence, changedDimensions = [], verdicts = null, revision = null }) {
  const list = Array.isArray(inferences) ? inferences : [];
  const changed = new Set((changedDimensions || []).filter((key) => G14_DIMENSIONS.includes(key)));
  const normalizedAnswers = normalizeAnswers(answers);
  let rebuiltTemplates = [];
  try { rebuiltTemplates = buildInferences({ statements: normalizedAnswers }, {}).map((raw) => normalizeInference(raw)).filter(Boolean); } catch (_error) { rebuiltTemplates = []; }
  const templateById = new Map(rebuiltTemplates.map((entry) => [entry.id, entry]));
  const dims = evidence && evidence.dimensions ? evidence.dimensions : {};
  const dimDigest = (key) => (dims[key] && typeof dims[key].digest === "string" ? dims[key].digest : null);
  const invalidated = [];
  const reestablished = [];
  const templatesRefreshed = [];
  const refreshed = [];
  const auditOverflow = [];
  for (const raw of list) {
    const entry = raw && typeof raw === "object" ? raw : null;
    if (!entry) continue;
    if (entry.source === "capacity_block" || entry.isCapacityMarker === true) { refreshed.push(entry); continue; }
    const basis = G14_DIMENSIONS.includes(entry.basis) ? entry.basis : null;
    const proposalKey = inferenceDependencyProposalKey(entry);
    // G14-F04：审计必须记录**变更前**的真实判定状态。
    const verdictStateBefore = resolveInferenceJudgment(entry, verdicts || {});
    const hasCompleteMetadata = Number.isInteger(entry.dependencyRuleVersion)
      && entry.dependencyRuleVersion === G14_RULE_VERSION
      && Array.isArray(entry.evidenceRefs) && entry.evidenceRefs.length > 0
      && typeof entry.dependencySource === "string" && DEPENDENCY_ALLOWED_SOURCES.has(entry.dependencySource)
      && typeof entry.dependencyRuleStatus === "string" && DEPENDENCY_ALLOWED_STATUSES.has(entry.dependencyRuleStatus);
    const priorRefs = Array.isArray(entry.evidenceRefs) ? entry.evidenceRefs.filter((ref) => ref && G14_DIMENSIONS.includes(ref.dimension)) : [];
    let refs = priorRefs.slice();
    let dependencySource = entry.dependencySource || null;
    let dependencyRuleStatus = entry.dependencyRuleStatus || null;
    let dependencyRuleVersion = entry.dependencyRuleVersion || null;
    let dependencyHintsRejected = Array.isArray(entry.dependencyHintsRejected) ? entry.dependencyHintsRejected : [];
    let dependencyProposalKeyStored = typeof entry.dependencyProposalKey === "string" ? entry.dependencyProposalKey : null;
    let forcedUpgrade = false;
    let reason = "dependency_changed";
    let established = null;
    if (!hasCompleteMetadata) {
      established = establishDependencies(entry, evidence);
      forcedUpgrade = true;
      reason = Number.isInteger(entry.dependencyRuleVersion) && entry.dependencyRuleVersion !== G14_RULE_VERSION ? "rule_version_upgrade" : "dependency_metadata_reestablished";
    } else if (!dependencyProposalKeyStored) {
      if (entry.source === "server_template") {
        // 模板依赖由服务端固定规则唯一确定（basis 不变），可安全补写提议指纹（不失效）。
        dependencyProposalKeyStored = proposalKey;
      } else {
        // 旧 G14 数据没有提议指纹：不能仅凭旧元数据认为依赖范围正确，必须重新裁决。
        established = establishDependencies(entry, evidence);
        forcedUpgrade = true;
        reason = "dependency_metadata_reestablished";
      }
    } else if (dependencyProposalKeyStored !== proposalKey) {
      // G14-F03：同 ID 的 basis/依赖建议变化 → 重新进行服务端依赖裁决。
      established = establishDependencies(entry, evidence);
      forcedUpgrade = true;
      reason = "dependency_proposal_changed";
    } else if (dependencySource === "server_rule" && !hasCompleteRuleDependencies(entry)) {
      // FINAL-F01：修复已丢失引用的旧状态，重建范围并推进版本，不能恢复旧 verdict。
      established = establishDependencies(entry, evidence);
      forcedUpgrade = true;
      reason = "dependency_metadata_reestablished";
    } else if (dependencySource === "model_conservative_potential") {
      // G14-F02：保守潜在依赖必须随已答维度集合动态扩缩容（新维度/撤回/恢复）。
      const expectedPotential = potentialDependencyRefs(evidence);
      if (dependencyDimensionSet(priorRefs) !== dependencyDimensionSet(expectedPotential)) {
        forcedUpgrade = true;
        reason = "conservative_dependency_changed";
        refs = expectedPotential;
      }
    }
    if (established) {
      refs = established.refs;
      dependencySource = established.dependencySource;
      dependencyRuleStatus = established.dependencyRuleStatus;
      dependencyRuleVersion = established.dependencyRuleVersion;
      dependencyHintsRejected = established.dependencyHintsRejected;
      dependencyProposalKeyStored = proposalKey;
    }
    let evidenceVersion = Number.isInteger(entry.evidenceVersion) && entry.evidenceVersion >= 0 ? entry.evidenceVersion : 0;
    let mismatches = [];
    if (!forcedUpgrade) {
      // 旧状态也可能已漏过一次恢复；不能只看本请求 changed，否则重绑摘要会静默恢复旧判定。
      mismatches = refs.filter((ref) => ref.digest !== dimDigest(ref.dimension));
    }
    const changedNow = forcedUpgrade || mismatches.length > 0;
    if (changedNow) { evidenceVersion += 1; invalidated.push(entry.id); if (forcedUpgrade) reestablished.push(entry.id); }
    const next = {
      ...entry,
      evidenceVersion,
      evidenceRefs: refs.map((ref) => ({ ...ref, digest: dimDigest(ref.dimension) })),
      dependencyRuleVersion,
      dependencySource,
      dependencyRuleStatus,
      dependencyHintsRejected,
      dependencyProposalKey: dependencyProposalKeyStored,
      proposedDependencyDimensions: Array.isArray(entry.proposedDependencyDimensions) ? entry.proposedDependencyDimensions : [],
      invalidations: Array.isArray(entry.invalidations) ? entry.invalidations.slice() : [],
    };
    if (next.source === "server_template" && basis && changed.has(basis)) {
      const rebuilt = templateById.get(entry.id);
      if (rebuilt && rebuilt.quote !== entry.quote) {
        const priorVersion = Number.isInteger(entry.contentVersion) && entry.contentVersion > 0 ? entry.contentVersion : 1;
        const history = Array.isArray(entry.evidenceHistory) ? entry.evidenceHistory.slice() : [];
        history.push({ evidenceHash: rebuilt.evidenceHash, quote: rebuilt.quote || null, contentVersion: priorVersion + 1 });
        next.quote = rebuilt.quote;
        next.text = rebuilt.text;
        next.evidenceHash = rebuilt.evidenceHash;
        next.contentVersion = priorVersion + 1;
        next.evidenceHistory = history;
        templatesRefreshed.push(entry.id);
      }
    }
    if (changedNow) {
      const audit = {
        seq: next.invalidations.length + 1,
        at: new Date().toISOString(),
        draftRevision: Number.isInteger(revision) ? revision : null,
        evidenceSeq: evidence && Number.isInteger(evidence.seq) ? evidence.seq : null,
        reason,
        ruleVersion: G14_RULE_VERSION,
        changed: forcedUpgrade ? dependencyRefDifference(priorRefs, refs) : mismatches.map((ref) => ({ dimension: ref.dimension, oldDigest: ref.digest, newDigest: dimDigest(ref.dimension) })),
        previousEvidenceVersion: evidenceVersion - 1,
        newEvidenceVersion: evidenceVersion,
        // G14-F04：变更前状态（valid / stale / unjudged），不是推进后的状态。
        verdictStateWas: verdictStateBefore,
      };
      if (next.invalidations.length >= MAX_DEPENDENCY_AUDIT) auditOverflow.push({ id: entry.id || null, current: next.invalidations.length });
      else next.invalidations.push(audit);
    }
    refreshed.push(next);
  }
  const overflow = refreshed.filter((entry) => entry && Array.isArray(entry.evidenceHistory) && entry.evidenceHistory.length > MAX_EVIDENCE_HISTORY).map((entry) => ({ id: entry.id || null, length: entry.evidenceHistory.length }));
  return {
    inferences: refreshed,
    invalidatedInferenceIds: invalidated,
    reestablishedInferenceIds: reestablished,
    templatesRefreshed,
    evidenceHistoryOverflow: overflow.length ? { limit: MAX_EVIDENCE_HISTORY, current: Math.max(...overflow.map((o) => o.length)), inferenceIds: overflow.map((o) => o.id) } : null,
    dependencyAuditOverflow: auditOverflow.length ? { limit: MAX_DEPENDENCY_AUDIT, current: Math.max(...auditOverflow.map((o) => o.current)), inferenceIds: auditOverflow.map((o) => o.id) } : null,
  };
}

export function appendEvidenceHistory({ prior, changedDimensions, answers, revision, intent = "" }) {
  let history = Array.isArray(prior) ? prior.slice() : [];
  const appended = [];
  for (const key of changedDimensions) {
    const text = normalizeAnswerText(answers && answers[key]);
    const result = text
      ? appendStatementHistory({ prior: history, dimension: key, text, intent, revision })
      : appendStatementHistory({ prior: history, dimension: key, revision, withdraw: true });
    if (result.overflow) {
      return { ok: false, code: "statement_history_overflow", history, appended, limit: STATEMENT_HISTORY_LIMIT, current: history.length };
    }
    history = result.history;
    if (result.appended) appended.push(result.appended);
  }
  return { ok: true, history, appended };
}

/**
 * 统一证据变更的核心（纯计算）：
 *   输入：已归一化的当前草稿 + 新答案（或答案补丁）+ 既有权威推断
 *   输出：新答案/历史/证据元数据/刷新后的推断/受影响条目
 */
export async function applyAnswerEvidence({ existing, answers = null, answersPatch = null, answerEntry = null, changedDimensions = null, historyOverride = null, authoritativeInferences = null, statementIntent = "" }) {
  const draft = existing && typeof existing === "object" ? existing : normalizeEmployeeDraft({});
  const baseAnswers = { ...(draft.answers || {}) };
  const nextAnswers = answers ? { ...answers } : { ...baseAnswers };
  if (answersPatch && typeof answersPatch === "object") {
    for (const [key, value] of Object.entries(answersPatch)) {
      if (!ANSWER_DIMENSIONS.includes(key) || typeof value !== "string") continue;
      const trimmed = normalizeAnswerText(value);
      if (!trimmed) delete nextAnswers[key];
      else nextAnswers[key] = trimmed;
    }
  }
  if (answerEntry && typeof answerEntry === "object" && ANSWER_DIMENSIONS.includes(answerEntry.dimension)) {
    const trimmed = normalizeAnswerText(answerEntry.text);
    if (!trimmed) delete nextAnswers[answerEntry.dimension];
    else nextAnswers[answerEntry.dimension] = trimmed;
  }
  const explicit = Array.isArray(changedDimensions) ? changedDimensions : null;
  const changed = explicit || ANSWER_DIMENSIONS.filter((key) => normalizeAnswerText(baseAnswers[key]) !== normalizeAnswerText(nextAnswers[key]));
  const priorLedger = draft.ledger && typeof draft.ledger === "object" ? draft.ledger : {};
  const priorEvidence = priorLedger.evidence && typeof priorLedger.evidence === "object" ? priorLedger.evidence : null;
  let history = historyOverride === null || historyOverride === undefined
    ? Array.isArray(priorLedger.statementHistory) ? priorLedger.statementHistory.slice() : []
    : historyOverride;
  let appended = [];
  let evidence = null;
  let controlledInitialization = false;
  // ── 旧草稿受控初始化（F03 兼容规则）─────────────────────────────────
  // 旧数据可能没有 evidence 元数据、也没有 statementHistory。允许在**第一次统一证据保存**时
  // 用库中已存在的答案受控初始化历史（append-only、只做一次），随后仍要求人工重新确认判定；
  // 无法证明一致（例如历史非空但与答案冲突）时保持原数据、让提交门禁要求重新确认。
  if (!changed.length && (historyOverride === null || historyOverride === undefined)
      && !priorEvidence && history.length === 0 && Object.keys(baseAnswers).length > 0) {
    const init = appendEvidenceHistory({
      prior: history,
      changedDimensions: ANSWER_DIMENSIONS.filter((key) => normalizeAnswerText(nextAnswers[key])),
      answers: nextAnswers,
      revision: draft.revision,
      intent: "",
    });
    if (!init.ok) return init;
    history = init.history;
    appended = init.appended;
    controlledInitialization = true;
  }
  if (changed.length) {
    if (historyOverride === null || historyOverride === undefined) {
      const appendedResult = appendEvidenceHistory({ prior: history, changedDimensions: changed, answers: nextAnswers, revision: draft.revision, intent: statementIntent });
      if (!appendedResult.ok) return appendedResult;
      history = appendedResult.history;
      appended = appendedResult.appended;
    }
    evidence = await buildEvidenceState(nextAnswers, priorEvidence, changed, draft.revision);
  } else {
    evidence = priorEvidence || await buildEvidenceState(nextAnswers, null, [], draft.revision);
    if (!priorEvidence) evidence = { ...evidence, initializedFromLegacy: true };
  }
  // G14：规则升级/旧数据：证据元数据也必须写入当前规则版本（提交门禁 fail-closed）。
  if (evidence && evidence.ruleVersion !== G14_RULE_VERSION) {
    evidence = { ...evidence, ruleVersion: G14_RULE_VERSION };
  }
  // FIX-06A：无 evidence 元数据但已有库中答案的首次证据写入 = 旧数据受控初始化。
  // 服务端写入显式来源标记（客户端不可写），供提交审计快照区分"旧数据初始化"与真实访谈。
  if (!priorEvidence && Object.keys(baseAnswers).length > 0) {
    evidence = { ...evidence, legacyInitialized: true, initializedFromLegacy: true, source: "legacy_controlled_init" };
  }
  const sourceInferences = authoritativeInferences !== null && authoritativeInferences !== undefined
    ? authoritativeInferences
    : Array.isArray(priorLedger.authoritativeInferences) ? priorLedger.authoritativeInferences : [];
  const refresh = await refreshInferencesForEvidence({ inferences: sourceInferences, answers: nextAnswers, evidence, changedDimensions: changed, verdicts: (draft.inferenceVerdicts || {}), revision: draft.revision });
  if (refresh.evidenceHistoryOverflow) {
    return {
      ok: false,
      code: "evidence_history_overflow",
      limit: refresh.evidenceHistoryOverflow.limit,
      current: refresh.evidenceHistoryOverflow.current,
      inferenceIds: refresh.evidenceHistoryOverflow.inferenceIds,
      detail: `推断证据历史已达上限（${refresh.evidenceHistoryOverflow.limit} 条），本次证据变更被拒绝，未写入任何内容；已有历史不会被删除。`,
    };
  }
  if (refresh.dependencyAuditOverflow) {
    return {
      ok: false,
      code: "dependency_audit_overflow",
      limit: refresh.dependencyAuditOverflow.limit,
      current: refresh.dependencyAuditOverflow.current,
      inferenceIds: refresh.dependencyAuditOverflow.inferenceIds,
      detail: `推断失效审计已达上限（${refresh.dependencyAuditOverflow.limit} 条），本次证据变更被拒绝，未写入任何内容；已有审计不会被删除。`,
    };
  }
  const statements = {};
  const covered = [];
  for (const key of ANSWER_DIMENSIONS) {
    const text = normalizeAnswerText(nextAnswers[key]);
    if (text) { statements[key] = text; covered.push(key); }
  }
  return {
    ok: true,
    answers: nextAnswers,
    changedDimensions: changed,
    history,
    historyAppended: appended,
    evidence,
    statements,
    covered,
    authoritativeInferences: refresh.inferences,
    invalidatedInferenceIds: refresh.invalidatedInferenceIds,
    reestablishedInferenceIds: refresh.reestablishedInferenceIds || [],
    templatesRefreshed: refresh.templatesRefreshed,
    controlledInitialization,
  };
}

/** 统一 CAS 写入入口（employee-draft / employee-turn 都调用它）。 */
export async function applyEvidenceMutation({ db, itemId, expectedRevision, writeGuard = null, materialStatus = null, answers, ledger, inferenceVerdicts, submissionText = "", revision }) {
  const draftJson = serializeEmployeeDraft({ answers, ledger, inferenceVerdicts, submissionText, revision });
  return casWriteEmployeeDraft(db, itemId, expectedRevision, draftJson, materialStatus, writeGuard);
}

/**
 * employee-turn 专用：把"本轮答案 + 本轮历史 + 本轮推断基线 + 下一问锚点"
 * 在同一次 CAS 写入中落库（F03-2）。
 */
export async function applyTurnEvidence({ db, workItemId, expectedRevision, storedDraft, answer = null, dimension = null, historyOverride = null, authoritativeInferences = null, anchor = null, burdenAsked = undefined, ledgerPatch = null, writeGuard = null }) {
  const evidenceResult = await applyAnswerEvidence({
    existing: storedDraft,
    answerEntry: dimension && answer !== null && answer !== undefined ? { dimension, text: answer } : null,
    historyOverride: historyOverride === null || historyOverride === undefined ? null : historyOverride,
    authoritativeInferences: authoritativeInferences === undefined ? null : authoritativeInferences,
  });
  if (!evidenceResult.ok) return { ok: false, ...evidenceResult };
  const priorLedger = storedDraft && storedDraft.ledger && typeof storedDraft.ledger === "object" ? storedDraft.ledger : {};
  const ledger = {
    ...priorLedger,
    ...(ledgerPatch && typeof ledgerPatch === "object" ? ledgerPatch : {}),
    statements: evidenceResult.statements,
    covered: evidenceResult.covered,
    statementHistory: evidenceResult.history,
    authoritativeInferences: evidenceResult.authoritativeInferences,
    evidence: evidenceResult.evidence,
    pendingQuestion: anchor === null ? null : anchor,
    burdenAsked: burdenAsked === undefined ? priorLedger.burdenAsked === true : Boolean(burdenAsked),
  };
  const cas = await applyEvidenceMutation({
    db, itemId: workItemId, expectedRevision, writeGuard,
    materialStatus: null,
    answers: evidenceResult.answers,
    ledger,
    inferenceVerdicts: storedDraft && storedDraft.inferenceVerdicts ? storedDraft.inferenceVerdicts : {},
    submissionText: storedDraft && typeof storedDraft.submissionText === "string" ? storedDraft.submissionText : "",
    revision: expectedRevision + 1,
  });
  return { ok: cas.ok, ...cas, evidence: evidenceResult.evidence, historyAppended: evidenceResult.historyAppended, invalidatedInferenceIds: evidenceResult.invalidatedInferenceIds, reestablishedInferenceIds: evidenceResult.reestablishedInferenceIds };
}

/**
 * 正式提交证据门禁（F03-6）：
 *   - 七维答案完整（F04 已校验，这里仍作为兜底）；
 *   - answersDigest / 每维 digest 与当前答案一致；
 *   - 每维最新陈述与当前答案一致（无访谈证据 / 证据分裂 ⇒ 拒绝）；
 *   - 每条推断的 evidenceRefs 摘要与当前证据一致、模板引用文本与答案一致；
 *   - 不支持/无法验证的跨维度依赖 ⇒ 拒绝；
 *   - 旧草稿（无证据元数据）只有在一致性可证明时才允许通过（受控初始化），否则要求重新确认。
 */
export async function validateSubmissionEvidence({ draft, answers = null, materialStatus = null }) {
  const normalized = draft && typeof draft === "object" && !Array.isArray(draft) ? draft : normalizeEmployeeDraft({});
  const currentAnswers = normalizeAnswers(answers || normalized.answers || {});
  const missing = ANSWER_DIMENSIONS.filter((key) => !currentAnswers[key]);
  if (missing.length) return { ok: false, code: "answers_incomplete", status: 422, detail: "服务端答案不完整，不能提交。", missingDimensions: missing };
  const ledger = normalized.ledger && typeof normalized.ledger === "object" ? normalized.ledger : {};
  const evidence = ledger.evidence && typeof ledger.evidence === "object" ? ledger.evidence : null;
  const expectedDigest = await computeAnswersDigest(currentAnswers);
  const dims = await computeDimensionDigests(currentAnswers);
  const history = Array.isArray(ledger.statementHistory) ? ledger.statementHistory : [];
  const inferences = Array.isArray(ledger.authoritativeInferences) ? ledger.authoritativeInferences : [];
  if (!inferences.length) {
    return { ok: false, code: "interview_evidence_missing", status: 409, detail: "没有服务端访谈证据（推断基线）可供核验，不能直接正式提交。请先完成一次员工访谈。" };
  }
  // 每维最新有效陈述必须与当前答案一致；无陈述视为无访谈证据。
  const latestByDimension = {};
  for (const entry of history) {
    if (!entry || !ANSWER_DIMENSIONS.includes(entry.dimension)) continue;
    if (entry.kind === "withdrawn") { latestByDimension[entry.dimension] = null; continue; }
    latestByDimension[entry.dimension] = normalizeAnswerText(entry.text);
  }
  const historyIssues = [];
  for (const key of ANSWER_DIMENSIONS) {
    const latest = latestByDimension[key];
    if (!latest) { historyIssues.push(key); continue; }
    if (latest !== currentAnswers[key]) historyIssues.push(key);
  }
  if (historyIssues.length) {
    return {
      ok: false, code: "evidence_history_mismatch", status: 409,
      detail: "服务端陈述历史与当前答案不一致（答案可能被绕过统一证据入口修改），不能提交。请重新完成访谈或纠错后再试。",
      dimensions: historyIssues,
    };
  }
  // 旧草稿：无证据元数据不得自动通过；只有历史/推断可证明一致时按 legacy_consistent 允许（受控初始化）。
  if (!evidence) return { ok: false, code: "evidence_metadata_missing", status: 409, detail: "该草稿缺少服务端证据版本元数据，旧裁决不能自动认定为有效。请刷新任务并完成一次统一证据保存（保存答案或访谈回答）后再提交。", legacy: true };
  if (evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION || typeof evidence.answersDigest !== "string" || typeof evidence.answersDigest !== "string") {
    return { ok: false, code: "evidence_metadata_invalid", status: 409, detail: "服务端证据元数据格式无效，不能提交。请重新保存证据后再试。" };
  }
  if (evidence.answersDigest !== expectedDigest) {
    return { ok: false, code: "evidence_digest_mismatch", status: 409, detail: "答案摘要与服务端证据版本不一致（答案被绕过统一证据入口修改），不能提交。请刷新后重新保存答案。" };
  }
  const digestIssues = ANSWER_DIMENSIONS.filter((key) => dimensionDigestOf(evidence, key) !== dims[key]);
  if (digestIssues.length) {
    return { ok: false, code: "evidence_digest_mismatch", status: 409, detail: "维度证据摘要与服务端证据版本不一致，不能提交。", dimensions: digestIssues };
  }
  // G14：规则版本必须一致；旧数据/规则升级未重新建立依赖时 fail-closed，不自动继承旧裁决。
  if (evidence.ruleVersion !== G14_RULE_VERSION) {
    return { ok: false, code: "dependency_rule_mismatch", status: 409,
      detail: "服务端证据/依赖规则版本不一致或缺失，旧裁决不能自动继承。请刷新并完成一次证据保存/重新核验后再提交。",
      expectedRuleVersion: G14_RULE_VERSION, actualRuleVersion: evidence.ruleVersion ?? null };
  }
  const inferenceIssues = [];
  const unverifiedInferences = [];
  const ruleMismatchInferences = [];
  for (const entry of inferences) {
    if (!entry || entry.source === "capacity_block" || entry.isCapacityMarker === true) continue;
    if (!Number.isInteger(entry.evidenceVersion)) { inferenceIssues.push(entry.id || null); continue; }
    // G14-F03：提交时提议指纹必须与当前 basis/建议一致；旧元数据不能自动视为依赖范围正确。
    if (entry.dependencyProposalKey !== inferenceDependencyProposalKey(entry)) { unverifiedInferences.push(entry.id || null); continue; }
    if (entry.dependencyRuleVersion !== G14_RULE_VERSION) { ruleMismatchInferences.push(entry.id || null); continue; }
    if (entry.dependencySource === "server_rule" && !hasCompleteRuleDependencies(entry)) {
      unverifiedInferences.push(entry.id || null); continue;
    }
    // G14-F02：保守潜在依赖的提交范围必须覆盖当前全部已答维度（新维度未被覆盖即 fail-closed）。
    if (entry.dependencySource === "model_conservative_potential"
        && dependencyDimensionSet(entry.evidenceRefs) !== dependencyDimensionSet(potentialDependencyRefs(evidence))) {
      unverifiedInferences.push(entry.id || null); continue;
    }
    if (!DEPENDENCY_ALLOWED_STATUSES.has(entry.dependencyRuleStatus) || !DEPENDENCY_ALLOWED_SOURCES.has(entry.dependencySource)) {
      unverifiedInferences.push(entry.id || null); continue;
    }
    const refs = Array.isArray(entry.evidenceRefs)
      ? entry.evidenceRefs.filter((ref) => ref && G14_DIMENSIONS.includes(ref.dimension) && typeof ref.digest === "string")
      : [];
    if (!refs.length || refs.length !== entry.evidenceRefs.length) { unverifiedInferences.push(entry.id || null); continue; }
    for (const ref of refs) {
      if (dimensionDigestOf(evidence, ref.dimension) !== ref.digest || dims[ref.dimension] !== ref.digest) {
        inferenceIssues.push(entry.id || null);
        break;
      }
    }
    if (entry.source === "server_template" && entry.basis && normalizeAnswerText(entry.quote) !== currentAnswers[entry.basis]) inferenceIssues.push(entry.id || null);
  }
  if (unverifiedInferences.length) {
    return { ok: false, code: "dependency_metadata_missing", status: 409,
      detail: "存在缺少/未验证服务端依赖元数据的推断，旧裁决不能自动认定有效。请刷新并完成一次证据保存/重新核验后再提交。",
      inferenceIds: [...new Set(unverifiedInferences)].slice(0, 20) };
  }
  if (ruleMismatchInferences.length) {
    return { ok: false, code: "dependency_rule_mismatch", status: 409,
      detail: "存在依赖规则版本不一致的推断，不能提交。请刷新并重新确认推断。",
      expectedRuleVersion: G14_RULE_VERSION, inferenceIds: [...new Set(ruleMismatchInferences)].slice(0, 20) };
  }
  if (inferenceIssues.length) {
    return { ok: false, code: "inference_evidence_stale", status: 409, detail: "存在仍绑定旧证据版本的 AI 推断，旧裁决不能作为新证据授权依据。请刷新后重新确认/更正相关推断。", inferenceIds: [...new Set(inferenceIssues)].slice(0, 20) };
  }
  return { ok: true, legacy: false, answersDigest: expectedDigest, evidenceSeq: evidence.seq };
}

/** 供提交审计快照使用：从草稿提取证据摘要（只读）。 */
export function submissionEvidenceSummary(draft) {
  const ledger = draft && draft.ledger && typeof draft.ledger === "object" ? draft.ledger : {};
  const evidence = ledger.evidence && typeof ledger.evidence === "object" ? ledger.evidence : null;
  const history = Array.isArray(ledger.statementHistory) ? ledger.statementHistory : [];
  const latestSeq = history.reduce((max, entry) => Math.max(max, Number.isInteger(entry && entry.seq) ? entry.seq : 0), 0);
  return {
    evidenceSeq: evidence ? evidence.seq : null,
    answersDigest: evidence ? evidence.answersDigest : null,
    dimensions: evidence ? Object.keys(evidence.dimensions || {}).length : 0,
    historyCount: history.length,
    historySeq: latestSeq,
    // FIX-06A：审计可见的证据来源（服务端维护；旧数据受控初始化 vs 真实访谈）
    source: evidence && typeof evidence.source === "string" ? evidence.source : null,
    legacyInitialized: evidence ? evidence.legacyInitialized === true : false,
    initialHistoryCount: history.filter((entry) => entry && entry.kind === "initial").length,
    // G14：证据/依赖规则版本 + 依赖审计概况（只读摘要）
    ruleVersion: evidence ? (Number.isInteger(evidence.ruleVersion) ? evidence.ruleVersion : null) : null,
    inferenceDependencyRuleVersions: [...new Set((Array.isArray(ledger.authoritativeInferences) ? ledger.authoritativeInferences : []).map((entry) => entry && entry.dependencyRuleVersion).filter((v) => Number.isInteger(v)))],
    invalidationAuditCount: (Array.isArray(ledger.authoritativeInferences) ? ledger.authoritativeInferences : []).reduce((sum, entry) => sum + (Array.isArray(entry?.invalidations) ? entry.invalidations.length : 0), 0),
  };
}

// 供提交门禁错误码之外的可读信息（测试/审计使用）
export function summarizeInferenceEvidence(inferences) {
  return (Array.isArray(inferences) ? inferences : []).map((entry) => ({
    id: entry && entry.id, basis: entry && entry.basis,
    evidenceVersion: entry && entry.evidenceVersion,
    contentVersion: entry && entry.contentVersion,
    refs: entry && Array.isArray(entry.evidenceRefs) ? entry.evidenceRefs : [],
  }));
}
