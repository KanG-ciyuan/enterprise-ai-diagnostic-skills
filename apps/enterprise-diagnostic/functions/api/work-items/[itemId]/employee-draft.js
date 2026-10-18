import { DRAFT_SCHEMA_VERSION, appendEvent, casWriteEmployeeDraft, cors, draftRevisionOf, formalActor, httpError, itemPayload, json, normalizeEmployeeDraft, requireAuthorizedProject, requireItem, requireMembership, serializeEmployeeDraft } from "../../../_shared.js";
import { canonicalDimension, canonicalVerdict, VERDICT_CORRECTED } from "../../agent/_adapter.js";
import { applyAnswerEvidence, applyEvidenceMutation } from "../../agent/_evidence.js";

// FIX-06A：人工裁决历史容量上限（append-only；达上限拒绝写入，不静默删除旧记录）。
const MAX_VERDICT_HISTORY = 10;

/**
 * PUT /api/work-items/{itemId}/employee-draft
 *
 * 员工访谈的会话状态持久化（PILOT-04 D8）。
 *
 * 存什么：answers（逐题回答）+ ledger（追问计数/未解决项/证据）+ inferenceVerdicts（推断判定）。
 * 为什么不是只存 answers：适配器是无状态的，追问计数必须跨轮保留，否则同一问题会被
 * 无限追问；刷新后若只恢复 answers，ledger 归零会让访谈从头追问。
 *
 * 格式：写入一律用嵌套 v2（见 _shared.js normalizeEmployeeDraft），
 * 读取侧对旧版扁平数据保持兼容，不做数据迁移。
 */
