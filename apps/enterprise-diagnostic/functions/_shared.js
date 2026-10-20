import { BUSINESS_TABLES, EXPECTED_MIGRATION_HEAD, KNOWN_MIGRATIONS } from "./_schema.generated.js";

const roles = new Set(["employee", "verifier", "owner", "external_builder", "it_admin"]);

export function actor(request) {
  const role = request.headers.get("X-Demo-Role");
  const userId = request.headers.get("X-Demo-User");
  if (!roles.has(role) || !userId) throw httpError("线上演示 API 需要角色和演示身份。", 401);
  return { role, userId };
}

// ── 数据库就绪门（PILOT-18B-R2A）────────────────────────────────────────
// 唯一 Schema 权威是 numbered migrations（生成物见 functions/_schema.generated.js）。
// 请求期绝不执行 DDL：这里只只读探测 sqlite_master 与 wrangler 的 d1_migrations 账本，
// 未就绪时抛出 503 Response（含机器可读 code，绝不 500 no such table）。
// 历史数据库（runtime ensureSchema / 旧 schema.sql / 污染账本）不会被自动迁移或修复；
// 它们只会得到 db_schema_unmanaged（fail-closed），由 scripts/db.sh diagnose 人工处置。
const readinessByDatabase = new WeakMap();

export const READINESS_ERROR_CODES = Object.freeze({
  DB_NOT_INITIALIZED: "db_not_initialized",
  DB_SCHEMA_INCOMPLETE: "db_schema_incomplete",
  DB_SCHEMA_UNMANAGED: "db_schema_unmanaged",
  DB_SCHEMA_OUTDATED: "db_schema_outdated",
  DB_SCHEMA_UNSUPPORTED: "db_schema_unsupported",
});

const READINESS_ERROR_DETAILS = Object.freeze({
  db_not_initialized: ["数据库尚未初始化。请运行 scripts/db.sh init（或按 README 启动）。", 503],
  db_schema_incomplete: ["数据库结构不完整（缺少业务表）。请运行 scripts/db.sh diagnose。", 503],
  db_schema_unmanaged: ["检测到未经迁移账本管理的旧数据库。请运行 scripts/db.sh diagnose 并按指引处理。", 503],
  db_schema_outdated: ["数据库版本落后于当前代码。请运行 scripts/db.sh init（或 scripts/db.sh diagnose 先只读检查）。", 503],
  db_schema_unsupported: ["数据库版本无法识别或高于当前代码。请勿降级，联系维护者。", 503],
});

function readinessError(code) {
  const [detail, status] = READINESS_ERROR_DETAILS[code] || ["数据库未就绪。", 503];
  return httpError(detail, status, code);
}

export function assertSchemaReady(db) {
  let ready = readinessByDatabase.get(db);
  if (!ready) {
    ready = probeSchemaReadiness(db).catch((error) => {
      readinessByDatabase.delete(db);
      throw error;
    });
    readinessByDatabase.set(db, ready);
  }
  return ready;
}

async function probeSchemaReadiness(db) {
  let row;
  try {
    const placeholders = BUSINESS_TABLES.map(() => "?").join(",");
    row = await db
      .prepare(
        "SELECT (SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN (" +
          placeholders +
          ")) AS business, " +
          "(SELECT count(*) FROM sqlite_master WHERE type='table' AND name='d1_migrations') AS ledger",
      )
      .bind(...BUSINESS_TABLES)
      .first();
  } catch (error) {
    throw readinessError(READINESS_ERROR_CODES.DB_NOT_INITIALIZED);
  }
  const business = Number(row && row.business ? row.business : 0);
  const ledger = Number(row && row.ledger ? row.ledger : 0);
  if (business === 0) throw readinessError(READINESS_ERROR_CODES.DB_NOT_INITIALIZED);
  if (business < BUSINESS_TABLES.length) throw readinessError(READINESS_ERROR_CODES.DB_SCHEMA_INCOMPLETE);
  if (!ledger) throw readinessError(READINESS_ERROR_CODES.DB_SCHEMA_UNMANAGED);
  const headRow = await db
    .prepare("SELECT name FROM d1_migrations WHERE name IS NOT NULL ORDER BY id DESC LIMIT 1")
    .first();
  const head = headRow && headRow.name ? String(headRow.name) : "";
  if (!head) throw readinessError(READINESS_ERROR_CODES.DB_SCHEMA_UNMANAGED);
  if (!KNOWN_MIGRATIONS.includes(head)) throw readinessError(READINESS_ERROR_CODES.DB_SCHEMA_UNSUPPORTED);
  if (head !== EXPECTED_MIGRATION_HEAD) throw readinessError(READINESS_ERROR_CODES.DB_SCHEMA_OUTDATED);
  return { head, tables: business };
}

