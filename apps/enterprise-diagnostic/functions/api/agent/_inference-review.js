// Read-only lifecycle from trusted server records. Never accepts a client status,
// deletes evidence, or converts an AI hypothesis into an employee/company fact.
const templates = new Map([
  ['template:exceptions:no-delete', /^处理异常时「/],
  ['template:judgments:needs-approval', /^遇到「/],
  ['template:steps:strict-order', /^按「/],
  ['template:trigger:self-only', /^由「/],
]);
// Pre-P2 submission snapshots omitted idSource. These are the four stable
// server-template identities; require source, template version and text prefix too.
const legacyTemplateSources = new Map([
  ['INF-0nst8wq','template:exceptions:no-delete'],
  ['INF-1cgazxp','template:judgments:needs-approval'],
  ['INF-0pxe1o4','template:steps:strict-order'],
  ['INF-0rerp8o','template:trigger:self-only'],
]);
export function inferenceReview(entry, draft = {}) {
  if (!entry || entry.source === 'capacity_block' || entry.isCapacityMarker) return {reviewStatus:'active',reviewReason:''};
  if (entry.source === 'server_template' && entry.templateVersion === 1 && templates.get(entry.idSource || legacyTemplateSources.get(entry.id))?.test(entry.text || '')) {
    return {reviewStatus:'retired_template',reviewReason:'旧通用模板已停止使用：原话不足以支持该全称推断；仅保留历史，不作为当前结论。'};
  }
  const stamp = draft.inferenceVerdicts?.[entry.id];
  if (stamp && ['correct','corrected'].includes(stamp.verdict) && String(stamp.correction || '').trim()
    && stamp.contentVersion === entry.contentVersion && stamp.evidenceHash === entry.evidenceHash
    && (stamp.evidenceVersion === entry.evidenceVersion || !Number.isInteger(entry.lastProposedRevision))) {
    return {reviewStatus:'employee_corrected',reviewReason:'员工已更正此旧假设；原文和更正保留在历史中，旧判定不作为新事实授权。',reviewCorrection:stamp.correction};
  }
  if (entry.source === 'model' && Number.isInteger(entry.lastProposedRevision)) {
    const later = (draft.ledger?.statementHistory || []).filter(h=>h.dimension===entry.basis && Number.isInteger(h.turnRevision) && h.turnRevision>entry.lastProposedRevision).at(-1);
    if (later) return {reviewStatus:'superseded_basis',reviewReason:'员工后续补充或修正了直接依据，旧假设转历史；不认定其真假，也不作为当前结论。',reviewSource:{dimension:later.dimension,statementSeq:later.seq,quote:later.text}};
  }
  return {reviewStatus:'active',reviewReason:''};
}
export function projectInferenceReviews(entries, draft = {}) {
  return (Array.isArray(entries)?entries:[]).map(entry=>({...entry,...inferenceReview(entry,draft)}));
}
