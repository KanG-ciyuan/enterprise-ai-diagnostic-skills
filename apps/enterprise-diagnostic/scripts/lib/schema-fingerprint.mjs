// R2A shared schema fingerprint / read-only classification library.
//
// Authority: migrations/0001..0013 are the only schema source. This module never
// writes to a database; it only introspects a SQLite/D1-local file and returns
// normalized structure, fingerprints, integrity scans and a state classification.
//
// Used by:
//   - scripts/gen-schema-snapshot.mjs        (generate schema.sql + generated constants)
//   - scripts/db-maintenance.mjs             (db.sh diagnose / init)
//   - tests/db_*.mjs                         (state matrix / generated artifacts)
//
// Normalization contract (fingerprint v1):
//   * business tables: fixed 19-name list (BUSINESS_TABLES)
//   * columns: name -> {type, notnull, default, pk}; column ORDER is NOT hashed
//   * table-level/column-level UNIQUE constraints: origin='u' column sets
//   * foreign keys: (child, childCol, parent, parentCol, onDelete, onUpdate, match)
//   * explicit named indexes: {name, unique, columns[{name,desc,collation}], predicate}
//   * autoincrement flag per table
//   * trigger/view counts + names (expected empty)
//   * excluded objects: sqlite_*, _cf_*, d1_migrations, diag_*, authorization_test_inbox
//
// The hash is sha256 over a canonical (recursively key-sorted) JSON document.
import { createHash } from "node:crypto";

export const FINGERPRINT_VERSION = 1;

export const BUSINESS_TABLES = Object.freeze([
  "accounts",
  "authorization_notification_outbox",
  "candidate_facts",
  "decision_packets",
  "enterprise_authorizations",
  "enterprises",
  "events",
  "evidence_materials",
  "evidence_supplements",
  "fact_judgments",
  "fact_second_confirmations",
  "idempotency_records",
  "invitations",
  "member_login_challenges",
  "owner_decisions",
  "project_memberships",
  "projects",
  "sessions",
  "work_items",
]);

export const EXCLUDED_TABLE_PATTERNS = Object.freeze([
  /^sqlite_/i,
  /^_cf_/i,
  /^diag_/i,
  /^d1_migrations$/,
  /^authorization_test_inbox$/,
]);

export function isExcludedTable(name) {
  return EXCLUDED_TABLE_PATTERNS.some((re) => re.test(String(name || "")));
}

export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Recursively sort object keys so JSON is deterministic. Arrays keep their order. */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function normalizeType(type) {
  return String(type || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function normalizeDefault(value) {
  if (value === null || value === undefined) return null;
  return String(value).trim().replace(/\s+/g, " ");
}

function normalizePredicate(predicate) {
  if (predicate === null || predicate === undefined) return null;
  const text = String(predicate).replace(/\s+/g, " ").trim();
  return text.length ? text : null;
}

function extractPredicate(sql) {
  if (!sql) return null;
  const match = String(sql).match(/\bWHERE\b([\s\S]+)$/i);
  return match ? normalizePredicate(match[1]) : null;
}

export function listUserTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name)
    .filter((name) => !isExcludedTable(name))
    .sort();
}

export function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function tableInfo(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all();
}

function indexList(db, table) {
  return db.prepare(`PRAGMA index_list(${quoteIdent(table)})`).all();
}

function indexInfo(db, indexName) {
  return db.prepare(`PRAGMA index_info(${quoteIdent(indexName)})`).all();
}

function indexXInfo(db, indexName) {
  return db.prepare(`PRAGMA index_xinfo(${quoteIdent(indexName)})`).all();
}

function foreignKeyList(db, table) {
  return db.prepare(`PRAGMA foreign_key_list(${quoteIdent(table)})`).all();
}

function createTableSql(db, table) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return row ? row.sql || "" : "";
}

function tableHasAutoincrement(db, table) {
  return /AUTOINCREMENT/i.test(createTableSql(db, table));
}

function columnSetOfIndex(db, indexName) {
  return indexInfo(db, indexName)
    .filter((row) => row.cid >= 0 && row.name)
    .sort((a, b) => a.seqno - b.seqno)
    .map((row) => row.name);
}

function explicitIndexesOf(db, table) {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL")
    .all(table)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const listed = indexList(db, table);
  return rows.map((row) => {
    const meta = listed.find((item) => item.name === row.name) || {};
    const xinfo = indexXInfo(db, row.name)
      .filter((item) => item.key === 1)
      .sort((a, b) => a.seqno - b.seqno)
      .map((item) => ({ name: item.name, desc: Number(item.desc) ? 1 : 0, collation: item.coll || "BINARY" }));
    return {
      name: String(row.name),
      unique: Number(meta.unique) ? 1 : 0,
      columns: xinfo,
      predicate: extractPredicate(row.sql),
    };
  });
}