// ── 运行模式判定（V0.1 第二批 B2-01）──────────────────────────────────
// 唯一实现。任何端点都**不得**自行比较 FORMAL_AUTH_MODE。
//
// 为什么必须是白名单：旧实现散落着 `!== "production"` / `=== "production"`
// 这类黑名单判定，于是「空串 / 拼写错误 / 未知取值」全部被当作**非生产**，
// 落入开发分支。2026-10-14 生产真实发生过一次（部署丢失 [vars] 抹掉该变量，
// 见 deploy/production/wrangler.toml 的记录），当时 login-request 正是因此
// 把一次性登录链接放进了 HTTP 响应体。
//
// 失效保护语义：**只有被明确识别的取值才具备明确语义**；
// 其余一律按生产语义处理（即"拒绝"，而不是"便利"）。
export const AUTH_MODE_PRODUCTION = "production";
export const AUTH_MODE_DEVELOPMENT = "development";

// 开发回退凭证的来源标记。写入 delivery_error 列（既有字段，无需迁移），
// 使"响应体内返回的登录链接"与"真实 provider 投递"在存储上可区分。
export const DEV_FALLBACK_DELIVERY_MARKER = "dev_fallback_link";

// 真实 provider 投递成功的**正向来源标记**（V0.1 第二批 B-1 安全修复）。
//
// 为什么必须要正向标记：delivery_status='delivered' 无法证明"真的投递过"——
// 旧版本的开发回退分支同样把 challenge 标为 delivered，却把链接放进 HTTP 响应体。
// 于是「delivered + delivery_error IS NULL」在历史上同时可能表示
//   (a) 真实 provider 投递成功   (b) 旧版把链接放进响应体的开发回退凭证
// 两者不可区分，生产语义因此可能消费到本不该可用的凭证。
//
// 采用正向标记后，生产语义**只接受被明确标记为真实投递**的凭证；
// 无标记（含全部历史遗留）一律拒绝。历史凭证在 15 分钟内自然过期，缺口永久闭合。
export const PROVIDER_DELIVERED_MARKER = "provider_delivered";

export function resolveAuthMode(env = {}) {
  const raw = String(env.FORMAL_AUTH_MODE ?? "").trim();
  const recognized = raw === AUTH_MODE_PRODUCTION || raw === AUTH_MODE_DEVELOPMENT;
  const isProduction = raw === AUTH_MODE_PRODUCTION || !recognized;
  const isDevelopment = raw === AUTH_MODE_DEVELOPMENT;
  const isTestMode = isDevelopment && env.FORMAL_AUTH_TEST_MODE === "1";
  return {
    raw,
    recognized,
    isProduction,
    isDevelopment,
    isTestMode,
    // 未识别取值单独可辨，便于给出准确的运维提示（但仍然按生产语义处置）。
    unrecognized: !recognized,
  };
}

// 开发便利登录是否允许把登录链接放进响应体。
// 三个条件**必须同时**成立，且与 FORMAL_AUTH_MODE 之外的输入绑定：
//   ① 显式 development（未识别取值不算）
//   ② 显式开启 FORMAL_AUTH_TEST_MODE=1
//   ③ 受控测试身份 —— 必须是隔离测试域 .invalid 的收件人
// 第 ③ 条是关键：即使生产被误配成 development 且误留测试开关，
// 真实业务邮箱也不会因此拿到响应内凭证。
export function mayReturnLoginLinkInResponse(mode, email) {
  return Boolean(mode?.isDevelopment && mode?.isTestMode && String(email || "").toLowerCase().endsWith(".invalid"));
}

// 受控测试身份判定（供调用方决定是否允许开发回退投递）。
export function isControlledTestRecipient(email) {
  return String(email || "").toLowerCase().endsWith(".invalid");
}

