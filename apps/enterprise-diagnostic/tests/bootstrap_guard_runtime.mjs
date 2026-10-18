import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { onRequestPost as authorize } from "../functions/api/auth/authorize.js";
import { D1Harness } from "./d1_harness.mjs";

/**
 * V0.1 第一批 · 默认开通码安全回归
 *
 * 覆盖三件事：
 *  1. 生产模式缺少 FORMAL_BOOTSTRAP_TOKEN 时必须安全拒绝（不得回退到开发默认码）；
 *  2. 环境变量丢失（自愈式回退）必须被拒绝 —— 这是 2026-10-14 生产事故的形态；
 *  3. 公开页面不得再出现固定默认开通码。
 *
 * 直接调用真实生产 handler，使用真实 schema.sql。
 */

function invoke(env, body) {
  return authorize({
    request: new Request("http://127.0.0.1/api/auth/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  });
}

const baseBody = (tag) => ({
  email: `builder-${tag}@example.invalid`,
  enterpriseName: `GuardTest-${tag}`,
  name: "Guard",
  bootstrapToken: "123456",
});

async function status(env, body) {
  const db = new D1Harness();
  try {
    const response = await invoke({ ...env, DB: db }, body);
    const payload = await response.json().catch(() => ({}));
    return { status: response.status, code: payload.code || "", detail: payload.detail || "" };
  } finally {
    db.close();
  }
}

// ── (b) 核心回归：环境变量缺失时提交开发默认码必须被拒绝 ────────────────
// 这是旧实现的失败形态：strictProduction=false 且无 secret → 回退 "123456"。
// D-3 之后，模式缺失属"未识别取值"，按生产语义处理，因此返回 503（配置错误）
// 而不是 401；关键断言是"绝不放行"。
{
  const result = await status({}, baseBody("nofallback"));
  assert.notEqual(result.status, 200, `变量缺失时不得回退到开发默认码，实际 ${result.status}`);
  assert.equal(result.status, 503, JSON.stringify(result));
  assert.equal(result.code, "bootstrap_not_configured");
  console.log("  ✔ 环境变量缺失 + 提交 123456 → 503 拒绝（无回退，按生产语义）");
}

// ── (a) 生产模式 + 无开通凭据 + 提交 123456 → 拒绝 ───────────────────────
{
  const result = await status({ FORMAL_AUTH_MODE: "production" }, baseBody("prod-nosecret"));
  assert.equal(result.status, 503, JSON.stringify(result));
  assert.equal(result.code, "bootstrap_not_configured");
  console.log("  ✔ 生产模式 + 无 FORMAL_BOOTSTRAP_TOKEN → 503 安全拒绝");
}

// ── 生产模式 + test mode 开着也必须拒绝（test mode 不得凌驾于生产之上）──
{
  const result = await status(
    { FORMAL_AUTH_MODE: "production", FORMAL_AUTH_TEST_MODE: "1" },
    baseBody("prod-testmode"),
  );
  assert.equal(result.status, 503, JSON.stringify(result));
  assert.equal(result.code, "bootstrap_not_configured");
  console.log("  ✔ 生产模式 + TEST_MODE=1（配置错误）+ 无 secret → 仍 503 拒绝");
}

// ── (D-3) 空串 / 拼写错误 / 未知值：一律安全拒绝（黑名单判定的补丁）────────
// 独立验收 D-3：旧实现用 `=== "production"` 判定，空串与拼写错误会被当成"非生产"
// 从而落进本地测试分支。以下三条锁定"未识别取值 = 生产语义 = 拒绝"。
for (const [label, mode] of [
  ["空串", ""],
  ["拼写错误 productionn", "productionn"],
  ["未知值 staging", "staging"],
]) {
  const result = await status({ FORMAL_AUTH_MODE: mode, FORMAL_AUTH_TEST_MODE: "1" }, baseBody(`mode-${label}`));
  assert.equal(result.status, 503, `${label} 必须安全拒绝，实际 ${result.status} ${JSON.stringify(result)}`);
  assert.equal(result.code, "bootstrap_not_configured", `${label} 应给出配置错误码`);
  console.log(`  ✔ FORMAL_AUTH_MODE=${label} + TEST_MODE=1 → 503 安全拒绝（即使误留测试开关）`);
}

// ── 空串 + 无任何其他变量，同样拒绝 ────────────────────────────────────
{
  const result = await status({ FORMAL_AUTH_MODE: "" }, baseBody("mode-empty-alone"));
  assert.equal(result.status, 503, JSON.stringify(result));
  console.log("  ✔ FORMAL_AUTH_MODE 为空且无测试开关 → 503 安全拒绝");
}

// ── (d) 生产模式 + 正确 FORMAL_BOOTSTRAP_TOKEN → 允许 ───────────────────
{
  const db = new D1Harness();
  try {
    const response = await authorize({
      request: new Request("http://127.0.0.1/api/auth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...baseBody("prod-ok"), bootstrapToken: "s3cret-controlled" }),
      }),
      env: { DB: db, FORMAL_AUTH_MODE: "production", FORMAL_BOOTSTRAP_TOKEN: "s3cret-controlled" },
    });
    assert.equal(response.status, 200, `生产 + 正确 secret 应放行，实际 ${response.status}`);
    const payload = await response.json();
    assert.ok(payload.account?.id, "应创建改造方账号");
    assert.match(String(response.headers.get("set-cookie") || ""), /__Host-diagnostic_session=/);
    assert.match(String(response.headers.get("set-cookie") || ""), /Secure/);
    assert.match(String(response.headers.get("set-cookie") || ""), /HttpOnly/);
    assert.match(String(response.headers.get("set-cookie") || ""), /SameSite=Lax/);
    console.log("  ✔ 生产 + 正确 FORMAL_BOOTSTRAP_TOKEN → 200 且会话 Cookie 属性未退化");
  } finally {
    db.close();
  }
}

// ── 生产模式 + 错误开通码 → 401 ─────────────────────────────────────────
{
  const result = await status(
    { FORMAL_AUTH_MODE: "production", FORMAL_BOOTSTRAP_TOKEN: "s3cret-controlled" },
    baseBody("prod-wrong"),
  );
  assert.equal(result.status, 401, JSON.stringify(result));
  console.log("  ✔ 生产 + 错误开通码 → 401");
}

// ── (c) 非生产 + TEST_MODE=1 + 开发测试码 → 允许（本地开发路径）─────────
{
  const db = new D1Harness();
  try {
    const response = await authorize({
      request: new Request("http://127.0.0.1/api/auth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(baseBody("local-ok")),
      }),
      env: { DB: db, FORMAL_AUTH_MODE: "development", FORMAL_AUTH_TEST_MODE: "1" },
    });
    assert.equal(response.status, 200, `本地显式开启 test mode 应可用，实际 ${response.status}`);
    console.log("  ✔ 非生产 + TEST_MODE=1 + 123456 → 200（本地开发路径保持可用）");
  } finally {
    db.close();
  }
}

// ── 非生产但未显式开启 TEST_MODE → 拒绝（默认安全）──────────────────────
{
  const result = await status({ FORMAL_AUTH_MODE: "development" }, baseBody("local-nomode"));
  assert.equal(result.status, 401, JSON.stringify(result));
  console.log("  ✔ 非生产但未开启 TEST_MODE → 401（默认拒绝）");
}

// ── (e) 静态断言：公开页面不得再出现固定默认开通码 ──────────────────────
{
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(!html.includes('value="123456"'), "index.html 不得预填固定开通码");
  assert.ok(!html.includes("本地演示开通码"), "index.html 不得展示可用开通码文案");
  assert.ok(html.includes('name="bootstrapToken"'), "开通码输入框应保留（改为由管理员发放）");
  console.log("  ✔ index.html 已移除固定默认开通码与凭据文案");
}

console.log("bootstrap guard runtime: ok");