function uniqueConstraintsOf(db, table) {
  return indexList(db, table)
    .filter((row) => row.origin === "u")
    .map((row) => ({ columns: columnSetOfIndex(db, row.name) }))
    .sort((a, b) => a.columns.join(",").localeCompare(b.columns.join(",")));
}

function foreignKeysOf(db, table) {
  return foreignKeyList(db, table)
    .map((row) => ({
      from: row.from,
      toTable: row.table,
      toColumn: row.to,
      onDelete: row.on_delete,
      onUpdate: row.on_update,
      match: row.match,
    }))
    .sort((a, b) =>
      `${a.from}->${a.toTable}.${a.toColumn}`.localeCompare(`${b.from}->${b.toTable}.${b.toColumn}`),
    );
}

function triggerViewSummary(db) {
  const triggers = db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
    .all()
    .map((row) => row.name)
    .sort();
  const views = db
    .prepare("SELECT name FROM sqlite_master WHERE type='view'")
    .all()
    .map((row) => row.name)
    .sort();
  return { triggers: { count: triggers.length, names: triggers }, views: { count: views.length, names: views } };
}

/**
 * Normalize the observable schema of a database.
 * Returns { canonical, columnOrderByTable, presentTables }.
 * `canonical` excludes column order (so it is a semantic fingerprint).
 */
export function normalizeSchema(db, { businessTables = BUSINESS_TABLES } = {}) {
  const tables = {};
  const columnOrderByTable = {};
  const presentTables = [];
  for (const table of [...businessTables].sort()) {
    if (!hasTable(db, table)) {
      tables[table] = { missing: true };
      continue;
    }
    presentTables.push(table);
    const info = tableInfo(db, table);
    const columns = {};
    columnOrderByTable[table] = info.map((row) => row.name);
    for (const row of info) {
      columns[row.name] = {
        type: normalizeType(row.type),
        notnull: Number(row.notnull) ? 1 : 0,
        default: normalizeDefault(row.dflt_value),
        pk: Number(row.pk) || 0,
      };
    }
    tables[table] = {
      columns,
      uniques: uniqueConstraintsOf(db, table),
      foreignKeys: foreignKeysOf(db, table),
      explicitIndexes: explicitIndexesOf(db, table),
      autoincrement: tableHasAutoincrement(db, table),
    };
  }
  const extraTables = listUserTables(db).filter((name) => !businessTables.includes(name));
  const canonical = {
    v: FINGERPRINT_VERSION,
    businessTables: [...businessTables].sort(),
    tables,
    extraTables,
    ...triggerViewSummary(db),
  };
  return { canonical, columnOrderByTable, presentTables };
}

export function countsOf(normalized) {
  let columns = 0;
  let fk = 0;
  let explicitIndexes = 0;
  let uniqueConstraints = 0;
  for (const detail of Object.values(normalized.canonical.tables)) {
    if (!detail || detail.missing) continue;
    columns += Object.keys(detail.columns).length;
    fk += detail.foreignKeys.length;
    explicitIndexes += detail.explicitIndexes.length;
    uniqueConstraints += detail.uniques.length;
  }
  return {
    tables: normalized.presentTables.length,
    columns,
    fk,
    explicitIndexes,
    uniqueConstraints,
    triggers: normalized.canonical.triggers.count,
    views: normalized.canonical.views.count,
  };
}

/** Fingerprint a database: { v, hash, counts, canonical, columnOrderByTable }. */
export function fingerprintOf(db, { businessTables = BUSINESS_TABLES } = {}) {
  const normalized = normalizeSchema(db, { businessTables });
  return {
    v: FINGERPRINT_VERSION,
    hash: sha256Hex(stableStringify(normalized.canonical)),
    counts: countsOf(normalized),
    canonical: normalized.canonical,
    columnOrderByTable: normalized.columnOrderByTable,
  };
}

