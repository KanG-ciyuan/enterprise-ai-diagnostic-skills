import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

class D1Statement {
  constructor(owner, sql, values = []) { this.owner = owner; this.sql = sql; this.values = values; }
  bind(...values) { return new D1Statement(this.owner, this.sql, values); }
  run() { return this.owner.runStatement(this); }
  first() { return this.owner.database.prepare(this.sql).get(...this.values) || null; }
  all() { return { results: this.owner.database.prepare(this.sql).all(...this.values) }; }
}

export class D1Harness {
  constructor({ loadSchema = true } = {}) {
    this.database = new DatabaseSync(":memory:");
    this.failOnEvent = false;
    this.failSqlOncePattern = null;
    this.simulateOldSplitWrites = process.argv.includes("--simulate-old-split-writes");
    if (loadSchema) this.database.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  }
  prepare(sql) { return new D1Statement(this, sql); }
  runStatement(statement) {
    if (this.failOnEvent && /^INSERT INTO events/i.test(statement.sql.trim())) throw new Error("injected event write failure");
    if (this.failSqlOncePattern?.test(statement.sql)) {
      this.failSqlOncePattern = null;
      throw new Error("injected SQL write failure");
    }
    const result = this.database.prepare(statement.sql).run(...statement.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
  batch(statements) {
    if (this.simulateOldSplitWrites) return statements.map((statement) => this.runStatement(statement));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => this.runStatement(statement));
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
  exec(sql) { this.database.exec(sql); }
  get(sql, ...values) { return this.database.prepare(sql).get(...values); }
  all(sql, ...values) { return this.database.prepare(sql).all(...values); }
  count(table) { return Number(this.get(`SELECT COUNT(*) AS count FROM ${table}`).count); }
  close() { this.database.close(); }
}

export function bearerRequest(url, token, body = undefined, headers = {}) {
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
