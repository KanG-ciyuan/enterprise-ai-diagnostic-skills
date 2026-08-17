import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PackageContractTest(unittest.TestCase):
    def test_required_package_files_exist(self):
        required = [
            "SKILL.md",
            "README.md",
            "agents/interface.yaml",
            "manifest.json",
            "evals/trigger_cases.json",
            "references/routing-method.md",
            "references/external-task-package.md",
            "references/interview-plan-adapter.md",
            "schema/orchestrator-event.schema.json",
            "schema/orchestrator-output.schema.json",
            "scripts/orchestrate_event.py",
            "scripts/run_offline_simulation.py",
            "scripts/validate_orchestrator_output.py",
            "reports/prior-art-research.md",
        ]
        missing = [path for path in required if not (ROOT / path).exists()]
        self.assertEqual([], missing)

    def test_skill_forbids_direct_writes_and_free_routing(self):
        path = ROOT / "SKILL.md"
        self.assertTrue(path.exists(), "SKILL.md is missing")
        text = path.read_text(encoding="utf-8")
        for phrase in ("registration proposal", "one primary Skill", "must not write", "S0"):
            self.assertIn(phrase, text)

    def test_trigger_cases_cover_boundaries(self):
        path = ROOT / "evals/trigger_cases.json"
        self.assertTrue(path.exists(), "trigger_cases.json is missing")
        payload = json.loads(path.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(payload["should_trigger"]), 5)
        self.assertGreaterEqual(len(payload["should_not_trigger"]), 6)
        self.assertGreaterEqual(len(payload["near_neighbor"]), 4)

    def test_public_files_do_not_contain_private_paths_or_secrets(self):
        forbidden = re.compile(r"/Users/kang|BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}")
        for path in ROOT.rglob("*"):
            if (
                not path.is_file()
                or "reports" in path.parts
                or "tests" in path.parts
                or "__pycache__" in path.parts
                or path.suffix == ".pyc"
            ):
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            self.assertIsNone(forbidden.search(text), str(path.relative_to(ROOT)))

    def test_output_schema_declares_scheduling_proposal_boundary(self):
        path = ROOT / "schema/orchestrator-output.schema.json"
        self.assertTrue(path.exists(), "orchestrator-output.schema.json is missing")
        payload = json.loads(path.read_text(encoding="utf-8"))
        required = set(payload["required"])
        self.assertTrue({"decision", "target", "reason_codes", "human_summary", "write_authority"} <= required)
        self.assertEqual("scheduling_proposal", payload["properties"]["write_authority"]["const"])


if __name__ == "__main__":
    unittest.main()
