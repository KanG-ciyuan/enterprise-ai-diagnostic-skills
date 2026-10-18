// PRIV-P1-009 — privilege separation around project creation.
//
// The formal login flow issues a session for ANY active account. When such an
// account has exactly one active project membership, login-consume binds the
// session to that project and the session role is the membership role. In every
// other case -- zero memberships, or two or more -- the session is left
// account-scoped (project_id NULL) and formalActor reports role "account".
//
// POST /api/projects accepted role "account", so an account-scoped session could
// create a project and, as its creator, receive an `external_builder` membership
// on it. Builder capability is supposed to come from the bootstrap-gated
// /api/auth/authorize path, so this let an account that was never provisioned as
// an external builder grant itself builder standing.
//
// Two real populations reach an account-scoped session:
//   1. a member whose project membership was revoked (zero active memberships)
//   2. an employee who participates in two or more projects
//
// The legitimate case must keep working: an external builder provisioned through
// authorize has zero memberships until it creates its first project, and must
// still be able to create that project.
//
// Run: node tests/privilege_escalation_runtime.mjs

import assert from "node:assert/strict";
import { D1Harness, bearerRequest } from "./d1_harness.mjs";
import { onRequestPost as createProject } from "../functions/api/projects.js";

const db = new D1Harness();
db.exec(`
  INSERT INTO enterprises(id,name) VALUES ('ENT-PE','Privilege Enterprise');
  INSERT INTO accounts(id,email,name,enterprise_id,status,account_role) VALUES
    ('BLD-PE','builder@example.invalid','Provisioned Builder','ENT-PE','active','external_builder'),
    ('REV-PE','revoked@example.invalid','Revoked Member','ENT-PE','active','member'),
    ('MULTI-PE','multi@example.invalid','Two Project Employee','ENT-PE','active','member');

  INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id) VALUES
    ('PRJ-PE1','Process One','Sales handoff','facts','active','L2','external_builder','BLD-PE'),
    ('PRJ-PE2','Process Two','Complaint refund','facts','active','L2','external_builder','BLD-PE'),
    ('PRJ-PE3','Process Three','Stock intake','facts','active','L2','external_builder','BLD-PE');

  -- REV-PE lost its only membership; MULTI-PE legitimately holds two.
  INSERT INTO project_memberships(project_id,account_id,role,status) VALUES
    ('PRJ-PE1','REV-PE','employee','revoked'),
    ('PRJ-PE2','MULTI-PE','employee','active'),
    ('PRJ-PE3','MULTI-PE','employee','active');

  -- Account-scoped sessions (project_id NULL) are exactly what login-consume
  -- produces for an account with zero or with two-plus active memberships.
  INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
    ('TOK-BLD-PE','BLD-PE',NULL,'2099-01-01T00:00:00Z','REF-BLD-PE'),
    ('TOK-REV-PE','REV-PE',NULL,'2099-01-01T00:00:00Z','REF-REV-PE'),
    ('TOK-MULTI-PE','MULTI-PE',NULL,'2099-01-01T00:00:00Z','REF-MULTI-PE');
`);

async function attemptCreateProject(token, key) {
  const response = await createProject({
    request: bearerRequest("http://127.0.0.1/api/projects", token, { name: `Self-serve ${key}`, scope: "Single process scope" }, { "Idempotency-Key": key }),
    env: { DB: db },
    params: {},
  });
  return { status: response.status, body: JSON.parse(await response.text()) };
}

function membershipRole(projectId, accountId) {
  const row = db.get("SELECT role,status FROM project_memberships WHERE project_id=? AND account_id=?", projectId, accountId);
  return row ? `${row.role}/${row.status}` : "none";
}

// 1. A member whose membership was revoked must not be able to self-serve into
//    builder standing.
const revoked = await attemptCreateProject("TOK-REV-PE", "pe-revoked");
assert.equal(
  revoked.status,
  403,
  `revoked member created a project (status ${revoked.status}); builder capability must come from the bootstrap-gated authorize path`,
);
assert.equal(db.get("SELECT COUNT(*) AS c FROM projects WHERE created_by_account_id='REV-PE'").c, 0, "revoked member must not own a new project");

// 2. An employee in two projects is account-scoped for a different reason, but
//    is equally not an external builder.
const multi = await attemptCreateProject("TOK-MULTI-PE", "pe-multi");
assert.equal(
  multi.status,
  403,
  `two-project employee created a project (status ${multi.status}); project membership is not builder standing`,
);
assert.equal(db.get("SELECT COUNT(*) AS c FROM projects WHERE created_by_account_id='MULTI-PE'").c, 0, "member must not own a new project");
assert.equal(membershipRole("PRJ-PE2", "MULTI-PE"), "employee/active", "the member's own memberships must be untouched");

// 3. The legitimate path must survive: a builder provisioned through authorize
//    has zero memberships until it creates its first project.
const builder = await attemptCreateProject("TOK-BLD-PE", "pe-builder");
assert.equal(builder.status, 201, `provisioned builder was blocked (status ${builder.status}): ${JSON.stringify(builder.body)}`);
const newProjectId = builder.body.project.id;
assert.equal(membershipRole(newProjectId, "BLD-PE"), "external_builder/active", "the creator must receive external_builder on the new project");

console.log("privilege_separation_ok: revoked member blocked, two-project employee blocked, provisioned builder allowed");
db.close();
