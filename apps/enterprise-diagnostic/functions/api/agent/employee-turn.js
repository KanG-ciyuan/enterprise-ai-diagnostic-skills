import { casWriteEmployeeDraft, cors, draftRevisionOf, formalActor, httpError, json, normalizeEmployeeDraft, requireAuthorizedProject, requireItem, requireMembership, serializeEmployeeDraft } from "../../_shared.js";
import { MAX_EVIDENCE_HISTORY, MODEL_CALL_LEASE_MS, MODEL_CALL_SETTLED_TYPES, QUESTION_BANK, VERDICT_CORRECTED, allocateQuotaSlot, appendStatementHistory, MAX_STATEMENT_HISTORY, buildInferenceRecords, buildSupplementQuestion, readSupplementRounds, MAX_SUPPLEMENT_ROUNDS_PER_DIMENSION, MAX_SUPPLEMENT_ROUNDS_PER_TASK, buildTrustedLedger, canonicalDimension, canonicalVerdict, claimTurnGate, estimateUsage, extractUsage, markModelCallStarted, modelTurnIdentity, readModelCallStats, readTurnGate, releaseQuotaSlot, resolveCoverage, resolveModelCallLimit, runFixture, runHarness, settleModelCall, settleTurnGate, takeOverTurnGate, validateAgentOutput } from "./_adapter.js";
import { applyTurnEvidence } from "./_evidence.js";

/**
 * POST /api/agent/employee-turn
 *
 * Runs the controlled employee mapping-interview adapter directly in the Worker
 * (DeepSeek credentials come from the `DEEPSEEK_API_KEY` secret; no separate
 * Python service). The edge enforces the product permission model (formal session
 * + employee role + project/task ownership) before the adapter runs.
 *
 * The adapter never writes the master record, never unlocks a stage, and never
 * decides for the owner; it only returns the next question or a workflow-card
 * draft for the employee to confirm. Only the existing employee-submission route
 * advances the work item.
 */
