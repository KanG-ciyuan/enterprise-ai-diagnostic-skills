import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = ROOT.parent / "enterprise-ai-diagnostic-master-record/examples/retail-complaint-master-record-v0.2.json"
EVENT_NAMES = (
    "management-problem",
    "interview-plan-confirmed",
    "employee-task-started",
    "file-uploaded",
    "diagnosis-ready",
    "authorization-withdrawn",
)


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ExampleRuntimeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.router = load_module(ROOT / "scripts/orchestrate_event.py", "orchestrate_event_examples")
        cls.validator = load_module(ROOT / "scripts/validate_orchestrator_output.py", "validate_output_examples")
        cls.master = json.loads(MASTER_PATH.read_text(encoding="utf-8"))

    def test_six_event_and_output_examples_exist(self):
        missing = []
        for name in EVENT_NAMES:
            for folder in ("events", "outputs"):
                path = ROOT / f"examples/{folder}/{name}.json"
                if not path.exists():
                    missing.append(str(path.relative_to(ROOT)))
        self.assertEqual([], missing)

    def test_saved_outputs_equal_fresh_router_results(self):
        for name in EVENT_NAMES:
            with self.subTest(name=name):
                event_path = ROOT / f"examples/events/{name}.json"
                output_path = ROOT / f"examples/outputs/{name}.json"
                self.assertTrue(event_path.exists(), str(event_path))
                self.assertTrue(output_path.exists(), str(output_path))
                event = json.loads(event_path.read_text(encoding="utf-8"))
                saved = json.loads(output_path.read_text(encoding="utf-8"))
                fresh = self.router.route_event(self.master, event)
                self.assertEqual(fresh, saved)
                self.assertEqual([], self.validator.validate_output(saved))


if __name__ == "__main__":
    unittest.main()