// Formal routes must derive role and project from the server-side session.
export async function formalActor(request, db) {
  if (request.headers.get("X-Demo-Role") || request.headers.get("X-Demo-User")) throw httpError("正式接口不接受演示身份。", 401);
  await assertSchemaReady(db);
  const token = requestSessionToken(request);
  if (!token) throw httpError("需要正式登录会话。", 401);
  const session = await db.prepare("SELECT s.*, m.role, a.status AS account_status, a.account_role AS account_role FROM sessions s JOIN accounts a ON a.id = s.account_id LEFT JOIN project_memberships m ON m.project_id = s.project_id AND m.account_id = s.account_id AND m.status = 'active' WHERE s.token = ?").bind(token).first();
  if (!session || session.revoked_at || session.account_status !== "active" || new Date(session.expires_at) <= new Date()) throw httpError("登录会话已失效，请重新登录。", 401);
  if (session.project_id && !session.role) throw httpError("当前会话没有项目成员权限。", 403);
  // `role` is the project-scoped role when a project is bound, else "account".
  // `accountRole` is a property of the account itself and is the only reliable
  // signal for builder standing: an account-scoped session ("account") covers
  // both a provisioned external builder and a member with zero or two-plus
  // memberships, and those must not be treated alike. See PRIV-P1-009.
  return { accountId: session.account_id, projectId: session.project_id, role: session.role || "account", accountRole: session.account_role || "member", token, expiresAt: session.expires_at };
}

export const SESSION_COOKIE_NAME = "__Host-diagnostic_session";

export function requestSessionToken(request) {
  const value = request.headers.get("Authorization") || "";
  const bearerToken = value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
  const cookie = request.headers.get("Cookie") || "";
  const cookieToken = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))?.slice(SESSION_COOKIE_NAME.length + 1) || "";
  const hostname = new URL(request.url).hostname;
  const localBearerAllowed = ["localhost", "127.0.0.1"].includes(hostname);
  const token = localBearerAllowed && bearerToken ? bearerToken : cookieToken;
  return token;
}

export function sessionCookie(token) {
  return `__Host-diagnostic_session=${token}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearSessionCookie() {
  return "__Host-diagnostic_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";
}

export function withSessionCookie(response, cookieValue) {
  const headers = new Headers(response.headers);
  headers.set("Set-Cookie", cookieValue);
  return new Response(response.body, { status: response.status, headers });
}

export function httpError(detail, status, code = "") {
  return new Response(JSON.stringify({ detail, ...(code ? { code } : {}) }), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" } });
}

export async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function authorizationConfirmationToken(secret, projectId, authorizationId, nonce, expiresAt) {
  if (!secret) throw new Error("AUTHORIZATION_CONFIRMATION_HMAC_SECRET is not configured");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${projectId}:${authorizationId}:${nonce}:${expiresAt}`));
  const hex = [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `AUTHC-${nonce}.${hex}`;
}

// Actionable config guidance for the P0 authorization-delivery precondition. The
// API route can only see the queue producer binding + HMAC secret; the notification
// provider binding lives on the queue consumer (checked there).
export function authorizationDeliveryConfigError(env) {
  const problems = [];
  if (!env.AUTHORIZATION_CONFIRMATION_QUEUE?.send) {
    problems.push("缺少队列绑定 AUTHORIZATION_CONFIRMATION_QUEUE（请在 wrangler.toml 声明 [[queues.producers]] 并在部署时绑定）");
  }
  if (!env.AUTHORIZATION_CONFIRMATION_HMAC_SECRET) {
    problems.push("缺少 HMAC 密钥 AUTHORIZATION_CONFIRMATION_HMAC_SECRET（运行 wrangler pages secret put AUTHORIZATION_CONFIRMATION_HMAC_SECRET）");
  }
  if (!problems.length) return "企业授权确认投递通道未配置：请检查队列绑定、HMAC 密钥，并确认已部署授权确认队列消费者且绑定通知服务 NOTIFICATION_PROVIDER。";
  return `企业授权确认投递通道未配置：${problems.join("；")}。`;
}

