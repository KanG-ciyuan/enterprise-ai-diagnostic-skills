/**
 * Minimal structured-output model caller for V0.2 diagnosis suggestions.
 *
 * Deliberately separate from the employee-interview caller in employee-turn.js: the
 * interview has quota leases, turn gates and retry semantics tied to a work item, and
 * none of that applies to a project-scoped suggestion draft. Keeping this file small
 * means the interview path is not touched at all.
 *
 * - One request, 20 s timeout, no automatic retry.
 * - Strict JSON parsing (a fenced block is tolerated, prose is not).
 * - Keys, prompts and raw responses are never logged.
 */
export class ModelError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function parseJsonContent(content) {
  const text = String(content || "").trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    return JSON.parse(candidate);
  } catch (_error) {
    throw new ModelError("model_output_invalid", 502, "模型未返回可解析的 JSON");
  }
}

export async function callStructuredModel({ env, system, user, timeoutMs = 20000, maxTokens = 1200 }) {
  const key = env?.DEEPSEEK_API_KEY;
  if (!key) throw new ModelError("model_unavailable", 503, "未配置模型凭据，无法生成诊断建议初稿");
  const base = (env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
  const model = env.DEEPSEEK_MODEL || "deepseek-chat";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        // This bounded diagnosis request needs final JSON, not a reasoning stream.
        // DeepSeek enables thinking by default; retain the existing output budget.
        thinking: { type: "disabled" },
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!response.ok) throw new ModelError("model_upstream_error", 502, `模型服务返回 ${response.status}`);
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new ModelError("model_output_empty", 502, "模型返回为空");
    if (payload?.choices?.[0]?.finish_reason === "length") throw new ModelError("model_output_truncated", 502, "模型输出达到上限，未获得完整建议");
    return parseJsonContent(content);
  } catch (error) {
    if (error instanceof ModelError) throw error;
    if (error?.name === "AbortError") throw new ModelError("model_timeout", 504, `模型调用超时（${timeoutMs}ms）`);
    throw new ModelError("model_transport_error", 502, "模型调用失败");
  } finally {
    clearTimeout(timer);
  }
}
