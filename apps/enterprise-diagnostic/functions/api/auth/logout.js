import { clearSessionCookie, cors, formalActor, httpError, json, withSessionCookie } from "../../_shared.js";

async function logout({ request, env }) {
  const preflight = cors(request); if (preflight) return preflight;
  try {
    const current = await formalActor(request, env.DB);
    await env.DB.prepare("UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP WHERE token=? AND revoked_at IS NULL").bind(current.token).run();
    return withSessionCookie(json({ loggedOut: true }), clearSessionCookie());
  } catch (error) { return error instanceof Response ? error : httpError(error.message, 500); }
}

export const onRequestPost = logout;
export const onRequestDelete = logout;
