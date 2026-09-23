import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

# The runtime-case documents embed a handoff block in a ```yaml fence. This
# suite validates that block **without a YAML parser**: PyYAML is not part of
# the standard library, and this repository's stated requirement is that every
# suite runs on a bare Python 3 with nothing installed. A previous revision
# imported `yaml`, which passed on machines that happened to have PyYAML and
# failed on a clean CI runner.
#
# The checks below therefore assert the *structure* the handoff contract needs,
# not full YAML semantics. They do not implement flow collections, anchors,
# multi-line scalars, or type coercion, and they intentionally do not assert
# scalar types beyond the literal text. See CHANGELOG.md for what this narrowed.


def handoff_block(text: str) -> str:
    blocks = re.findall(r"```yaml\n(.*?)\n```", text, re.S)
    if len(blocks) != 1:
        raise AssertionError(f"expected exactly one handoff block, found {len(blocks)}")
    return blocks[0]


def top_level_keys(block: str) -> set:
    return set(re.findall(r"^([A-Za-z_][A-Za-z0-9_]*):", block, re.M))


def block_items(block: str, key: str):
    """Return the raw first line of each `- ` item directly under a top-level key."""
    match = re.search(rf"^{re.escape(key)}:[ \t]*\n((?:[ \t]+.*\n|\n)*)", block, re.M)
    if not match:
        return []
    return [
        line.strip()[1:].strip()
        for line in match.group(1).splitlines()
        if line.strip().startswith("-")
    ]