export function itemPayload(item) {
  const parseJson = (value, fallback) => {
    try { return value ? JSON.parse(value) : fallback; } catch (_error) { return fallback; }
  };
  // PILOT-04/N3：草稿在出口处统一归一化，读取方只会拿到 answers/ledger，
  // 不再需要（也不允许）自行解析格式。
  const __draft = normalizeEmployeeDraft(parseJson(item.employee_draft_json, {}));
  return {
    ...item,
    projectId: item.project_id,
    assigneeRole: item.assignee_role,
    assigneeLabel: item.assignee_label,
    assigneeAccountId: item.assignee_account_id || null,
    sourceEmployeeAccountId: item.source_employee_account_id || null,
    evidenceCompleteness: item.evidence_completeness,
    blockingReason: item.blocking_reason,
    nextAction: item.next_action,
    employeeDescription: item.employee_description,
    materialStatus: item.material_status || "undecided",
    draft: __draft,
    draftRevision: __draft.revision,
    draftAnswers: __draft.answers,
    draftLedger: __draft.ledger,
    draftInferenceVerdicts: __draft.inferenceVerdicts,
    workflowCard: parseJson(item.workflow_card_json, {}),
    candidateFactId: item.candidate_fact_id || `FACT-${item.id}`,
    flowCardVersion: item.flow_card_version || 1,
    evidenceVersion: item.evidence_version || 1,
    assignedVerifierId: item.assigned_verifier_id || null,
    assignedVerifierName: item.assigned_verifier_name || null,
    assignmentVersion: Number(item.assignment_version || 1),
    submissionVersion: item.submission_version,
    submittedAt: item.submitted_at,
    handoffStatus: item.handoff_status,
    evidenceItems: parseJson(item.evidence_json, []),
    alternativeExplanations: parseJson(item.alternative_explanations_json, []),
    judgmentStatus: item.judgment_status || "open",
    supplementId: item.supplement_id || null,
    revisionReason: item.revision_reason || null,
    revisionFromVersion: item.revision_from_version == null ? null : Number(item.revision_from_version),
    revisionPacketId: item.revision_packet_id || null,
  };
}

export function receiptPayload(item) {
  return {
    workItemId: item.id,
    submissionVersion: item.submission_version,
    submittedAt: item.submitted_at,
    flowCardVersion: item.flow_card_version,
    materialStatus: item.material_status,
    handoffStatus: item.handoff_status,
    assignedVerifierId: item.assigned_verifier_id || null,
    assignedVerifierName: item.assigned_verifier_name || null,
    assignedVerifierLabel: item.assigned_verifier_id ? (item.assignee_label || "流程核验人员") : null,
  };
}

export async function requireItem(db, itemId) {
  const item = await db.prepare("SELECT * FROM work_items WHERE id = ?").bind(itemId).first();
  if (!item) throw httpError("任务不存在", 404);
  return item;
}

export async function requireDecisionPacket(db, packetId) {
  const packet = await db.prepare("SELECT * FROM decision_packets WHERE id=?").bind(packetId).first();
  if (!packet) throw httpError("决策包不存在", 404);
  return packet;
}

export function decisionPacketPayload(packet) {
  const parseJson = (value) => {
    try { return JSON.parse(value || "[]"); } catch (_error) { return []; }
  };
  return {
    id: packet.id,
    projectId: packet.project_id,
    version: Number(packet.version),
    status: packet.status,
    draftedByAccountId: packet.drafted_by_account_id,
    verifierAccountId: packet.verifier_account_id || null,
    factRefs: parseJson(packet.fact_refs_json),
    riskSummary: packet.risk_summary,
    pilotScope: packet.pilot_scope,
    constraints: parseJson(packet.constraints_json),
    successMetrics: parseJson(packet.success_metrics_json),
    stopConditions: parseJson(packet.stop_conditions_json),
    downstreamOwner: packet.downstream_owner,
    createdAt: packet.created_at,
    verifiedAt: packet.verified_at || null,
    publishedAt: packet.published_at || null,
    revisionReason: packet.revision_reason || null,
    revisionFromVersion: packet.revision_from_version == null ? null : Number(packet.revision_from_version),
    revisionWorkItemId: packet.revision_work_item_id || null,
  };
}