/** Derive the expected contract (FK relations + unique keys) from a terminal database. */
export function deriveContract(db, { businessTables = BUSINESS_TABLES } = {}) {
  const fkRelations = [];
  const uniqueKeys = [];
  for (const table of [...businessTables].sort()) {
    if (!hasTable(db, table)) continue;
    for (const fk of foreignKeysOf(db, table)) {
      fkRelations.push({ child: table, childColumn: fk.from, parent: fk.toTable, parentColumn: fk.toColumn });
    }
    for (const unique of uniqueConstraintsOf(db, table)) {
      uniqueKeys.push({ kind: "table-unique", table, columns: unique.columns, predicate: null });
    }
    for (const index of explicitIndexesOf(db, table)) {
      if (!index.unique) continue;
      uniqueKeys.push({
        kind: "unique-index",
        table,
        columns: index.columns.map((column) => column.name),
        predicate: index.predicate,
      });
    }
  }
  const dedupe = (items) => [...new Map(items.map((item) => [stableStringify(item), item])).values()];
  return {
    fkRelations: dedupe(fkRelations).sort((a, b) =>
      stableStringify(a).localeCompare(stableStringify(b)),
    ),
    uniqueKeys: dedupe(uniqueKeys).sort((a, b) => stableStringify(a).localeCompare(stableStringify(b))),
  };
}

/** Read the wrangler D1 migration ledger (read-only). */
export function readLedger(db, knownMigrations) {
  const present = hasTable(db, "d1_migrations");
  const rows = present
    ? db.prepare("SELECT id, name, applied_at FROM d1_migrations ORDER BY id").all()
    : [];
  const names = rows.map((row) => row.name);
  const known = [...knownMigrations];
  const unknown = names.filter((name) => !known.includes(name));
  const tooNew = names.length > known.length;
  const contiguous = !tooNew && names.every((name, index) => known[index] === name);
  return {
    present,
    rows,
    names,
    unknown,
    tooNew,
    contiguous,
    prefixLength: contiguous ? names.length : null,
    head: names.length ? names[names.length - 1] : null,
  };
}

function tableColumnsSet(db, table) {
  return new Set(tableInfo(db, table).map((row) => row.name));
}

/**
 * Read-only integrity checks:
 *   - PRAGMA integrity_check
 *   - PRAGMA foreign_key_check (declared FKs only)
 *   - expected-FK orphan scan (covers relations that are declared in the authority
 *     but missing from a legacy database)
 *   - duplicate scan for expected unique keys (skip keys whose objects are absent,
 *     which is required for honest migration prefixes)
 */
export function scanDataIntegrity(db, { contract, businessTables = BUSINESS_TABLES } = {}) {
  const issues = [];
  let integrity = "ok";
  try {
    const rows = db.prepare("PRAGMA integrity_check").all();
    integrity = rows.length ? String(rows[0].integrity_check ?? "unknown") : "unknown";
  } catch (error) {
    integrity = `error: ${error && error.message ? error.message : String(error)}`;
  }
  if (integrity !== "ok") issues.push(`integrity_check=${integrity}`);

  let fkViolations = [];
  try {
    fkViolations = db.prepare("PRAGMA foreign_key_check").all();
  } catch {
    fkViolations = [];
  }
  if (fkViolations.length) issues.push(`foreign_key_check=${fkViolations.length}`);

  const orphanViolations = [];
  for (const relation of contract.fkRelations) {
    const { child, childColumn, parent, parentColumn } = relation;
    if (!hasTable(db, child) || !hasTable(db, parent)) continue;
    const childColumns = tableColumnsSet(db, child);
    const parentColumns = tableColumnsSet(db, parent);
    if (!childColumns.has(childColumn) || !parentColumns.has(parentColumn)) continue;
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count FROM ${quoteIdent(child)} AS c ` +
          `LEFT JOIN ${quoteIdent(parent)} AS p ON c.${quoteIdent(childColumn)} = p.${quoteIdent(parentColumn)} ` +
          `WHERE c.${quoteIdent(childColumn)} IS NOT NULL AND p.${quoteIdent(parentColumn)} IS NULL`,
      )
      .get();
    const count = Number(row ? row.count : 0);
    if (count > 0) orphanViolations.push({ ...relation, count });
  }
  if (orphanViolations.length) {
    issues.push(`orphan_rows=${orphanViolations.reduce((sum, item) => sum + item.count, 0)}`);
  }

  const duplicateViolations = [];
  for (const key of contract.uniqueKeys) {
    if (!hasTable(db, key.table)) continue;
    const tableColumns = tableColumnsSet(db, key.table);
    if (!key.columns.every((column) => tableColumns.has(column))) continue;
    const notNull = key.columns.map((column) => `${quoteIdent(column)} IS NOT NULL`).join(" AND ");
    const predicate = key.predicate ? `(${key.predicate}) AND (${notNull})` : notNull;
    const grouped = key.columns.map((column) => quoteIdent(column)).join(", ");
    try {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS count FROM (` +
            `SELECT 1 FROM ${quoteIdent(key.table)} WHERE ${predicate} ` +
            `GROUP BY ${grouped} HAVING COUNT(*) > 1)`,
        )
        .get();
      const count = Number(row ? row.count : 0);
      if (count > 0) duplicateViolations.push({ ...key, count });
    } catch {
      // Column/index shape not representable on this database; uniqueness is only
      // checked for keys whose objects exist (honest prefixes can be incomplete).
    }
  }
  if (duplicateViolations.length) {
    issues.push(`duplicate_keys=${duplicateViolations.length}`);
  }

  return {
    integrity,
    fkViolations: fkViolations.length,
    orphanViolations,
    duplicateViolations,
    ok: issues.length === 0,
    issues,
  };
}

