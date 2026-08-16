import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PackageContractTest(unittest.TestCase):
    def test_employee_template_has_required_sections_and_boundary(self) -> None:
        text = (ROOT / "templates" / "workflow-card.md").read_text(encoding="utf-8")
        for heading in ("## 基本信息", "## 工作流程", "## 工作负担", "## 材料与证据", "## 待确认事项", "## 员工确认"):
            self.assertIn(heading, text)
        self.assertIn("```mermaid", text)
        self.assertIn("不包含数字化改造", text)

    def test_skill_enforces_employee_side_boundaries(self) -> None:
        text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("Ask one question per turn", text)
        self.assertIn("one job at a time", text)
        self.assertIn("Do not mark it confirmed until", text)
        self.assertIn("Never add transformation opportunities", text)

    def test_schema_requires_lineage_and_confirmation_fields(self) -> None:
        schema = json.loads((ROOT / "templates" / "workflow-card.schema.json").read_text(encoding="utf-8"))
        required = set(schema["required"])
        self.assertTrue({"record_id", "version", "project_id", "employee_id", "steps", "evidence", "employee_confirmed", "created_at"} <= required)
        self.assertIn("upstream_records", schema["properties"])

    def test_public_files_contain_no_private_absolute_path_or_secret_value(self) -> None:
        public_paths = [ROOT / "SKILL.md", ROOT / "README.md", ROOT / "agents" / "interface.yaml", *ROOT.glob("references/*.md"), *ROOT.glob("templates/*")]
        forbidden = re.compile(r"/Users/kang|BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]{20,}")
        for path in public_paths:
            self.assertIsNone(forbidden.search(path.read_text(encoding="utf-8")), path)

    def test_difficult_employee_fixture_has_hidden_baseline_and_evidence_limits(self) -> None:
        fixture = ROOT / "evals" / "fixtures" / "difficult-procurement"
        self.assertTrue((fixture / "employee-background.md").is_file())
        self.assertTrue((fixture / "sample-evidence.md").is_file())
        expected = (fixture / "expected-workflow-card.md").read_text(encoding="utf-8")
        self.assertIn("不作为运行时输入", expected)
        self.assertIn("不责备", expected)
        self.assertIn("个人 Excel", expected)

    def test_output_eval_includes_difficult_employee_boundaries(self) -> None:
        cases = json.loads((ROOT / "evals" / "output_cases.json").read_text(encoding="utf-8"))["cases"]
        hard_case = next(case for case in cases if case["id"] == "difficult_procurement_employee")
        assertions = "\n".join(hard_case["assertions"])
        self.assertIn("neutral non-blaming language", assertions)
        self.assertIn("personal spreadsheet", assertions)
        self.assertIn("E1 sample fields", assertions)

    def test_master_record_handoff_is_a_registration_proposal_only(self) -> None:
        skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        mapping_path = ROOT / "references" / "master-record-handoff.md"
        self.assertTrue(mapping_path.is_file())
        mapping = mapping_path.read_text(encoding="utf-8")
        self.assertIn("registration proposal", skill)
        self.assertIn("Never infer P0", skill)
        self.assertIn("workflow_card_confirmed", mapping)
        self.assertIn("workflow_card_declined", mapping)
        self.assertIn("participant_task_updates", mapping)
        self.assertIn("missing_registration_fields", mapping)


if __name__ == "__main__":
    unittest.main()
