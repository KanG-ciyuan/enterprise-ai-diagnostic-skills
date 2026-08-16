import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class SyntheticSalesSampleTest(unittest.TestCase):
    def test_required_artifacts_exist(self):
        for name in (
            "07-synthetic-sales-applicant-sample.md",
            "08-synthetic-sales-workflow-draft.json",
            "09-cross-role-material-manifest.json",
        ):
            self.assertTrue((ROOT / name).exists(), name)

    def test_sample_is_visibly_e5_and_not_employee_confirmed(self):
        text = (ROOT / "07-synthetic-sales-applicant-sample.md").read_text(encoding="utf-8")
        self.assertIn("E5 AI假设，待验证", text)
        self.assertIn("不是销售员工证词", text)
        self.assertNotIn("销售员工已确认", text)

    def test_draft_cannot_close_participant_task(self):
        payload = json.loads(
            (ROOT / "08-synthetic-sales-workflow-draft.json").read_text(encoding="utf-8")
        )
        self.assertEqual("E5", payload["evidence_level"])
        self.assertEqual("AI假设，待验证", payload["evidence_label"])
        self.assertFalse(payload["employee_confirmed"])
        self.assertEqual("draft_hypothesis", payload["lifecycle_status"])
        self.assertNotIn("participant_task_update", payload)

    def test_manifest_preserves_e3_and_e5_separately(self):
        payload = json.loads(
            (ROOT / "09-cross-role-material-manifest.json").read_text(encoding="utf-8")
        )
        levels = {item["source_id"]: item["evidence_level"] for item in payload["sources"]}
        self.assertEqual("E3", levels["CARD-BIZOPS-CRM-AUTH-001@1"])
        self.assertEqual("E5", levels["SYN-SALES-APPLICANT-001@1"])
        self.assertFalse(payload["diagnosis_gate_allowed"])
        self.assertIn("不得合并升级为E2", payload["prohibited_conclusions"])


if __name__ == "__main__":
    unittest.main()