export async function onRequestPost({ request, env, params }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    if (current.role !== "employee") return httpError("只有一线员工可以发起摸排问答", 403);

    const body = await request.json().catch(() => ({}));
    const projectId = String(body.projectId || "");
    const workItemId = String(body.workItemId || "");
    if (!projectId) return httpError("projectId 不能为空", 422);
    if (!projectId.startsWith("PRJ-")) return httpError("正式员工摸排需要正式项目会话", 401);

    // PILOT-04B/A：客户端每轮带回它上次见到的草稿修订号。
    const baseRevision = Number.isInteger(body.baseRevision) && body.baseRevision >= 0 ? body.baseRevision : null;
    if (workItemId) {
      const item = await requireItem(env.DB, workItemId);
      if (item.project_id !== projectId) return httpError("该任务不属于当前项目", 403);
      await requireMembership(env.DB, item.project_id, current, ["employee"]);
      await requireAuthorizedProject(env.DB, item.project_id);
      if (item.assignee_account_id !== current.accountId) return httpError("不能访问其他员工的摸排任务", 403);
      if (item.stage !== "mapping") return httpError("当前任务不在摸排阶段，不能继续问答", 409);
    } else {
      await requireMembership(env.DB, projectId, current, ["employee"]);
      await requireAuthorizedProject(env.DB, projectId);
    }

    // ── PILOT-09C/FIX-CODEX-04A（R04-02）：锚点/草稿写入的可编辑态守卫 ──────
    // 问题：本函数在模型调用前只做了一次 stage/status/归属前置检查；模型调用是长
    // 窗口，期间正式提交可能已完成（stage→facts / status→awaiting_verification /
    // 归属→核验人），而草稿 revision 不变 ⇒ 旧实现写入 pendingQuestion 的 CAS 仍会
    // 命中 id+revision，把旧 turn 的 ledger/draft 写进已提交快照之后。
    // 修复：把"仍可编辑 + 写入者归属"作为 CAS 的实际 WHERE 条件（见 writePendingQuestion）。
    // 未命中时：workItemId 非空（确实发生了持久化写入尝试）⇒ 明确 409 冲突、不写 draft；
    // workItemId 为空时 issueAnchor 本就立即返回 null（未尝试任何写入），这不是 CAS
    // 冲突，保持旧响应语义（200 / draftRevision:currentRevision / anchorPersisted:false）。
    const writeGuard = workItemId ? { assigneeAccountId: current.accountId, requireEditable: true } : null;
    const anchorWriteConflict = async () => {
      let latest = null;
      try { latest = await requireItem(env.DB, workItemId); } catch (_error) { latest = null; }
      let currentRevision = null;
      if (latest) {
        try {
          currentRevision = draftRevisionOf(normalizeEmployeeDraft(JSON.parse(latest.employee_draft_json || "{}")));
        } catch (_error) { currentRevision = null; }
      }
      return json({
        code: "draft_conflict",
        reason: "write_conflict",
        detail: "任务状态在本次问答期间已发生变化（例如已完成正式提交或草稿被并发推进），本次问答结果未写入草稿与问题锚点。请刷新页面获取最新任务状态后继续。",
        currentRevision,
      }, 409);
    };

    const materialRefs = Array.isArray(body.materialRefs) ? body.materialRefs : [];

    // ── PILOT-07/S2：权威项目背景由**服务端**按已鉴权 projectId 读取 ────────
    // 绝不使用客户端传来的 workName / projectScope：PILOT-04B 已实测客户端
    // 可把任意文本注入模型 prompt。这里用已通过 requireMembership 的 projectId
    // 查库，只取 name / scope 两个字段。
    const authorizedContext = await loadAuthorizedProjectContext(env.DB, projectId);

    // ── PILOT-07/S1：历史答案只认**服务端草稿**，不认客户端断言 ─────────────
    // 客户端可伪造 body.answers / body.ledger.statements / covered / coverage /
    // crossFilled。这里一律忽略，改从库中 employee_draft_json 重建历史。
    const storedDraft = await loadStoredDraft(env.DB, workItemId, projectId);

    // ── PILOT-04B/A + PILOT-07：真实草稿修订号（严格单调）────────────────
    // 旧实现用"覆盖维度数 + 追问次数 + 未解决数"当版本号：既不唯一
    // （不同草稿可同值），也不单调（unresolved 被解决会倒退），已复现。
    // 现用 employee_draft_json.revision；客户端 baseRevision 落后即拒绝。
    const currentRevision = storedDraft.revision;
    if (baseRevision !== null && baseRevision < currentRevision) {
      return json({
        code: "stale_turn",
        detail: "访谈状态已在别处更新，请刷新后继续。",
        currentRevision,
        expectedRevision: baseRevision,
      }, 409);
    }
    const questionKey = String(body.questionKey || "").trim();
    const answer = typeof body.answer === "string" ? body.answer.slice(0, MAX_ANSWER_CHARS) : "";

    // 问题 key 必须可归一到七维之一，否则拒绝 —— 防止客户端用伪造 key
    // 把任意内容直接塞进别的维度。
    // PILOT-08A/S2：recover 请求由服务端自行决定维度，**不消费** questionKey，
    // 因此不受"key 必须属于七维"的约束（该约束只适用于"提交回答"的轮次）。
    const recoverRequested = body.recover === true;
    let resolvedKey = "";
    if (questionKey) {
      resolvedKey = canonicalDimension(questionKey);
      if (!resolvedKey && !recoverRequested) return httpError("questionKey 不是合法的诊断维度", 422);
    }

    // ── PILOT-09C/FIX-CODEX-02A（F01）：服务端权威状态只来自**持久化快照** ──
    // 旧实现（PILOT-07C）把客户端 body.ledger 作为 carried 的优先来源。VERIFY-CODEX-01
    // 已实测：合法员工在有效补正锚点下提交 `ledger:{}`，下一轮 inherited 到的
    // authoritativeInferences / burdenAsked / statementHistory 全部为空，并被当作
    // 权威基线落库 ⇒ 既有推断与逐条判定义务被整体清空。
    //
    // 修复后的信任边界：
    //   · authoritativeInferences / burdenAsked / statementHistory / pendingQuestion /
    //     authoritativeUnresolved / supplementRounds 等**服务端权威状态**，
    //     一律只从库中草稿（storedDraft.ledger）读取；
    //   · body.ledger **不再参与任何状态继承**（客户端即使回传空对象、伪造字段或
    //     旧版本推断，也不影响本轮继承与落库）；
    //   · statements / covered / coverage / crossFilled 仍由 buildTrustedLedger
    //     按**服务端已保存的 answers** 重建，客户端无法影响。
    // 说明：正常前端的 ledger 只是服务端下发的复读，草稿保存接口会持续持久化这些
    // 状态，因此忽略请求体 ledger 不减少任何合法能力。
    const storedLedger = storedDraft.ledger && typeof storedDraft.ledger === "object" ? storedDraft.ledger : null;
    const carriedLedger = storedLedger;

    // ── PILOT-08A/S1+S2：回答必须绑定到**服务端签发**的问题锚点 ────────────
    // PILOT-08 复现了三条攻击路径（A/E/G），全部依赖"锚点可被客户端写入"。
    // 现在的规则：
    //   · 锚点只由服务端写入（employee-draft 已忽略客户端提交的锚点）；
    //   · 读锚点时校验签名（绑定 workItemId/key/prompt/revision）与任务归属；
    //   · **取消原来的"无锚点引导轮"** —— 无有效锚点一律不接受回答，
    //     改为要求客户端走服务端恢复路径（recover），由服务端决定当前该问什么。
    const rawAnchor = storedDraft.pendingQuestion;
    const anchor = readValidAnchor(rawAnchor, workItemId || null);

    if (recoverRequested) {
      // S2 恢复路径：服务端自行推导"当前该问什么"，并**重新签发**锚点。
      // 完全不读 body.questionKey / questionLabel / questionPrompt。
      const recoveryLedger = buildTrustedLedger(storedDraft.answers, materialRefs, carriedLedger);
      // PILOT-08E/D2：覆盖已满足时，`deriveRecoveryQuestion` 可能返回 null。
      // 但访谈完成还有**另一个**前置条件：burden（耗时与人力）必须被询问过。
      // 旧实现直接回 interview_complete，会导致"覆盖够了、burden 却没问过"的任务
      // 既出不了卡、又拿不到问题，形成死结。这里优先补问 burden。
      const recoveryQuestion = deriveRecoveryQuestion(recoveryLedger);
      if (!recoveryQuestion) {
        const burdenAlreadyAsked = storedDraft.ledger && storedDraft.ledger.burdenAsked === true;
        if (!burdenAlreadyAsked) {
          const burdenDef = QUESTION_BANK.find((q) => q.key === "burden");
          if (burdenDef) {
            const issuedRevision = await issueAnchor(env.DB, workItemId, currentRevision, { key: "burden", label: burdenDef.label, prompt: burdenDef.prompt }, { burdenAsked: true }, writeGuard);
            // R04-02：仅当**确实尝试写入**（workItemId 非空）且 CAS 未命中（任务已提交/
            // 已不可编辑/版本被推进）时才明确 409；workItemId 为空时未写任何东西，保持旧语义。
            if (issuedRevision === null && workItemId) return anchorWriteConflict();
            return json({
              code: "question_reissued",
              detail: "已由服务端重新签发当前问题。",
              turn: {
                turnKind: "question",
                executionMode: "server_recovery",
                nextQuestion: { key: "burden", label: burdenDef.label, prompt: burdenDef.prompt },
                coverage: resolveCoverage(recoveryLedger.statements, {}, recoveryLedger),
              },
              draftRevision: issuedRevision === null ? currentRevision : issuedRevision,
              anchorPersisted: issuedRevision !== null,
            });
          }
        }
        // ── PILOT-09C/IMPLEMENT-3G（F-1）：出卡后**补正通道** ──────────────
        // 仅当员工显式声明要补正某个**既有维度**时签发补正锚点；
        // 其余情况保持原语义（interview_complete）。
        const supplementRequest = body.supplement && typeof body.supplement === "object" ? body.supplement : null;
        if (supplementRequest && workItemId) {
          const dimension = String(supplementRequest.dimension || "");
          const intent = supplementRequest.intent === "correction" ? "correction" : "supplement";
          const supplementQuestion = buildSupplementQuestion(dimension, intent);
          if (!supplementQuestion) {
            return httpError("只能补正已有的七个工作维度之一。", 422, "supplement_dimension_invalid");
          }
          const rounds = readSupplementRounds(storedDraft.ledger);
          if ((rounds.byDimension[supplementQuestion.key] || 0) >= MAX_SUPPLEMENT_ROUNDS_PER_DIMENSION) {
            return httpError(`「${supplementQuestion.label}」的补充/纠正次数已达上限（${MAX_SUPPLEMENT_ROUNDS_PER_DIMENSION} 次），无法继续补正。请联系项目管理员。`, 409, "supplement_dimension_limit");
          }
          if (rounds.total >= MAX_SUPPLEMENT_ROUNDS_PER_TASK) {
            return httpError(`本任务的补充/纠正总次数已达上限（${MAX_SUPPLEMENT_ROUNDS_PER_TASK} 次），无法继续补正。请联系项目管理员。`, 409, "supplement_total_limit");
          }
          const carryLedger = {
            authoritativeInferences: storedDraft.ledger && Array.isArray(storedDraft.ledger.authoritativeInferences) ? storedDraft.ledger.authoritativeInferences : [],
            burdenAsked: storedDraft.ledger ? storedDraft.ledger.burdenAsked === true : false,
            statementHistory: storedDraft.ledger && Array.isArray(storedDraft.ledger.statementHistory) ? storedDraft.ledger.statementHistory : [],
            supplementRounds: rounds,
          };
          const supplementRevision = await issueAnchor(env.DB, workItemId, currentRevision, supplementQuestion, carryLedger, writeGuard);
          // R04-02：仅当确实尝试写入（workItemId 非空，本分支条件已保证）且 CAS 未命中
          // ⇒ 明确 409，不写 draft；成功路径响应形状保持不变。
          if (supplementRevision === null && workItemId) return anchorWriteConflict();
          return json({
            turn: {
              turnKind: "question",
              nextQuestion: supplementQuestion,
              question: supplementQuestion,
              supplement: { dimension: supplementQuestion.key, intent, round: (rounds.byDimension[supplementQuestion.key] || 0) + 1 },
            },
            draftRevision: supplementRevision === null ? currentRevision : supplementRevision,
            anchorPersisted: supplementRevision !== null,
          }, 200);
        }
        return json({
          code: "interview_complete",
          detail: "访谈所需信息已覆盖，请刷新页面查看流程卡。",
        }, 409);
      }
      const issuedRevision = await issueAnchor(env.DB, workItemId, currentRevision, recoveryQuestion, null, writeGuard);
      // R04-02：恢复签发同样必须原子绑定可编辑态；仅当确实尝试写入（workItemId 非空）
      // 且未命中时 ⇒ 明确 409；无任务轮次（workItemId 为空）保持旧 200 语义。
      if (issuedRevision === null && workItemId) return anchorWriteConflict();
      return json({
        code: "question_reissued",
        detail: "已由服务端重新签发当前问题。",
        turn: { turnKind: "question", executionMode: "server_recovery", nextQuestion: recoveryQuestion, coverage: resolveCoverage(recoveryLedger.statements, {}, recoveryLedger) },
        draftRevision: issuedRevision === null ? currentRevision : issuedRevision,
        anchorPersisted: issuedRevision !== null,
      });
    }

    if (!anchor) {
      // 无有效锚点 → 不接受回答（这是 E 攻击路径的封堵点）
      return json({
        code: "question_anchor_missing",
        detail: "当前没有服务端签发的问题身份，无法确认这条回答对应哪一问。请重新获取问题后作答。",
        recoverable: true,
      }, 409);
    }

    if (!resolvedKey) {
      return httpError("questionKey 不能为空", 422);
    }
    if (anchor.key !== resolvedKey) {
      // A/G 攻击路径的封堵点：回答的维度与服务端签发的维度不一致
      return json({
        code: "question_identity_mismatch",
        detail: "这条回答对应的不是服务端签发的提问，已拒绝以免把回答归入错误的维度。请重新获取问题后作答。",
        expectedKey: anchor.key,
      }, 409);
    }
    // 权威提问文本取自服务端锚点；客户端自报的 label/prompt 一律不采信。
    const authoritativeQuestion = { key: anchor.key, label: anchor.label, prompt: anchor.prompt };
    // 注：carriedLedger 已在上方定义（锚点校验之前），供恢复路径复用。

    // 本轮回答作为**未持久化增量**并入分析集：仅在 key 合法时合并，
    // 且不覆盖已落库的同维度答案（除非本轮正是对该维度的更正）。
    // ── PILOT-07/S5-E：员工已否认的推断必须回流给模型 ─────────────────
    // 否则模型下一轮可能再次把被否定的推断当作前提。
    // 只有被判为"需要更正"（corrected）的推断才算被否认；confirmed 绝不进入。
    const rejectedInferences = Object.entries(storedDraft.inferenceVerdicts || {})
      .filter(([, entry]) => entry && canonicalVerdict(entry.verdict) === VERDICT_CORRECTED)
      .slice(0, 8)
      .map(([id, entry]) => ({ id, verdict: VERDICT_CORRECTED, correction: String(entry.correction || "").slice(0, 300) }));

    const trustedAnswers = { ...storedDraft.answers };
    if (resolvedKey && answer.trim()) trustedAnswers[resolvedKey] = answer.trim();

    const frame = {
      projectId,
      workItemId: workItemId || null,
      role: "employee",
      runId: `${projectId}-${current.accountId}`,
      questionKey: resolvedKey || questionKey,
      // R1：提问文本以服务端 pendingQuestion 为准；客户端自报值仅在引导轮兜底。
      questionLabel: authoritativeQuestion?.label
        || (typeof body.questionLabel === "string" ? body.questionLabel.slice(0, 80) : ""),
      questionPrompt: authoritativeQuestion?.prompt
        || (typeof body.questionPrompt === "string" ? body.questionPrompt.slice(0, 500) : ""),
      answer,
      // 已保存历史 + 本轮增量（均经服务端重建，非客户端断言）
      answers: trustedAnswers,
      persistedAnswers: storedDraft.answers,
      currentTurnKey: resolvedKey || null,
      draftRevision: currentRevision,
      rejectedInferences,
      authorizedContext,
      materialRefs,
      materialStatus: ["provided", "none_available", "undecided"].includes(body.materialStatus) ? body.materialStatus : "undecided",
    };

    // ── PILOT-09C/FIX-CODEX-02A（F01）：正式任务执行模式由**服务端**决定 ──
    // 旧实现直接采信 body.mode：合法员工可指定 fixture，从而进入"确定性展示列表、
    // 但不写回权威记录集"的路径（配合客户端 ledger 即可清空基线）。
    // 现在的服务端策略（客户端 mode 不再是模式开关，只是受限的测试档请求）：
    //   · 服务端配置了模型凭据 → 正式语义固定为 harness；
    //   · 服务端未配置模型凭据 → 只有确定性 fixture 降级可用（本地离线可运行）；
    //   · 显式请求 harness 但服务端无凭据 → 503（保留"无密钥不得进模型"语义）；
    //   · 仅当服务端显式声明 FORMAL_AGENT_TEST_MODE=1（本地/CI 受控测试环境）时，
    //     才允许把该轮切到 fixture 测试档。该变量不进生产 [vars]，客户端无法开启，
    //     因此客户端传入 mode:"fixture" 在正式环境不会改变执行语义。
    const requestedMode = ["auto", "fixture", "harness"].includes(body.mode) ? body.mode : "auto";
    const hasKey = Boolean(env.DEEPSEEK_API_KEY);
    const fixtureTestMode = env.FORMAL_AGENT_TEST_MODE === "1";
    if (requestedMode === "harness" && !hasKey) return httpError("harness 模式需要 DEEPSEEK_API_KEY。", 503);
    const useHarness = hasKey && !(fixtureTestMode && requestedMode === "fixture");
    let result;
    // PILOT-09A-FIX/F1–F4：本轮计量与抢占句柄（仅 harness 用到）
    let claim = null;
    let stats = await readModelCallStats(env.DB, workItemId);
    if (useHarness) {
      // ── R1：额度槽位 + 轮次门（两处原子写入，顺序经过故障分析）────────────
      // 顺序选择：**先槽位，后门**。理由：若反过来，「门成功但槽位失败」会让该轮
      // 永久卡住（门占着、额度没有），即 §二 要求消除的 A/B 故障。先槽位则：
      //   · 额度耗尽 → 直接 429，**不创建门** ⇒ 该轮仍可重试（上调额度后即可继续）；
      //   · 抢到槽位但输掉门竞争 → **释放自己那个从未 started 的槽位**（可证无调用）。
      const limit = resolveModelCallLimit(env);
      const turnIdentity = modelTurnIdentity({
        revision: currentRevision,
        anchorKey: anchor ? anchor.key : null,
        questionKey: resolvedKey || questionKey || null,
      });

      // ① 轮次门预读：快速给出明确语义，并识别可接管的过期租约
      let gateId = null;
      let gateTakenOver = false;
      const gate = await readTurnGate(env.DB, { workItemId, turnIdentity });
      if (gate) {
        if (MODEL_CALL_SETTLED_TYPES.includes(gate.type)) {
          return httpError("这一轮已经处理完成，请刷新页面获取最新的问题。", 409, "turn_already_settled");
        }
        const expired = await isGateExpired(env.DB, gate.eventId);
        if (!expired) {
          return httpError("这一轮已经有一个请求在处理中，请稍候刷新查看结果，不要重复提交。", 409, "model_call_in_progress");
        }
        // 过期租约：原子接管（CAS：类型 + 年龄）。接管失败 ⇒ 他人已接管 ⇒ 本轮退出
        const took = await takeOverTurnGate(env.DB, { gateId: gate.eventId, payload: JSON.stringify({ kind: "turn_gate", turnIdentity, takenOver: true }) });
        if (!took) return httpError("这一轮正在被另一个请求接管，请稍候重试。", 409, "model_call_in_progress");
        gateId = gate.eventId;
        gateTakenOver = true;
      }

      // ② 原子分配额度槽位
      let slot = await allocateQuotaSlot(env.DB, { projectId, workItemId, actor: current, limit });
      for (let attempt = 0; !slot.ok && slot.reason === "contended" && attempt < 3; attempt += 1) {
        slot = await allocateQuotaSlot(env.DB, { projectId, workItemId, actor: current, limit });
      }
      stats = await readModelCallStats(env.DB, workItemId);
      if (!slot.ok) {
        if (slot.reason === "limit") {
          return httpError(
            `该任务已达到模型调用上限（${limit} 次），为避免继续产生费用已暂停模型调用。额度上调后可继续本轮访谈。`,
            429,
            "model_call_limit_reached",
          );
        }
        return httpError("额度分配遇到并发竞争，请稍候重试。", 409, "model_call_contended");
      }

      // ③ 轮次门占用（未接管时插入确定性键）
      if (!gateTakenOver) {
        const claimed = await claimTurnGate(env.DB, { projectId, workItemId, turnIdentity, actor: current });
        if (!claimed.ok) {
          // 输掉门竞争：释放自己那个**从未 started** 的槽位（可证未发出任何模型请求）
          await releaseQuotaSlot(env.DB, slot.slotId);
          return httpError("这一轮已经有一个请求在处理中，请稍候刷新查看结果，不要重复提交。", 409, "model_call_in_progress");
        }
        gateId = claimed.gateId;
      }

      claim = { id: slot.slotId, slot: slot.slot, gateId, meter: { usage: null, model: null } };

      const ledger = buildTrustedLedger(frame.answers, materialRefs, carriedLedger);
      const meter = claim.meter;
      const callModel = async (prompt) => {
        // 槽位 reserved → started。**返回值是权威判定**：若为 false，说明执行权已被接管，
        // 本请求必须中止，**不得**再发出模型请求（防止重复付费）。
        const started = await markModelCallStarted(env.DB, claim.id);
        if (!started) throw new Error("本轮执行权已被接管，已中止本次模型调用。");
        const startedAt = Date.now();
        try {
          const content = await callDeepSeek(prompt, env, meter);
          claim.outcome = "succeeded";
          claim.durationMs = Date.now() - startedAt;
          return content;
        } catch (error) {
          // F1：失败与超时**必须计入**，不得漏记、不得当成零成本
          const message = String(error && error.message ? error.message : error);
          claim.outcome = /超时|AbortError|aborted/i.test(message) ? "timed_out" : "failed";
          claim.durationMs = Date.now() - startedAt;
          claim.reason = message;
          throw error;
        }
      };
      try {
        result = await runHarness(frame, ledger, callModel, { rejectedInferences });
      } catch (error) {
        // 结算失败/超时：保留额度（不退款），避免"超时后立即释放再重试"造成超支
        if (claim && !claim.settled) {
          const outcome = claim.outcome || "failed";
          await settleModelCall(env.DB, claim.id, outcome, meter.usage, {
            model: meter.model, durationMs: claim.durationMs, reason: claim.reason || String(error && error.message || error),
          }).catch(() => {});
          await settleTurnGate(env.DB, claim.gateId, outcome).catch(() => {});
          claim.settled = true;
        }
        const after = await readModelCallStats(env.DB, workItemId);
        const failure = httpError(error.message || "Agent 问答未完成。", 503);
        // 附带服务端计量，便于联调判断"失败是否已计费"；不泄露任何内容
        failure.headers.set("x-model-call-claimed", String(after.claimed));
        failure.headers.set("x-model-call-remaining", String(after.remaining));
        return failure;
      }
    } else {
      const ledger = buildTrustedLedger(frame.answers, materialRefs, carriedLedger);
      result = runFixture(frame, ledger);
    }

    // Keep the output contract enforced even for the deterministic path.
    validateAgentOutput(result.output);

    // ── PILOT-08A/S1：服务端签发并持久化下一问的锚点 ────────────────────
    // 只有本处会写入 ledger.pendingQuestion（employee-draft 已忽略客户端提交值）。
    // 此举让"下一轮回答"有可信身份可校验：
    //   · 写入失败（并发/异常）→ revision 不变，下一轮将走 S2 恢复路径；
    //   · 出流程卡（turnKind=draft）→ 写入 null，清除锚点。
    // ── PILOT-08E/D1：把本轮确立的推断基线一并落库 ───────────────────────
    // 基线 = 库中已有基线 ∪ 本轮服务端裁决后的推断列表（result.turn.alternativeExplanations）。
    // 后者已由 _adapter 清洗（长度、字段、ID 由内容派生），因此这里拿到的就是
    // **服务端自己的**推断，不接受任何客户端输入。
    // 优先使用 _adapter 已确立的权威列表（与客户端所见一致）；缺失时回退到合并。
    const resolvedLedger = result.turn.interviewState && result.turn.interviewState.ledger
      ? result.turn.interviewState.ledger : null;
    const authoritativeFromTurn = resolvedLedger && Array.isArray(resolvedLedger.authoritativeInferences)
      ? resolvedLedger.authoritativeInferences : null;
    // F01：回退路径也只能以**库中基线**为既有记录，并按记录集上限合并；
    // 不得使用默认可见列表上限（12）截断，否则会在异常路径下丢记录。
    const authoritativeInferences = authoritativeFromTurn
      || buildInferenceRecords(
        storedDraft.ledger && Array.isArray(storedDraft.ledger.authoritativeInferences)
          ? storedDraft.ledger.authoritativeInferences
          : [],
        Array.isArray(result.turn.alternativeExplanations) ? result.turn.alternativeExplanations : [],
      ).records;
    // PILOT-08E/D2：burden 询问标记必须**持久化**，否则下一轮读库时丢失，
    // 导致"已经问过 burden 却永远不能出卡"。三个来源任一为真即视为已询问：
    //   ① 库中已有标记；② 本轮裁决后的 ledger 标记；③ 本轮签发的问题正是 burden。
    // PILOT-08E/D1（一致性关键）：落库的推断基线必须与**客户端本轮收到的列表完全一致**。
    // `result.turn.interviewState.ledger` 已经是 _adapter 在出卡/签发前确立好的权威 ledger
    // （含权威基线），因此这里以它为唯一来源 —— 否则会出现：
    //   卡片上 6 条都判完了，服务端基线却有 8 条 → 提交被拒且用户无从判定（死结）。
    // FIX-06A：推断证据历史容量满额 → 显式拒绝本轮写入（在任何 CAS 之前），不得静默截断。
    const evidenceHistoryOverflowEntry = (Array.isArray(authoritativeInferences) ? authoritativeInferences : [])
      .find((entry) => entry && entry.source !== "capacity_block" && entry.isCapacityMarker !== true && Array.isArray(entry.evidenceHistory) && entry.evidenceHistory.length > MAX_EVIDENCE_HISTORY);
    if (evidenceHistoryOverflowEntry) {
      return json({
        code: "evidence_history_overflow",
        detail: `推断证据历史已达上限（${MAX_EVIDENCE_HISTORY} 条），本轮回答未被写入；已有历史不会被删除。`,
        limit: MAX_EVIDENCE_HISTORY,
        current: evidenceHistoryOverflowEntry.evidenceHistory.length,
        inferenceIds: [evidenceHistoryOverflowEntry.id || null],
        draftRevision: currentRevision,
      }, 409);
    }
    const issuedKey = result.turn.nextQuestion ? canonicalDimension(String(result.turn.nextQuestion.key || "")) : "";
    const burdenAsked = Boolean(
      (storedDraft.ledger && storedDraft.ledger.burdenAsked === true)
      || (resolvedLedger && resolvedLedger.burdenAsked === true)
      || issuedKey === "burden",
    );
    // ── PILOT-09C/IMPLEMENT-3D（H-1）：员工陈述历史（append-only，服务端专属）──
    // 与推断基线在同一次 CAS 中落库；`statements` 仍保持"最新值"语义（流程卡零回归）。
    // F-1：识别本轮是否是"补正锚点"的作答（锚点由服务端签发，客户端不可伪造）
    const pendingAnchor = storedDraft.ledger && storedDraft.ledger.pendingQuestion && typeof storedDraft.ledger.pendingQuestion === "object"
      ? storedDraft.ledger.pendingQuestion : null;
    const supplementIntent = pendingAnchor && pendingAnchor.supplementIntent ? pendingAnchor.supplementIntent : "";
    // 计数从 statementHistory 派生（本次历史已追加后自然 +1），无需额外持久化字段
    const supplementRounds = readSupplementRounds(storedDraft.ledger);
    const historyResult = appendStatementHistory({
      prior: storedDraft.ledger ? storedDraft.ledger.statementHistory : [],
      dimension: resolvedKey,
      text: answer,
      // 补正意图只能来自**服务端锚点**；客户端 body.intent 不参与
      intent: supplementIntent || "",
      revision: currentRevision,
      anchorKey: (authoritativeQuestion && authoritativeQuestion.key) || resolvedKey || "",
    });
    if (historyResult.overflow) {
      // 硬上限：**显式阻塞**，绝不静默截断或丢弃证据
      return json({
        code: "statement_history_overflow",
        detail: "员工陈述历史已达容量上限，无法安全记录本轮回答。请联系管理员处理后再继续（已有陈述不会丢失）。",
        limit: MAX_STATEMENT_HISTORY,
        current: historyResult.history.length,
      }, 409);
    }
    const ledgerPatch = { authoritativeInferences, burdenAsked, statementHistory: historyResult.history };

    let responseRevision = currentRevision;
    let anchorWriteFailed = false;
    if (workItemId) {
      if (result.turn.turnKind === "question" && result.turn.nextQuestion) {
        const issued = await issueAnchor(env.DB, workItemId, currentRevision, result.turn.nextQuestion, ledgerPatch, writeGuard, { answer, dimension: resolvedKey });
        if (issued === null) anchorWriteFailed = true;
        else responseRevision = issued;
      } else if (result.turn.turnKind === "draft") {
        const cleared = await issueAnchor(env.DB, workItemId, currentRevision, null, ledgerPatch, writeGuard, { answer, dimension: resolvedKey });
        if (cleared === null) anchorWriteFailed = true;
        else responseRevision = cleared;
      }
    }

    // ── F1/F3：结算本次调用。**先结算，再返回** ─────────────────────────
    // 注意顺序语义：模型已成功但草稿 CAS 失败时，额度**不退还**、也不盲目重调模型
    // （见报告 T11）。这里记录 succeeded + usage，供审计与费用核对。
    if (claim && !claim.settled) {
      const outcome = claim.outcome || "succeeded";
      await settleModelCall(env.DB, claim.id, outcome, claim.meter ? claim.meter.usage : null, {
        model: claim.meter ? claim.meter.model : null,
        durationMs: claim.durationMs,
      }).catch(() => {});
      // 门结算为终态，便于后续请求快速判定；失败不影响额度（门另有租约兜底）
      await settleTurnGate(env.DB, claim.gateId, outcome).catch(() => {});
      claim.settled = true;
    }
    stats = await readModelCallStats(env.DB, workItemId);

    // ── R04-02：锚点 CAS 未命中 ⇒ 明确 409 ─────────────────────────────
    // 走到这里说明模型调用已发生；上方已先 settleModelCall / settleTurnGate，
    // 确保计量与轮次门不丢失、不重复付费。随后返回冲突 —— **不得**返回 200 成功语义，
    // 也不得写 draft（CAS 未命中即未写入）。
    // R04-02 兼容语义：anchorWriteFailed 只可能在此前 `if (workItemId)` 分支内被置位，
    // 这里仍显式要求 workItemId 非空 —— 无任务轮次（无写入尝试）不得"顺便"改成 409。
    if (anchorWriteFailed && workItemId) return anchorWriteConflict();

    return json({
      turn: result.turn,
      output: result.output,
      draftRevision: responseRevision,
      // 让客户端明确知道锚点是否成功落库；未落库时下一轮应走恢复路径。
      anchorPersisted: responseRevision !== currentRevision,
      // ── PILOT-09A-FIX/F1–F3：服务端计量（供联调核对；客户端**不能**修改）──
      // 只含计量元数据：次数、剩余额度、Token 来源与费用上界估算。不含任何提示词/回答内容。
      metering: {
        limit: stats.limit,
        claimed: stats.claimed,
        remaining: stats.remaining,
        succeeded: stats.succeeded,
        failed: stats.failed,
        timedOut: stats.timedOut,
        // Token 来源必须可区分：reported / unavailable / estimated
        tokenSource: claim && claim.meter && claim.meter.usage ? claim.meter.usage.source : "unavailable",
        promptTokens: claim && claim.meter && claim.meter.usage && Number.isFinite(claim.meter.usage.promptTokens) ? claim.meter.usage.promptTokens : null,
        completionTokens: claim && claim.meter && claim.meter.usage && Number.isFinite(claim.meter.usage.completionTokens) ? claim.meter.usage.completionTokens : null,
        // 费用为**估算上界**，不是实际账单；硬限制只有调用次数
        estimatedCostCnyUpperBound: stats.estimatedCostCnyUpperBound,
        costCeilingCny: stats.costCeilingCny,
        costIsHardLimit: false,
      },
    });
  } catch (error) {
    return error instanceof Response ? error : httpError(error.message, 500);
  }
}

