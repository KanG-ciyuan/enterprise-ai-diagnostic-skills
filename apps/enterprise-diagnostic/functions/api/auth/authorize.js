import { cors, assertSchemaReady, httpError, json, resolveAuthMode, sessionCookie, withSessionCookie } from "../../_shared.js";

export async function onRequestPost({ request, env }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    if (request.headers.get("X-Demo-Role") || request.headers.get("X-Demo-User")) return httpError("正式接口不接受演示身份", 401);
    await assertSchemaReady(env.DB);
    const body = await request.json();
    const supplied = String(body.bootstrapToken || request.headers.get("X-Bootstrap-Token") || "").trim();

    // ── 受控开通门（V0.1 第一批安全修复）────────────────────────────────
    // 这里**不存在**任何内置默认开通码。安全默认是"拒绝"。
    //
    // 旧实现为 `env.FORMAL_BOOTSTRAP_TOKEN || (strictProduction ? "" : "123456")`，
    // 其缺陷是：任何**非** production 的环境都会回退到公开页面上明文可见的
    // `123456`。2026-10-14 生产真实发生过一次 `FORMAL_AUTH_MODE` 丢失（见
    // 提交 662c33f），那一刻公开页面上的 `123456` 就是有效开通码。
    //
    // 独立验收 D-3 进一步指出：仅用 `=== "production"` 做判定是**黑名单式**的，
    // 空串或拼写错误（"productionn"）会被当作"非生产"，从而落进本地测试分支。
    // 现在改为**白名单式**判定：FORMAL_AUTH_MODE 只接受 "production" / "development"
    // 两个合法值；缺失、空串、未知值、拼写错误一律按生产语义处理（= 安全拒绝）。
    //
    // 于是只有三条被显式定义的路径：
    //   ① 配置了 FORMAL_BOOTSTRAP_TOKEN            → 必须匹配该 secret
    //   ② 模式为 production（或未知/缺失，视同生产）→ 无 secret 即拒绝，绝不回退
    //   ③ 模式显式为 development 且 TEST_MODE === "1" → 允许开发测试码
    // 其余一切情况拒绝。
    // B2-01：模式判定统一由 _shared.js 的 resolveAuthMode 提供，本端点不再自行比较。
    const mode = resolveAuthMode(env);
    const strictProduction = mode.isProduction;
    const configuredBootstrap = String(env.FORMAL_BOOTSTRAP_TOKEN || "").trim();
    // 本地测试分支必须同时满足：显式 development + 显式测试开关。
    const testModeEnabled = mode.isTestMode;
    // 该常量只在路径 ③ 生效，且必须与 wrangler.toml [vars] 的 TEST_MODE 同时开启。
    // 生产环境绝不可设置 FORMAL_AUTH_TEST_MODE。
    const LOCAL_TEST_BOOTSTRAP = "123456";

    let bootstrapOk = false;
    if (configuredBootstrap) {
      bootstrapOk = supplied.length > 0 && supplied === configuredBootstrap;
    } else if (strictProduction) {
      // 生产（含模式缺失/空串/未知值）缺少开通凭据：明确拒绝并给出可执行提示。
      // 不得回退到开发默认码。
      const detail = mode.unrecognized
        ? `运行模式未识别（FORMAL_AUTH_MODE=${mode.raw === "" ? "空/缺失" : mode.raw}），按生产语义拒绝开通`
        : "生产环境未配置受控开通凭据（FORMAL_BOOTSTRAP_TOKEN），拒绝开通";
      return httpError(detail, 503, "bootstrap_not_configured");
    } else if (testModeEnabled) {
      bootstrapOk = supplied === LOCAL_TEST_BOOTSTRAP;
    }
    if (!bootstrapOk) return httpError("正式登录需要受控 bootstrap token", 401, "invalid_bootstrap_token");
    const email = String(body.email || "").trim().toLowerCase();
    const enterpriseName = String(body.enterpriseName || "").trim();
    if (!email || !enterpriseName) return httpError("邮箱和企业名称不能为空", 422);
    // The bootstrap code provisions a new external builder; it is never a password
    // for an existing member. Existing accounts must use their invitation/session
    // capability so a leaked shared code cannot select another role by email.
    const existingAccount = await env.DB.prepare("SELECT id,status FROM accounts WHERE lower(email)=lower(?)").bind(email).first();
    if (existingAccount) return httpError("该邮箱已有账号，请使用专属邀请或已登录会话", 409, "account_exists");
    let enterprise = await env.DB.prepare("SELECT * FROM enterprises WHERE lower(name)=lower(?)").bind(enterpriseName).first();
    if (!enterprise) {
      enterprise = { id: `ENT-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`, name: enterpriseName, authorization_status: "authorized" };
      await env.DB.prepare("INSERT INTO enterprises(id,name,authorization_status) VALUES (?,?,?)").bind(enterprise.id, enterprise.name, enterprise.authorization_status).run();
    } else if (enterprise.authorization_status !== "authorized") return httpError("企业授权状态不可用", 403);
    const account = { id: `ACC-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`, email, name: body.name || "", enterprise_id: enterprise.id, status: "active" };
    // The bootstrap code is the only path that grants external-builder standing,
    // so it is recorded on the account instead of being inferred from "has no
    // project membership". A revoked member and a two-project employee also have
    // no bound project, and must not receive builder capability (PRIV-P1-009).
    await env.DB.prepare("INSERT INTO accounts(id,email,name,enterprise_id,account_role) VALUES (?,?,?,?,'external_builder')").bind(account.id, account.email, account.name, account.enterprise_id).run();
    const token = crypto.randomUUID().replaceAll("-", "");
    const refreshToken = crypto.randomUUID().replaceAll("-", "");
    const expiresAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
    await env.DB.prepare("INSERT INTO sessions(token,account_id,expires_at,refresh_token) VALUES (?,?,?,?)").bind(token, account.id, expiresAt, refreshToken).run();
    return withSessionCookie(json({ account, enterprise: { id: enterprise.id, name: enterprise.name, authorizationStatus: enterprise.authorization_status }, session: { expiresAt, projectId: null } }), sessionCookie(token));
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
