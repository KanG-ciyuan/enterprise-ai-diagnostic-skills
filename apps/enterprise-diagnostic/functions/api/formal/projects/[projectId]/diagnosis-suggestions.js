import { cors, findIdempotent, formalActor, httpError, idempotencyKey, json, requireAuthorizedProject, requireMembership, storeIdempotent } from "../../../../_shared.js";
import { callStructuredModel, ModelError } from "../../../agent/_model.js";
import { effectiveFactText, factsBasisDigest, formalEligibleFacts, internalEligibleFacts, INTERNAL_FACT_LIMIT, normalizeSuggestions, suggestionEvidence } from "../../decision-packets/_facts.js";

const BUCKET_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS_PER_BUCKET = 3;

function factLine(fact) {
  return `- ${fact.id} | ${effectiveFactText(fact)} | ${fact.status} | ${String(fact.evidence_level || "未定级")} | ${fact.impact_level || "normal"}`;
}

function buildPrompt(scope, facts) {
  const system = [
    "你是企业 AI 诊断助手。只能依据用户提供的事实清单生成诊断建议，不得引入清单之外的信息。",
    "输出最多 3 条建议，不要求凑满。每条必须包含 problem（业务问题）、opportunity（AI 改造机会）、factIds（事实 ID 数组）、",
    "priority（high / medium / low）、priorityReason（优先级理由）、pendingConditions（待确认条件数组）。",
    "优先级只依据业务影响、重复性、实施前提做定性判断。",
    "严禁出现收益率、节省金额、实施周期、百分比或货币金额等未经证实的量化结论。",
    "只输出 JSON：{\"suggestions\":[...]}，不要输出任何解释文字。",
    scope === "internal"
      ? "本次初稿基于未核实事实，每条建议必须写明待确认条件，且不得表述为已确认结论。"
      : "本次初稿只能引用清单中已确认且合格的事实。",
  ].join("");
  const user = [
    `范围：${scope === "internal" ? "内部待核实初稿" : "正式诊断初稿"}`,
    "事实清单（ID | 业务事实 | 核验状态 | 证据等级 | 影响等级）：",
    ...facts.map(factLine),
  ].join("\n");
  return { system, user };
}