export async function onRequestPut({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    if (current.role !== "employee") return httpError("只有受邀员工可以保存本人草稿", 403);
    const item = await requireItem(env.DB, params.itemId);
    if (!item.project_id.startsWith("PRJ-")) return httpError("正式员工草稿需要正式项目会话", 401);
    await requireMembership(env.DB, item.project_id, current, ["employee"]);
    await requireAuthorizedProject(env.DB, item.project_id);
    if (item.assignee_account_id !== current.accountId) return httpError("不能访问其他员工的摸排任务", 403);
    if (item.stage !== "mapping" || item.status === "complete") return httpError("当前任务不能继续保存草稿", 409);

    const body = await request.json().catch(() => ({}));
    let rawExisting = {};
    try { rawExisting = item.employee_draft_json ? JSON.parse(item.employee_draft_json) : {}; } catch (_error) { rawExisting = {}; }
    const existing = normalizeEmployeeDraft(rawExisting);

    // 只接受字符串型答案；空值视为"清除该题"，不写入。
    // 结构型键（例如误把 ledger 放进 answers）一律丢弃 —— 这是 N3 的正面防线。
    const incomingAnswers = body.answers && typeof body.answers === "object" && !Array.isArray(body.answers) ? body.answers : {};
    const answers = { ...existing.answers };
    for (const [key, value] of Object.entries(incomingAnswers)) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (!trimmed) { delete answers[key]; continue; }
      answers[key] = trimmed;
    }

    // ledger：客户端是无状态适配器的唯一上下文携带者，必须原样保存（白名单校验形状）。
    // PILOT-07C/R6：ledger 缺省时必须**保留**既有 ledger。
    // api-client 在调用方未提供 ledger 时会发送 `ledger: null`（该文件不在本轮
    // 授权清单内，故不改它）。若这里把 null 当作"清空"，服务端写入的
    // pendingQuestion 锚点与 unresolved / vagueTerms 会被一并抹掉 —— 既破坏
    // 问题身份绑定，也违反"未解决问题不得静默删除"。因此 null/undefined 一律
    // 视为"本次不更新 ledger"，沿用库中既有值（仍经同一套白名单清洗）。
    const incomingLedger = body.ledger === undefined || body.ledger === null ? existing.ledger : body.ledger;
    const ledger = sanitizeLedger(incomingLedger);
    // PILOT-08A：sanitizeLedger 对"完全无 ledger"会返回 null。但 S1/S3 需要在
    // ledger 上挂载**服务端专属字段**（pendingQuestion / authoritativeUnresolved），
    // 因此这里统一归一为一个对象；否则 `ledger.xxx =` 会抛 TypeError（500）。
    const ledgerState = ledger || { statements: {}, covered: [], vagueTerms: [], unresolved: [], evidence: [] };

    // ── PILOT-08A/S3：服务端权威 unresolved 不可被客户端删除或改写 ───────
    // PILOT-08 已复现：客户端提交 ledger={} / unresolved=[] / 伪造另一维度，
    // 即可把服务端记录的未解决问题静默清空。
    //
    // 做法：把"服务端权威条目"存进客户端不可写的字段 authoritativeUnresolved，
    // 客户端提交的 unresolved 只被当作**补充待核实输入**；
    // 最终对模型/响应可见的 unresolved = 服务端权威条目 ∪ 客户端补充（去重）。
    // 客户端无法删除服务端条目，也无法通过写 source="server" 冒充权威
    // —— source 由本函数按来源重新打标，客户端自报值不被采用。
    ledgerState.authoritativeUnresolved = existing.ledger && Array.isArray(existing.ledger.authoritativeUnresolved)
      ? existing.ledger.authoritativeUnresolved
      : (existing.ledger && Array.isArray(existing.ledger.unresolved) ? existing.ledger.unresolved : []);
    const clientSupplements = Array.isArray(ledgerState.unresolved) ? ledgerState.unresolved : [];
    const serverDims = new Set(ledgerState.authoritativeUnresolved.map((u) => u && u.dimension).filter(Boolean));
    ledgerState.unresolved = [
      ...ledgerState.authoritativeUnresolved.map((u) => ({ ...u, source: "server" })),
      ...clientSupplements
        .filter((u) => u && u.dimension && !serverDims.has(u.dimension))
        .map((u) => ({ ...u, source: "client" })),   // 强制重打标：客户端不能冒充 server
    ].slice(0, MAX_LEDGER_ENTRIES);

    // ── PILOT-08A/S1：权威锚点只由服务端写入 ────────────────────────────
    // PILOT-08 已复现：本接口此前接受客户端提交的 ledger.pendingQuestion，
    // 于是普通员工可以先把它改成 burden，再在 employee-turn 报 questionKey=burden，
    // 使回答被归入错误维度（真实被问的 steps 保持 absent）。
    //
    // 现在改为：**客户端提交的 pendingQuestion 一律忽略**，本接口只把库中已有
    // 锚点原样带过（不创建、不修改、不删除）。锚点的创建/推进由 employee-turn
    // 的服务端专属写路径负责（见 employee-turn.js 的 writePendingQuestion）。
    ledgerState.pendingQuestion = existing.ledger ? existing.ledger.pendingQuestion || null : null;

    // ── PILOT-08E/D1：服务端权威推断基线 ────────────────────────────────
    // 与 pendingQuestion 完全同构：**客户端提交的同名字段一律不可信**，
    // 本接口只把库中已有基线原样带过（不创建、不修改、不删除）。
    //
    // 因此客户端既不能新增、也不能替换、更不能删除服务端推断：
    //   · 提交伪造列表 → 被丢弃；
    //   · 提交空列表   → 库中基线保留（无法"删空"来绕过判定要求）；
    //   · 提交同 ID 的改写文本 → 不生效。
    // 基线的唯一写入方是 employee-turn（服务端在签发锚点的同一次 CAS 中落库）。
    // PILOT-08E/D2：burden 是否已被询问 —— 同样是服务端专属状态，客户端不可写。
    ledgerState.burdenAsked = existing.ledger ? existing.ledger.burdenAsked === true : false;

    // ── PILOT-09C/IMPLEMENT-05B（F03）：统一服务端证据写入 ─────────────────
    // 答案变化必须与以下动作发生在**同一次 CAS 写入**：
    //   ① 服务端追加 statementHistory（append-only；空串删除 = withdrawn）；
    //   ② 更新 answersDigest / 每维 digest / evidenceSeq（SHA-256）；
    //   ③ 使依赖该维度的推断推进 evidenceVersion（模板引用文本由服务端确定性重建）；
    //   ④ 保留旧裁决历史（不自动升级、不静默删除）。
    // 客户端提交的 ledger.statements / statementHistory 一律不采信（A7 攻击面）。
    const evidenceResult = await applyAnswerEvidence({
      existing,
      answers,
      authoritativeInferences: existing.ledger && Array.isArray(existing.ledger.authoritativeInferences)
        ? existing.ledger.authoritativeInferences
        : [],
    });
    if (!evidenceResult.ok) {
      const current = await requireItem(env.DB, params.itemId);
      return json({
        code: evidenceResult.code || "evidence_mutation_rejected",
        detail: evidenceResult.code === "statement_history_overflow"
          ? `员工陈述历史已达上限（${evidenceResult.limit || 200} 条），本次证据变更被拒绝，未写入任何内容。请联系项目管理员。`
          : evidenceResult.code === "evidence_history_overflow"
            ? `推断证据历史已达上限（${evidenceResult.limit || 20} 条），本次证据变更被拒绝，未写入任何内容；已有历史不会被删除。`
            : "本次证据变更被服务端拒绝，未写入任何内容。",
        ...(evidenceResult.limit ? { limit: evidenceResult.limit } : {}),
        ...(evidenceResult.current ? { current: evidenceResult.current } : {}),
        ...(Array.isArray(evidenceResult.inferenceIds) ? { inferenceIds: evidenceResult.inferenceIds } : {}),
        currentRevision: draftRevisionOf(JSON.parse(current.employee_draft_json || "{}")),
        task: itemPayload(current),
      }, 409);
    }
    ledgerState.statements = evidenceResult.statements;
    ledgerState.covered = evidenceResult.covered;
    ledgerState.statementHistory = evidenceResult.history;
    ledgerState.evidence = evidenceResult.evidence;
    ledgerState.authoritativeInferences = evidenceResult.authoritativeInferences;

    // ── PILOT-09C/IMPLEMENT-2：判定 = 服务端盖章 + 版本绑定 + 历史留存 ──────
    //
    // 三条硬规则：
    //   ① **只信任客户端的"判定动作"**（verdict / correction）。所有可信字段
    //      （contentVersion / templateVersion / evidenceHash）由服务端从**库中基线**计算并盖章；
    //      客户端提交的同名字段会被 sanitizeVerdicts 丢弃（见 T11）。
    //   ② **绝不静默删除**：既有判定（含基线中已不存在的"孤儿判定"）一律原样结转。
    //      旧实现按基线 ID 过滤并**删除**，会在容量裁剪时永久抹掉员工判定（09C-AUDIT E1）。
    //   ③ **可审计**：判定内容发生变化时，把旧值追加到 `history`（append-only），
    //      不做无条件覆盖。
    const baselineById = new Map();
    for (const entry of ledgerState.authoritativeInferences) {
      if (entry && entry.id) baselineById.set(entry.id, entry);
    }
    const rawVerdicts = sanitizeVerdicts(body.inferenceVerdicts !== undefined ? body.inferenceVerdicts : existing.inferenceVerdicts);
    const priorVerdicts = existing.inferenceVerdicts && typeof existing.inferenceVerdicts === "object" ? existing.inferenceVerdicts : {};
    // PILOT-09C/FIX-3B（S-1）：版本绑定校验。
    // 规则：客户端必须回显 **contentVersion / templateVersion / evidenceHash** 三项，
    // 且必须与库中条目**逐字段一致**才允许盖章；任一缺失或不一致 ⇒ **不盖章**（保留旧判定）。
    // ★ 不得用库中当前版本"补齐"客户端声明 —— 那会把旧请求重放变成有效判定。
    const versionMatchesEntry = (entry, echo) => {
      if (!entry) return false;
      const e = echo && typeof echo === "object" ? echo : {};
      if (!Number.isInteger(entry.contentVersion)) return false;          // 条目无版本 → 不可绑定
      if (e.contentVersion !== entry.contentVersion) return false;
      const norm = (v) => (v === undefined ? null : v);
      const entryTemplate = Number.isInteger(entry.templateVersion) ? entry.templateVersion : null;
      if (norm(e.templateVersion) !== entryTemplate) return false;
      const entryHash = entry.evidenceHash || null;
      if (norm(e.evidenceHash) !== entryHash) return false;
      // F03：判定必须绑定推断所引用的证据版本（答案变化后旧 verdict 失效，不得自动升级）。
      if (Number.isInteger(entry.evidenceVersion)) {
        if (!Number.isInteger(e.evidenceVersion) || e.evidenceVersion !== entry.evidenceVersion) return false;
      }
      return true;
    };
    const rejectedVerdicts = [];
    const describeVersion = (entry) => ({
      contentVersion: entry && Number.isInteger(entry.contentVersion) ? entry.contentVersion : null,
      templateVersion: entry && Number.isInteger(entry.templateVersion) ? entry.templateVersion : null,
      evidenceHash: entry ? entry.evidenceHash || null : null,
      evidenceVersion: entry && Number.isInteger(entry.evidenceVersion) ? entry.evidenceVersion : null,
    });
    // FIX-06A：判定历史 append-only；达到上限时记录 overflow（本次整请求拒绝，零写入）。
    const verdictHistoryOverflows = [];
    const stampVerdict = (id, incoming) => {
      const prior = priorVerdicts[id] && typeof priorVerdicts[id] === "object" ? priorVerdicts[id] : null;
      const entry = baselineById.get(id) || null;
      const verdict = canonicalVerdict(incoming && incoming.verdict);
      const correction = verdict === VERDICT_CORRECTED ? String((incoming && incoming.correction) || "").trim() : "";
      const history = Array.isArray(prior && prior.history)
        ? prior.history.filter((x) => x && typeof x === "object")
        : [];
      if (prior && prior.verdict && (prior.verdict !== verdict || String(prior.correction || "") !== correction)) {
        if (history.length >= MAX_VERDICT_HISTORY) {
          verdictHistoryOverflows.push({ id, current: history.length, limit: MAX_VERDICT_HISTORY });
        } else {
          history.push({
            verdict: prior.verdict,
            correction: String(prior.correction || ""),
            contentVersion: Number.isInteger(prior.contentVersion) ? prior.contentVersion : null,
            evidenceHash: prior.evidenceHash || null,
            supersededAt: new Date().toISOString(),
          });
        }
      }
      return {
        verdict,
        correction,
        // ★ 服务端盖章：客户端无法影响这三个字段
        contentVersion: entry && Number.isInteger(entry.contentVersion) ? entry.contentVersion : null,
        templateVersion: entry && Number.isInteger(entry.templateVersion) ? entry.templateVersion : null,
        evidenceHash: entry ? entry.evidenceHash || null : null,
        evidenceVersion: entry && Number.isInteger(entry.evidenceVersion) ? entry.evidenceVersion : null,
        history,
      };
    };
    const inferenceVerdicts = {};
    // ① 既有判定全部结转（含孤儿）—— 不删除、不改写
    for (const [id, value] of Object.entries(priorVerdicts)) {
      if (value && typeof value === "object") inferenceVerdicts[id] = value;
    }
    // ② 本轮客户端提交的判定：校验 ID 归属后盖章
    for (const [id, value] of Object.entries(rawVerdicts)) {
      if (!baselineById.size) {
        // 基线为空（旧草稿 / 尚未生成推断）：保持历史行为，不做裁剪、不加盖
        const legacyVerdict = canonicalVerdict(value && value.verdict);
        inferenceVerdicts[id] = {
          verdict: legacyVerdict,
          correction: legacyVerdict === VERDICT_CORRECTED ? String((value && value.correction) || "").trim() : "",
        };
        continue;
      }
      // 判定不得凭空指向不存在的推断（防伪造）；既有记录已在 ① 中保留
      if (!baselineById.has(id)) {
        rejectedVerdicts.push({ id, reason: "unknown_inference" });
        continue;
      }
      const entry = baselineById.get(id);
      const echo = value && value.echo ? value.echo : {};
      if (!versionMatchesEntry(entry, echo)) {
        // ★ 不盖章、不补版本；库中既有判定原样保留（旧版本 ⇒ 过期）
        const echoMissing = echo.contentVersion === undefined || echo.templateVersion === undefined || echo.evidenceHash === undefined;
        rejectedVerdicts.push({
          id,
          reason: echoMissing ? "version_echo_required" : "version_mismatch",
          expected: describeVersion(entry),
          received: { contentVersion: echo.contentVersion === undefined ? null : echo.contentVersion,
                      templateVersion: echo.templateVersion === undefined ? null : echo.templateVersion,
                      evidenceHash: echo.evidenceHash === undefined ? null : echo.evidenceHash,
                      evidenceVersion: echo.evidenceVersion === undefined ? null : echo.evidenceVersion },
        });
        continue;
      }
      inferenceVerdicts[id] = stampVerdict(id, value);
    }
    if (verdictHistoryOverflows.length) {
      return json({
        code: "verdict_history_overflow",
        detail: `人工裁决历史已达上限（${MAX_VERDICT_HISTORY} 条），本次判定变更被拒绝，未写入任何内容；已有历史不会被删除。`,
        limit: MAX_VERDICT_HISTORY,
        current: Math.max(...verdictHistoryOverflows.map((entry) => entry.current)),
        inferenceIds: verdictHistoryOverflows.map((entry) => entry.id),
        currentRevision: existing.revision,
        task: itemPayload(item),
      }, 409);
    }
    const materialStatus = ["provided", "none_available", "undecided"].includes(body.materialStatus)
      ? body.materialStatus
      : (item.material_status || "undecided");

    // ── PILOT-04B/A + PILOT-09C/FIX-CODEX-02B（F02）：原子比较并交换 ──────────
    // 客户端必须回传它上次见到的 revision（baseRevision）。
    // 版本判断放进 UPDATE 的 WHERE 子句 —— 数据库对同一行的写是串行的，
    // 因此并发/迟到请求不可能"先通过检查、后被覆盖"。
    //
    // ★ 修复：缺失或非法 baseRevision 一律 **fail-closed**，不得用 existing.revision
    //   （服务端刚读到的最新版本）自动补齐。旧实现会把旧页面迟到保存当成"最新 CAS"
    //   而覆盖较新答案（VERIFY-CODEX-01 F02）。缺失版本只能要求客户端刷新重取。
    const baseRevision = body.baseRevision;
    if (!Number.isInteger(baseRevision) || baseRevision < 0) {
      return json({
        code: "base_revision_required",
        detail: "保存草稿必须携带你所依据的 baseRevision（非负整数）；缺失或非法版本不会被自动补齐。请刷新页面获取当前版本后重试。",
        currentRevision: existing.revision,
      }, 428);
    }
    const nextRevision = baseRevision + 1;
    // ── PILOT-09C/FIX-CODEX-04A（R04-02）：把"仍可编辑"交给**原子写入条件** ────
    // 仅靠本函数开头的前置检查（stage/status/归属）存在天然窗口：请求通过检查后、
    // 真正写库前，正式提交可能已完成（stage→facts / status→awaiting_verification /
    // 归属→核验人），而草稿 revision 不变 ⇒ 旧实现的 id+revision CAS 仍会命中，
    // 把草稿/材料写回"已提交快照"之外并追加成功事件。
    // 因此这里显式声明写入者与可编辑要求，由共享 CAS 在同一条 UPDATE 内原子判定。
    const writeGuard = { assigneeAccountId: current.accountId, requireEditable: true };
    // F03：统一证据写入入口（employee-turn 也调用 applyEvidenceMutation，避免两套规则漂移）。
    const cas = await applyEvidenceMutation({
      db: env.DB,
      itemId: params.itemId,
      expectedRevision: baseRevision,
      writeGuard,
      materialStatus,
      answers,
      ledger: ledgerState,
      inferenceVerdicts,
      submissionText: existing.submissionText,
      revision: nextRevision,
    });
    if (!cas.ok) {
      // 明确冲突：不静默覆盖，交回当前版本供客户端刷新后重试。
      // reason 仅作分类（stale_revision / not_editable / assignee_mismatch / conflict），
      // 既有字段 code / currentRevision / expectedRevision / task 语义不变。
      const current = await requireItem(env.DB, params.itemId);
      return json({
        code: "draft_conflict",
        reason: cas.reason,
        detail: "访谈状态已在别处更新（或任务已提交/已结束），已放弃本次保存以免覆盖较新的回答。请刷新后继续。",
        currentRevision: cas.currentRevision,
        expectedRevision: baseRevision,
        task: itemPayload(current),
      }, 409);
    }
    const updated = await requireItem(env.DB, params.itemId);
    await appendEvent(env.DB, item.project_id, params.itemId, "employee_draft_saved", current, {
      reason: "employee saved draft",
      materialStatus,
      answeredCount: Object.keys(answers).length,
      hasLedger: Boolean(ledger),
      draftSchemaVersion: DRAFT_SCHEMA_VERSION,
      draftRevision: draftRevisionOf({ revision: nextRevision }),
      evidenceSeq: evidenceResult.evidence.seq,
      evidenceChangedDimensions: evidenceResult.changedDimensions,
      historyAppended: evidenceResult.historyAppended.length,
      invalidatedInferences: evidenceResult.invalidatedInferenceIds,
      reestablishedInferences: evidenceResult.reestablishedInferenceIds || [],
    });
    // PILOT-09C/FIX-3B：逐项反馈判定结果，禁止"静默部分成功"。
    return json({
      task: itemPayload(updated),
      verdictResult: {
        rejected: rejectedVerdicts,
        acceptedIds: Object.keys(inferenceVerdicts),
      },
      // F03：返回最新证据状态（revision 已由 task 返回；这里给出证据版本便于客户端判断）
      evidence: evidenceResult.evidence,
      evidenceChangedDimensions: evidenceResult.changedDimensions,
      historyAppended: evidenceResult.historyAppended.length,
      invalidatedInferences: evidenceResult.invalidatedInferenceIds,
      reestablishedInferences: evidenceResult.reestablishedInferenceIds || [],
    });
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}