export async function appendEvent(db, projectId, workItemId, type, actor_, payload) {
  await db.prepare("INSERT INTO events (event_id,project_id,work_item_id,type,actor_role,actor_id,payload) VALUES (?,?,?,?,?,?,?)")
    .bind(`EVT-${crypto.randomUUID()}`, projectId, workItemId, type, actor_.role, actor_.userId || actor_.accountId, JSON.stringify(payload)).run();
}

export function demoActor(request) { return actor(request); }

export function idempotencyKey(request) {
  return request.headers.get("Idempotency-Key") || "";
}

export async function findIdempotent(db, actor_, projectId, action, key) {
  if (!key || !actor_?.accountId) return null;
  const row = await db.prepare("SELECT response_json FROM idempotency_records WHERE account_id=? AND project_id IS ? AND action=? AND request_key=?")
    .bind(actor_.accountId, projectId || null, action, key).first();
  if (!row) return null;
  try { return JSON.parse(row.response_json); } catch (_error) { return null; }
}

export async function storeIdempotent(db, actor_, projectId, action, key, response) {
  if (!key || !actor_?.accountId) return;
  await db.prepare("INSERT OR IGNORE INTO idempotency_records(account_id,project_id,action,request_key,response_json) VALUES (?,?,?,?,?)")
    .bind(actor_.accountId, projectId || null, action, key, JSON.stringify(response)).run();
}

export async function requireMembership(db, projectId, actor_, roles = null) {
  if (actor_.projectId && actor_.projectId !== projectId) throw httpError("当前会话绑定到其他项目", 403);
  const membership = await db.prepare("SELECT * FROM project_memberships WHERE project_id=? AND account_id=? AND status='active'")
    .bind(projectId, actor_.accountId).first();
  if (!membership) throw httpError("无权访问该项目", 403);
  if (roles && !roles.includes(membership.role)) throw httpError("当前职责无权执行该操作", 403);
  actor_.role = membership.role;
  return membership;
}

export async function requireAuthorizedProject(db, projectId) {
  const project = await db.prepare("SELECT id,status,authorization_stage FROM projects WHERE id=?").bind(projectId).first();
  if (!project) throw httpError("项目不存在", 404);
  const authorization = await db.prepare("SELECT id FROM enterprise_authorizations WHERE project_id=? AND status='authorized' LIMIT 1").bind(projectId).first();
  if (!authorization) throw httpError("企业具名授权确认后才能启动成员邀请和企业数据处理", 409, "enterprise_authorization_required");
  return { ...project, authorizationId: authorization.id };
}

// ── 员工访谈草稿格式（PILOT-04 / N3）─────────────────────────────────
// v2（嵌套）: { schemaVersion:2, answers:{...}, ledger:{...}, inferenceVerdicts:{...} }
// v1（旧扁平）: { trigger:"…", inputs:"…", submissionText:"…" }
//
// 为什么必须归一化：旧版读取方会把草稿对象的**任意顶层键**并入答案集
// （app.js 的 Object.entries 循环），一旦把 ledger 直接放在顶层，它就会
// 被当成一道题的答案。归一化把"数据"与"内部状态"在结构上分开。
export const DRAFT_SCHEMA_VERSION = 2;
// PILOT-07/S1：revision 也是**内部键**，必须排除在答案集之外。
// 否则旧版扁平分支会把它当成一道题的答案（"revision": 3 变成 answers.revision），
// 既污染答案集，又让该草稿的修订号被读成 0。
const DRAFT_INTERNAL_KEYS = new Set(["schemaVersion", "revision", "ledger", "inferenceVerdicts", "submissionText"]);

