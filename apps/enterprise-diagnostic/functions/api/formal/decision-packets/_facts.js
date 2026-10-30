import { httpError } from "../../../_shared.js";

export function packetFactIds(refs) {
  if (!Array.isArray(refs)) return [];
  return [...new Set(refs.map((ref) => String(ref?.factId || "").trim()).filter(Boolean))].sort();
}

/**
 * B-01/B-02 — published conclusion protection.
 *
 * A decision packet snapshots `fact_refs_json` at draft time. After publication the
 * facts can change underneath it: an employee supplement resets a fact to `open`
 * (evidence-supplement.js), a verifier re-grades it, or a missed high-impact fact is
 * upgraded and re-enters second confirmation. `requireEligiblePacketFacts` only runs
 * at verify/publish time, so a published packet could keep being treated as a valid
 * basis for decisions after its evidence had been invalidated.
 *
 * These helpers find the published packets that depend on a fact and mark them
 * `stale`. They never delete or rewrite history: the packet row, its version, the
 * attached `owner_decisions` and all prior events stay exactly as they were. Only an
 * explicit invalidation marker plus an append-only event are added, so a later reader
 * can see both that a decision was made and that its basis lapsed afterwards.
 */

function safeParse(value) {
  try { return JSON.parse(value || "[]"); } catch (_error) { return []; }
}

/** Find published / verifier-checked packets in a project that reference this fact. */
export async function findInvalidatablePacketsReferencing(db, projectId, factId) {
  const key = String(factId || "").trim();
  if (!key) return [];
  const result = await db.prepare(
    "SELECT id,version,status,fact_refs_json,suggestions_json FROM decision_packets WHERE project_id=? AND status IN ('published','verifier_checked','owner_decided','revision_requested') AND (fact_refs_json LIKE ? OR suggestions_json LIKE ?)"
  ).bind(projectId, `%${key}%`, `%${key}%`).all();
  return (result.results || []).filter((packet) => {
    const refs = packetFactIds(safeParse(packet.fact_refs_json));
    const suggested = suggestionFactIds(packet.suggestions_json);
    return refs.includes(key) || suggested.includes(key);
  });
}

/**
 * Build the statements that mark the given packets `stale` and append one event each.
 * Idempotent: the UPDATE is guarded on the current status, and the event is guarded
 * on the resulting `last_transition_key`, so a retry cannot double-write an event.
 * Callers splice these into the same `db.batch` as the fact change that caused them.
 */
export function stalePacketStatements(db, { packets, projectId, factId, actorRole, actorId, reason, cause }) {
  // Every caller supplies the successful transition in this same batch. A losing CAS
  // must not invalidate a later conclusion or append an event for a change it did not make.
  if (!cause?.sql) throw new Error("Packet invalidation requires a successful cause");
  const sweepKey = `stale-sweep:${factId}:${crypto.randomUUID()}`;
  const referencesFact = "(EXISTS (SELECT 1 FROM json_each(decision_packets.fact_refs_json) ref WHERE json_extract(ref.value,'$.factId')=?) OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(decision_packets.suggestions_json)='array' THEN decision_packets.suggestions_json ELSE json_extract(decision_packets.suggestions_json,'$.items') END) item,json_each(item.value,'$.factIds') ref WHERE ref.value=?))";
  const statements = [
    db.prepare(`UPDATE decision_packets SET status='stale',last_transition_key=? WHERE project_id=? AND status IN ('published','verifier_checked','owner_decided','revision_requested') AND ${referencesFact} AND (${cause.sql})`)
      .bind(sweepKey, projectId, factId, factId, ...(cause.values || [])),
    db.prepare("INSERT INTO events(event_id,project_id,type,actor_role,actor_id,payload) SELECT 'EVT-STALE-' || ? || '-' || id,project_id,'decision_packet_staled',?,?,json_object('packetId',id,'packetVersion',version,'triggeringFactId',?,'reason',?) FROM decision_packets WHERE project_id=? AND status='stale' AND last_transition_key=?")
      .bind(crypto.randomUUID(), actorRole, actorId, factId, reason, projectId, sweepKey),
  ];
  return { statements, staled: packets.map((packet) => packet.id) };
}

/**
 * V0.2 suggestions — shared validation.
 *
 * The suggestion envelope lives in `decision_packets.suggestions_json`. It is derived
 * server-side: the model may only supply the six business fields, and every factId is
 * checked against the facts that role is allowed to see. Nothing in this module trusts
 * a client-supplied status, reviewer, or evidence snapshot.
 */