export const INIT_ALLOWED_STATES = Object.freeze([
  "EMPTY",
  "MIGRATION_PARTIAL_OK",
  "MIGRATION_COMPLETE",
]);

function findPrefixHash(fingerprints, k) {
  if (!fingerprints || !Array.isArray(fingerprints.prefixes)) return null;
  const item = fingerprints.prefixes.find((entry) => entry.k === k);
  return item ? item.hash : null;
}

/**
 * Classify a database state without writing anything.
 *
 * @param db DatabaseSync connection
 * @param options.contract        expected FK relations/unique keys (terminal)
 * @param options.fingerprints    {terminal:{hash},prefixes:[{k,hash}],runtimeV1,schemaSqlV1,schemaSqlBooted}
 * @param options.knownMigrations ordered migration file names
 * @param options.businessTables  override business table list (tests)
 */
export function classifyDatabase(db, { contract, fingerprints, knownMigrations, businessTables = BUSINESS_TABLES }) {
  const userTables = listUserTables(db);
  const presentTables = userTables.filter((name) => businessTables.includes(name));
  const extraTables = userTables.filter((name) => !businessTables.includes(name));

  if (presentTables.length === 0) {
    if (extraTables.length > 0) {
      return {
        state: "UNKNOWN",
        reason: "no business tables but non-internal tables exist",
        extraTables,
      };
    }
    // R2A F3: never call a database EMPTY before inspecting the migration ledger.
    // A non-empty (or unknown/damaged) d1_migrations without business tables is an
    // anomalous state that must be refused, not silently initialized. Only a truly
    // empty database (no ledger, or an empty ledger created but nothing applied)
    // stays EMPTY.
    let ledger;
    try {
      ledger = readLedger(db, knownMigrations);
    } catch (error) {
      return {
        state: "UNKNOWN",
        reason: `migration ledger (d1_migrations) is unreadable or damaged: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const ledgerSummary = {
      present: ledger.present,
      rowCount: ledger.names.length,
      prefixLength: ledger.prefixLength,
      head: ledger.head,
      unknown: ledger.unknown,
    };
    if (!ledger.present || ledger.names.length === 0) {
      return {
        state: "EMPTY",
        reason: ledger.present ? "no business tables (migration ledger exists but is empty)" : "no business tables",
        ledger: ledgerSummary,
      };
    }
    if (ledger.unknown.length > 0 || ledger.tooNew) {
      return {
        state: "TOO_NEW",
        reason: `migration ledger has rows but no business tables: ${ledger.unknown.join(", ") || "(too many rows)"}`,
        ledger: ledgerSummary,
      };
    }
    if (!ledger.contiguous) {
      return {
        state: "UNKNOWN",
        reason: "migration ledger has rows but no business tables and is not a contiguous known prefix",
        ledger: ledgerSummary,
      };
    }
    return {
      state: "LEDGER_SCHEMA_CONFLICT",
      reason: "d1_migrations records applied migrations but no business tables exist",
      ledger: ledgerSummary,
    };
  }

  const fingerprint = fingerprintOf(db, { businessTables });
  const ledger = readLedger(db, knownMigrations);
  const data = scanDataIntegrity(db, { contract, businessTables });

  let state;
  let reason;
  if (ledger.names.length > 0) {
    if (ledger.unknown.length > 0 || ledger.tooNew) {
      state = "TOO_NEW";
      reason = `ledger contains unknown/newer migrations: ${ledger.unknown.join(", ") || "(extra rows)"}`;
    } else if (!ledger.contiguous) {
      state = "UNKNOWN";
      reason = "ledger names are not a contiguous prefix of the known migration chain";
    } else {
      const k = ledger.prefixLength;
      const expectedHash = k === knownMigrations.length ? fingerprints.terminal.hash : findPrefixHash(fingerprints, k);
      if (expectedHash && fingerprint.hash === expectedHash) {
        state = k === knownMigrations.length ? "MIGRATION_COMPLETE" : "MIGRATION_PARTIAL_OK";
        reason = `ledger prefix ${k}/${knownMigrations.length} matches schema fingerprint`;
      } else {
        state = "LEDGER_SCHEMA_CONFLICT";
        reason = `ledger prefix ${k} does not match the database fingerprint`;
      }
    }
  } else if (fingerprint.hash === fingerprints.terminal.hash) {
    state = "COMPLETE_NO_LEDGER";
    reason = "schema is at terminal state but no migration ledger rows exist";
  } else if (fingerprint.hash === fingerprints.runtimeV1.hash) {
    state = "RUNTIME_LEGACY";
    reason = "schema matches the historical runtime ensureSchema shape";
  } else if (
    fingerprint.hash === fingerprints.schemaSqlV1.hash ||
    fingerprint.hash === fingerprints.schemaSqlBooted.hash
  ) {
    state = "SCHEMASQL_LEGACY";
    reason = "schema matches a historical schema.sql shape";
  } else {
    state = "UNKNOWN";
    reason = "schema fingerprint does not match any known state";
  }

  const underlyingState = state;
  if (state !== "EMPTY" && !data.ok) {
    state = "DATA_CONFLICT";
    reason = `data integrity conflict (underlying state ${underlyingState}): ${data.issues.join("; ")}`;
  }

  return {
    state,
    reason,
    underlyingState,
    fingerprint: fingerprint.hash,
    counts: fingerprint.counts,
    ledger: {
      present: ledger.present,
      rowCount: ledger.names.length,
      prefixLength: ledger.prefixLength,
      head: ledger.head,
      unknown: ledger.unknown,
    },
    data: {
      ok: data.ok,
      integrity: data.integrity,
      fkViolations: data.fkViolations,
      orphanViolations: data.orphanViolations,
      duplicateViolations: data.duplicateViolations,
      issues: data.issues,
    },
    extraTables,
  };
}

/** Short human-readable summary for diagnostics. */
export function summarizeClassification(result) {
  const counts = result.counts || {};
  return {
    state: result.state,
    reason: result.reason,
    fingerprint: result.fingerprint,
    counts: {
      tables: counts.tables,
      columns: counts.columns,
      fk: counts.fk,
      explicitIndexes: counts.explicitIndexes,
      uniqueConstraints: counts.uniqueConstraints,
    },
    ledger: result.ledger,
    data_ok: result.data ? result.data.ok : null,
  };
}

/** Structural diff between two normalized fingerprints (for diagnose output). */
export function diffFingerprints(a, b) {
  const diffs = [];
  const tablesA = a.canonical.tables || {};
  const tablesB = b.canonical.tables || {};
  for (const table of Object.keys(tablesA).sort()) {
    const left = tablesA[table];
    const right = tablesB[table];
    if (!left || !right) continue;
    if (left.missing !== right.missing) {
      diffs.push({ table, kind: "presence", a: !left.missing, b: !right.missing });
      continue;
    }
    if (left.missing || right.missing) continue;
    const columnsA = left.columns || {};
    const columnsB = right.columns || {};
    for (const column of [...new Set([...Object.keys(columnsA), ...Object.keys(columnsB)])].sort()) {
      const ca = columnsA[column];
      const cb = columnsB[column];
      if (!ca || !cb) {
        diffs.push({ table, column, kind: "column_presence", a: Boolean(ca), b: Boolean(cb) });
      } else if (stableStringify(ca) !== stableStringify(cb)) {
        diffs.push({ table, column, kind: "column_attributes", a: ca, b: cb });
      }
    }
    if (stableStringify(left.uniques) !== stableStringify(right.uniques)) {
      diffs.push({ table, kind: "unique_constraints", a: left.uniques, b: right.uniques });
    }
    if (stableStringify(left.foreignKeys) !== stableStringify(right.foreignKeys)) {
      diffs.push({ table, kind: "foreign_keys", a: left.foreignKeys, b: right.foreignKeys });
    }
    if (stableStringify(left.explicitIndexes) !== stableStringify(right.explicitIndexes)) {
      diffs.push({ table, kind: "explicit_indexes", a: left.explicitIndexes, b: right.explicitIndexes });
    }
    if (left.autoincrement !== right.autoincrement) {
      diffs.push({ table, kind: "autoincrement", a: left.autoincrement, b: right.autoincrement });
    }
  }
  if (stableStringify(a.canonical.triggers) !== stableStringify(b.canonical.triggers)) {
    diffs.push({ kind: "triggers", a: a.canonical.triggers, b: b.canonical.triggers });
  }
  if (stableStringify(a.canonical.views) !== stableStringify(b.canonical.views)) {
    diffs.push({ kind: "views", a: a.canonical.views, b: b.canonical.views });
  }
  return diffs;
}
