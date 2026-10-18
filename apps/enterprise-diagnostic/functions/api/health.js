import { json } from "../_shared.js";
export async function onRequestGet({ env }) { const row = await env.DB.prepare("SELECT 1 AS ok").first(); return json({ status: row?.ok === 1 ? "ok" : "error", storage: "cloudflare-d1" }); }
