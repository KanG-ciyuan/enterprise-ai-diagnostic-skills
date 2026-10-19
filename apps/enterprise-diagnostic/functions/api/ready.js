import { assertSchemaReady, httpError, json } from "../_shared.js";

/**
 * GET /api/ready — schema readiness (not liveness).
 *
 * 200 { ready: true, schema: "<migration head>", tables: 19 }
 * 503 { detail, code }  e.g. db_not_initialized / db_schema_unmanaged /
 *                       db_schema_outdated / db_schema_unsupported / db_schema_incomplete
 *
 * Read-only: never creates tables, never applies migrations, never writes.
 * Liveness (SELECT 1) stays at GET /api/health.
 */
export async function onRequestGet({ env }) {
  try {
    const ready = await assertSchemaReady(env.DB);
    return json({ ready: true, schema: ready.head, tables: ready.tables });
  } catch (error) {
    return error instanceof Response ? error : httpError(error && error.message ? error.message : "数据库未就绪。", 503, "db_schema_unknown");
  }
}
