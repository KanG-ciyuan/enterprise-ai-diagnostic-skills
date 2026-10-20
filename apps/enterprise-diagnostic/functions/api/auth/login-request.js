import { DEV_FALLBACK_DELIVERY_MARKER, PROVIDER_DELIVERED_MARKER, cors, assertSchemaReady, httpError, json, isControlledTestRecipient, mayReturnLoginLinkInResponse, resolveAuthMode, sha256 } from "../../_shared.js";

const RESPONSE = { accepted: true, detail: "如果该邮箱已登记且仍有有效项目成员权限，验证链接会发送到邮箱。" };

function challengeToken() {
  return `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

async function deliver(env, email, token) {
  const provider = env.LOGIN_CHALLENGE_PROVIDER || env.MEMBER_LOGIN_PROVIDER;
  if (!provider?.send) throw new Error("login_provider_missing");
  const isolated = provider === env.LOGIN_CHALLENGE_PROVIDER;
  if (isolated && !email.endsWith(".invalid")) throw new Error("isolated_recipient_required");
  const baseUrl = String(env.FORMAL_APP_ORIGIN || "").replace(/\/$/, "") || `https://${String(env.FORMAL_HOSTNAME || "localhost")}`;
  const message = {
    to: email,
    subject: "诊断平台登录验证",
    loginUrl: `${baseUrl}/#login=${encodeURIComponent(token)}`,
  };
  if (isolated && env.FORMAL_AUTH_TEST_MODE === "1") message.token = token;
  await provider.send(message);
}

/**
 * 给 challenge 写入**来源标记**，并**核实写入确实持久化**。
 *
 * 为什么必须核实：如果标记写入静默失败，challenge 会停在无来源标记的状态，
 * 而生产语义只接受 PROVIDER_DELIVERED_MARKER —— 该凭证将永远无法被消费，
 * 却会给调用方一个"投递成功"的假象。更糟的是开发回退场景下，
 * 未打标的凭证在旧语义里等同于真实投递。故此处采取 fail-closed。
 *
 * 返回 true = 已确认持久化；false = 写入未生效（调用方必须据此失败关闭）。
 */
async function markDeliverySource(env, challengeId, tokenHash, marker) {
  const result = await env.DB.prepare("UPDATE member_login_challenges SET delivery_error=? WHERE id=? AND token_hash=?")
    .bind(marker, challengeId, tokenHash).run();
  return Number(result?.meta?.changes || 0) === 1;
}