export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    await requireMembership(env.DB, params.projectId, current, ["external_builder"]);
    await requireAuthorizedProject(env.DB, params.projectId);
    const requestKey = idempotencyKey(request).trim();
    if (!requestKey) return httpError("生成诊断建议需要 Idempotency-Key", 422);
    const body = await request.json().catch(() => ({}));
    const scope = body.scope === "internal" ? "internal" : "formal";

    const formal = await formalEligibleFacts(env.DB, params.projectId);
    let facts;
    if (scope === "internal") {
      facts = await internalEligibleFacts(env.DB, params.projectId, INTERNAL_FACT_LIMIT, formal);
    } else {
      facts = [...formal.values()];
    }
    if (!facts.length) {
      return httpError(scope === "internal" ? "当前没有可用于内部初稿的未核实候选事实" : "当前没有合格已确认事实", 409, "no_eligible_facts");
    }
    const digest = await factsBasisDigest(facts);
    const replay = await findIdempotent(env.DB, current, params.projectId, "diagnosis-suggestions", requestKey);
    if (replay) {
      if (replay.generation?.basisDigest !== digest) {
        return json({ code: "preview_basis_changed", detail: "事实已在你生成预览后变化，旧预览不能保存；请重新生成。" }, 409);
      }
      return json(replay);
    }
    const factMap = new Map(facts.map((fact) => [fact.id, { ...fact, eligible: scope === "formal" }]));
    const bucket = Math.floor(Date.now() / BUCKET_MS);
    const prefix = `DGN-${params.projectId}-${digest.slice(0, 12)}-${bucket}`;

    // Cost/duplicate gate: one claim row per attempt, unique by event_id. A concurrent
    // second caller loses the insert; a failed call leaves a failure marker so the next
    // attempt is allowed, but only up to three per ten-minute bucket.
    const existing = new Set(((await env.DB.prepare("SELECT event_id FROM events WHERE event_id LIKE ? ESCAPE '\\'").bind(`${prefix.replace(/[\\%_]/g, "\\$&")}-%`).all()).results || []).map((row) => row.event_id));
    const claims = [...existing].filter((id) => id.includes("-C-")).map((id) => Number(id.split("-C-")[1])).filter(Number.isFinite);
    const recentClaims = new Set(((await env.DB.prepare("SELECT event_id FROM events WHERE event_id LIKE ? ESCAPE '\\' AND created_at >= datetime('now','-60 seconds')").bind(`${prefix.replace(/[\\%_]/g, "\\$&")}-C-%`).all()).results || []).map((row) => row.event_id));
    const inFlight = claims.some((n) => recentClaims.has(`${prefix}-C-${n}`)
      && !existing.has(`${prefix}-S-${n}`) && !existing.has(`${prefix}-F-${n}`));
    if (inFlight) return json({ code: "generation_in_progress", detail: "同一批事实的生成请求正在处理中，请稍后重试" }, 409);
    if (claims.length >= MAX_ATTEMPTS_PER_BUCKET) {
      return json({ code: "generation_limit_reached", detail: "短时间内生成次数已达上限，请稍后再试", retryAfterSeconds: Math.ceil((BUCKET_MS - (Date.now() % BUCKET_MS)) / 1000) }, 429);
    }
    const attempt = claims.length + 1;
    const claimId = `${prefix}-C-${attempt}`;
    const claim = await env.DB.prepare("INSERT INTO events(event_id,project_id,type,actor_role,actor_id,payload) SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM events WHERE event_id=?)")
      .bind(claimId, params.projectId, "diagnosis_suggestion_generation", current.role, current.accountId, JSON.stringify({ scope, attempt }), claimId).run();
    if (!Number(claim.meta?.changes || 0)) return json({ code: "generation_in_progress", detail: "同一批事实的生成请求正在处理中，请稍后重试" }, 409);

    const { system, user } = buildPrompt(scope, facts);
    let output;
    try {
      output = await callStructuredModel({ env, system, user });
    } catch (error) {
      await env.DB.prepare("INSERT OR IGNORE INTO events(event_id,project_id,type,actor_role,actor_id,payload) VALUES (?,?,?,?,?,?)")
        .bind(`${prefix}-F-${attempt}`, params.projectId, "diagnosis_suggestion_generation_failed", current.role, current.accountId, JSON.stringify({ scope, attempt, code: error instanceof ModelError ? error.code : "model_error" })).run();
      if (error instanceof ModelError) return httpError(error.message, error.status, error.code);
      throw error;
    }

    let items;
    try {
      const normalized = normalizeSuggestions(output?.suggestions, { requirePending: scope === "internal" });
      const allowed = new Set(facts.map((fact) => fact.id));
      for (const item of normalized) {
        for (const factId of item.factIds) {
          if (!allowed.has(factId)) throw httpError("建议引用了不允许的事实 ID，整稿拒绝", 422, "unknown_fact_refs");
        }
      }
      items = suggestionEvidence(normalized, factMap).map((item) => ({
        ...item,
        id: `SUG-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`,
        unverified: scope === "internal" || item.evidence.some((entry) => !entry.eligible),
      }));
    } catch (error) {
      await env.DB.prepare("INSERT OR IGNORE INTO events(event_id,project_id,type,actor_role,actor_id,payload) VALUES (?,?,?,?,?,?)")
        .bind(`${prefix}-F-${attempt}`, params.projectId, "diagnosis_suggestion_generation_failed", current.role, current.accountId, JSON.stringify({ scope, attempt, code: "model_output_rejected" })).run();
      throw error;
    }
    const response = {
      scope,
      suggestions: items,
      generation: { attempt, bucket, factsDigest: digest.slice(0, 12), basisDigest: digest, generatedAt: new Date().toISOString() },
    };
    await env.DB.prepare("INSERT OR IGNORE INTO events(event_id,project_id,type,actor_role,actor_id,payload) VALUES (?,?,?,?,?,?)")
      .bind(`${prefix}-S-${attempt}`, params.projectId, "diagnosis_suggestion_generated", current.role, current.accountId, JSON.stringify({ scope, attempt, count: items.length })).run();
    await storeIdempotent(env.DB, current, params.projectId, "diagnosis-suggestions", requestKey, response);
    return json(response);
  } catch (error) {
    return error instanceof Response ? error : httpError(error.message, 500);
  }
}
