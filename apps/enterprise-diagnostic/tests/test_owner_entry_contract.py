from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]


class DiagnosticMvpContractTest(unittest.TestCase):
    def read(self, name):
        path = ROOT / name
        self.assertTrue(path.is_file(), name)
        return path.read_text(encoding="utf-8")

    def test_approved_reassessment_defaults_are_recorded_exactly(self):
        contract_path = ROOT.parents[1] / ".agent-workflow/05-pilot-2026-08-22/v1-product-contract.md"
        contract = contract_path.read_text(encoding="utf-8")
        for policy in (
            "submission_without_verifier = blocked_draft",
            "unsupported_fact_decision_eligibility = false",
            "formal_session = secure_http_only_cookie",
            "candidate_facts_per_flow_card = 2..5",
            "verification_sla = 2 business days",
            "supplement_sla = 5 business days",
            "owner_decision_sla = 5 business days",
            "enterprise_authorizer = named external authorization record",
        ):
            self.assertIn(policy, contract)

    def test_legacy_diagnostic_workbench_keeps_stage_rail_narrow(self):
        styles = self.read("styles.css")
        self.assertIn(
            ".workbench-layout { display: grid; grid-template-columns: 270px minmax(0, 1fr);",
            styles,
        )
        self.assertIn(".workbench-main { display: grid;", styles)

    def test_static_assets_and_mvp_views_exist(self):
        html = self.read("index.html")
        script = self.read("app.js")
        for name in ("styles.css", "mock-data.js", "app.js"):
            self.assertTrue((ROOT / name).is_file(), name)
        for view_id in ("invitation-gate-view", "project-list-view", "project-wizard-dialog", "diagnostic-workbench-view", "verifier-workbench-view", "owner-review-view"):
            self.assertIn(f'id="{view_id}"', html)
        for phrase in ("新建诊断项目", "客户交接流程", "开始模拟诊断"):
            self.assertIn(phrase, f"{html}\n{script}")
        self.assertIn('src="agent-adapter.js', html)

    def test_formal_owner_invitation_opens_summary_only_decision_workspace(self):
        html = self.read("index.html")
        script = self.read("app.js")
        client = self.read("api-client.js")
        self.assertIn('id="formal-owner-view"', html)
        self.assertIn('response.role === "owner"', script)
        self.assertIn("loadFormalOwnerWorkspace", script)
        self.assertIn("getFormalOwnerPacket", client)
        self.assertIn("submitFormalOwnerDecision", client)
        for field in ("reason", "scope", "constraints", "successMetrics", "stopConditions", "downstreamOwner"):
            self.assertIn(field, script)
        owner_section = html[html.index('id="formal-owner-view"'):html.index('id="employee-workbench-view"')]
        self.assertIn("不展示原始材料", owner_section)
        for forbidden in ("E5", "切换角色", "X-Demo-Role"):
            self.assertNotIn(forbidden, owner_section)

    def test_browser_api_client_defines_real_local_workflow_contract(self):
        html = self.read("index.html")
        client = self.read("api-client.js")
        self.assertIn('src="api-client.js', html)
        for phrase in (
            "window.diagnosticApi",
            "X-Demo-Role",
            "X-Demo-User",
            "/api/projects/${projectId}/work-items",
            "/api/projects/${projectId}/events",
            "/api/work-items/${itemId}/employee-submission",
            "/api/work-items/${itemId}/verification",
            "/api/work-items/${itemId}/owner-decision",
            "throw new DiagnosticApiError",
        ):
            self.assertIn(phrase, client)

    def test_workspace_loads_role_scoped_backend_tasks_and_events(self):
        html = self.read("index.html")
        script = self.read("app.js")
        styles = self.read("styles.css")
        content = f"{html}\n{script}\n{styles}"
        for phrase in (
            'id="backend-status"',
            "loadBackendWorkspace",
            "adaptApiWorkItem",
            "diagnosticApi.setIdentity",
            "diagnosticApi.listWorkItems",
            "diagnosticApi.listEvents",
            'backendConnection: "idle"',
            'backendConnection = "loading"',
            'backendConnection = "connected"',
            'backendConnection = "error"',
            'data-action="retry-backend"',
            "本地数据库已连接",
            "本地服务不可用",
        ):
            self.assertIn(phrase, content)

    def test_direct_file_preview_points_to_the_http_app_entry(self):
        script = self.read("app.js")
        client = self.read("api-client.js")
        content = f"{script}\n{client}"
        for phrase in (
            'localAppUrl = "http://127.0.0.1:53117/"',
            'isDirectFileMode = window.location.protocol === "file:"',
            "当前页面是直接打开的文件",
            "请使用本地服务入口",
            'data-action="open-local-app"',
            "window.location.assign(localAppUrl)",
        ):
            self.assertIn(phrase, content)

    def test_sidebar_navigation_is_scoped_to_the_selected_role(self):
        mock = self.read("mock-data.js")
        script = self.read("app.js")
        styles = self.read("styles.css")
        content = f"{mock}\n{script}\n{styles}"
        for phrase in (
            'navigation: ["overview", "mapping"]',
            'navigation: ["overview", "mapping", "facts", "risks"]',
            'navigation: ["overview", "decisions"]',
            "renderRoleNavigation",
            "item.hidden = !visible",
            "allowedNavigation.includes(control.dataset.nav)",
            ".sidebar-item[hidden]",
        ):
            self.assertIn(phrase, content)

    def test_frontend_asset_versions_change_with_permission_behavior(self):
        html = self.read("index.html")
        self.assertIn('styles.css?v=workbench-v5', html)
        self.assertIn('mock-data.js?v=workbench-v5', html)
        self.assertIn('agent-adapter.js?v=workbench-v5', html)
        self.assertIn('formal-ui-contract.js?v=workbench-v6', html)
        self.assertIn('api-client.js?v=workbench-v6', html)
        self.assertIn('app.js?v=workbench-v6', html)

    def test_role_actions_wait_for_backend_persistence(self):
        script = self.read("app.js")
        for phrase in (
            "persistEmployeeSubmission",
            "persistVerification",
            "persistOwnerDecision",
            "window.diagnosticApi.submitEmployee",
            "window.diagnosticApi.verify",
            "window.diagnosticApi.decide",
            '"同一个客户": "same"',
            '"不同客户": "different"',
            '"暂时无法判断": "insufficient"',
            '"继续影子试点": "continue_pilot"',
            '"要求修改": "request_revision"',
            '"暂不推进": "pause"',
            "await runBackendAction",
            "pendingAction",
            "处理结果没有保存",
        ):
            self.assertIn(phrase, script)

    def test_invitation_gate_is_first_and_invitation_only(self):
        html = self.read("index.html")
        app = self.read("app.js")
        mock = self.read("mock-data.js")
        script = self.read("app.js")
        self.assertLess(html.index('id="invitation-gate-view"'), html.index('id="project-list-view"'))
        for phrase in ("通过项目邀请进入", "企业项目不开放自行注册", "手机号或企业邮箱", "模拟身份壳"):
            self.assertIn(phrase, f"{html}\n{app}")
        self.assertIn("invitationOnly: true", mock)
        self.assertIn("enterFromInvitation", app)
        self.assertIn("resolveRoleRoute", app)
        for role in ("employee", "verifier", "owner", "external_builder", "it_admin"):
            self.assertIn(role, mock)
        self.assertIn('owner: "owner-review-view"', mock)
        self.assertIn("不连接OA、CRM或ERP", html)

    def test_simulation_uses_the_fixture_adapter_seam(self):
        adapter = self.read("agent-adapter.js")
        app = self.read("app.js")
        self.assertIn("async function runDiagnostic", adapter)
        self.assertIn('executionMode: "fixture"', adapter)
        for collection in ("candidateInterpretations", "alternativeExplanations", "unresolvedQuestions"):
            self.assertIn(collection, adapter)
            self.assertIn(f"state.{collection} = result.{collection}", app)
        self.assertIn("runDiagnostic(", app)
        for forbidden in ("resolveConfirmation", "unlockRiskStage", "CRM.write", "ERP.write", "OA.write"):
            self.assertNotIn(forbidden, adapter)

    def test_activity_log_contract_is_present(self):
        script = self.read("app.js")
        html = self.read("index.html")
        for phrase in (
            "activityEvents",
            "appendActivity",
            "诊断过程记录",
            "系统",
            "模拟 Agent",
            "人工",
            "诊断项目已创建",
            "模拟 Agent 开始分析",
            "发现证据冲突并暂停",
            "人工要求补充材料",
            "模拟材料已补充",
            "人工确认事实",
            "断点与风险阶段已解锁",
            "三类诊断产出已就绪",
        ):
            self.assertIn(phrase, f"{html}\n{script}")

    def test_activity_log_resets_and_rejects_duplicate_actions(self):
        script = self.read("app.js")
        self.assertIn("state.activityEvents = []", script)
        self.assertIn("event.actor === actor && event.action === action", script)
        self.assertIn("event.itemId === itemId", script)
        self.assertIn("itemId = \"\"", script)

    def test_simulation_run_is_guarded_and_recovers_from_adapter_failure(self):
        script = self.read("app.js")
        self.assertIn("simulationRunToken", script)
        self.assertIn("const runToken = state.simulationRunToken + 1", script)
        self.assertIn("state.simulationRunToken !== runToken", script)
        self.assertIn(".catch(() =>", script)
        self.assertIn('state.simulationState = "idle"', script)

    def test_workbench_keeps_human_machine_boundaries_visible(self):
        content = "\n".join(self.read(name) for name in ("index.html", "app.js", "mock-data.js"))
        for phrase in ("当前已确认事实", "证据来源", "模拟 Agent 分析", "待人工确认", "暂停原因"):
            self.assertIn(phrase, content)
        for phrase in ("E5合成数据", "不连接OA、CRM或ERP", "不修改任何企业业务数据", "未确认事项尚未处理"):
            self.assertIn(phrase, content)

    def test_new_user_guidance_and_next_stage_entry_are_visible(self):
        content = "\n".join(self.read(name) for name in ("index.html", "app.js", "styles.css"))
        for phrase in (
            "你现在只需要做一件事",
            "确认并纳入风险清单",
            "查看断点与风险",
            "查看改造方案初稿",
            "改造方案初稿",
            "不是生产执行指令",
            "确认结果：该记录将进入断点与风险清单",
            "status-message[hidden]",
        ):
            self.assertIn(phrase, content)

    def test_simulation_fixture_has_evidence_agent_and_confirmation_data(self):
        mock_data = self.read("mock-data.js")
        for phrase in (
            "window.diagnosticMvpFixture",
            'evidenceLevel: "E5"',
            "confirmedFacts",
            "sourceLabel",
            "agentFindings",
            "agentRecommendations",
            "confirmationItems",
            "暂停原因：多条相似记录，无法判定唯一业务事实",
        ):
            self.assertIn(phrase, mock_data)

    def test_app_has_guarded_simulation_and_confirmation_transitions(self):
        script = self.read("app.js")
        for phrase in (
            "startSimulation",
            "resolveConfirmation",
            "requestMoreEvidence",
            "provideEvidence",
            'item.status = "evidence_provided"',
            'data-action="provide-evidence"',
            "未确认事项尚未处理",
            "state.simulationState = \"running\"",
            'status: "blocked"',
        ):
            self.assertIn(phrase, script)

    def test_resolved_confirmation_has_a_distinct_completion_state(self):
        script = self.read("app.js")
        styles = self.read("styles.css")
        self.assertIn("confirmation-card--resolved", f"{script}\n{styles}")
        self.assertIn("人工确认已记录", script)

    def test_unlocking_next_stage_closes_the_previous_active_stage(self):
        script = self.read("app.js")
        self.assertIn('const previousStage = stageById(state.project.currentStage);', script)
        self.assertIn('previousStage.status = "done";', script)
        self.assertIn('risks.status = "active";', script)

    def test_confirmed_diagnostic_marks_simulated_outputs_ready(self):
        script = self.read("app.js")
        self.assertIn('state.outputs = state.outputs.map((output) => ({ ...output, status: "ready" }))', script)

    def test_new_project_resets_demo_state_and_idle_count_is_zero(self):
        script = self.read("app.js")
        self.assertIn('Object.assign(state, cloneFixture()', script)
        self.assertIn('state.simulationState === "complete"', script)

    def test_new_project_preserves_session_and_refreshes_project_list(self):
        script = self.read("app.js")
        self.assertIn('authenticated: state.authenticated', script)
        self.assertIn('role: state.role', script)
        self.assertIn('simulationRunToken: state.simulationRunToken + 1', script)
        self.assertIn('renderProjectList();\n  showView("diagnostic-workbench-view")', script)

    def test_prototype_never_claims_real_system_access_or_auto_adjudication(self):
        content = "\n".join(self.read(name) for name in ("index.html", "app.js", "mock-data.js"))
        for phrase in ("已接入生产CRM", "自动裁决客户归属", "真实OA写入", "真实CRM写入"):
            self.assertNotIn(phrase, content)

    def test_employee_workspace_is_a_light_local_task_surface(self):
        html = self.read("index.html")
        script = self.read("app.js")
        mock = self.read("mock-data.js")
        content = f"{html}\n{script}\n{mock}"
        self.assertIn('id="employee-workbench-view"', html)
        self.assertIn("员工工作台", content)
        self.assertIn("请描述这项工作实际是怎么发生的", content)
        self.assertIn("工作描述草稿", content)
        self.assertIn("保存草稿", content)
        self.assertIn("提交这一段", content)
        self.assertIn("截图", content)
        self.assertIn("Excel", content)
        self.assertIn("特殊情况", content)
        self.assertIn("不需要判断整个流程", content)
        self.assertIn("不审批改造方案", content)
        self.assertIn("不修改生产系统", content)
        self.assertIn("仅在本地保存", content)
        self.assertIn('employee: "employee-workbench-view"', mock)

    def test_employee_mopup_is_agent_guided_and_progressive(self):
        script = self.read("app.js")
        mock = self.read("mock-data.js")
        content = f"{script}\n{mock}"
        for phrase in ("employeeInterviewStep", "continue-employee-interview", "Agent 正在提问", "从哪里开始", "实际怎么做", "哪里会卡住"):
            self.assertIn(phrase, content)

    def test_external_builder_can_enter_and_create_project(self):
        html = self.read("index.html")
        mock = self.read("mock-data.js")
        self.assertIn('data-role-choice="external_builder"', html)
        self.assertIn('external_builder: "project-list-view"', mock)
        self.assertIn("外部改造方", html)

    def test_employee_draft_is_assigned_as_a_dom_value_not_html(self):
        script = self.read("app.js")
        self.assertNotIn('>${state.employeeDraft}</textarea>', script)
        self.assertIn('draft.value = state.employeeDraft', script)
        self.assertIn('state.employeeSubmissionState = "saved"', script)
        self.assertIn('state.employeeSubmissionState = "submitted"', script)

    def test_formal_employee_entry_explains_the_single_assigned_task(self):
        html = self.read("index.html")
        script = self.read("app.js")
        content = f"{html}\n{script}"
        self.assertIn('id="formal-employee-view"', html)
        for phrase in (
            "为什么邀请你",
            "要还原的工作",
            "Agent 会先问",
            "预计 10 分钟",
            "提交后交给流程核验人员",
            "开始还原我的工作",
            "确认描述并提交给流程核验人员",
        ):
            self.assertIn(phrase, content)

    def test_formal_employee_flow_supports_draft_material_and_card_states(self):
        content = "\n".join(self.read(name) for name in ("index.html", "app.js", "api-client.js"))
        for phrase in (
            "saveFormalEmployeeDraft",
            "loadFormalEmployeeTask",
            "renderFormalWorkflowCard",
            'value="provided"',
            'value="none_available"',
            "我有已授权材料",
            "目前没有可提供的材料",
            "开始条件",
            "所需信息",
            "主要操作",
            "人工判断",
            "异常处理",
            "材料索引",
            "/employee-draft",
            "/employee-task",
        ):
            self.assertIn(phrase, content)

    def test_formal_employee_can_provide_requested_evidence_after_submission(self):
        content = "\n".join(self.read(name) for name in ("app.js", "api-client.js"))
        for phrase in (
            "provideFormalSupplement",
            "补充材料请求",
            "恢复同一事实核验",
            "formal-employee-supplement",
            "/evidence-supplement",
        ):
            self.assertIn(phrase, content)

    def test_employee_receipt_is_server_readable_and_names_handoff_state(self):
        schema = self.read("schema.sql")
        shared = self.read("functions/_shared.js")
        task_route = self.read("functions/api/projects/[projectId]/employee-task.js")
        submission_route = self.read("functions/api/work-items/[itemId]/employee-submission.js")
        source = f"{shared}\n{task_route}\n{submission_route}"
        for field in ("submission_version", "submitted_at", "handoff_status"):
            self.assertIn(field, schema)
        self.assertIn("onRequestGet", task_route)
        self.assertIn("itemPayload", task_route)
        self.assertRegex(task_route, r"JOIN\s+accounts[\s\S]*assigned_verifier_id[\s\S]*assigned_verifier_name")
        for contract_field, persisted_field in (
            ("submissionVersion", "submission_version"),
            ("submittedAt", "submitted_at"),
            ("handoffStatus", "handoff_status"),
            ("assignedVerifierName", "assigned_verifier_name"),
        ):
            self.assertRegex(source, rf"{contract_field}\s*:\s*(?:item|row)\.{persisted_field}")
        for field in (
            "workItemId",
            "submissionVersion",
            "submittedAt",
            "flowCardVersion",
            "materialStatus",
            "handoffStatus",
            "assignedVerifierId",
            "assignedVerifierName",
            "assignedVerifierLabel",
        ):
            self.assertRegex(source, rf"{field}\s*:")
        self.assertIn('handoff_status: "waiting_assignment"', source)
        self.assertIn('handoff_status: "assigned"', source)
        self.assertRegex(task_route, r"json\s*\(\s*\{\s*task\s*,\s*receipt\s*\}\s*\)")

    def test_formal_employee_surface_excludes_management_and_demo_controls(self):
        html = self.read("index.html")
        employee_section = html.split('id="formal-employee-view"', 1)[1].split("</section>", 1)[0]
        for forbidden in ("角色选择", "风险与建议", "负责人决策", "E5", "状态演示"):
            self.assertNotIn(forbidden, employee_section)

    def test_formal_entry_is_separate_from_demo_entry_and_exposes_real_setup_client_contract(self):
        html = self.read("index.html")
        client = self.read("api-client.js")
        app = self.read("app.js")
        formal_entry = html.split('id="formal-entry-view"', 1)[1].split('</section>', 1)[0]
        for forbidden in ("E5", "本地演示身份", "本次演示职责", '<select name=\"role\"'):
            self.assertNotIn(forbidden, formal_entry)
        for phrase in (
            'id="formal-entry-view"',
            'id="formal-builder-view"',
            'data-action="enter-demo"',
            'authorizeBuilder',
            'createFormalProject',
            'createInvitation',
            'acceptInvitation',
            '/api/auth/authorize',
            '/api/projects',
            '/api/invitations/" + invitationRef + "/accept',
            'loadFormalBuilderWorkspace',
            'submitFormalBuilderLogin',
        ):
            self.assertIn(phrase, f"{html}\n{client}\n{app}")

    def test_formal_verifier_invitation_uses_session_scoped_queue_and_never_falls_back_to_demo(self):
        app = self.read("app.js")
        client = self.read("api-client.js")
        for phrase in (
            'params.get("role") === "verifier"',
            "loadFormalVerifierWorkspace",
            "formalSessionActive",
            "formalProjectId",
            "getFormalVerifierFacts",
            "verifyFormal",
        ):
            self.assertIn(phrase, f"{app}\n{client}")
        self.assertIn("/api/formal/projects/${projectId}/verifier-facts", client)
        formal_loader = app.split("async function loadFormalVerifierWorkspace", 1)[1].split("window.loadFormalVerifierWorkspace = loadFormalVerifierWorkspace;", 1)[0]
        self.assertIn("state.verifierFact = items[0] || null", formal_loader)
        self.assertNotIn("state.workItems.find((entry) => entry.assigneeRole === \"verifier\"", formal_loader)

    def test_revision_requested_returns_to_builder_with_version_reason(self):
        schema = self.read("schema.sql")
        decision = self.read("functions/api/formal/decision-packets/[packetId]/owner-decision.js")
        builder_queue = self.read("functions/api/projects/[projectId]/work-items.js")
        draft = self.read("functions/api/formal/projects/[projectId]/decision-packets/draft.js")
        publish = self.read("functions/api/formal/decision-packets/[packetId]/publish.js")
        source = f"{decision}\n{builder_queue}\n{self.read('app.js')}"
        for field in ("revision_reason", "revision_from_version"):
            self.assertIn(field, schema)
        for phrase in ("revision_requested", "revisionReason", "revisionFromVersion", "external_builder"):
            self.assertIn(phrase, source)
        revision_branch = re.search(
            r"if\s*\(\s*decision\s*===\s*['\"]revision['\"]\s*\)\s*\{(?P<body>[\s\S]*?)\n\s*\}",
            decision,
        )
        self.assertIsNotNone(revision_branch, "revision must have a dedicated persistence branch")
        revision_body = revision_branch.group("body")
        self.assertRegex(revision_body, r"(?:INSERT\s+INTO|UPDATE)\s+work_items[\s\S]*external_builder")
        self.assertRegex(revision_body, r"revision_reason[\s\S]*reason")
        self.assertRegex(revision_body, r"revision_from_version[\s\S]*packet\.version")
        self.assertIn("revision_requested", revision_body)
        non_revision = re.search(
            r"(?:else\s+)?if\s*\(\s*\[['\"]continue['\"],\s*['\"]pause['\"]\]\.includes\(decision\)\s*\)\s*\{(?P<body>[\s\S]*?)\n\s*\}",
            decision,
        )
        self.assertIsNotNone(non_revision, "continue/pause must use a non-revision branch")
        self.assertNotIn("revision_requested", non_revision.group("body"))
        self.assertNotIn("INSERT INTO work_items", non_revision.group("body"))
        self.assertRegex(builder_queue, r"external_builder[\s\S]*(work_items|items)")
        self.assertRegex(draft, r"MAX\(version\)[\s\S]*Number\([^)]*version[^)]*\)\s*\+\s*1")
        self.assertRegex(draft, r"['\"]draft['\"]")
        self.assertRegex(publish, r"status\s*!==\s*['\"]verifier_checked['\"][\s\S]*409")

    def test_formal_session_routes_each_role_to_one_server_owned_workbench(self):
        app = self.read("app.js")
        html = self.read("index.html")
        restore = app.split("async function openFormalEntry", 1)[1].split("async function submitFormalInvitationAccept", 1)[0]
        expected = {
            "employee": "loadFormalEmployeeTask",
            "verifier": "loadFormalVerifierWorkspace",
            "owner": "loadFormalOwnerWorkspace",
            "account": "loadFormalBuilderWorkspace",
        }
        for role, loader in expected.items():
            self.assertIn(f'restored.role === "{role}"', restore)
            self.assertIn(loader, restore)
        formal_sections = {
            "employee": "formal-employee-view",
            "verifier": "formal-verifier-view",
            "owner": "formal-owner-view",
            "external_builder": "formal-builder-view",
        }
        for role, view_id in formal_sections.items():
            self.assertRegex(html, rf'id="{view_id}"[\s\S]*data-formal-role="{role}"')
        self.assertIn("formal-role-nav", html)
        self.assertNotIn('data-action="switch-formal-role"', html)

    def test_verifier_workbench_is_question_driven_and_keeps_boundary(self):
        html = self.read("index.html")
        script = self.read("app.js")
        mock = self.read("mock-data.js")
        content = f"{html}\n{script}\n{mock}"
        self.assertIn('id="verifier-workbench-view"', html)
        self.assertIn('verifier: "verifier-workbench-view"', mock)
        self.assertIn("这两条客户记录，实际指的是同一个客户吗？", content)
        for phrase in ("证据 A · OA 交接申请", "证据 B · CRM 候选记录", "同一个客户", "不同客户", "暂时无法判断", "客户 ID", "不修改 CRM"):
            self.assertIn(phrase, content)
        self.assertIn("等待人工判断", content)
        self.assertIn("renderVerifierWorkbench", script)

    def test_owner_review_view_is_summary_first_and_collapses_raw_evidence(self):
        html = self.read("index.html")
        script = self.read("app.js")
        mock = self.read("mock-data.js")
        styles = self.read("styles.css")
        content = f"{html}\n{script}\n{mock}\n{styles}"
        self.assertIn('id="owner-review-view"', html)
        self.assertIn("审阅与决策", content)
        self.assertIn("已确认事实", content)
        self.assertIn("核心风险", content)
        self.assertIn("小范围影子试点", content)
        self.assertIn("继续影子试点", content)
        self.assertIn("要求修改", content)
        self.assertIn("暂不推进", content)
        self.assertIn("已核验依据（折叠）", content)
        self.assertIn("这是决策摘要，不是任务清单", content)
        self.assertIn("renderOwnerReview", script)

    def test_demo_flow_connects_the_three_core_workspaces_locally(self):
        script = self.read("app.js")
        mock = self.read("mock-data.js")
        styles = self.read("styles.css")
        content = f"{script}\n{mock}\n{styles}"
        self.assertIn("demoFlow", mock)
        for phrase in (
            "员工摸排 → 事实核验 → 负责人审阅",
            "这条路线只用于演示角色关系，不是企业真实权限入口",
            "switchDemoRole",
            'data-action="switch-role"',
            "进入核验人员视角",
            "进入负责人审阅",
            "演示闭环已完成",
            "demo-flow-step.is-active",
        ):
            self.assertIn(phrase, content)

    def test_shared_queue_hands_work_between_core_roles(self):
        script = self.read("app.js")
        for phrase in (
            "persistEmployeeSubmission",
            "window.diagnosticApi.submitEmployee",
            "persistVerification",
            "window.diagnosticApi.verify",
            "persistOwnerDecision",
            "window.diagnosticApi.decide",
            "交给负责人审阅",
            'data-action="handoff-to-owner"',
        ):
            self.assertIn(phrase, script)

    def test_domain_model_defines_persistable_entities_and_permissions(self):
        mock = self.read("mock-data.js")
        script = self.read("app.js")
        docs = self.read("../../docs/architecture/2026-08-20-enterprise-diagnostic-domain-model.md")
        for phrase in (
            'schemaVersion: "diagnostic-domain-v0.1"',
            "domainModel",
            "memberships",
            "evidenceItems",
            "candidateFacts",
            "confirmations",
            "riskFindings",
            "decisionRecords",
            "handoffEvents",
            "permissionMatrix",
            "handoffRules",
            "validateDomainModel",
            "appendHandoffEvent",
            "persistOwnerDecision",
        ):
            self.assertIn(phrase, f"{mock}\n{script}")
        for phrase in ("diagnostic_project", "project_membership", "evidence_item", "human_confirmation", "handoff_event", "权限矩阵"):
            self.assertIn(phrase, docs)

    def test_b2b_workspace_shell_and_queue_contract(self):
        content = "\n".join(self.read(name) for name in ("index.html", "app.js", "mock-data.js"))
        for phrase in (
            'id="workspace-overview"',
            'id="work-queue"',
            'id="detail-drawer"',
            'id="bulk-action-bar"',
            "工作概览",
            "流程摸排",
            "材料与事实",
            "风险与建议",
            "审阅决策",
            "只看我的任务",
            "证据完整度",
            "下一步动作",
        ):
            self.assertIn(phrase, content)

    def test_workspace_has_complete_feedback_states(self):
        content = "\n".join(self.read(name) for name in ("index.html", "app.js", "styles.css"))
        for phrase in (
            "queue-loading",
            "queue-empty",
            "queue-error",
            "permission-notice",
            "success-feedback",
            "retry-queue",
        ):
            self.assertIn(phrase, content)

    def test_role_policy_keeps_high_risk_actions_individual(self):
        mock = self.read("mock-data.js")
        script = self.read("app.js")
        for phrase in ("rolePolicy", "bulkActions", "request_evidence", "assign_reviewer", "export_summary"):
            self.assertIn(phrase, f"{mock}\n{script}")
        for forbidden in ("bulk_confirm_fact", "bulk_owner_decision", "bulk_write_source_system"):
            self.assertNotIn(forbidden, f"{mock}\n{script}")

    def test_calendly_inspired_tokens_replace_dark_and_multicolor_workspace(self):
        styles = self.read("styles.css").lower()
        for token in ("#0b3558", "#006bff", "#476788", "#d4e0ed", "#f0f3f8", "#f8f9fb"):
            self.assertIn(token, styles)
        self.assertIn("prefers-reduced-motion", styles)

    def test_shared_queue_fixture_supports_operational_scanning(self):
        mock = self.read("mock-data.js")
        for phrase in (
            "workItems",
            "stageLabel",
            "assigneeLabel",
            "evidenceCompleteness",
            "blockingReason",
            "updatedAt",
            "nextAction",
            "rolePolicy",
        ):
            self.assertIn(phrase, mock)

    def test_queue_rendering_and_filters_are_interactive(self):
        script = self.read("app.js")
        for phrase in (
            "renderWorkspaceOverview",
            "renderQueueToolbar",
            "renderWorkQueue",
            "visibleWorkItems",
            "toggle-work-item",
            "clear-filters",
            "queue-search",
            "queue-page",
        ):
            self.assertIn(phrase, script)

    def test_detail_drawer_and_bulk_actions_preserve_accountability(self):
        script = self.read("app.js")
        for phrase in (
            "renderDetailDrawer",
            "open-detail",
            "close-detail",
            "renderRoleActions",
            "renderBulkActionBar",
            "bulk-request-evidence",
            "bulk-assign-reviewer",
            "bulk-export-summary",
        ):
            self.assertIn(phrase, script)

    def test_demo_builder_enters_the_formal_project_flow(self):
        script = self.read("app.js")
        self.assertIn('role === "external_builder"', script)
        self.assertIn('openFormalEntry()', script)
        self.assertIn('showView("formal-entry-view")', script)

    def test_verifier_supplement_fields_are_full_width_and_touch_friendly(self):
        styles = self.read("styles.css")
        self.assertRegex(styles, r"\.supplement-fields\s*\{[^}]*display:\s*grid[^}]*gap:")
        self.assertRegex(styles, r"\.supplement-fields\s+label\s*\{[^}]*display:\s*grid")
        self.assertRegex(styles, r"\.supplement-fields\s+input[^}]*width:\s*100%")
        self.assertRegex(styles, r"\.supplement-fields\s+(?:input|select)[^}]*min-height:\s*44px")
        self.assertRegex(styles, r"\.verifier-question-panel\s*>\s*textarea\s*\{[^}]*width:\s*100%")
        self.assertRegex(styles, r"\.verifier-question-panel\s*>\s*\.field-label\s*\{[^}]*display:\s*block")

    def test_builder_control_shows_the_server_blocking_reason(self):
        script = self.read("app.js")
        self.assertIn("task.blockingReason", script)
        self.assertIn("当前阻塞", script)

    def test_completed_employee_receipt_has_no_next_receiver(self):
        script = self.read("app.js")
        self.assertIn('currentStage.complete ? "流程已关闭"', script)
        self.assertIn('currentStage.complete ? "已闭环"', script)

    def test_employee_supplement_controls_use_compact_mobile_sizes(self):
        script = self.read("app.js")
        styles = self.read("styles.css")
        self.assertIn("employee-supplement-fields", script)
        self.assertRegex(styles, r"\.employee-supplement-fields\s+(?:input|select)\s*\{[^}]*min-height:\s*44px")
        self.assertRegex(styles, r"\.employee-supplement-fields\s+textarea\s*\{[^}]*min-height:\s*80px")
        self.assertRegex(styles, r"\.employee-supplement-fields\s+button\s*\{[^}]*min-height:\s*44px")

    def test_mobile_formal_entry_prioritizes_the_login_action(self):
        styles = self.read("styles.css")
        self.assertRegex(styles, r"@media\s*\(max-width:\s*760px\)[\s\S]*\.formal-entry-steps\s*\{[^}]*display:\s*none")
        self.assertRegex(styles, r"@media\s*\(max-width:\s*760px\)[\s\S]*\.formal-entry-form\s*>\s*button\s*\{[^}]*min-height:\s*44px")

    def test_mobile_formal_workbench_buttons_are_touch_friendly(self):
        styles = self.read("styles.css")
        self.assertRegex(styles, r"@media\s*\(max-width:\s*760px\)[\s\S]*body\.formal-active \.primary-button[^}]*min-height:\s*44px")


if __name__ == "__main__":
    unittest.main()
