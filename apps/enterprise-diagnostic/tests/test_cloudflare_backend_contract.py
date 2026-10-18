from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).parents[1]
FUNCTIONS = ROOT / "functions"


class CloudflareBackendContractTest(unittest.TestCase):
    def read(self, relative):
        return (FUNCTIONS / relative).read_text(encoding="utf-8")

    def test_all_shared_module_imports_resolve_from_the_handler_directory(self):
        for handler in FUNCTIONS.glob("api/**/*.js"):
            source = handler.read_text(encoding="utf-8")
            matches = list(re.finditer(r"from\s+['\"]([^'\"]*_shared\.js)['\"]", source))
            for match in matches:
                self.assertTrue((handler.parent / match.group(1)).resolve().is_file(), str(handler.relative_to(FUNCTIONS)))

    def test_cloudflare_function_routes_exist(self):
        for route in (
            "api/health.js",
            "api/auth/login-request.js",
            "api/auth/login-consume.js",
            "api/projects/[projectId].js",
            "api/projects/[projectId]/work-items.js",
            "api/projects/[projectId]/events.js",
            "api/projects/[projectId]/invitations.js",
            "api/invitations/[invitationRef]/accept.js",
            "api/invitations/[invitationRef]/revoke.js",
            "api/projects/[projectId]/employee-task.js",
            "api/formal/projects/[projectId]/verifier-facts.js",
            "api/work-items/[itemId]/employee-draft.js",
            "api/work-items/[itemId]/employee-submission.js",
            "api/work-items/[itemId]/evidence-supplement.js",
            "api/work-items/[itemId]/verification.js",
            "api/work-items/[itemId]/owner-decision.js",
        ):
            self.assertTrue((FUNCTIONS / route).exists(), route)

    def test_member_reauthentication_uses_hashed_single_use_challenges(self):
        request_route = self.read("api/auth/login-request.js")
        consume_route = self.read("api/auth/login-consume.js")
        schema = (ROOT / "schema.sql").read_text(encoding="utf-8")
        shared = self.read("_shared.js")
        self.assertIn("member_login_challenges", schema)
        self.assertIn("member_login_challenges", shared)
        self.assertIn("sha256", request_route + consume_route)
        self.assertRegex(request_route, r"202")
        self.assertRegex(request_route, r"FROM accounts[\s\S]*status='active'")
        # Challenge issuance deliberately does NOT require a membership. The
        # 2026-09 relaxation recorded in docs/agent-integration-handoff-v2.md
        # removed that gate so a provisioned account with zero memberships can
        # still reach the builder workspace. Project access is therefore
        # enforced after login, not at the login gate; see
        # test_project_access_requires_an_active_membership_after_login.
        self.assertIn("consumed_at IS NULL", consume_route)
        self.assertIn("UPDATE member_login_challenges", consume_route)
        self.assertIn("HttpOnly", shared)
        self.assertNotRegex(consume_route, r"json\s*\([^)]*tokenValue")

    def test_project_access_requires_an_active_membership_after_login(self):
        shared = self.read("_shared.js")
        # A session bound to a project that has no active membership for the
        # account is rejected: the project-scoped 403 gate in formalActor.
        self.assertRegex(shared, r"project_memberships[\s\S]*status\s*=\s*'active'")
        self.assertRegex(shared, r"当前会话没有项目成员权限")
        # Every project route re-checks membership independently of the session.
        self.assertIn("SELECT * FROM project_memberships WHERE project_id=? AND account_id=? AND status='active'", shared)
        self.assertIn("无权访问该项目", shared)

    def test_formal_d4_decision_packet_routes_and_storage_exist(self):
        for route in (
            "api/formal/projects/[projectId]/confirmed-facts.js",
            "api/formal/projects/[projectId]/decision-packet.js",
            "api/formal/projects/[projectId]/decision-packets/draft.js",
            "api/formal/decision-packets/[packetId]/verify.js",
            "api/formal/decision-packets/[packetId]/publish.js",
            "api/formal/projects/[projectId]/owner-packet.js",
            "api/formal/decision-packets/[packetId]/owner-decision.js",
        ):
            self.assertTrue((FUNCTIONS / route).exists(), route)
        schema = (ROOT / "schema.sql").read_text(encoding="utf-8")
        shared = self.read("_shared.js")
        for table in ("decision_packets", "owner_decisions"):
            self.assertIn(f"CREATE TABLE IF NOT EXISTS {table}", schema)
            self.assertIn(f"CREATE TABLE IF NOT EXISTS {table}", shared)

    def test_formal_d4_handlers_enforce_human_gates_and_owner_summary_boundary(self):
        draft = self.read("api/formal/projects/[projectId]/decision-packets/draft.js")
        verify = self.read("api/formal/decision-packets/[packetId]/verify.js")
        publish = self.read("api/formal/decision-packets/[packetId]/publish.js")
        owner = self.read("api/formal/projects/[projectId]/owner-packet.js")
        decision = self.read("api/formal/decision-packets/[packetId]/owner-decision.js")
        self.assertIn("external_builder", draft + publish)
        self.assertIn("judgment_status='confirmed'", draft)
        self.assertIn("verifier", verify)
        self.assertIn("verifier_checked", verify + publish)
        self.assertIn("published", owner + decision)
        self.assertIn("evidenceItems", draft)
        self.assertIn("confirmedFacts", owner)
        self.assertIn("decisionReceipt", owner)
        self.assertNotIn("evidenceItems", owner)
        self.assertNotIn("FROM evidence_materials", owner)
        for raw_material_field in ("source_type", "reference", "content_json"):
            self.assertNotIn(raw_material_field, owner)
        self.assertIn("owner_decisions", decision)
        for field in ("reason", "scope", "constraints", "successMetrics", "stopConditions", "downstreamOwner"):
            self.assertIn(field, decision)

    def test_formal_d4_builder_and_verifier_read_routes_match_fastapi_contract(self):
        facts = self.read("api/formal/projects/[projectId]/confirmed-facts.js")
        packet = self.read("api/formal/projects/[projectId]/decision-packet.js")
        for phrase in ("formalActor", "requireMembership", "external_builder", "judgment_status='confirmed'", "factId", "materialStatus"):
            self.assertIn(phrase, facts)
        for phrase in ("formalActor", "requireMembership", "external_builder", "verifier", "decisionPacketPayload", "draft", "verifier_checked", "404"):
            self.assertIn(phrase, packet)

    def test_formal_employee_routes_use_server_identity_and_persist_intake_fields(self):
        task = self.read("api/projects/[projectId]/employee-task.js")
        draft = self.read("api/work-items/[itemId]/employee-draft.js")
        submission = self.read("api/work-items/[itemId]/employee-submission.js")
        for source in (task, draft, submission):
            self.assertIn("formalActor", source)
            self.assertNotIn("actor(request)", source)
            self.assertIn("assignee_account_id", source)
        for phrase in ("workflowCard", "materialStatus", "Idempotency-Key"):
            self.assertIn(phrase, submission)
        self.assertIn("employee_draft_json", draft)

    def test_formal_submission_requires_an_active_assigned_verifier(self):
        handler = self.read("api/work-items/[itemId]/employee-submission.js")
        self.assertRegex(handler, r"FROM\s+project_memberships(?:\s+(?:AS\s+)?\w+)?[\s\S]*JOIN\s+invitations")
        self.assertRegex(handler, r"project_memberships[\s\S]*project_id\s*=\s*\?")
        self.assertRegex(handler, r"role='verifier'[\s\S]*status='active'")
        self.assertRegex(handler, r"invitations[\s\S]*status='accepted'")
        self.assertRegex(handler, r"accepted_account_id\s*=\s*[^\s]+\.account_id")
        self.assertRegex(handler, r"invitations[^\n]*project_id\s*=\s*[^\s]+\.project_id")
        self.assertRegex(handler, r"\.bind\(\s*item\.project_id\s*\)")
        self.assertIn("assigned_verifier_id: assignedVerifierId", handler)
        self.assertRegex(handler, r"handoff[\s\S]*receiverId\s*:\s*assignedVerifierId")
        blocked = re.search(
            r"if\s*\(\s*!assignedVerifierId\s*\)\s*\{(?P<body>[\s\S]*?return[\s\S]*?;)[\s\S]*?\}",
            handler,
        )
        self.assertIsNotNone(blocked, "missing no-verifier blocking branch")
        blocked_body = blocked.group("body")
        for phrase in (
            "employee_draft_json",
            "body.workflowCard",
            "materialStatus",
            'stage: "mapping"',
            'status: "blocked_draft"',
            "verifier_not_ready",
            "409",
        ):
            self.assertIn(phrase, blocked_body)
        self.assertNotIn("appendEvent", blocked_body)

    def test_formal_session_uses_secure_http_only_cookie_and_can_restore(self):
        shared = self.read("_shared.js")
        session_path = FUNCTIONS / "api/auth/session.js"
        self.assertTrue(session_path.is_file(), "api/auth/session.js")
        session_route = session_path.read_text(encoding="utf-8")
        self.assertRegex(shared, r"__Host-diagnostic_session=[^;]*;\s*Path=/;\s*Secure;\s*HttpOnly;\s*SameSite=Lax")
        self.assertRegex(shared, r"formalActor[\s\S]*request\.headers\.get\(['\"]Cookie['\"]\)")
        self.assertRegex(shared, r"revoked_at[\s\S]*(expires_at|expired)")
        self.assertRegex(shared, r"new Date\([^)]*expires_at[^)]*\)\s*<=\s*new Date")
        self.assertIn("onRequestGet", session_route)
        self.assertIn("formalActor", session_route)
        self.assertRegex(session_route, r"json\s*\(\s*\{[\s\S]*(account|accountId)[\s\S]*projectId[\s\S]*role")
        self.assertRegex(session_route, r"(revoked_at|revoked)[\s\S]*(401|重新登录)")
        self.assertRegex(session_route, r"(expires_at|expired)[\s\S]*(401|重新登录)")
        self.assertNotRegex(session_route, r"json\s*\(\s*\{[\s\S]*refreshToken")

    def test_production_browser_auth_is_cookie_only_and_bearer_is_local_only(self):
        shared = self.read("_shared.js")
        client = (ROOT / "api-client.js").read_text(encoding="utf-8")
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        self.assertIn('credentials: "same-origin"', client)
        for forbidden in ("setSessionToken", "sessionToken", "Authorization"):
            self.assertNotIn(forbidden, client)
        self.assertNotIn('params.get("session")', app)
        self.assertNotIn("formalSessionToken", app)
        self.assertIn("restoreSession", app)
        self.assertRegex(shared, r"new URL\(request\.url\)\.hostname")
        self.assertRegex(shared, r"(?:localhost|127\.0\.0\.1)[\s\S]*bearerToken")
        self.assertRegex(shared, r"token\s*=\s*(?:localBearerAllowed|isLocalhost)[^;]*\?[^:]*bearerToken[^:]*:[^;]*cookieToken")

    def test_formal_submission_commits_assignment_events_and_idempotency_atomically(self):
        handler = self.read("api/work-items/[itemId]/employee-submission.js")
        success = handler.split("const submittedAt", 1)[1]
        self.assertIn("env.DB.batch(", success)
        self.assertIn("UPDATE work_items", success)
        self.assertGreaterEqual(success.count("INSERT INTO events"), 2)
        self.assertIn("INSERT", success)
        self.assertIn("idempotency_records", success)
        for forbidden in ("await updateItem", "await appendEvent", "await storeIdempotent"):
            self.assertNotIn(forbidden, success)

    def test_formal_submission_uses_cas_transition_token_for_concurrent_writers(self):
        schema = (ROOT / "schema.sql").read_text(encoding="utf-8")
        shared = self.read("_shared.js")
        handler = self.read("api/work-items/[itemId]/employee-submission.js")
        self.assertIn("last_submission_key", schema)
        self.assertIn("last_submission_key", shared)
        self.assertRegex(handler, r"UPDATE work_items[\s\S]*last_submission_key[\s\S]*WHERE id=\?[\s\S]*stage=\?[\s\S]*status=\?[\s\S]*submission_version=\?")
        self.assertGreaterEqual(len(re.findall(r"INSERT INTO events[\s\S]*?SELECT[\s\S]*?last_submission_key=\?", handler)), 2)
        self.assertRegex(handler, r"INSERT INTO idempotency_records[\s\S]*SELECT[\s\S]*last_submission_key=\?")
        self.assertRegex(handler, r"last_submission_key\s*!==\s*transitionKey[\s\S]*(409|submission_conflict)")

    def test_confirmed_fact_refs_registered_authorized_material(self):
        schema = (ROOT / "schema.sql").read_text(encoding="utf-8")
        verify = self.read("api/work-items/[itemId]/verification.js")
        for phrase in ("enterprise_authorizations", "evidence_materials", "authorization_record_id", "authorization_status", "integrity_status"):
            self.assertIn(phrase, schema)
        self.assertRegex(verify, r"for\s*\([^)]*sourceRef[^)]*of\s+sourceRefs\s*\)")
        self.assertRegex(verify, r"SELECT[\s\S]*FROM evidence_materials[\s\S]*id\s*=\s*\?[\s\S]*project_id\s*=\s*\?")
        self.assertRegex(verify, r"authorization_status[\s\S]*authorized")
        self.assertRegex(verify, r"integrity_status[\s\S]*(checked|verified)")
        for code in ("unknown_source_ref", "cross_project_source_ref", "unauthorized_source_ref", "unverified_source_ref"):
            self.assertIn(code, verify)
        self.assertRegex(verify, r"eligibleMaterials\.push\([^)]*material[^)]*\)")
        self.assertRegex(verify, r"eligibleMaterials\.length\s*!==\s*sourceRefs\.length")

    def test_one_flow_card_produces_two_to_five_candidate_facts(self):
        schema = (ROOT / "schema.sql").read_text(encoding="utf-8")
        submit = self.read("api/work-items/[itemId]/employee-submission.js")
        self.assertIn("candidate_facts", schema)
        self.assertRegex(submit, r"(?:function|const)\s+candidateFactsFromWorkflowCard")
        self.assertRegex(submit, r"candidateFacts\.length\s*<\s*2")
        self.assertRegex(submit, r"candidateFacts\.length\s*>\s*5")
        self.assertRegex(submit, r"INSERT\s+INTO\s+candidate_facts")

    def test_authorization_and_material_registry_are_external_builder_owned(self):
        for route in (
            "api/projects/[projectId]/authorizations.js",
            "api/projects/[projectId]/materials.js",
        ):
            self.assertTrue((FUNCTIONS / route).exists(), route)
            source = self.read(route)
            self.assertIn("formalActor", source)
            self.assertIn("requireMembership", source)
            self.assertIn('current.role !== "external_builder"', source)
        materials = self.read("api/projects/[projectId]/materials.js")
        schema = (ROOT / "schema.sql").read_text(encoding="utf-8")
        self.assertRegex(schema, r"enterprise_authorizations[^;]*name TEXT NOT NULL")
        self.assertIn("crypto.randomUUID", materials)
        self.assertIn("authorization_record_id", materials)
        self.assertIn("integrity_status", materials)

    def test_builder_cannot_self_attest_authorization_or_material_integrity(self):
        authorizations = self.read("api/projects/[projectId]/authorizations.js")
        materials = self.read("api/projects/[projectId]/materials.js")
        self.assertNotIn("body.status", authorizations)
        self.assertRegex(authorizations, r"INSERT INTO enterprise_authorizations[\s\S]*'pending'")
        self.assertNotIn("body.integrityStatus", materials)
        self.assertRegex(materials, r'bind\([^)]*"pending"')
        for route in (
            "api/projects/[projectId]/authorizations/[authorizationId]/confirm.js",
            "api/projects/[projectId]/materials/[materialId]/review.js",
        ):
            self.assertTrue((FUNCTIONS / route).exists(), route)
        confirmation = self.read("api/projects/[projectId]/authorizations/[authorizationId]/confirm.js")
        review = self.read("api/projects/[projectId]/materials/[materialId]/review.js")
        self.assertIn("body.confirmationToken", confirmation)
        self.assertIn("confirmation_token_hash", confirmation)
        self.assertIn("token_consumed_at", confirmation)
        self.assertNotIn("formalActor", confirmation)
        for phrase in ("confirmed_by_identity", "confirmed_at", "confirmation_reason", "status='pending'"):
            self.assertIn(phrase, confirmation)
        self.assertIn("AUTHORIZATION_CONFIRMATION_QUEUE", authorizations)
        self.assertIn("crypto.randomUUID", authorizations)
        self.assertNotRegex(authorizations, r"return json\(\{[^}]*confirmationToken")
        for phrase in ("formalActor", "requireMembership", "assigned_verifier_id", "reviewed_by_account_id", "reviewed_at", "review_reason"):
            self.assertIn(phrase, review)

    def test_authorization_delivery_is_addressed_retryable_and_non_orphaning(self):
        schema = (ROOT / "schema.sql").read_text(encoding="utf-8")
        create = self.read("api/projects/[projectId]/authorizations.js")
        resend_path = "api/projects/[projectId]/authorizations/[authorizationId]/resend.js"
        self.assertTrue((FUNCTIONS / resend_path).exists())
        resend = self.read(resend_path)
        for field in ("authorizer_name", "authorizer_email", "creation_idempotency_key", "confirmation_token_nonce", "confirmation_token_expires_at", "confirmation_delivery_status", "confirmation_delivery_attempts", "confirmation_delivery_last_error", "confirmation_delivery_last_attempt_at"):
            self.assertIn(field, schema)
        for phrase in ("authorizerEmail", "toLowerCase", "recipientEmail", "confirmationUrl", "AUTHORIZATION_CONFIRMATION_HMAC_SECRET", "confirmation_delivery_status='failed'", "authorizationId"):
            self.assertIn(phrase, create)
        self.assertNotRegex(create, r"return json\([^\n]*confirmationToken")
        for phrase in ("formalActor", "external_builder", "confirmation_token_nonce", "recipientEmail", "confirmationUrl", "confirmation_delivery_attempts", "status='pending'", "token_consumed_at IS NULL"):
            self.assertIn(phrase, resend)
        self.assertNotIn("body.authorizerEmail", resend)
        self.assertIn("crypto.randomUUID", resend)
        self.assertIn("confirmation_token_expires_at", resend)
        self.assertTrue((ROOT / "migrations" / "0005_authorization_capability.sql").exists())
        self.assertTrue((ROOT / "migrations" / "0006_authorization_notification_outbox.sql").exists())
        self.assertIn("authorization_notification_outbox", schema + create)
        self.assertIn("notificationId", create + resend)
        self.assertIn("providerIdempotencyKey", create + resend)
        self.assertIn("INSERT INTO idempotency_records", create)
        self.assertIn("env.DB.batch", create)

    def test_queue_producer_and_notification_consumer_contract_are_checked_in(self):
        wrangler = (ROOT / "wrangler.toml").read_text(encoding="utf-8")
        consumer_config = ROOT / "wrangler.authorization-consumer.toml"
        consumer_path = ROOT / "workers" / "authorization-confirmation-consumer.js"
        delivery_doc = ROOT / "AUTHORIZATION_CONFIRMATION_DELIVERY.md"
        self.assertIn("[[queues.producers]]", wrangler)
        self.assertIn('binding = "AUTHORIZATION_CONFIRMATION_QUEUE"', wrangler)
        self.assertTrue(consumer_config.exists())
        self.assertTrue(consumer_path.exists())
        self.assertTrue(delivery_doc.exists())
        consumer = consumer_path.read_text(encoding="utf-8")
        for phrase in ("queue(batch, env)", "recipientEmail", "confirmationUrl", "confirmationToken", "NOTIFICATION_PROVIDER", "message.ack()", "message.retry()"):
            self.assertIn(phrase, consumer)
        for phrase in ("env.DB.prepare", "confirmation_delivery_status='delivered'", "confirmation_delivery_status='provider_retrying'"):
            self.assertIn(phrase, consumer)
        self.assertIn('binding = "DB"', consumer_config.read_text(encoding="utf-8"))
        self.assertNotIn("API_KEY", consumer + consumer_config.read_text(encoding="utf-8"))

    def test_high_impact_fact_requires_distinct_persisted_second_confirmation(self):
        schema = (ROOT / "schema.sql").read_text(encoding="utf-8")
        verify = self.read("api/work-items/[itemId]/verification.js")
        self.assertIn("fact_second_confirmations", schema)
        self.assertNotIn("body.secondConfirmation === true", verify)
        self.assertIn("first_verified_by_account_id", verify)
        self.assertRegex(verify, r"first_verified_by_account_id\s*===\s*current\.accountId")
        self.assertIn("INSERT INTO fact_second_confirmations", verify)
        self.assertIn("secondConfirmationReason", verify)

    def test_material_source_type_is_required_and_propagated(self):
        schema = (ROOT / "schema.sql").read_text(encoding="utf-8")
        sources = "\n".join(self.read(route) for route in (
            "api/projects/[projectId]/materials.js",
            "api/formal/projects/[projectId]/verifier-facts.js",
            "api/formal/projects/[projectId]/confirmed-facts.js",
            "api/formal/projects/[projectId]/decision-packets/draft.js",
        ))
        self.assertIn("source_type TEXT NOT NULL", schema)
        for source_type in ("pdf", "image", "csv", "xlsx", "text"):
            self.assertIn(source_type, sources)
        self.assertIn("sourceType", sources)

    def test_evidence_registry_has_versioned_d1_migration(self):
        migration = ROOT / "migrations" / "0002_evidence_registry.sql"
        self.assertTrue(migration.exists())
        source = migration.read_text(encoding="utf-8")
        for phrase in ("enterprise_authorizations", "evidence_materials", "candidate_facts", "fact_second_confirmations", "source_type"):
            self.assertIn(phrase, source)
        self.assertTrue((ROOT / "migrations" / "0003_evidence_delivery_upgrade.sql").exists())

    def test_legacy_preview_rows_are_upgraded_and_self_attestation_is_downgraded(self):
        legacy = """
        CREATE TABLE enterprise_authorizations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, scope TEXT NOT NULL, reference TEXT NOT NULL, status TEXT NOT NULL, created_by_account_id TEXT NOT NULL, confirmation_token_hash TEXT NOT NULL, token_consumed_at TEXT, confirmed_by_identity TEXT, confirmed_at TEXT, confirmation_reason TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE evidence_materials (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, version INTEGER NOT NULL, source_type TEXT NOT NULL, authorization_record_id TEXT, authorization_status TEXT NOT NULL, integrity_status TEXT NOT NULL, visibility TEXT NOT NULL, created_by_account_id TEXT NOT NULL, work_item_id TEXT, label TEXT NOT NULL, reference TEXT NOT NULL, metadata_json TEXT NOT NULL, reviewed_by_account_id TEXT, reviewed_at TEXT, review_reason TEXT, created_at TEXT);
        INSERT INTO enterprise_authorizations VALUES ('AUTH-SELF','PRJ-1','Self','scope','ref','authorized','builder','hash',NULL,NULL,NULL,NULL,NULL,NULL);
        INSERT INTO enterprise_authorizations VALUES ('AUTH-OK','PRJ-1','Confirmed','scope','ref','authorized','builder','hash','used','authorizer','2026-01-01','checked',NULL,NULL);
        INSERT INTO evidence_materials VALUES ('MAT-SELF','PRJ-1',1,'text','AUTH-SELF','authorized','verified','project','builder',NULL,'Self','ref','{}',NULL,NULL,NULL,NULL);
        INSERT INTO evidence_materials VALUES ('MAT-OK','PRJ-1',1,'pdf','AUTH-OK','authorized','verified','project','builder',NULL,'Reviewed','ref','{}','verifier','2026-01-01','checked',NULL);
        """
        migration = (ROOT / "migrations" / "0003_evidence_delivery_upgrade.sql").read_text(encoding="utf-8")
        with tempfile.NamedTemporaryFile(suffix=".sqlite3") as handle:
            db = sqlite3.connect(handle.name)
            db.executescript(legacy)
            db.executescript(migration)
            self.assertEqual(db.execute("SELECT status FROM enterprise_authorizations WHERE id='AUTH-SELF'").fetchone()[0], "pending")
            self.assertEqual(db.execute("SELECT status FROM enterprise_authorizations WHERE id='AUTH-OK'").fetchone()[0], "authorized")
            self.assertEqual(db.execute("SELECT integrity_status FROM evidence_materials WHERE id='MAT-SELF'").fetchone()[0], "pending")
            self.assertEqual(db.execute("SELECT integrity_status FROM evidence_materials WHERE id='MAT-OK'").fetchone()[0], "verified")
            columns = {row[1] for row in db.execute("PRAGMA table_info(enterprise_authorizations)")}
            self.assertIn("authorizer_email", columns)
            self.assertIn("confirmation_delivery_status", columns)
            db.close()

    def test_candidate_fact_open_status_is_consistent(self):
        schema = (ROOT / "schema.sql").read_text(encoding="utf-8")
        submit = self.read("api/work-items/[itemId]/employee-submission.js")
        supplement = self.read("api/work-items/[itemId]/evidence-supplement.js")
        self.assertIn("DEFAULT 'open'", schema)
        self.assertNotIn('status: "pending"', submit)
        self.assertIn("status='open'", supplement)

    def test_confirmation_identity_is_immutable_registered_authorizer(self):
        confirm = self.read("api/projects/[projectId]/authorizations/[authorizationId]/confirm.js")
        self.assertNotIn("body.authorizerName", confirm)
        self.assertIn("authorizer_name", confirm)
        self.assertIn("authorizer_email", confirm)
        self.assertRegex(confirm, r"confirmed_by_identity[\s\S]*(?:authorizer_email|name)")
        self.assertIn("confirmation_token_expires_at", confirm)
        self.assertIn("datetime(confirmation_token_expires_at)>datetime(?)", confirm)
        self.assertNotIn("confirmation_token_expires_at>CURRENT_TIMESTAMP", confirm)

    def test_high_impact_classification_is_deterministic_and_requires_distinct_actor(self):
        submit = self.read("api/work-items/[itemId]/employee-submission.js")
        verify = self.read("api/work-items/[itemId]/verification.js")
        for topic in ("归属", "金额", "审批责任", "合规", "重大风险"):
            self.assertIn(topic, submit)
        self.assertIn("classifyImpactLevel", submit)
        self.assertIn('impactLevel: classifyImpactLevel', submit)
        self.assertIn("awaiting_second_confirmation", verify)
        self.assertIn("first_verified_by_account_id === current.accountId", verify)

    def test_target_project_membership_overrides_stale_session_role(self):
        shared = self.read("_shared.js")
        verify = self.read("api/work-items/[itemId]/verification.js")
        self.assertRegex(shared, r"actor_\.projectId[\s\S]*!==\s*projectId")
        self.assertIn("actor_.role = membership.role", shared)
        self.assertRegex(verify, r"requireMembership[\s\S]*current\.role\s*!==\s*\"verifier\"")

    def test_fact_transitions_are_atomic_cas_batches(self):
        schema = (ROOT / "schema.sql").read_text(encoding="utf-8")
        verify = self.read("api/work-items/[itemId]/verification.js")
        self.assertIn("last_transition_key", schema)
        self.assertGreaterEqual(verify.count("env.DB.batch("), 3)
        for phrase in ("INSERT INTO fact_judgments", "INSERT INTO fact_second_confirmations", "INSERT INTO evidence_supplements", "INSERT INTO events", "last_transition_key=?", "transition_conflict"):
            self.assertIn(phrase, verify)
        success = verify.split("const body", 1)[-1]
        self.assertNotIn("await appendEvent", success)
        self.assertNotIn("await updateItem", success)

    def test_dlq_marks_terminal_delivery_without_infinite_retry(self):
        consumer = (ROOT / "workers" / "authorization-confirmation-consumer.js").read_text(encoding="utf-8")
        config = (ROOT / "wrangler.authorization-consumer.toml").read_text(encoding="utf-8")
        dlq_config = ROOT / "wrangler.authorization-dlq.toml"
        dlq_worker = ROOT / "workers" / "authorization-confirmation-dlq.js"
        self.assertIn('dead_letter_queue = "enterprise-authorization-confirmations-dlq"', config)
        self.assertTrue(dlq_config.exists())
        self.assertTrue(dlq_worker.exists())
        dlq = dlq_worker.read_text(encoding="utf-8")
        for phrase in ("failed_terminal", "message.ack()"):
            self.assertIn(phrase, dlq)
        self.assertNotIn("confirmation_delivery_attempts=confirmation_delivery_attempts+1", dlq)
        self.assertIn("confirmation_delivery_attempts=confirmation_delivery_attempts+1", consumer)
        self.assertRegex(consumer, r"!validMessage[\s\S]*failed_terminal[\s\S]*message\.ack\(\)")

    def test_decision_draft_expands_complete_referenced_fact_groups(self):
        draft = self.read("api/formal/projects/[projectId]/decision-packets/draft.js")
        verify = self.read("api/formal/decision-packets/[packetId]/verify.js")
        publish = self.read("api/formal/decision-packets/[packetId]/publish.js")
        fact_gate = self.read("api/formal/decision-packets/_facts.js")
        self.assertIn("referencedWorkItemIds", draft)
        self.assertRegex(draft, r"FROM candidate_facts[\s\S]*work_item_id IN")
        self.assertIn("incomplete_fact_group", draft)
        self.assertRegex(draft, r"factRefs\s*=\s*facts\.map")
        self.assertIn("FROM candidate_facts", fact_gate)
        self.assertNotIn("FROM work_items", verify + publish)
        for source in (verify, publish):
            self.assertIn("env.DB.batch", source)
            self.assertIn("idempotency_records", source)
            self.assertIn("transition_conflict", source)
        self.assertIn("INSERT INTO events", publish)
        self.assertNotIn("appendEvent", publish)

    def test_materials_use_stable_keys_and_immutable_version_rows(self):
        schema = (ROOT / "schema.sql").read_text(encoding="utf-8")
        materials = self.read("api/projects/[projectId]/materials.js")
        supplement = self.read("api/work-items/[itemId]/evidence-supplement.js")
        for phrase in ("material_key", "previous_version_id", "UNIQUE(project_id, material_key, version)"):
            self.assertIn(phrase, schema)
        for phrase in ("materialKey", "version", "previousVersionId"):
            self.assertIn(phrase, materials + supplement)
        self.assertRegex(supplement, r"MAX\(version\)[\s\S]*material_key")
        self.assertIn("materialVersion", supplement)
        self.assertIn("newEvidenceVersion", supplement)
        self.assertTrue((ROOT / "migrations" / "0004_fact_cas_material_versions.sql").exists())

    def test_evidence_supplement_is_atomic_cas_and_safely_replayable(self):
        supplement = self.read("api/work-items/[itemId]/evidence-supplement.js")
        self.assertEqual(1, supplement.count("env.DB.batch("))
        for phrase in (
            "UPDATE evidence_supplements",
            "status='waiting'",
            "INSERT INTO evidence_materials",
            "UPDATE candidate_facts",
            "UPDATE work_items",
            "INSERT INTO events",
            "INSERT INTO idempotency_records",
            "findIdempotent",
            "transition_conflict",
            "results[0]?.meta?.changes",
        ):
            self.assertIn(phrase, supplement)
        success = supplement.split("await env.DB.batch(", 1)[-1]
        self.assertNotIn("await appendEvent", success)
        self.assertNotIn("await updateItem", success)
        self.assertIn("materialVersion", supplement)
        self.assertIn("newEvidenceVersion", supplement)

    def test_evidence_supplement_runtime_state_transitions(self):
        result = subprocess.run(
            ["node", "--no-warnings", str(ROOT / "tests" / "evidence_supplement_runtime.mjs")],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_decision_packet_runtime_uses_candidate_fact_ids(self):
        result = subprocess.run(
            ["node", "--no-warnings", str(ROOT / "tests" / "decision_packet_runtime.mjs")],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_owner_revision_runtime_requires_builder_revision_and_reverification(self):
        result = subprocess.run(
            ["node", "--no-warnings", str(ROOT / "tests" / "owner_revision_runtime.mjs")],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_authorization_runtime_capability_access_and_idempotency(self):
        result = subprocess.run(
            ["node", "--no-warnings", str(ROOT / "tests" / "authorization_runtime.mjs")],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_runtime_schema_and_migration_chain_do_not_duplicate_columns(self):
        result = subprocess.run(
            ["node", "--no-warnings", str(ROOT / "tests" / "migration_runtime.mjs")],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_fact_verification_and_supplement_keep_independent_server_gates(self):
        verify = self.read("api/work-items/[itemId]/verification.js")
        supplement = self.read("api/work-items/[itemId]/evidence-supplement.js")
        draft = self.read("api/formal/projects/[projectId]/decision-packets/draft.js")
        self.assertIn("body.factId", verify)
        self.assertIn("NOT EXISTS", verify)
        self.assertIn("second_confirmation_status", verify + draft)
        self.assertIn("responsible_account_id", supplement)
        self.assertIn("addBusinessDays", supplement)
        self.assertIn("integrity_status", supplement)
        self.assertNotIn('authorizationStatus: "authorized"', supplement)

    def test_formal_project_reads_reject_demo_identity_and_scope_membership(self):
        work_items = self.read("api/projects/[projectId]/work-items.js")
        events = self.read("api/projects/[projectId]/events.js")
        for source in (work_items, events):
            self.assertIn("formalActor", source)
            self.assertIn("startsWith(\"PRJ-\")", source)
            self.assertIn("project_memberships", source)
        submission = self.read("api/work-items/[itemId]/employee-submission.js")
        self.assertIn("startsWith(\"PRJ-\")", submission)

    def test_schema_contains_formal_work_item_fields_and_idempotency_migration(self):
        schema = (ROOT / "schema.sql").read_text(encoding="utf-8")
        for column in ("assignee_account_id", "employee_draft_json", "material_status", "workflow_card_json"):
            self.assertIn(column, schema)
        shared = self.read("_shared.js")
        self.assertIn("idempotency_records", shared)
        self.assertIn("work_items", shared)

    def test_formal_invitation_chain_has_server_scoped_lifecycle(self):
        create = self.read("api/projects/[projectId]/invitations.js")
        accept = self.read("api/invitations/[invitationRef]/accept.js")
        revoke = self.read("api/invitations/[invitationRef]/revoke.js")
        self.assertIn("formalActor", create)
        self.assertIn("Idempotency-Key", create + self.read("_shared.js"))
        for phrase in ("requireMembership", "external_builder", "owner", "职责冲突", "token", "expiresAt"):
            self.assertIn(phrase, create)
        for phrase in ("pending", "expired", "邮箱不匹配", "accepted_account_id", "project_memberships", "sessions", "invitation_accepted"):
            self.assertIn(phrase, accept)
        for phrase in ("formalActor", "requireMembership", "revoked", "invitation_revoked"):
            self.assertIn(phrase, revoke)
        self.assertRegex(
            revoke,
            r"appendEvent\(env\.DB,\s*invitation\.project_id,\s*null,\s*[\"']invitation_revoked[\"'],\s*current,",
        )

    def test_invitation_accept_batches_winner_only_side_effects(self):
        accept = self.read("api/invitations/[invitationRef]/accept.js")
        self.assertIn("env.DB.batch(", accept)
        self.assertRegex(accept, r"INSERT INTO accounts[\s\S]*SELECT[\s\S]*status='pending'")
        for table in ("project_memberships", "work_items", "sessions", "events"):
            self.assertRegex(accept, rf"(?:INSERT INTO|UPDATE) {table}[\s\S]*status='pending'")
        self.assertRegex(accept, r"UPDATE invitations SET status='accepted'[\s\S]*status='pending'")
        self.assertRegex(accept, r"accepted_account_id[\s\S]*session[\s\S]*(409|已使用)")
        winner_section = accept.split("env.DB.batch(", 1)[1]
        for forbidden in ("await appendEvent", 'await env.DB.prepare("INSERT INTO sessions'):
            self.assertNotIn(forbidden, winner_section)

    def test_formal_invitation_schema_and_bootstrap_cover_legacy_d1(self):
        schema = (ROOT / "schema.sql").read_text(encoding="utf-8")
        shared = self.read("_shared.js")
        for table in ("enterprises", "accounts", "project_memberships", "invitations", "sessions", "idempotency_records"):
            self.assertIn(f"CREATE TABLE IF NOT EXISTS {table}", schema)
            self.assertIn(f"CREATE TABLE IF NOT EXISTS {table}", shared)
        self.assertIn("数据库结构缺失，请先执行 schema.sql 迁移", shared)

    def test_shared_api_enforces_demo_actor_and_maps_response_fields(self):
        shared = self.read("_shared.js")
        for phrase in ("X-Demo-Role", "X-Demo-User", "401", "projectId", "assigneeRole", "appendEvent"):
            self.assertIn(phrase, shared)

    def test_write_handlers_preserve_handoff_contract(self):
        submission = self.read("api/work-items/[itemId]/employee-submission.js")
        verification = self.read("api/work-items/[itemId]/verification.js")
        decision = self.read("api/work-items/[itemId]/owner-decision.js")
        self.assertIn("employee_submitted", submission)
        self.assertIn("handoff", submission)
        self.assertIn("fact_confirmed", verification)
        self.assertIn("evidence_insufficient", verification)
        self.assertIn("owner_decision", decision)

    def test_schema_has_clean_seed_and_indexes(self):
        schema = (ROOT / "schema.sql").read_text(encoding="utf-8")
        seed = (ROOT / "seed.sql").read_text(encoding="utf-8")
        for table in ("projects", "work_items", "events"):
            self.assertIn(f"CREATE TABLE IF NOT EXISTS {table}", schema)
        self.assertIn("CREATE INDEX", schema)
        self.assertIn("DIA-CRM-001", seed)
        self.assertIn("needs_input", seed)

    def test_client_uses_relative_cloudflare_api(self):
        client = (ROOT / "api-client.js").read_text(encoding="utf-8")
        self.assertIn('const formalBaseUrl = ""', client)
        self.assertIn('const demoBaseUrl = isLocalHost ? "http://127.0.0.1:8000" : ""', client)
        self.assertRegex(client, r"formalRequest[\s\S]*fetch\(`\$\{formalBaseUrl\}\$\{path\}`")
        self.assertRegex(client, r"publicFormalRequest[\s\S]*fetch\(formalBaseUrl \+ path")
        self.assertRegex(client, r"async function request[\s\S]*fetch\(`\$\{demoBaseUrl\}\$\{path\}`")
        self.assertNotIn("previewRequest", client)
        self.assertIn("return request(`/api", client)

    def test_formal_request_supports_idempotency_and_recoverable_unauthorized(self):
        client = (ROOT / "api-client.js").read_text(encoding="utf-8")
        self.assertIn("Idempotency-Key", client)
        self.assertIn("status === 401", client)
        self.assertIn("restoreSession", client)
        self.assertIn('credentials: "same-origin"', client)

    def test_bootstrap_cannot_rebind_existing_member_and_project_create_is_idempotent(self):
        authorize = self.read("api/auth/authorize.js")
        projects = self.read("api/projects.js")
        self.assertIn("account_exists", authorize)
        self.assertIn("findIdempotent", projects)
        self.assertIn("project-create", projects)
        self.assertIn("Idempotency-Key", projects + self.read("_shared.js"))

    def test_supplement_authorization_binding_and_employee_only_responsibility(self):
        supplement = self.read("api/work-items/[itemId]/evidence-supplement.js")
        verification = self.read("api/work-items/[itemId]/verification.js")
        verifier_facts = self.read("api/formal/projects/[projectId]/verifier-facts.js")
        binding = self.read("api/projects/[projectId]/materials/[materialId]/authorization-binding.js")
        self.assertIn("responsible_account_id", supplement)
        self.assertIn("authorization_record_id", binding)
        self.assertIn("external_builder", binding)
        self.assertIn("role='employee'", verification)
        self.assertNotIn("'external_builder'", verifier_facts.split("responsibleResult", 1)[-1])

    def test_security_and_recoverable_evidence_runtime(self):
        result = subprocess.run(
            ["node", "--no-warnings", str(ROOT / "tests" / "security_recovery_runtime.mjs")],
            cwd=ROOT, capture_output=True, text=True,
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_employee_submission_reuses_one_logical_key_and_preserves_409_payload(self):
        client = (ROOT / "api-client.js").read_text(encoding="utf-8")
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        self.assertRegex(client, r"constructor\(message, status = 0, payload")
        self.assertIn("this.payload", client)
        self.assertIn("this.code", client)
        self.assertRegex(client, r"submitFormalEmployee\([^)]*idempotencyKey[^)]*\)[\s\S]*idempotencyKey")
        for phrase in ("formalEmployeeSubmissionKey", "formalEmployeeReceipt", "crypto.randomUUID", "error.payload", "blocked_draft", "waiting_assignment"):
            self.assertIn(phrase, app)
        self.assertRegex(app, r"formalEmployeeSubmissionKey[\s\S]*submitFormalEmployee\([\s\S]*formalEmployeeSubmissionKey")
        self.assertRegex(app, r"handoffStatus === \"assigned\"[\s\S]*formalEmployeeStep = \"submitted\"")
        self.assertRegex(app, r"edit-formal-employee[\s\S]*formalEmployeeSubmissionKey = \"\"")
        self.assertNotIn("error.status !== 0", app)
        self.assertRegex(app, r"error\.status >= 400 && error\.status < 500[\s\S]*formalEmployeeSubmissionKey = \"\"")

    def test_waiting_employee_can_recheck_and_resume_preserved_workflow_card(self):
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        employee_task = self.read("api/projects/[projectId]/employee-task.js")
        self.assertIn('data-action="recheck-formal-employee"', app)
        self.assertIn("async function recheckFormalEmployeeAssignment", app)
        self.assertRegex(app, r"recheck-formal-employee[\s\S]*recheckFormalEmployeeAssignment\(\)")
        self.assertRegex(app, r"draftAnswers[\s\S]*workflowCard")
        self.assertIn("submissionReady", employee_task)
        self.assertRegex(employee_task, r"project_memberships[\s\S]*invitations[\s\S]*submissionReady")
        self.assertRegex(app, r"recheckFormalEmployeeAssignment[\s\S]*getEmployeeTask[\s\S]*submissionReady[\s\S]*formalEmployeeStep = \"card\"")
        self.assertRegex(app, r"submissionReady[\s\S]*formalEmployeeStep = \"waiting\"")
        self.assertRegex(app, r"waiting_assignment[\s\S]*formalEmployeeStep = \"waiting\"")

    def test_formal_employee_actions_disable_while_pending(self):
        app = (ROOT / "app.js").read_text(encoding="utf-8")
        self.assertIn("formalEmployeeSaving", app)
        self.assertIn("disabled", app)
        self.assertIn("formalEmployeeSubmitting", app)

    def test_formal_verifier_queue_and_supplement_recovery_are_session_scoped(self):
        queue = self.read("api/formal/projects/[projectId]/verifier-facts.js")
        verification = self.read("api/work-items/[itemId]/verification.js")
        supplement = self.read("api/work-items/[itemId]/evidence-supplement.js")
        shared = self.read("_shared.js")
        for phrase in ("formalActor", "requireMembership", "assigned_verifier_id", "awaiting_verification"):
            self.assertIn(phrase, queue)
        for phrase in ("same", "different_with_correction", "insufficient_evidence", "reason", "sourceRefs", "requestedMaterial", "responsiblePerson", "deadline", "recoveryEntry"):
            self.assertIn(phrase, verification)
        for phrase in ("formalActor", "evidence_version", "awaiting_verification", "candidate_fact_id", "evidence_provided"):
            self.assertIn(phrase, supplement)
        for column in ("candidate_fact_id", "evidence_version", "assigned_verifier_id", "evidence_supplements", "fact_judgments"):
            self.assertIn(column, shared)
        self.assertIn("X-Demo-Role", shared)

    def test_submitted_employee_can_reopen_only_own_blocked_fact_for_supplementation(self):
        task = self.read("api/projects/[projectId]/employee-task.js")
        submission = self.read("api/work-items/[itemId]/employee-submission.js")
        for phrase in ("source_employee_account_id", "status='blocked'", "assignee_account_id"):
            self.assertIn(phrase, task + submission)


if __name__ == "__main__":
    unittest.main()
