import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PackageContractTest(unittest.TestCase):
    def test_skill_consumes_evidence_pack_and_preserves_boundaries(self):
        text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("enterprise_material_evidence_pack", text)
        self.assertIn("prohibited_conclusions", text)
        self.assertIn("可开发", text)
        self.assertIn("有条件", text)
        self.assertIn("阻塞", text)

    def test_system_discovery_card_covers_implementation_conditions(self):
        text = (ROOT / "templates" / "system-interface-discovery-card.md").read_text(encoding="utf-8")
        for required in ("系统负责人", "接入方式", "认证与权限", "测试环境", "数据字段", "数据量", "部署", "审计", "维护负责人"):
            self.assertIn(required, text)
        self.assertIn("不得因为存在系统就推定存在 API", text)

    def test_conditional_plan_requires_branches_and_operational_controls(self):
        text = (ROOT / "templates" / "conditional-technical-plan.md").read_text(encoding="utf-8")
        for required in ("事实前提", "条件分支", "组件", "数据流", "状态", "幂等", "重试", "人工确认", "审计", "验收"):
            self.assertIn(required, text)

    def test_simulated_output_is_build_specific_but_not_fabricated(self):
        text = (ROOT / "evals" / "fixtures" / "urgent-procurement" / "actual-diagnosis.md").read_text(encoding="utf-8")
        for required in ("条件式技术方案", "离线文件导入器", "规则检查器", "AI字段提取器", "人工复核队列", "审计日志", "case_id", "接口可用性未知"):
            self.assertIn(required, text)
        self.assertIn("当天补 OA", text)
        self.assertIn("1 个工作日", text)
        self.assertNotIn("供应商编码已被证实为两次异常的根因", text)
        self.assertNotIn("预计节省", text)

    def test_trigger_cases_include_handoff_and_near_neighbors(self):
        cases = json.loads((ROOT / "evals" / "trigger_cases.json").read_text(encoding="utf-8"))
        positives = " ".join(case["text"] for case in cases["should_trigger"])
        negatives = " ".join(case["text"] for case in cases["should_not_trigger"] + cases["near_neighbor"])
        self.assertIn("证据包", positives)
        self.assertIn("系统接口", positives)
        self.assertIn("只整理", negatives)
        self.assertIn("已经确定", negatives)

    def test_public_files_have_no_private_path_or_secret(self):
        public = [ROOT / "SKILL.md", ROOT / "README.md", ROOT / "agents" / "interface.yaml", *ROOT.glob("references/*.md"), *ROOT.glob("templates/*")]
        forbidden = re.compile(r"/Users/kang|BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}")
        for path in public:
            self.assertIsNone(forbidden.search(path.read_text(encoding="utf-8")), path)

    def test_master_record_handoff_requires_human_review(self):
        skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        mapping_path = ROOT / "references" / "master-record-handoff.md"
        self.assertTrue(mapping_path.is_file())
        mapping = mapping_path.read_text(encoding="utf-8")
        self.assertIn("registration proposal", skill)
        self.assertIn("process_diagnosis_completed", mapping)
        self.assertIn("outstanding_gaps", mapping)
        self.assertIn("review_required", mapping)
        self.assertIn("must never set `review_status: approved`", mapping)


if __name__ == "__main__":
    unittest.main()