// ledger 白名单：只保留适配器契约中定义的字段，其余丢弃。
function sanitizeLedger(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const asArray = (entry) => (Array.isArray(entry) ? entry.filter((x) => x && typeof x === "object") : []);
  const asMap = (entry) => (entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {});
  return {
    statements: asMap(value.statements),
    covered: Array.isArray(value.covered) ? value.covered.filter((x) => typeof x === "string") : [],
    // PILOT-07C/R4：客户端可控的会话辅助数据必须限长（见文件末尾常量与说明）。
    vagueTerms: asArray(value.vagueTerms).slice(0, MAX_LEDGER_ENTRIES).map(sanitizeVagueTerm).filter(Boolean),
    unresolved: asArray(value.unresolved).slice(0, MAX_LEDGER_ENTRIES).map(sanitizeUnresolvedEntry).filter(Boolean),
    evidence: asArray(value.evidence).slice(0, MAX_LEDGER_ENTRIES),
    // PILOT-08A/S1：此处**不再**接受客户端提供的 pendingQuestion。
    // 保留该键（恒为 null）是为了让输出形状稳定；真实锚点由 onRequestPut
    // 用"库中既有值"覆盖写入 —— 客户端不能创建、修改或删除权威锚点。
    pendingQuestion: null,
    // PILOT-08A/S3：同理，authoritativeUnresolved 也不从客户端取值
    // （恒为空数组）；真实内容由 onRequestPut 用"库中既有值"覆盖写入。
    authoritativeUnresolved: [],
    // PILOT-08E/D1：服务端权威推断基线 —— 同样不从客户端取值（恒为空）。
    // H-1：陈述历史恒为空（客户端不得提交/伪造）—— 真实值由 onRequestPut 用库中值覆盖
    statementHistory: [],
    authoritativeInferences: [],
    // PILOT-08E/D2：burden 是否已询问 —— 服务端专属（恒为 false）。
    burdenAsked: false,
  };
}