// PILOT-04B/A：草稿修订号。
// 每次成功写入 +1，是**唯一**可用于乐观并发的标识。
// 绝不能改用"覆盖维度数 / 追问次数 / 未解决数"这类业务统计值：
// 它们既不唯一（不同内容可能同值），也不单调（unresolved 被解决会减少）。
export function draftRevisionOf(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const value = Number(source.revision);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function normalizeEmployeeDraft(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  // PILOT-07：v2 的识别要接受两种情况 ——
  //   ① 显式声明 schemaVersion === 2；
  //   ② 结构上就是 v2（存在 answers 对象）。
  // 否则会落进旧扁平分支，把 `answers` 这个键**本身**当成一道题的答案：
  // 由于七维里恰好有同名维度，会造成"数据丢失 + 答案集污染"双重问题。
  // 旧版扁平草稿从不含 answers 键，因此这个判据不会误伤旧数据。
  const declaresV2 = source.schemaVersion === DRAFT_SCHEMA_VERSION;
  const looksLikeV2 = source.answers && typeof source.answers === "object" && !Array.isArray(source.answers);
  if (declaresV2 || looksLikeV2) {
    return {
      schemaVersion: DRAFT_SCHEMA_VERSION,
      revision: draftRevisionOf(source),
      answers: source.answers && typeof source.answers === "object" && !Array.isArray(source.answers) ? { ...source.answers } : {},
      ledger: source.ledger && typeof source.ledger === "object" ? source.ledger : null,
      inferenceVerdicts: source.inferenceVerdicts && typeof source.inferenceVerdicts === "object" ? source.inferenceVerdicts : {},
      submissionText: typeof source.submissionText === "string" ? source.submissionText : "",
    };
  }
  // 旧版扁平格式：除内部保留键外，其余顶层键都视为答案
  const answers = {};
  for (const [key, value] of Object.entries(source)) {
    if (DRAFT_INTERNAL_KEYS.has(key)) continue;
    if (value && typeof value === "object") continue;   // 旧数据不应有对象值，防御性跳过
    answers[key] = value;
  }
  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    revision: draftRevisionOf(source),
    answers,
    ledger: null,                                        // 旧格式无追问计数，从头计
    inferenceVerdicts: {},
    submissionText: typeof source.submissionText === "string" ? source.submissionText : "",
  };
}

export function serializeEmployeeDraft({ answers, ledger, inferenceVerdicts, submissionText, revision }) {
  return JSON.stringify({
    schemaVersion: DRAFT_SCHEMA_VERSION,
    revision: Number.isInteger(revision) && revision >= 0 ? revision : 0,
    answers: answers && typeof answers === "object" ? answers : {},
    ledger: ledger && typeof ledger === "object" ? ledger : null,
    inferenceVerdicts: inferenceVerdicts && typeof inferenceVerdicts === "object" ? inferenceVerdicts : {},
    submissionText: typeof submissionText === "string" ? submissionText : "",
  });
}

/**
 * PILOT-04B/A：草稿的**原子**比较并交换写入。
 *
 * 为什么必须是条件 UPDATE：
 *   先 SELECT 再 UPDATE 存在天然竞态 —— 两个请求可以同时读到 revision=N，
 *   随后都通过版本检查、都写入，后写者静默覆盖先写者。
 *   因此把版本判断放进 UPDATE 的 WHERE 子句：数据库对同一行的写是串行的，
 *   只有一个请求能匹配到 revision=N，另一个 changes=0。
 *   这与 verification.js 的既有做法一致（条件 UPDATE + meta.changes 校验）。
 *
 * 复用既有 employee_draft_json 列，revision 存在 JSON 内部 —— **零迁移**。
 *
 * ── PILOT-09C/FIX-CODEX-04A（R04-02）：可编辑态守卫 ──────────────────────
 * 仅按 id + revision 做 CAS 并不足以保证"写回的是仍可编辑的任务"：
 * 正常正式提交成功后任务进入 stage='facts' / status='awaiting_verification'，
 * 而**草稿 revision 不变**。一个在提交前已通过 employee-draft 前置检查（stage/
 * status/归属）的在途保存请求，恢复执行时仍会命中 id+revision，把草稿/材料写回
 * 已提交快照之外，并追加 employee_draft_saved 成功事件。
 * 因此生产调用方必须传 writeGuard，把「stage='mapping' AND status!='complete'
 * AND assignee_account_id=写入者」放进**同一条 UPDATE 的 WHERE** —— 可编辑性由
 * 数据库在写入时原子判定，而不是只靠调用方写入前的 SELECT。
 * 兼容：不传 writeGuard（仅测试/历史直接调用）时保持旧行为（id+revision），
 * 既有直接调用不受影响；传了但缺少合法写入者身份则 fail-closed 不写库。
 *
 * @param {{ assigneeAccountId?: string, requireEditable?: boolean }} [writeGuard]
 * @returns {{ ok: true } | { ok: false, currentRevision: number, reason: string }}
 */