export const MAX_SUGGESTIONS = 3;
export const SUGGESTION_PRIORITIES = Object.freeze(["high", "medium", "low"]);
// One range rule for the internal set: list, model prompt and save use the same first 30.
export const INTERNAL_FACT_LIMIT = 30;

export async function factsBasisDigest(facts) {
  const lines = (facts || []).map((fact) => [
    fact.id, Number(fact.evidence_version || 1), fact.status,
    String(fact.evidence_level || "").toUpperCase(), fact.impact_level || "",
    effectiveFactText(fact),
  ].join(":")).sort();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(lines.join("|")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Rule 4: no invented ROI / savings / implementation duration. Matching is contextual:
// a clearly negated disclaimer ("不承诺实施周期") and a sample count ("3万条订单") are
// allowed, while "承诺三天完成上线"/"节省十万"/"提升三成" are refused.
const QUANTIFICATION_PATTERNS = [
  /([0-9０-９]+(?:[.．][0-9０-９]+)?\s*[%％])/i,
  /(百分之[零一二三四五六七八九十百千万亿两0-9０-９.．]+)/i,
  /([¥￥]\s*[0-9０-９])/,
  /([0-9０-９]+(?:[.．][0-9０-９]+)?\s*(?:万元|元))/,
  /((?:节省|节约|成本|费用|收入|利润|收益)[^。；\n]{0,10}(?:[0-9０-９]+|[零一二三四五六七八九十百千万亿两]+)\s*万?(?:元)?)/i,
  /((?:提升|提高|降低|下降|增长|涨幅|降幅)[^。；\n]{0,6}[0-9０-９零一二三四五六七八九十百]+(?:成|倍))/i,
  /([0-9０-９零一二三四五六七八九十百两半]+\s*(?:小时|分钟|天|日|周|星期|个月|月|季度|半年|年)\s*(?:内|完成|上线|交付|见效))/i,
  /([0-9０-９零一二三四五六七八九十百两]+\s*(?:个)?工作日\s*(?:内|完成|上线|交付|见效))/i,
  /((?:上线|实施|交付|部署|落地|见效|完成)[^。；\n，,]{0,8}(?:仅需|只需|只要|需要|需|需时|用时|耗时|历时|可在|控制在)\s*[0-9０-９零一二三四五六七八九十百两半]+\s*(?:个工作日|工作日|小时|分钟|天|日|周|星期|个月|月|季度|半年|年))/i,
  /([0-9０-９零一二三四五六七八九十百两半]+\s*(?:个工作日|工作日|小时|分钟|天|日|周|星期|个月|月|季度|半年|年)\s*(?:之后|以后|后|以内|即可|就能|便可|可以|可)\s*(?:完成|上线|交付|部署|落地|见效))/i,
  /(实施周期|上线周期|交付周期)/i,
  /(投资回报率|ROI|回本周期|回本)/i,
];

// A disclaimer is only valid inside the clause that contains the quantified phrase:
// "不承诺实施周期，需先核实" is allowed, while "尚未统计，预计节省十万" is still a
// promise and must be refused. Bare adjacent negation ("并没有节省十万") is allowed too.
// `未` inside 未来, `不` inside 不断, etc. are not negations; without this guard a phrase
// like "不排除未来提升三成" would be misread as a disclaimer.
const DISCLAIMER_PATTERN = /(?:不|未|没|无|勿)(?!来|断|仅|同|错|论|数|比|疑)[^。；\n，,]{0,6}(?:承诺|预设|保证|声称|宣称|断言)/;
const ADJACENT_NEGATION = /(?:不|未|没|无|勿)(?!来|断|仅|同|错|论|数|比|疑)[^。；\n，,]{0,2}$/;

function clauseBefore(text, index) {
  const head = text.slice(0, index);
  const cut = Math.max(
    head.lastIndexOf("。"), head.lastIndexOf("；"), head.lastIndexOf("，"),
    head.lastIndexOf(","), head.lastIndexOf("\n"),
  );
  return head.slice(cut + 1);
}

function negatedAt(text, index) {
  const clause = clauseBefore(text, index);
  return DISCLAIMER_PATTERN.test(clause) || ADJACENT_NEGATION.test(clause);
}

/** Return the first non-negated quantified promise, or null. */
export function quantificationViolation(text) {
  // Split before matching too: an amount regex must not consume both "不承诺收益"
  // and "但保证节省十万" as one negated match and thereby hide the second claim.
  const clauses = String(text || "").split(/[。；，,\n]|但是|然而|不过|而是|但|并且|而且|同时|且|并/);
  for (const source of clauses) {
    for (const pattern of QUANTIFICATION_PATTERNS) {
      const scanner = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
      let match = scanner.exec(source);
      while (match) {
        if (!negatedAt(source, match.index)) return match[0];
        match = scanner.exec(source);
      }
    }
  }
  return null;
}

/** The text a reader must treat as the current business fact. */
export function effectiveFactText(fact) {
  const correction = String(fact?.correction || "").trim();
  if (fact?.material_status === "different_with_correction" && correction) return correction;
  return String(fact?.claim || "").trim();
}

export function parseSuggestions(value) {
  let envelope = null;
  try { envelope = typeof value === "string" ? JSON.parse(value || "[]") : value; } catch (_error) { envelope = null; }
  if (Array.isArray(envelope)) return { schemaVersion: 1, draftKind: "formal", items: envelope, contentReview: null };
  if (!envelope || typeof envelope !== "object" || !Array.isArray(envelope.items)) {
    return { schemaVersion: 1, draftKind: "formal", items: [], contentReview: null };
  }
  return envelope;
}

export function suggestionFactIds(value) {
  const envelope = parseSuggestions(value);
  const ids = [];
  for (const item of envelope.items) {
    for (const factId of item?.factIds || []) {
      const key = String(factId || "").trim();
      if (key && !ids.includes(key)) ids.push(key);
    }
  }
  return ids.sort();
}

export async function suggestionsContentHash(items) {
  const material = (items || []).map((item) => ({
    id: item.id,
    problem: item.problem,
    opportunity: item.opportunity,
    factIds: [...(item.factIds || [])].sort(),
    priority: item.priority,
    priorityReason: item.priorityReason,
    pendingConditions: item.pendingConditions || [],
  }));
  const bytes = new TextEncoder().encode(JSON.stringify(material));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function suggestionText(value, label) {
  const text = String(value || "").trim();
  if (!text) throw httpError(`${label}不能为空`, 422, "suggestion_field_missing");
  return text;
}

export function normalizeSuggestions(raw, { requirePending = false } = {}) {
  const source = Array.isArray(raw) ? raw : [];
  if (!source.length) throw httpError("建议至少需要一条", 422, "suggestion_missing");
  if (source.length > MAX_SUGGESTIONS) throw httpError("建议最多 3 条", 422, "too_many_suggestions");
  const allowed = new Set(["problem", "opportunity", "factIds", "priority", "priorityReason", "pendingConditions"]);
  return source.map((entry, index) => {
    const item = entry && typeof entry === "object" ? entry : {};
    for (const key of Object.keys(item)) {
      if (!allowed.has(key)) throw httpError(`建议包含不允许的字段：${key}`, 422, "suggestion_field_not_allowed");
    }
    const problem = suggestionText(item.problem, `第 ${index + 1} 条建议的业务问题`);
    const opportunity = suggestionText(item.opportunity, `第 ${index + 1} 条建议的改造机会`);
    const priority = String(item.priority || "").trim().toLowerCase();
    if (!SUGGESTION_PRIORITIES.includes(priority)) throw httpError("优先级只能是 high / medium / low", 422, "invalid_priority");
    const priorityReason = suggestionText(item.priorityReason, `第 ${index + 1} 条建议的优先级理由`);
    const factIds = [...new Set((Array.isArray(item.factIds) ? item.factIds : [])
      .map((factId) => String(factId || "").trim()).filter(Boolean))];
    if (!factIds.length) throw httpError(`第 ${index + 1} 条建议至少需要一个事实引用`, 422, "missing_fact_refs");
    const pendingConditions = (Array.isArray(item.pendingConditions) ? item.pendingConditions : [])
      .map((condition) => String(condition || "").trim()).filter(Boolean);
    if (requirePending && !pendingConditions.length) {
      throw httpError(`第 ${index + 1} 条内部建议必须写明待确认条件`, 422, "missing_pending_conditions");
    }
    const scanned = [problem, opportunity, priorityReason, ...pendingConditions].join("\n");
    const violation = quantificationViolation(scanned);
    if (violation) {
      throw httpError(`建议不得包含未经证实的量化结论（${violation}）`, 422, "fabricated_quantification");
    }
    return { problem, opportunity, factIds, priority, priorityReason, pendingConditions };
  });
}

/**
 * Facts the formal path may cite: confirmed, group-complete, material-authorised and
 * verified, non-E5, high-impact second-confirmed. This mirrors the rules draft.js and
 * /_facts.js already enforce; keeping the query in one helper stops a new entry point
 * from drifting away from them.
 */
export async function formalEligibleFacts(db, projectId) {
  const result = await db.prepare(
    "SELECT cf.* FROM candidate_facts cf JOIN work_items wi ON wi.id=cf.work_item_id WHERE cf.project_id=? AND wi.judgment_status='confirmed' AND cf.status='confirmed' AND cf.material_status IN ('same','different_with_correction') AND (cf.impact_level!='high' OR cf.second_confirmation_status='confirmed') AND NOT EXISTS (SELECT 1 FROM candidate_facts dependent WHERE dependent.work_item_id=cf.work_item_id AND dependent.required=1 AND dependent.status!='confirmed') ORDER BY cf.work_item_id,cf.created_at"
  ).bind(projectId).all();
  const eligible = new Map();
  for (const fact of result.results || []) {
    if (String(fact.evidence_level || "").toUpperCase() === "E5") continue;
    let refs = [];
    try { refs = JSON.parse(fact.source_refs_json || "[]"); } catch (_error) { refs = []; }
    if (!refs.length) continue;
    let ok = true;
    for (const ref of refs) {
      const material = await db.prepare("SELECT 1 FROM evidence_materials WHERE id=? AND project_id=? AND authorization_status='authorized' AND integrity_status='verified'").bind(ref, projectId).first();
      if (!material) { ok = false; break; }
    }
    if (ok) eligible.set(fact.id, fact);
  }
  return eligible;
}

/** Facts the internal draft may cite: persisted candidates that are not formally eligible. */
export async function internalEligibleFacts(db, projectId, limit = INTERNAL_FACT_LIMIT, formal = null) {
  const eligible = formal || await formalEligibleFacts(db, projectId);
  const result = await db.prepare(
    "SELECT id,claim,correction,material_status,status,evidence_level,impact_level,second_confirmation_status,evidence_version,source_refs_json FROM candidate_facts WHERE project_id=? AND status IN ('open','insufficient_evidence','confirmed') ORDER BY created_at,id"
  ).bind(projectId).all();
  return (result.results || []).filter((fact) => !eligible.has(fact.id)).slice(0, limit);
}

export function suggestionEvidence(items, factMap) {
  return items.map((item) => ({
    ...item,
    evidence: item.factIds.map((factId) => {
      const fact = factMap.get(factId);
      return {
        factId,
        status: fact?.status || null,
        evidenceLevel: String(fact?.evidence_level || "").toUpperCase() || null,
        impactLevel: fact?.impact_level || null,
        evidenceVersion: Number(fact?.evidence_version || 1),
        text: effectiveFactText(fact),
        eligible: Boolean(fact?.eligible),
      };
    }),
  }));
}

/**
 * Current-fact comparison shared by verify, publish, owner read and owner decision.
 * A snapshot that no longer matches status/level/impact/effective-text/version is a
 * hard stop: the suggestion cannot be re-used without a new package and new review.
 */
export async function suggestionBasisDrift(db, projectId, envelope) {
  if (!envelope?.items?.length) return null;
  for (const item of envelope.items) {
    // Legacy packets without suggestions remain supported. Legacy suggestion drafts
    // without a complete basis must be regenerated rather than silently trusted.
    for (const factId of item.factIds || []) {
      const snapshot = (item.evidence || []).find((entry) => entry.factId === factId);
      if (!snapshot || !Number.isInteger(snapshot.evidenceVersion) || snapshot.evidenceVersion < 1 || !snapshot.text) return `事实 ${factId} 缺少可核对的建议依据版本`;
    }
    for (const entry of item.evidence || []) {
      const fact = await db.prepare("SELECT * FROM candidate_facts WHERE id=? AND project_id=?").bind(entry.factId, projectId).first();
      if (!fact) return `事实 ${entry.factId} 已不存在`;
      if (fact.status !== entry.status) return `事实 ${entry.factId} 的核验状态已变化`;
      if ((String(fact.evidence_level || "").toUpperCase() || null) !== (entry.evidenceLevel || null)) return `事实 ${entry.factId} 的证据等级已变化`;
      if ((fact.impact_level || null) !== (entry.impactLevel || null)) return `事实 ${entry.factId} 的影响等级已变化`;
      if (entry.evidenceVersion && Number(fact.evidence_version || 1) !== Number(entry.evidenceVersion)) return `事实 ${entry.factId} 的证据版本已变化`;
      if (entry.text && effectiveFactText(fact) !== entry.text) return `事实 ${entry.factId} 的有效文本已变化`;
      if (entry.eligible) {
        if (fact.status !== "confirmed" || !["same", "different_with_correction"].includes(fact.material_status)) return `事实 ${entry.factId} 不再合格`;
        if (fact.impact_level === "high" && fact.second_confirmation_status !== "confirmed") return `事实 ${entry.factId} 缺少二次确认`;
        if (String(fact.evidence_level || "").toUpperCase() === "E5") return `事实 ${entry.factId} 为 E5 假设`;
        let refs = [];
        try { refs = JSON.parse(fact.source_refs_json || "[]"); } catch (_error) { refs = []; }
        for (const ref of refs) {
          const material = await db.prepare("SELECT 1 FROM evidence_materials WHERE id=? AND project_id=? AND authorization_status='authorized' AND integrity_status='verified'").bind(ref, projectId).first();
          if (!material) return `事实 ${entry.factId} 的材料已不合格`;
        }
      }
    }
  }
  return null;
}

export async function requireSuggestionBasisCurrent(db, projectId, packet) {
  const drift = await suggestionBasisDrift(db, projectId, parseSuggestions(packet.suggestions_json));
  if (drift) throw httpError(`${drift}。建议依据已变化，必须重新生成、重新审核并重新核验。`, 409, "suggestion_basis_changed");
}

/**
 * The verifier may only see a fact's text and materials when the existing material
 * boundary allows it: visibility project/verifier, and the material's work item is
 * assigned to this verifier. Knowing a packetId is not a read grant.
 */
async function verifierFactSnapshot(db, projectId, accountId, factId) {
  const fact = await db.prepare("SELECT * FROM candidate_facts WHERE id=? AND project_id=?").bind(factId, projectId).first();
  if (!fact) return null;
  let refs = [];
  try { refs = JSON.parse(fact.source_refs_json || "[]"); } catch (_error) { refs = []; }
  // No material basis means there is no authorised evidence to read: a formal fact
  // always has at least one source ref, so a bare fact must stay behind the boundary.
  if (!refs.length) return null;
  const materials = [];
  for (const ref of refs) {
    const material = await db.prepare("SELECT id,project_id,version,visibility,work_item_id,authorization_status,integrity_status FROM evidence_materials WHERE id=? AND project_id=?").bind(ref, projectId).first();
    if (!material || !["project", "verifier"].includes(material.visibility)) return null;
    const workItemId = material.work_item_id || fact.work_item_id;
    let task = null;
    if (workItemId) {
      task = await db.prepare("SELECT id,project_id,assigned_verifier_id,assignment_version FROM work_items WHERE id=? AND project_id=?").bind(workItemId, projectId).first();
      if (task?.assigned_verifier_id !== accountId) return null;
    }
    materials.push({ ...material, task });
  }
  return { ...fact, materials };
}

export async function verifierCanReadFact(db, projectId, accountId, factId) {
  return Boolean(await verifierFactSnapshot(db, projectId, accountId, factId));
}

/** Bind a write to the same facts, materials and named assignments it checked. */
export async function verifierPacketGuard(db, projectId, accountId, refs) {
  const snapshots = [];
  for (const id of packetFactIds(refs)) {
    const snapshot = await verifierFactSnapshot(db, projectId, accountId, id);
    if (!snapshot) throw httpError("建议引用了未分配给你的任务或不可见材料，不能由你核验", 403, "verifier_not_assigned");
    snapshots.push(snapshot);
  }
  if (!snapshots.length) throw httpError("决策包事实引用无效", 409);
  const sql = `NOT EXISTS (
    SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS (
      SELECT 1 FROM candidate_facts cf
      WHERE cf.id=json_extract(expected.value,'$.id') AND cf.project_id=json_extract(expected.value,'$.project_id')
        AND cf.evidence_version=json_extract(expected.value,'$.evidence_version')
        AND cf.last_transition_key IS json_extract(expected.value,'$.last_transition_key')
        AND cf.status=json_extract(expected.value,'$.status') AND cf.material_status=json_extract(expected.value,'$.material_status')
        AND cf.claim=json_extract(expected.value,'$.claim') AND cf.correction IS json_extract(expected.value,'$.correction')
        AND cf.source_refs_json=json_extract(expected.value,'$.source_refs_json')
        AND cf.impact_level=json_extract(expected.value,'$.impact_level')
        AND cf.second_confirmation_status=json_extract(expected.value,'$.second_confirmation_status')
    ) OR EXISTS (
      SELECT 1 FROM json_each(expected.value,'$.materials') evidence WHERE NOT EXISTS (
        SELECT 1 FROM evidence_materials m WHERE m.id=json_extract(evidence.value,'$.id')
          AND m.project_id=json_extract(evidence.value,'$.project_id') AND m.version=json_extract(evidence.value,'$.version')
          AND m.visibility=json_extract(evidence.value,'$.visibility') AND m.work_item_id IS json_extract(evidence.value,'$.work_item_id')
          AND m.authorization_status=json_extract(evidence.value,'$.authorization_status')
          AND m.integrity_status=json_extract(evidence.value,'$.integrity_status')
      ) OR (json_type(evidence.value,'$.task')!='null' AND NOT EXISTS (
        SELECT 1 FROM work_items wi WHERE wi.id=json_extract(evidence.value,'$.task.id')
          AND wi.project_id=json_extract(evidence.value,'$.task.project_id')
          AND wi.assigned_verifier_id=json_extract(evidence.value,'$.task.assigned_verifier_id')
          AND wi.assignment_version=json_extract(evidence.value,'$.task.assignment_version')
      ))
    )
  ) AND EXISTS (SELECT 1 FROM project_memberships pm JOIN accounts a ON a.id=pm.account_id
    WHERE pm.project_id=? AND pm.account_id=? AND pm.role='verifier' AND pm.status='active' AND a.status='active')`;
  return { sql, values: [JSON.stringify(snapshots), projectId, accountId] };
}

export async function requireSuggestionFacts(db, projectId, suggestions) {
  const ids = suggestionFactIds(suggestions);
  if (!ids.length) throw httpError("建议事实引用无效", 409);
  return requireEligiblePacketFacts(db, projectId, ids.map((factId) => ({ factId })));
}

export async function requireEligiblePacketFacts(db, projectId, refs) {
  const ids = packetFactIds(refs);
  if (!ids.length || ids.length !== refs.length) throw httpError("决策包事实引用无效", 409);
  const placeholders = ids.map(() => "?").join(",");
  const result = await db.prepare(`SELECT * FROM candidate_facts WHERE project_id=? AND id IN (${placeholders})`).bind(projectId, ...ids).all();
  const facts = result.results || [];
  if (facts.length !== ids.length) throw httpError("决策包中的事实不存在或已跨项目", 409);
  for (const fact of facts) {
    if (fact.status !== "confirmed" || !["same", "different_with_correction"].includes(fact.material_status)) throw httpError("决策包中的事实已不再是合格确认状态", 409);
    if (fact.impact_level === "high" && fact.second_confirmation_status !== "confirmed") throw httpError("高影响事实尚未完成二次确认", 409);
    // V0.1-01: an E5 grade is a model inference or an analyst hypothesis. It may be
    // recorded and may steer further verification, but it must never stand as a
    // confirmed fact inside a formal conclusion. A confirmed E5 fact blocks the
    // packet; the resolution is to obtain corroborating evidence (raising the grade)
    // or to withdraw the fact — not to publish it with an "unverified" label.
    if (String(fact.evidence_level || "").toUpperCase() === "E5") {
      throw httpError("E5 为 AI 假设（AI假设，待验证），不得作为已核实事实进入正式结论；请补充佐证材料重新定级，或撤回该事实", 409, "e5_cannot_be_confirmed_conclusion");
    }
    let sourceRefs = [];
    try { sourceRefs = JSON.parse(fact.source_refs_json || "[]"); } catch (_error) { sourceRefs = []; }
    if (!sourceRefs.length) throw httpError("决策包事实缺少材料引用", 409);
    for (const sourceRef of sourceRefs) {
      const material = await db.prepare("SELECT 1 FROM evidence_materials WHERE id=? AND project_id=? AND authorization_status='authorized' AND integrity_status='verified'").bind(sourceRef, projectId).first();
      if (!material) throw httpError("决策包事实的材料已不再合格", 409);
    }
  }
  return facts;
}