// 推断判定白名单：{ verdict, correction }。
function sanitizeVerdicts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object") continue;
    // PILOT-07C/R2：在服务端边界做规范化。
    // 前端「符合实际」= agree，「需要更正」= correct —— 两者都必须被保留。
    // 规范化后：confirmed / corrected；未知值一律 unjudged（不丢弃条目本身，
    // 以便界面能区分"未判定"与"判定值非法"）。
    const verdict = canonicalVerdict(entry.verdict);
    const correction = typeof entry.correction === "string" ? entry.correction.trim() : "";
    // 更正原文只在 corrected 语义下有意义；confirmed 不携带更正，避免语义混杂。
    //
    // PILOT-09C/FIX-3B（S-1）：保留客户端**回显的版本字段**。
    // ★ 它们是"待验证的声明"，不是可信版本 —— 是否盖章由服务端逐字段比对后决定（见 stampVerdict）。
    const echo = {
      contentVersion: Number.isInteger(entry.contentVersion) ? entry.contentVersion : (entry.contentVersion === undefined ? undefined : null),
      templateVersion: entry.templateVersion === undefined ? undefined : (Number.isInteger(entry.templateVersion) ? entry.templateVersion : null),
      evidenceHash: typeof entry.evidenceHash === "string" ? entry.evidenceHash : (entry.evidenceHash === undefined ? undefined : null),
      evidenceVersion: Number.isInteger(entry.evidenceVersion) ? entry.evidenceVersion : (entry.evidenceVersion === undefined ? undefined : null),
    };
    out[String(id)] = { verdict, correction: verdict === "corrected" ? correction : "", echo };
  }
  return out;
}