class InterviewPreparationPackageTest(unittest.TestCase):
    def test_root_skill_has_clear_handoffs_and_no_diagnosis_boundary(self) -> None:
        text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("$enterprise-workflow-mapping", text)
        self.assertIn("$enterprise-material-analysis", text)
        self.assertIn("$enterprise-ai-process-diagnosis", text)
        self.assertIn("does not conduct the employee workflow interview", text)
        self.assertIn("must not recommend technology", text)

    def test_method_covers_role_selection_followups_and_evidence(self) -> None:
        text = (ROOT / "references" / "interview-design-method.md").read_text(encoding="utf-8")
        for phrase in (
            "Role coverage",
            "Resource-constrained planning",
            "Conflicting inputs",
            "Expected cross-role disagreement",
            "Decision-changing questions",
            "Recent concrete event",
            "Vague-answer follow-up",
            "Minimum evidence",
            "Do-not-promise",
        ):
            self.assertIn(phrase, text)

    def test_template_has_required_skimmable_sections(self) -> None:
        text = (ROOT / "templates" / "interview-plan.md").read_text(encoding="utf-8")
        for heading in (
            "## 结论先行",
            "## 资源约束与最小访谈组合",
            "## 角色覆盖矩阵",
            "## 待验证的跨角色分歧",
            "## 分角色访谈提纲",
            "## 最小材料清单",
            "## 现场边界",
            "## 覆盖缺口与停止条件",
            "## 总档案交接块",
        ):
            self.assertIn(heading, text)

    def test_schema_supports_master_record_handoff(self) -> None:
        schema = json.loads((ROOT / "templates" / "interview-plan.schema.json").read_text(encoding="utf-8"))
        required = set(schema["required"])
        self.assertTrue({
            "record_type", "record_id", "version", "enterprise_id", "project_id",
            "process_id", "planning_constraints", "participant_roles",
            "conflict_hypotheses", "evidence_requests", "coverage_gaps",
            "prohibited_promises", "created_at"
        } <= required)
        self.assertEqual("enterprise_interview_plan", schema["properties"]["record_type"]["const"])
        self.assertEqual("0.2", schema["properties"]["schema_version"]["const"])

    def test_root_skill_handles_scope_conflict_constraints_and_example_discovery(self) -> None:
        text = (ROOT / "SKILL.md").read_text(encoding="utf-8")
        for phrase in (
            "total interview time",
            "maximum participants",
            "conflicting inputs",
            "expected cross-role disagreements",
            "runtime-case-manufacturing-procurement.md",
            "runtime-case-retail-complaint.md",
        ):
            self.assertIn(phrase, text)

    def test_output_cases_require_process_specific_and_safe_plans(self) -> None:
        cases = json.loads((ROOT / "evals" / "output_cases.json").read_text(encoding="utf-8"))["cases"]
        self.assertEqual(
            {"manufacturing_procurement", "retail_complaint", "constrained_conflicting_scope"},
            {case["id"] for case in cases},
        )
        for case in cases:
            assertions = "\n".join(case["assertions"])
            self.assertIn("role coverage", assertions)
            self.assertIn("adaptive follow-up", assertions)
            self.assertIn("minimum evidence", assertions)
            self.assertIn("no technology recommendation", assertions)
            self.assertIn("enterprise_interview_plan", assertions)
        constrained = next(case for case in cases if case["id"] == "constrained_conflicting_scope")
        constrained_assertions = "\n".join(constrained["assertions"])
        self.assertIn("time and participant constraints", constrained_assertions)
        self.assertIn("cross-role conflict hypotheses", constrained_assertions)
        self.assertIn("scope reduction", constrained_assertions)

    def test_runtime_examples_preserve_domain_boundaries(self) -> None:
        procurement = (ROOT / "reports" / "runtime-case-manufacturing-procurement.md").read_text(encoding="utf-8")
        retail = (ROOT / "reports" / "runtime-case-retail-complaint.md").read_text(encoding="utf-8")
        constrained = (ROOT / "reports" / "runtime-case-constrained-customer-service.md").read_text(encoding="utf-8")
        self.assertIn("采购执行人员", procurement)
        self.assertIn("ERP管理员", procurement)
        self.assertIn("不能承诺ERP存在API", procurement)
        self.assertIn("门店客服", retail)
        self.assertIn("总部品控", retail)
        self.assertIn("不能承诺Agent自主赔付", retail)
        self.assertIn("最多4人", constrained)
        self.assertIn("最小可行组合", constrained)
        self.assertIn("待验证的跨角色分歧", constrained)
        self.assertIn("不判断谁对谁错", constrained)
        for text in (procurement, retail, constrained):
            self.assertIn("追问触发", text)
            self.assertIn("最小证据", text)
            self.assertIn("record_type: enterprise_interview_plan", text)
            self.assertIn('schema_version: "0.2"', text)
            self.assertIn("planning_constraints:", text)
            self.assertIn("conflict_hypotheses:", text)

    def test_runtime_handoffs_follow_v02_structure(self) -> None:
        required = {
            "record_type", "schema_version", "record_id", "version",
            "enterprise_id", "project_id", "process_id", "scope",
            "discovery_decisions", "planning_constraints", "participant_roles",
            "conflict_hypotheses", "evidence_requests", "coverage_gaps",
            "prohibited_promises", "upstream_records", "created_at",
        }
        list_of_mappings = ("participant_roles", "evidence_requests", "conflict_hypotheses")
        cases = sorted((ROOT / "reports").glob("runtime-case-*.md"))
        self.assertTrue(cases, "no runtime-case documents found")
        for path in cases:
            block = handoff_block(path.read_text(encoding="utf-8"))

            # Every contract key is present as a top-level key.
            self.assertTrue(required <= top_level_keys(block), f"{path}: missing {sorted(required - top_level_keys(block))}")

            # Identity literals the downstream handoff depends on.
            self.assertIn("record_type: enterprise_interview_plan", block, path)
            self.assertIn('schema_version: "0.2"', block, path)

            # The three role/evidence/conflict collections must be block
            # sequences of mappings: at least one `- ` item, and each item must
            # carry at least one nested `key:` of its own.
            for key in list_of_mappings:
                items = block_items(block, key)
                self.assertTrue(items, f"{path}: {key} has no block sequence items")
                nested = re.search(
                    rf"^{re.escape(key)}:[ \t]*\n(?:[ \t]+.*\n|\n)*?[ \t]{{4,}}[A-Za-z_][A-Za-z0-9_]*:",
                    block, re.M,
                )
                self.assertIsNotNone(nested, f"{path}: {key} items are not mappings")
                self.assertTrue(
                    any(re.match(r"[A-Za-z_][A-Za-z0-9_]*:", item) or item == "" for item in items),
                    f"{path}: {key} item shape unexpected: {items[:2]}",
                )

    def test_public_package_has_no_private_paths_or_secret_values(self) -> None:
        public = [
            ROOT / "SKILL.md",
            ROOT / "README.md",
            ROOT / "agents" / "interface.yaml",
            *ROOT.glob("references/*.md"),
            *ROOT.glob("templates/*"),
        ]
        forbidden = re.compile(r"/Users/kang|BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}")
        for path in public:
            self.assertIsNone(forbidden.search(path.read_text(encoding="utf-8")), path)


if __name__ == "__main__":
    unittest.main()
