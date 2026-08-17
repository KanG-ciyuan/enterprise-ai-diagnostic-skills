import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNNER_PATH = ROOT / "scripts/run_offline_simulation.py"
SIMULATION_ROOT = ROOT.parent / "simulations/business-operations-crm-authorization/runtime-simulation"


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OfflineSimulationTest(unittest.TestCase):
    def runner(self):
        self.assertTrue(RUNNER_PATH.exists(), "run_offline_simulation.py is missing")
        return load_module(RUNNER_PATH, "offline_runtime_simulation")

    def test_runtime_replays_controlled_scenario(self):
        self.assertTrue((SIMULATION_ROOT / "master-record.json").exists())
        self.assertTrue((SIMULATION_ROOT / "scenario.json").exists())
        runner = self.runner()
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir) / "result"
            result = runner.run_simulation(
                SIMULATION_ROOT / "master-record.json",
                SIMULATION_ROOT / "scenario.json",
                output_dir,
            )
            self.assertEqual("SIM-RUNTIME-CRM-AUTH-001", result["scenario_id"])
            self.assertTrue(result["simulation_only"])
            self.assertFalse(result["production_write"])
            self.assertEqual("E5", result["evidence_level"])
            records = result["runtime_records"]
            by_event = {record["event_type"]: record for record in records if record["record_kind"] == "routing"}
            self.assertEqual("enterprise-material-analysis", by_event["file_uploaded"]["target"])
            self.assertEqual("request_human", by_event["h1_required"]["decision"])
            self.assertEqual("pause", by_event["authorization_withdrawn"]["decision"])
            self.assertEqual("wait_external", by_event["manual_recovery_confirmed"]["decision"])
            self.assertEqual("evidence_completion", result["final_master_record"]["current_stage"]["stage"])
            self.assertEqual("active", result["final_master_record"]["current_stage"]["status"])
            self.assertTrue((output_dir / "runtime-log.jsonl").exists())
            self.assertTrue((output_dir / "summary.json").exists())
            self.assertTrue((output_dir / "final-master-record.json").exists())

    def test_runtime_refuses_to_overwrite_output_directory(self):
        self.assertTrue((SIMULATION_ROOT / "master-record.json").exists())
        self.assertTrue((SIMULATION_ROOT / "scenario.json").exists())
        runner = self.runner()
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir) / "result"
            output_dir.mkdir()
            with self.assertRaises(FileExistsError):
                runner.run_simulation(
                    SIMULATION_ROOT / "master-record.json",
                    SIMULATION_ROOT / "scenario.json",
                    output_dir,
                )


if __name__ == "__main__":
    unittest.main()