/**
 * PILOT-08A/S1：待答问题身份的**形状**校验（服务端内部使用）。
 *
 * 注意：本函数**不再**用于清洗客户端输入 —— employee-draft 已彻底忽略
 * 客户端提交的 pendingQuestion（见 onRequestPut 内）。它保留下来仅供
 * employee-turn 在写入/读取锚点时做形状约束。
 */
function sanitizePendingQuestion(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const key = canonicalDimension(String(value.key || ""));
  if (!key) return null;
  return {
    key,
    label: typeof value.label === "string" ? value.label.trim().slice(0, 80) : "",
    prompt: typeof value.prompt === "string" ? value.prompt.trim().slice(0, 500) : "",
    revision: Number.isInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    workItemId: typeof value.workItemId === "string" ? value.workItemId.slice(0, 64) : "",
  };
}

// ── PILOT-07C/R4：客户端可控会话数据的边界 ──────────────────────────
// PILOT-07B 已复现：客户端可提交 5000 条 × 200 字 unresolved，被原样回显
// 并写回库。这里做三件事：**条数上限 + 字段白名单 + 文本限长**。
//
// 重要区分（不改变信任边界语义）：
//   · 覆盖裁决（statements/covered/coverage）**始终**由服务端从员工原始答案
//     重建，客户端无法影响 —— 这部分已是权威。
//   · unresolved/vagueTerms 只是**辅助提示**，参与 prompt 与展示，不参与
//     missing/allRequiredHandled 裁决（PILOT-07B 已用实验证明）。
//     因此目标是把它们**限制在有限规模**，而不是升级为权威。
const MAX_LEDGER_ENTRIES = 50;
const MAX_LEDGER_TEXT = 300;

function boundedText(value, max = MAX_LEDGER_TEXT) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** vagueTerms 条目：只保留追问计数所需字段 */
function sanitizeVagueTerm(entry) {
  if (!entry || typeof entry !== "object") return null;
  const key = canonicalDimension(String(entry.key || ""));
  if (!key) return null;
  return {
    key,
    count: Number.isFinite(Number(entry.count)) ? Math.max(0, Math.min(99, Math.trunc(Number(entry.count)))) : 0,
    lastAnswer: boundedText(entry.lastAnswer),
  };
}

/**
 * unresolved 条目：只保留 key/dimension/reason/lastAnswer；
 * dimension 必须可归一到七维（防止伪造维度名污染展示）；
 * 服务端写入的条目带 source="server"，便于后续人机来源区分。
 */
function sanitizeUnresolvedEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const dimension = canonicalDimension(String(entry.dimension || entry.key || ""));
  if (!dimension) return null;
  return {
    key: canonicalDimension(String(entry.key || "")) || dimension,
    dimension,
    reason: boundedText(entry.reason, 120) || "描述仍不明确",
    lastAnswer: boundedText(entry.lastAnswer),
    source: entry.source === "server" ? "server" : "client",
  };
}
