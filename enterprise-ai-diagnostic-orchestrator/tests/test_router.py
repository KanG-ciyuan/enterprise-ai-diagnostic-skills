import copy
import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ROUTER_PATH = ROOT / "scripts/orchestrate_event.py"
VALIDATOR_PATH = ROOT / "scripts/validate_orchestrator_output.py"


def load_module(path: Path, name: str):
    if not path.exists():
        return None
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RouterTest(unittest.TestCase):
    def setUp(self):
        self.router = load_module(ROUTER_PATH, "orchestrate_event")
        self.validator = load_module(VALIDATOR_PATH, "validate_orchestrator_output")
        self.master = {
            "schema_version": "0.2",
            "enterprise_id": "ENT-SIM-RTL",
            "project_id": "PRJ-SIM-RTL-V02",
            "current_stage": {"stage": "workflow_mapping", "status": "active"},
            "research_coverage": [],
            "participant_tasks": [],
        }

    def event(self, event_type, **overrides):
        event = {
            "contract_type": "enterprise_ai_diagnostic_orchestrator_event",
            "contract_version": "0.1",
            "event_id": f"EVENT-{event_type}",
            "event_type": event_type,
            "enterprise_id": "ENT-SIM-RTL",
            "project_id": "PRJ-SIM-RTL-V02",
            "actor_role": "enterprise_project_owner",
            "authorization_status": "authorized",
            "source_status": "known",
            "payload": {},
            "created_at": "2026-08-14T18:00:00+08:00",
        }
        event.update(overrides)
        return event

    def route(self, event_type, **overrides):
        if self.router is None:
            self.fail("orchestrate_event.py is missing")
        return self.router.route_event(self.master, self.event(event_type, **overrides))

    def test_router_and_validator_modules_exist(self):
        self.assertTrue(ROUTER_PATH.exists())
        self.assertTrue(VALIDATOR_PATH.exists())

    def test_four_main_events_route_to_one_professional_skill(self):
        cases = {
            "management_problem_submitted": "enterprise-interview-preparation",
            "participant_task_started": "enterprise-workflow-mapping",
            "file_uploaded": "enterprise-material-analysis",
            "diagnosis_gate_ready": "enterprise-ai-process-diagnosis",
        }
        for event_type, target in cases.items():
            with self.subTest(event_type=event_type):
                original_stage = self.master["current_stage"]["stage"]
                if event_type == "diagnosis_gate_ready":
                    self.master["current_stage"]["stage"] = "diagnosis"
                result = self.route(event_type)
                self.master["current_stage"]["stage"] = original_stage
                self.assertEqual("invoke_skill", result["decision"])
                self.assertEqual(target, result["target"])
                self.assertIsInstance(result["target"], str)

    def test_diagnosis_route_requires_diagnosis_stage(self):
        result = self.route("diagnosis_gate_ready")
        self.assertEqual("request_human", result["decision"])
        self.assertIn("DIAGNOSIS_GATE_NOT_CONFIRMED", result["reason_codes"])

    def test_blocked_material_analysis_waits_for_minimum_evidence(self):
        result = self.route(
            "material_analysis_blocked",
            payload={
                "reason": "only_simulated_materials_available",
                "missing_evidence": ["authorized_desensitized_oa_sample"],
            },
        )
        self.assertEqual("wait_external", result["decision"])
        self.assertEqual("enterprise_project_owner", result["target"])
        self.assertIn("MATERIAL_EVIDENCE_REQUIRED", result["reason_codes"])
        self.assertTrue(result["human_task"]["recovery_conditions"])
        self.assertIn("file_uploaded", result["next_expected_events"])

    def test_authorization_withdrawal_pauses_with_recovery_conditions(self):
        result = self.route("authorization_withdrawn", authorization_status="withdrawn")
        self.assertEqual("pause", result["decision"])
        self.assertEqual("enterprise_project_owner", result["target"])
        self.assertIn("AUTHORIZATION_WITHDRAWN", result["reason_codes"])
        self.assertTrue(result["human_task"]["recovery_conditions"])

    def test_cross_enterprise_input_is_paused(self):
        result = self.route("file_uploaded", enterprise_id="ENT-OTHER")
        self.assertEqual("pause", result["decision"])
        self.assertIn("CROSS_ENTERPRISE_SCOPE", result["reason_codes"])

    def test_unknown_source_is_paused(self):
        result = self.route("file_uploaded", source_status="unknown")
        self.assertEqual("pause", result["decision"])
        self.assertIn("SOURCE_UNKNOWN", result["reason_codes"])

    def test_inputs_are_not_mutated(self):
        if self.router is None:
            self.fail("orchestrate_event.py is missing")
        event = self.event("participant_task_started")
        before_master = copy.deepcopy(self.master)
        before_event = copy.deepcopy(event)
        self.router.route_event(self.master, event)
        self.assertEqual(before_master, self.master)
        self.assertEqual(before_event, event)

    def test_unconfirmed_interview_plan_does_not_propose_coverage(self):
        result = self.route(
            "interview_plan_submitted",
            payload={"owner_confirmed": False, "participant_roles": [{"role": "门店客服", "priority": "P0"}]},
        )
        self.assertEqual("wait_external", result["decision"])
        self.assertEqual({}, result["proposed_state_change"])

    def test_confirmed_plan_without_participant_ids_does_not_create_tasks(self):
        result = self.route(
            "interview_plan_confirmed",
            payload={
                "owner_confirmed": True,
                "participant_roles": [
                    {
                        "department_id": "DEPT-STORE",
                        "role": "门店客服",
                        "process_id": "PROC-COMPLAINT",
                        "priority": "P0",
                        "planned_participants": 2,
                    }
                ],
            },
        )
        state = result["proposed_state_change"]
        self.assertEqual(1, len(state["research_coverage_proposals"]))
        self.assertEqual([], state["participant_task_proposals"])

    def test_output_validator_rejects_direct_write_authority(self):
        if self.validator is None:
            self.fail("validate_orchestrator_output.py is missing")
        output = self.route("participant_task_started")
        output["write_authority"] = "direct_master_record_write"
        errors = self.validator.validate_output(output)
        self.assertIn("WRITE_AUTHORITY_INVALID", errors)


if __name__ == "__main__":
    unittest.main()