export async function onRequestPost({ request, env }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    await assertSchemaReady(env.DB);
    // B2-01：模式判定唯一来源（_shared.js），本端点不自行比较 FORMAL_AUTH_MODE。
    const mode = resolveAuthMode(env);
    const body = await request.json().catch(() => ({}));
    const email = String(body?.email || "").trim().toLowerCase();
    const configuredProvider = env.LOGIN_CHALLENGE_PROVIDER || env.MEMBER_LOGIN_PROVIDER;
    const canDeliver = Boolean(configuredProvider?.send);
    if (email && email.includes("@")) {
      const account = await env.DB.prepare("SELECT id,email FROM accounts WHERE lower(email)=lower(?) AND status='active'").bind(email).first();
      if (account) {
        const token = challengeToken();
        const tokenHash = await sha256(token);
        const challengeId = `CH-${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        const claimed = await env.DB.prepare("INSERT INTO member_login_challenges(id,account_id,token_hash,expires_at,delivery_status) SELECT ?,?,?,?,'dispatching' WHERE NOT EXISTS (SELECT 1 FROM member_login_challenges WHERE account_id=? AND created_at>datetime('now','-5 minutes')) AND (SELECT COUNT(*) FROM member_login_challenges WHERE account_id=? AND created_at>datetime('now','-1 day'))<3")
          .bind(challengeId, account.id, tokenHash, expiresAt, account.id, account.id).run();
        if (Number(claimed?.meta?.changes || 0) === 1) {
          await env.DB.prepare("UPDATE member_login_challenges SET consumed_at=CURRENT_TIMESTAMP,delivery_status='superseded' WHERE account_id=? AND id!=? AND consumed_at IS NULL AND EXISTS (SELECT 1 FROM member_login_challenges WHERE id=? AND delivery_status='dispatching')").bind(account.id, challengeId, challengeId).run();
          if (canDeliver) {
            // B2-01：响应体内返回登录链接必须同时满足三条件（显式 development +
            // 显式测试开关 + 受控 .invalid 收件人）。生产语义与真实业务邮箱一律不返回。
            const returnsLinkInResponse = mayReturnLoginLinkInResponse(mode, account.email);
            // B-1：凭证来源必须**正向**标注，否则生产语义无法区分真实投递与历史回退。
            const sourceMarker = returnsLinkInResponse && isControlledTestRecipient(account.email)
              ? DEV_FALLBACK_DELIVERY_MARKER      // 该凭证会把链接放进响应体 → 标为开发回退
              : PROVIDER_DELIVERED_MARKER;        // 链接只经由 provider 送达 → 标为真实投递
            let marked = false;
            let sendFailed = false;
            // 分三段独立捕获，以便准确区分「投递失败」与「来源标记未持久化」：
            // 前者是 provider 的问题（用户重试即可，响应保持防枚举的统一文案）；
            // 后者是数据层的问题（必须 fail-closed，且不能让调用方以为已经成功）。
            try {
              await deliver(env, account.email, token);
            } catch (error) {
              // 投递本身失败：记录真实原因。此时**不得**写入任何来源标记。
              sendFailed = true;
              await env.DB.prepare("UPDATE member_login_challenges SET delivery_status='failed',delivery_error=?,consumed_at=CURRENT_TIMESTAMP WHERE id=? AND token_hash=?").bind(String(error?.message || "delivery_failed").slice(0, 120), challengeId, tokenHash).run();
            }
            if (!sendFailed) {
              try {
                await env.DB.prepare("UPDATE member_login_challenges SET delivery_status='delivered' WHERE id=? AND token_hash=?").bind(challengeId, tokenHash).run();
                marked = await markDeliverySource(env, challengeId, tokenHash, sourceMarker);
              } catch (_markError) {
                marked = false;   // 落库异常同样视为"未能确认持久化"
              }
            }
            if (marked && returnsLinkInResponse) {
              const baseUrl = new URL(request.url).origin;
              return json({ accepted: true, detail: "开发/验收模式：邮件投递已尝试，同时生成当前环境的一次性登录链接。", loginUrl: `${baseUrl}/#login=${encodeURIComponent(token)}` }, 202);
            }
            // 投递失败：已记录真实原因并作废，返回防枚举的统一文案。
            if (sendFailed) return json(RESPONSE, 202);
            if (marked) return json(RESPONSE, 202);
            // 投递成功但**来源标记未能确认持久化**：fail-closed。
            // ① 作废该 challenge，避免留下无法判定来源、可能被误用的凭证；
            // ② 明确告知未能完成，而不是返回一个看似成功、实则无法登录的结果。
            await env.DB.prepare("UPDATE member_login_challenges SET delivery_status='failed',delivery_error='delivery_not_persisted',consumed_at=CURRENT_TIMESTAMP WHERE id=? AND token_hash=?").bind(challengeId, tokenHash).run();
            return httpError("登录链接生成未完成，请重新请求。", 503, "login_delivery_not_persisted");
          }
          // Development/acceptance fallback: when no provider is bound, return a
          // one-time link so the owner can keep testing. Production must configure
          // a reviewed provider and never exposes the token in the response.
          // 无 provider 时：生产语义（含未识别取值）绝不生成可用凭证，直接作废该 challenge。
          if (!mayReturnLoginLinkInResponse(mode, account.email)) {
            const why = mode.isProduction ? "login_provider_missing" : "dev_link_requires_controlled_recipient";
            await env.DB.prepare("UPDATE member_login_challenges SET delivery_status='failed',delivery_error=?,consumed_at=CURRENT_TIMESTAMP WHERE id=? AND token_hash=?").bind(why, challengeId, tokenHash).run();
            return json(RESPONSE, 202);
          }
          // 开发回退凭证：正向标注为 dev_fallback_link，供 login-consume 在生产语义下拒绝。
          await env.DB.prepare("UPDATE member_login_challenges SET delivery_status='delivered' WHERE id=? AND token_hash=?").bind(challengeId, tokenHash).run();
          const fallbackMarked = await markDeliverySource(env, challengeId, tokenHash, DEV_FALLBACK_DELIVERY_MARKER);
          if (!fallbackMarked) {
            await env.DB.prepare("UPDATE member_login_challenges SET delivery_status='failed',delivery_error='delivery_not_persisted',consumed_at=CURRENT_TIMESTAMP WHERE id=? AND token_hash=?").bind(challengeId, tokenHash).run();
            return httpError("登录链接生成未完成，请重新请求。", 503, "login_delivery_not_persisted");
          }
          const baseUrl = new URL(request.url).origin;
          return json({ accepted: true, detail: "未配置邮件投递：已生成直接登录链接。", loginUrl: `${baseUrl}/#login=${encodeURIComponent(token)}` }, 202);
        }
      }
    }
    return json(RESPONSE, 202);
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}
