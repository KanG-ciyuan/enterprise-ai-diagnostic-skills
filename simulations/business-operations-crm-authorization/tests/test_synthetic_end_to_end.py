import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[1]
MATRIX_PATH = ROOT / "40-synthetic-test-matrix.json"
MASTER_PATH = ROOT / "39-owner-transfer-master-record-candidate-v0.2.json"
ROUTER_PATH = REPO_ROOT / "enterprise-ai-diagnostic-orchestrator" / "scripts" / "orchestrate_event.py"


def load_router():
    spec = importlib.util.spec_from_file_location("synthetic_orchestrator", ROUTER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SyntheticEndToEndTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.matrix = json.loads(MATRIX_PATH.read_text(encoding="utf-8"))
        cls.master = json.loads(MASTER_PATH.read_text(encoding="utf-8"))
        cls.router = load_router()

    def make_event(self, case):
        return {
            "contract_type": "enterprise_ai_diagnostic_orchestrator_event",
            "contract_version": "0.1",
            "event_id": case["case_id"],
            "event_type": case["event_type"],
            "enterprise_id": self.master["enterprise_id"],
            "project_id": self.master["project_id"],
            "actor_role": "simulation_agent",
            "authorization_status": "not_required",
            "source_status": "known",
            "payload": {"simulation_only": True},
            "created_at": "2026-08-16T17:00:00+08:00",
        }

    def test_dataset_is_explicitly_simulation_only_and_e5(self):
        self.assertTrue(self.matrix["simulation_only"])
        self.assertEqual("E5", self.matrix["evidence_level"])
        self.assertIn("待真实企业验证", self.matrix["evidence_label"])
        self.assertEqual(6, len(self.matrix["route_cases"]))
        self.assertEqual(8, len(self.matrix["business_control_cases"]))

    def test_all_route_cases_match_orchestrator_contract(self):
        for case in self.matrix["route_cases"]:
            with self.subTest(case_id=case["case_id"]):
                output = self.router.route_event(self.master, self.make_event(case))
                self.assertEqual(case["expected_decision"], output["decision"])
                self.assertEqual(case["expected_target"], output["target"])
                self.assertIn(case["expected_reason"], output["reason_codes"])

    def test_business_controls_have_explicit_safe_and_forbidden_actions(self):
        for case in self.matrix["business_control_cases"]:
            with self.subTest(case_id=case["case_id"]):
                self.assertTrue(case["condition"])
                self.assertTrue(case["input_signal"])
                self.assertTrue(case["expected_action"])
                self.assertTrue(case["forbidden_action"])


if __name__ == "__main__":
    unittest.main()
