import importlib.util
import csv
import json
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[1]
MATRIX_PATH = ROOT / "40-synthetic-test-matrix.json"
MASTER_PATH = ROOT / "39-owner-transfer-master-record-candidate-v0.2.json"
ROUTER_PATH = REPO_ROOT / "enterprise-ai-diagnostic-orchestrator" / "scripts" / "orchestrate_event.py"
INPUT_ROOT = ROOT / "synthetic-inputs"


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

    def test_realistic_input_package_has_common_enterprise_file_types(self):
        expected = {
            "README.md",
            "crm-customer-handover-list.xlsx",
            "oa-approval-export.csv",
            "crm-operation-log.csv",
            "employee-interview-transcript.md",
            "management-meeting-minutes.md",
        }
        self.assertTrue(expected.issubset({path.name for path in INPUT_ROOT.iterdir()}))

    def test_uploaded_text_materials_remain_explicitly_e5(self):
        for name in ("README.md", "employee-interview-transcript.md", "management-meeting-minutes.md"):
            with self.subTest(name=name):
                text = (INPUT_ROOT / name).read_text(encoding="utf-8")
                self.assertIn("E5", text)
                self.assertIn("模拟", text)

    def test_csv_exports_cover_blocked_and_failed_business_records(self):
        with (INPUT_ROOT / "oa-approval-export.csv").open(encoding="utf-8", newline="") as handle:
            approvals = list(csv.DictReader(handle))
        with (INPUT_ROOT / "crm-operation-log.csv").open(encoding="utf-8", newline="") as handle:
            logs = list(csv.DictReader(handle))
        self.assertIn("paused", {row["current_status"] for row in approvals})
        self.assertIn("returned_for_countersign", {row["current_status"] for row in approvals})
        self.assertIn("failed", {row["operation_status"] for row in logs})
        self.assertIn("blocked", {row["operation_status"] for row in logs})

    def test_xlsx_is_real_ooxml_with_two_expected_sheets(self):
        workbook_path = INPUT_ROOT / "crm-customer-handover-list.xlsx"
        self.assertTrue(zipfile.is_zipfile(workbook_path))
        with zipfile.ZipFile(workbook_path) as archive:
            self.assertIn("[Content_Types].xml", archive.namelist())
            workbook_xml = archive.read("xl/workbook.xml").decode("utf-8")
        self.assertIn("客户交接清单", workbook_xml)
        self.assertIn("字段说明", workbook_xml)


if __name__ == "__main__":
    unittest.main()