export async function casWriteEmployeeDraft(db, itemId, expectedRevision, draftJson, materialStatus = null, writeGuard = null) {
  // fail-closed：声明要守卫却没有合法写入者身份 → 拒绝写入（禁止退化为"只按版本写"）。
  const guardProvided = writeGuard !== undefined && writeGuard !== null && writeGuard !== false;
  if (guardProvided && (typeof writeGuard !== "object" || Array.isArray(writeGuard) || typeof writeGuard.assigneeAccountId !== "string" || !writeGuard.assigneeAccountId)) {
    return { ok: false, currentRevision: await readDraftRevision(db, itemId), reason: "write_guard_invalid" };
  }
  const requireEditable = guardProvided && writeGuard.requireEditable !== false;
  // 守卫 SQL 写在最前：保证"可编辑条件"与 id/revision 处在**同一条** UPDATE 语句中。
  const sql = requireEditable
    ? `UPDATE work_items
         SET employee_draft_json = ?,
             material_status = COALESCE(?, material_status)
       WHERE id = ?
         AND COALESCE(json_extract(employee_draft_json, '$.revision'), 0) = ?
         AND stage = 'mapping'
         AND status != 'complete'
         AND assignee_account_id = ?`
    : guardProvided
      ? `UPDATE work_items
           SET employee_draft_json = ?,
               material_status = COALESCE(?, material_status)
         WHERE id = ?
           AND COALESCE(json_extract(employee_draft_json, '$.revision'), 0) = ?
           AND assignee_account_id = ?`
      : `UPDATE work_items
           SET employee_draft_json = ?,
               material_status = COALESCE(?, material_status)
         WHERE id = ?
           AND COALESCE(json_extract(employee_draft_json, '$.revision'), 0) = ?`;
  const statement = guardProvided
    ? db.prepare(sql).bind(draftJson, materialStatus, itemId, expectedRevision, writeGuard.assigneeAccountId)
    : db.prepare(sql).bind(draftJson, materialStatus, itemId, expectedRevision);
  const result = await statement.run();
  if (Number(result?.meta?.changes || 0) !== 1) {
    const fresh = await db.prepare("SELECT employee_draft_json, stage, status, assignee_account_id FROM work_items WHERE id=?").bind(itemId).first();
    if (!fresh) return { ok: false, currentRevision: 0, reason: "item_not_found" };
    let parsed = {};
    try { parsed = fresh.employee_draft_json ? JSON.parse(fresh.employee_draft_json) : {}; } catch (_error) { parsed = {}; }
    const currentRevision = draftRevisionOf(parsed);
    // 冲突分类：只用于给调用方/客户端更明确的原因，不改变"未命中即拒绝"的语义。
    if (currentRevision !== expectedRevision) return { ok: false, currentRevision, reason: "stale_revision" };
    if (requireEditable && (fresh.stage !== "mapping" || fresh.status === "complete")) {
      return { ok: false, currentRevision, reason: "not_editable" };
    }
    if (guardProvided && fresh.assignee_account_id !== writeGuard.assigneeAccountId) {
      return { ok: false, currentRevision, reason: "assignee_mismatch" };
    }
    return { ok: false, currentRevision, reason: "conflict" };
  }
  return { ok: true };
}

async function readDraftRevision(db, itemId) {
  const fresh = await db.prepare("SELECT employee_draft_json FROM work_items WHERE id=?").bind(itemId).first();
  let parsed = {};
  try { parsed = fresh?.employee_draft_json ? JSON.parse(fresh.employee_draft_json) : {}; } catch (_error) { parsed = {}; }
  return draftRevisionOf(parsed);
}

export async function updateItem(db, itemId, changes) {
  const entries = Object.entries(changes);
  await db.prepare(`UPDATE work_items SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`).bind(...entries.map(([, value]) => value), itemId).run();
  return requireItem(db, itemId);
}

export function cors(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,OPTIONS", "access-control-allow-headers": "Content-Type,Authorization,Idempotency-Key,X-Demo-Role,X-Demo-User,X-Enterprise-Authorizer-Token,X-Enterprise-Authorizer-Id" } });
  return null;
}