// PILOT-04/D5：模型调用必须有明确超时。此前 fetch 无任何超时，
// 一次挂起会把访谈卡死（前端只能等平台级超时），且没有重试上限。
// 这里只做"单次调用 + 明确超时"，**不重试** —— 避免重复计费与半截状态。
/**
 * R1：轮次门是否已过租约（可被接管）。
 * 判定完全在数据库侧完成（比较事件行的 created_at 与当前时间），
 * **不依赖客户端时间**，也不依赖服务端进程内时钟漂移。
 */
async function isGateExpired(db, gateId) {
  const row = await db.prepare(
    "SELECT 1 AS expired FROM events WHERE event_id = ? AND substr(event_id,1,4)='MCT|' AND created_at < datetime('now', ?)",
  ).bind(gateId, `-${Math.ceil(MODEL_CALL_LEASE_MS / 1000)} seconds`).first();
  return Boolean(row);
}

const MODEL_TIMEOUT_MS = 20000;

/**
 * PILOT-09A-FIX/F3：调用模型并把 usage 写入**本次请求专属**的 meter 对象。
 *
 * 为什么用传入的 meter 而不是模块级变量：Workers 的模块作用域可能被同一 isolate
 * 内的并发请求共享，模块级变量会串味（甲请求的 usage 被乙请求读到）。
 * meter 由每次 onRequestPost 新建，天然隔离。
 *
 * usage 三态必须可区分，**不得**把缺失当成 0：
 *   reported（供应商返回）/ unavailable（未返回）/ estimated（可说明的估算）。
 * 只记计量元数据，绝不记录 API Key、完整提示词、完整响应或员工原话。
 */
