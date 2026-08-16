import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PackageContractTest(unittest.TestCase):
    def test_skill_has_evidence_and_no_diagnosis_boundary(self):
        text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("Every substantive finding must cite", text)
        self.assertIn("Do not recommend process redesign", text)
        self.assertIn("minimum evidence", text)

    def test_template_has_required_sections(self):
        text = (ROOT / "templates" / "evidence-pack.md").read_text(encoding="utf-8")
        for heading in ("## 材料清单", "## 原子证据账本", "## 一致与冲突", "## 最小补证请求", "## 诊断交接块"):
            self.assertIn(heading, text)

    def test_schema_requires_traceability_records(self):
        schema = json.loads((ROOT / "templates" / "evidence-pack.schema.json").read_text(encoding="utf-8"))
        required = set(schema["required"])
        self.assertTrue({"materials", "claims", "conflicts", "coverage", "evidence_requests", "prohibited_conclusions"} <= required)

    def test_fixture_contains_unreadable_and_policy_sample_distinction(self):
        fixture = ROOT / "evals" / "fixtures" / "urgent-procurement"
        self.assertTrue((fixture / "materials" / "MAT-006-damaged-screenshot.txt").is_file())
        expected = (fixture / "expected-findings.md").read_text(encoding="utf-8")
        self.assertIn("禁止作为运行输入", expected)
        self.assertIn("E4", expected)
        self.assertIn("不可读", expected)

    def test_public_files_have_no_private_path_or_secret(self):
        public = [ROOT / "SKILL.md", ROOT / "README.md", ROOT / "agents" / "interface.yaml", *ROOT.glob("references/*.md"), *ROOT.glob("templates/*")]
        forbidden = re.compile(r"/Users/kang|BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}")
        for path in public:
            self.assertIsNone(forbidden.search(path.read_text(encoding="utf-8")), path)

    def test_simulated_evidence_pack_preserves_critical_boundaries(self):
        pack = (ROOT / "evals" / "fixtures" / "urgent-procurement" / "actual-evidence-pack.md").read_text(encoding="utf-8")
        self.assertIn("MAT-006", pack)
        self.assertIn("不可验证", pack)
        self.assertIn("仅限 PO-SIM-001", pack)
        self.assertIn("这是未来目标，不能支持现实结果", pack)
        self.assertIn("近20笔", pack)
        self.assertIn("prohibited_conclusions", pack)
        for forbidden in ("建议使用n8n", "建议采用RPA", "建议部署Agent", "预计节省"):
            self.assertNotIn(forbidden, pack)

    def test_master_record_handoff_cannot_cross_into_diagnosis(self):
        skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        mapping_path = ROOT / "references" / "master-record-handoff.md"
        self.assertTrue(mapping_path.is_file())
        mapping = mapping_path.read_text(encoding="utf-8")
        self.assertIn("registration proposal", skill)
        self.assertIn("material_analysis_completed", mapping)
        self.assertIn("materials", mapping)
        self.assertIn("conflicts_and_evidence_requests", mapping)
        self.assertIn("content_hash", mapping)
        self.assertIn("must not propose `diagnoses_and_pilots`", mapping)


if __name__ == "__main__":
    unittest.main()