async function callDeepSeek(prompt, env, meter = null) {
  const key = env.DEEPSEEK_API_KEY;
  const base = (env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
  const model = env.DEEPSEEK_MODEL || "deepseek-chat";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.2, stream: false }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`模型调用超时（${MODEL_TIMEOUT_MS}ms）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  // PILOT-09A-FIX/F3：解析 usage。供应商未返回时记 unavailable + 输入估算，
  // 便于事后核对；**不写 0**，避免"看起来用了 0 token"。
  if (meter) {
    const parsed = extractUsage(data);
    meter.usage = parsed.source !== "unavailable" ? parsed : estimateUsage(prompt.length);
    meter.model = model;
  }
  if (typeof content !== "string" || !content.trim()) throw new Error("DeepSeek 响应缺少内容字段");
  return content;
}

// PILOT-07/S1：单轮回答长度上限（与 employee-submission 的 4000 保持一致量级）
const MAX_ANSWER_CHARS = 4000;

/**
 * 读取服务端已保存的草稿（唯一可信的历史答案来源）。
 * 旧版扁平格式由 normalizeEmployeeDraft 兼容，无需额外分支。
 */
async function loadStoredDraft(db, workItemId, projectId) {
  if (!workItemId) return { answers: {}, ledger: null, inferenceVerdicts: {}, revision: 0, pendingQuestion: null };
  const item = await requireItem(db, workItemId);
  // 双重保险：任务必须属于已鉴权的 projectId。
  if (item.project_id !== projectId) return { answers: {}, ledger: null, inferenceVerdicts: {}, revision: 0, pendingQuestion: null };
  let raw = {};
  try { raw = item.employee_draft_json ? JSON.parse(item.employee_draft_json) : {}; } catch (_error) { raw = {}; }
  const draft = normalizeEmployeeDraft(raw);
  return { answers: draft.answers || {}, ledger: draft.ledger || null, inferenceVerdicts: draft.inferenceVerdicts || {}, revision: draft.revision || 0, pendingQuestion: draft.ledger?.pendingQuestion || null };
}

/**
 * PILOT-07/S2：按**已鉴权**的 projectId 读取权威项目背景。
 *
 * 只读 name / scope 两个字段。返回 null 表示背景不可用 —— 调用方必须安全降级，
 * 不得因此中断访谈。绝不接受客户端提供的任何项目信息。
 */
async function loadAuthorizedProjectContext(db, projectId) {
  try {
    const row = await db.prepare("SELECT name, scope FROM projects WHERE id = ?").bind(projectId).first();
    if (!row) return null;
    return {
      workName: sanitizeProjectText(row.name, 200),
      projectScope: sanitizeProjectText(row.scope, 300),
    };
  } catch (_error) {
    return null;
  }
}

/**
 * 项目文本清洗：去控制字符、折叠空白、限长。
 * 注意：**清洗不等于完整的提示词注入防护** —— 定界符 + 服务端输出校验
 * （字段白名单 / 维度合法性 / 越权内容过滤）才是最终防线。
 */
function sanitizeProjectText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

// ══════════════════════════════════════════════════════════════════════
// PILOT-08A/S1 + S2：服务端权威问题锚点
//
// 威胁模型（PILOT-08 已复现）：
//   · 变体 A/G：客户端经 employee-draft 把 pendingQuestion 改成 burden，
//     再在 employee-turn 报 questionKey=burden → 200，回答归入错误维度。
//   · 变体 E：客户端删除 pendingQuestion → 进入"无锚点引导分支"，
//     任意合法维度被接受 → 同样错误归类。
//
// 修复后的信任模型：
//   · 写入：只有本文件（服务端）能写锚点，且**只能**基于服务端自己生成的
//     nextQuestion 写入；employee-draft 已改为忽略客户端提交的锚点。
//   · 校验：只信任"库中锚点"，且要求它同时满足
//       ① workItemId 绑定当前任务
//       ② 签名与四元组（workItemId, key, prompt, revision）一致
//       ③ 答案所用的 revision 在锚点允许的窗口内
//   · 失效：出流程卡（draft）时清除；revision 越窗即失效。
//   · 恢复：无锚点/锚点失效时**不**按客户端自报 key 放行，改为走
//     "服务端重新签发"路径（recover === true），由服务端自行决定当前该问什么。
// ══════════════════════════════════════════════════════════════════════

const ANCHOR_SECRET = "__pilot08a_anchor_v1__";
const ANCHOR_REVISION_WINDOW = 1;   // 锚点写入后允许的 revision 推进量（客户端自动保存 +1）

/** 锚点签名：绑定 workItemId / key / prompt / revision，防维度或文本被改写后继续使用 */
function anchorSignature({ workItemId, key, prompt, revision }) {
  return `${ANCHOR_SECRET}|${workItemId}|${key}|${String(prompt || "").slice(0, 120)}|${revision}`;
}

/** 校验库中锚点：形状 + 任务绑定 + 签名 + 内容非空 */
function readValidAnchor(rawAnchor, workItemId) {
  if (!rawAnchor || typeof rawAnchor !== "object") return null;
  const key = canonicalDimension(String(rawAnchor.key || ""));
  if (!key) return null;
  const prompt = String(rawAnchor.prompt || "");
  const revision = Number(rawAnchor.revision);
  const anchorWorkItemId = String(rawAnchor.workItemId || "");
  if (!prompt.trim()) return null;                       // 无提问文本 → 不可信
  if (!Number.isInteger(revision) || revision < 0) return null;
  if (!anchorWorkItemId || !workItemId) return null;
  if (anchorWorkItemId !== workItemId) return null;       // 跨任务复用 → 无效
  const expected = anchorSignature({ workItemId: anchorWorkItemId, key, prompt, revision });
  if (String(rawAnchor.sig || "") !== expected) return null;  // 被篡改 → 无效
  return { key, label: String(rawAnchor.label || "").slice(0, 80), prompt, revision, workItemId: anchorWorkItemId };
}

/** 本轮回答所用的 revision 是否仍在该锚点允许的窗口内 */
function anchorAcceptsRevision(anchor, answerRevision) {
  if (!anchor) return false;
  if (anchor.revision > answerRevision) return false;                       // 用了更旧的状态
  if (answerRevision - anchor.revision > ANCHOR_REVISION_WINDOW) return false; // 窗口外 → 已过期
  return true;
}

/**
 * 无锚点时的安全恢复：由**服务端**决定当前应问什么，绝不采信客户端自报 key。
 *
 * 实现方式：用服务端已重建的 ledger.statements 跑一次覆盖裁决，
 * 取所需维度中的第一个。这里**完全不读** body.questionKey。
 */
function deriveRecoveryQuestion(ledger) {
  const coverage = resolveCoverage(ledger.statements, {}, ledger);
  const missing = Array.isArray(coverage.missing) ? coverage.missing : [];
  if (!missing.length) return null;                 // 覆盖已满足 → 本轮不应再提问
  const key = canonicalDimension(String(missing[0]));
  if (!key) return null;
  const question = QUESTION_BANK.find((q) => q.key === key);
  if (!question) return null;
  return { key: question.key, label: question.label, prompt: question.prompt };
}

/**
 * 服务端专属锚点写入（S1 的"可信创建/保存"环节）。
 *
 * 使用与草稿相同的 CAS 语义：仅当库中 revision 仍等于 expectedRevision 时写入，
 * 因此不会覆盖客户端在并发下已保存的更新，也不产生不受控写入。
 * 返回值：成功 → 新 revision；失败（并发/异常）→ null。
 */
async function writePendingQuestion(db, workItemId, expectedRevision, anchor, forcedRevision = null, ledgerPatch = null, writeGuard = null, answerContext = null) {
  if (!workItemId) return null;
  try {
    const item = await requireItem(db, workItemId);
    const draft = normalizeEmployeeDraft(
      (() => { try { return item.employee_draft_json ? JSON.parse(item.employee_draft_json) : {}; } catch (_error) { return {}; } })(),
    );
    if (draft.revision !== expectedRevision) return null;   // 已被并发推进 → 让下一轮走恢复
    const nextRevision = forcedRevision === null ? expectedRevision + 1 : forcedRevision;
    const patch = ledgerPatch && typeof ledgerPatch === "object" ? ledgerPatch : {};
    const historyOverride = Array.isArray(patch.statementHistory) ? patch.statementHistory : null;
    const authoritative = Array.isArray(patch.authoritativeInferences) ? patch.authoritativeInferences : null;
    const context = answerContext && typeof answerContext === "object" ? answerContext : null;
    // ── PILOT-09C/IMPLEMENT-05B（F03-2）：本轮答案/历史/推断/锚点**原子落库** ──
    // turn 成功即代表本轮员工输入已成为服务端证据，不再依赖客户端随后再调一次
    // employee-draft（A5：旧实现 turn 成功但 answers 未落库，形成证据分裂）。
    // 该写入通过统一证据入口完成：追加历史、更新 evidenceSeq/answersDigest、
    // 使受影响推断失效；CAS（含 R04-02 writeGuard）未命中 ⇒ 返回 null ⇒ 调用点 409。
    const result = await applyTurnEvidence({
      db,
      workItemId,
      expectedRevision,
      storedDraft: draft,
      answer: context ? context.answer : null,
      dimension: context ? context.dimension : null,
      historyOverride,
      authoritativeInferences: authoritative,
      anchor,
      burdenAsked: Object.prototype.hasOwnProperty.call(patch, "burdenAsked") ? patch.burdenAsked : undefined,
      ledgerPatch: patch,
      writeGuard,
    });
    return result.ok ? nextRevision : null;
  } catch (_error) {
    return null;
  }
}

/**
 * 服务端签发锚点（S1 的"可信创建/保存"环节）。
 *
 * 使用与草稿相同的 CAS 语义：仅当库中 revision 仍等于 expectedRevision 时写入，
 * 因此不会覆盖客户端在并发下已保存的更新，也不产生不受控写入。
 * 返回值：成功 → 新 revision；失败（并发/异常）→ null（下一轮将走恢复路径）。
 */
async function issueAnchor(db, workItemId, expectedRevision, question, ledgerPatch = null, writeGuard = null, answerContext = null) {
  if (!workItemId) return null;
  // question === null → 清除锚点（出流程卡时），仍然走同一条 CAS 写路径。
  if (question === null) {
    const nextRevision = expectedRevision + 1;
    return writePendingQuestion(db, workItemId, expectedRevision, null, nextRevision, ledgerPatch, writeGuard, answerContext);
  }
  if (!question || !question.key) return null;
  const nextRevision = expectedRevision + 1;
  const anchor = {
    key: canonicalDimension(String(question.key)),
    label: String(question.label || "").slice(0, 80),
    prompt: String(question.prompt || "").slice(0, 500),
    revision: nextRevision,
    workItemId,
  };
  // F-1（3G-FIX）：补正锚点必须把**服务端决定的** supplementIntent 一并持久化。
  // 只接受两个合法枚举值；其余（含客户端传入的任意值）一律不写入。
  // 普通访谈锚点没有该字段 ⇒ 结构与此前完全一致（零回归）。
  if (question.supplementIntent === "supplement" || question.supplementIntent === "correction") {
    anchor.supplementIntent = question.supplementIntent;
  }
  if (!anchor.key || !anchor.prompt.trim()) return null;
  anchor.sig = anchorSignature({ workItemId, key: anchor.key, prompt: anchor.prompt, revision: nextRevision });
  return writePendingQuestion(db, workItemId, expectedRevision, anchor, null, ledgerPatch, writeGuard, answerContext);
}
