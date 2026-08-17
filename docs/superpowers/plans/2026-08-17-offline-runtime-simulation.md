# Offline Runtime Simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a repeatable E5-only CRM authorization runtime simulation that proves the orchestrator handles material routing, targeted human review, S0 pause, and owner-only recovery without connecting to any production system.

**Architecture:** Extend the existing thin orchestrator with an explicit manual-recovery scheduling proposal; it still never writes the master record. A separate standard-library Python runner replays a fixed scenario, invokes `route_event()` once per event, records every proposal, and applies a stage change only when the scenario includes an explicit project-owner recovery action. JSON fixtures live beside the existing CRM authorization simulation; runtime output is always written to a new caller-provided directory.

**Tech Stack:** Python 3 standard library (`argparse`, `copy`, `json`, `pathlib`, `unittest`); existing `enterprise-ai-diagnostic-orchestrator` router.

---

## File Map

| Path | Change | Responsibility |
|---|---|---|
| `enterprise-ai-diagnostic-orchestrator/scripts/orchestrate_event.py` | Modify | Return an explicit non-writing proposal for valid `manual_recovery_confirmed` events and wait for the owner when recovery is invalid. |
| `enterprise-ai-diagnostic-orchestrator/tests/test_router.py` | Modify | Specify owner-only recovery behavior and verify that recovery stays a scheduling proposal. |
| `enterprise-ai-diagnostic-orchestrator/scripts/run_offline_simulation.py` | Create | Load scenario JSON, route each event, write append-only runtime records, and create a summary plus master-record snapshot. |
| `enterprise-ai-diagnostic-orchestrator/tests/test_offline_simulation.py` | Create | Exercise the runner in a temporary directory, including refusal to overwrite an output directory. |
| `simulations/business-operations-crm-authorization/runtime-simulation/master-record.json` | Create | Initial E5-only master record for this runtime fixture. |
| `simulations/business-operations-crm-authorization/runtime-simulation/scenario.json` | Create | Fixed event sequence and explicit owner recovery action. |
| `simulations/business-operations-crm-authorization/runtime-simulation/README.md` | Create | Human-readable command, output meanings, and non-production boundary. |

## Scenario Contract

`scenario.json` must contain these top-level keys:

```json
{
  "scenario_id": "SIM-RUNTIME-CRM-AUTH-001",
  "evidence_level": "E5",
  "simulation_only": true,
  "production_write": false,
  "events": [],
  "human_actions": []
}
```

The fixed event order is:

1. `management_problem_submitted` routes to `enterprise-interview-preparation`.
2. `interview_plan_confirmed` proposes the authorized P0 employee task.
3. `participant_task_started` routes to `enterprise-workflow-mapping`.
4. `file_uploaded` routes to `enterprise-material-analysis` while the task remains in workflow mapping.
5. `h1_required` routes to a targeted human review, followed by a separately recorded H1 action.
6. `authorization_withdrawn` produces S0 pause and records the stage as `paused`.
7. `manual_recovery_confirmed` by `enterprise_project_owner` proposes `evidence_completion`; the matching explicit owner action applies that stage in the simulated snapshot.

No scenario event may be `diagnosis_gate_ready`. The final stage is `evidence_completion`, `status: active`, with a clear note that real authorized material and real employee confirmation are still required.

## Task 1: Route Manual Recovery Without Direct Writes

**Files:**
- Modify: `enterprise-ai-diagnostic-orchestrator/scripts/orchestrate_event.py`
- Modify: `enterprise-ai-diagnostic-orchestrator/tests/test_router.py`

- [ ] **Step 1: Write the failing router tests**

Add these methods to `RouterTest` before the final `if __name__` block:

```python
    def test_owner_manual_recovery_proposes_evidence_completion(self):
        self.master["current_stage"] = {"stage": "paused", "status": "paused"}
        result = self.route(
            "manual_recovery_confirmed",
            actor_role="enterprise_project_owner",
            payload={
                "recovery_conditions_met": True,
                "recovery_basis": "模拟授权方重新确认材料范围",
                "resume_stage": "evidence_completion",
            },
        )
        self.assertEqual("wait_external", result["decision"])
        self.assertEqual("enterprise_project_owner", result["target"])
        self.assertIn("MANUAL_RECOVERY_CONFIRMED", result["reason_codes"])
        self.assertEqual("evidence_completion", result["proposed_state_change"]["suggested_stage"])
        self.assertFalse(result["proposed_state_change"]["automatic_write"])
        self.assertEqual(["file_uploaded", "participant_task_started"], result["next_expected_events"])

    def test_non_owner_manual_recovery_keeps_project_waiting(self):
        self.master["current_stage"] = {"stage": "paused", "status": "paused"}
        result = self.route(
            "manual_recovery_confirmed",
            actor_role="employee",
            payload={"recovery_conditions_met": True, "resume_stage": "evidence_completion"},
        )
        self.assertEqual("wait_external", result["decision"])
        self.assertEqual("enterprise_project_owner", result["target"])
        self.assertIn("MANUAL_RECOVERY_OWNER_REQUIRED", result["reason_codes"])
        self.assertEqual({}, result["proposed_state_change"])
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
python3 -m unittest enterprise-ai-diagnostic-orchestrator/tests/test_router.py -v
```

Expected: the two new tests fail because `manual_recovery_confirmed` currently returns `no_action`.

- [ ] **Step 3: Implement the smallest recovery branch**

Insert this branch in `route_event()` after the authorization checks and before the diagnosis-gate branch:

```python
    if event_type == "manual_recovery_confirmed":
        payload = event.get("payload", {})
        if (
            master.get("current_stage", {}).get("stage") != "paused"
            or event.get("actor_role") != "enterprise_project_owner"
            or payload.get("recovery_conditions_met") is not True
            or payload.get("resume_stage") != "evidence_completion"
            or not payload.get("recovery_basis")
        ):
            return proposal(
                event,
                "wait_external",
                "enterprise_project_owner",
                ["MANUAL_RECOVERY_OWNER_REQUIRED"],
                "暂停项目只能由项目负责人在明确恢复依据后手动恢复。",
                human_task=task(
                    "S0_recovery",
                    "enterprise_project_owner",
                    "请确认恢复依据、恢复阶段和受影响引用已完成复核。",
                    "当前恢复回执不满足项目负责人手动恢复条件。",
                    "书面恢复依据、受影响记录复核结果和恢复阶段",
                    "是否允许项目离开暂停状态",
                    ["项目负责人确认", "恢复依据完整", "恢复阶段为evidence_completion"],
                    "manual_recovery_confirmed",
                ),
                next_events=["manual_recovery_confirmed"],
            )
        return proposal(
            event,
            "wait_external",
            "enterprise_project_owner",
            ["MANUAL_RECOVERY_CONFIRMED", "EVIDENCE_COMPLETION_REQUIRED"],
            "项目负责人已确认恢复；仅可回到补证阶段，不能直接进入诊断。",
            state_change={"suggested_stage": "evidence_completion", "automatic_write": False},
            next_events=["file_uploaded", "participant_task_started"],
        )
```

- [ ] **Step 4: Run the focused tests and verify pass**

Run:

```bash
python3 -m unittest enterprise-ai-diagnostic-orchestrator/tests/test_router.py -v
```

Expected: all router tests pass, including the two recovery tests.

- [ ] **Step 5: Commit the router change**

```bash
git add enterprise-ai-diagnostic-orchestrator/scripts/orchestrate_event.py enterprise-ai-diagnostic-orchestrator/tests/test_router.py
git commit -m "feat: route owner-approved recovery"
```

## Task 2: Create the E5 Runtime Fixture and Runner

**Files:**
- Create: `simulations/business-operations-crm-authorization/runtime-simulation/master-record.json`
- Create: `simulations/business-operations-crm-authorization/runtime-simulation/scenario.json`
- Create: `enterprise-ai-diagnostic-orchestrator/scripts/run_offline_simulation.py`

- [ ] **Step 1: Write the failing runner tests**

Create `enterprise-ai-diagnostic-orchestrator/tests/test_offline_simulation.py` with the following executable contract:

```python
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SIMULATION_ROOT = ROOT.parent / "simulations/business-operations-crm-authorization/runtime-simulation"


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OfflineSimulationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runner = load_module(ROOT / "scripts/run_offline_simulation.py", "offline_runtime_simulation")

    def test_runtime_replays_controlled_scenario(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            result = self.runner.run_simulation(
                SIMULATION_ROOT / "master-record.json",
                SIMULATION_ROOT / "scenario.json",
                Path(temp_dir) / "result",
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
            self.assertTrue((Path(temp_dir) / "result/runtime-log.jsonl").exists())
            self.assertTrue((Path(temp_dir) / "result/summary.json").exists())
            self.assertTrue((Path(temp_dir) / "result/final-master-record.json").exists())

    def test_runtime_refuses_to_overwrite_output_directory(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            output_dir = Path(temp_dir) / "result"
            output_dir.mkdir()
            with self.assertRaises(FileExistsError):
                self.runner.run_simulation(
                    SIMULATION_ROOT / "master-record.json",
                    SIMULATION_ROOT / "scenario.json",
                    output_dir,
                )


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
python3 -m unittest enterprise-ai-diagnostic-orchestrator/tests/test_offline_simulation.py -v
```

Expected: FAIL because `run_offline_simulation.py` and the fixture files do not exist.

- [ ] **Step 3: Add the fixed E5 master record**

Create `master-record.json` with only the minimum index structure consumed by `route_event()`:

```json
{
  "record_type": "enterprise_ai_diagnostic_master_record",
  "schema_version": "0.2",
  "record_id": "MASTER-SIM-RUNTIME-CRM-AUTH-001",
  "version": 1,
  "enterprise_id": "ENT-SIM-RUNTIME-BIZOPS",
  "project_id": "PRJ-SIM-RUNTIME-CRM-AUTH-001",
  "current_stage": {"stage": "workflow_mapping", "status": "active", "owner_role": "enterprise_project_owner"},
  "research_coverage": [],
  "participant_tasks": [],
  "simulation_only": true,
  "evidence_level": "E5",
  "production_write": false
}
```

- [ ] **Step 4: Add the fixed scenario**

Create `scenario.json` with the IDs above and these event facts:

```json
{
  "scenario_id": "SIM-RUNTIME-CRM-AUTH-001",
  "evidence_level": "E5",
  "simulation_only": true,
  "production_write": false,
  "events": [
    {"event_id": "EVENT-RUNTIME-001", "event_type": "management_problem_submitted", "actor_role": "enterprise_project_owner", "authorization_status": "authorized", "source_status": "known", "payload": {"process_id": "PROC-CRM-AUTH"}},
    {"event_id": "EVENT-RUNTIME-002", "event_type": "interview_plan_confirmed", "actor_role": "enterprise_project_owner", "authorization_status": "authorized", "source_status": "known", "payload": {"owner_confirmed": true, "participant_roles": [{"department_id": "DEPT-BIZOPS", "role": "业务运营", "process_id": "PROC-CRM-AUTH", "priority": "P0", "planned_participants": 1}], "participants": [{"task_id": "TASK-RUNTIME-BIZOPS-001", "participant_id": "PART-RUNTIME-BIZOPS-001", "department_id": "DEPT-BIZOPS", "role": "业务运营", "process_id": "PROC-CRM-AUTH", "priority": "P0", "authorization_status": "authorized"}]}},
    {"event_id": "EVENT-RUNTIME-003", "event_type": "participant_task_started", "actor_role": "employee", "authorization_status": "authorized", "source_status": "known", "payload": {"task_id": "TASK-RUNTIME-BIZOPS-001", "participant_id": "PART-RUNTIME-BIZOPS-001", "process_id": "PROC-CRM-AUTH"}},
    {"event_id": "EVENT-RUNTIME-004", "event_type": "file_uploaded", "actor_role": "employee", "authorization_status": "authorized", "source_status": "known", "payload": {"material_id": "MAT-RUNTIME-001", "process_id": "PROC-CRM-AUTH", "file_type": "xlsx"}},
    {"event_id": "EVENT-RUNTIME-005", "event_type": "h1_required", "actor_role": "agent", "authorization_status": "not_required", "source_status": "known", "payload": {"human_task": {"task_type": "H1", "responsible_role": "authorized_reviewer", "question": "请确认客户编号缺失是否允许继续。", "reason": "模拟清单缺少稳定标识。", "required_evidence": "模拟字段核对说明", "affected_decision": "材料是否可继续分析", "recovery_conditions": ["确认字段口径"], "expected_return_event": "file_uploaded"}}},
    {"event_id": "EVENT-RUNTIME-006", "event_type": "authorization_withdrawn", "actor_role": "enterprise_project_owner", "authorization_status": "withdrawn", "source_status": "known", "payload": {"affected_record": "MAT-RUNTIME-001@1"}},
    {"event_id": "EVENT-RUNTIME-007", "event_type": "manual_recovery_confirmed", "actor_role": "enterprise_project_owner", "authorization_status": "authorized", "source_status": "known", "payload": {"recovery_conditions_met": true, "recovery_basis": "模拟授权方重新确认范围并复核引用。", "resume_stage": "evidence_completion"}}
  ],
  "human_actions": [
    {"action_id": "ACTION-RUNTIME-H1-001", "action_type": "H1_completed", "actor_role": "authorized_reviewer", "after_event_id": "EVENT-RUNTIME-005", "evidence_level": "E5"},
    {"action_id": "ACTION-RUNTIME-RECOVERY-001", "action_type": "apply_manual_recovery", "actor_role": "enterprise_project_owner", "after_event_id": "EVENT-RUNTIME-007", "resume_stage": "evidence_completion", "evidence_level": "E5"}
  ]
}
```

The implementation must enrich every event with `contract_type`, `contract_version`, `enterprise_id`, `project_id`, and deterministic `created_at` values before routing; the fixture intentionally keeps only scenario-specific fields.

- [ ] **Step 5: Implement the runner**

Create `run_offline_simulation.py` with these public functions:

```python
def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def build_event(master: dict, item: dict, index: int) -> dict:
    return {
        "contract_type": "enterprise_ai_diagnostic_orchestrator_event",
        "contract_version": "0.1",
        "event_id": item["event_id"],
        "event_type": item["event_type"],
        "enterprise_id": master["enterprise_id"],
        "project_id": master["project_id"],
        "actor_role": item["actor_role"],
        "authorization_status": item["authorization_status"],
        "source_status": item["source_status"],
        "payload": copy.deepcopy(item["payload"]),
        "created_at": f"2026-08-17T10:{index:02d}:00+08:00",
    }


def run_simulation(master_path: Path, scenario_path: Path, output_dir: Path) -> dict:
    """Replay one declared E5 scenario and return its complete in-memory result."""
```

`run_simulation()` must:

1. reject an existing `output_dir` with `FileExistsError` before creating any file;
2. read both JSON files and reject a scenario unless all three values are exactly `E5`, `true`, and `false` for evidence level, simulation flag, and production-write flag;
3. deep-copy the master record; reject it unless enterprise/project IDs exist and it is also marked E5/simulation-only/no-production-write;
4. import `route_event` from `orchestrate_event.py` using `importlib.util`, so the runner is directly testing the packaged router;
5. loop through scenario events, call `route_event(master, event)`, append a routing record containing `record_kind`, `event_id`, `event_type`, `decision`, `target`, `reason_codes`, `next_expected_events`, `proposal`, and E5 simulation markers;
6. after a `pause` proposal, manually set only `current_stage.stage`, `current_stage.status`, and `current_stage.stop_reason` to the proposal’s suggested paused state, and append an `applied_pause` record;
7. after each event, append matching `human_actions`. `H1_completed` only adds an audit record. `apply_manual_recovery` may change stage and status only when the preceding routing proposal contains `MANUAL_RECOVERY_CONFIRMED` and the action role is `enterprise_project_owner`; otherwise raise `ValueError`;
8. write `runtime-log.jsonl`, `summary.json`, and `final-master-record.json`, then return a dict containing `scenario_id`, all markers, `runtime_records`, and `final_master_record`.

Add a minimal CLI:

```python
def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Run an E5-only offline diagnostic simulation.")
    parser.add_argument("master_record")
    parser.add_argument("scenario")
    parser.add_argument("output_dir")
    args = parser.parse_args(argv[1:])
    result = run_simulation(Path(args.master_record), Path(args.scenario), Path(args.output_dir))
    print(json.dumps({"scenario_id": result["scenario_id"], "result": "completed"}, ensure_ascii=False))
    return 0
```

- [ ] **Step 6: Run the focused runner tests and verify pass**

Run:

```bash
python3 -m unittest enterprise-ai-diagnostic-orchestrator/tests/test_offline_simulation.py -v
```

Expected: both tests pass. The result includes material analysis routing, H1 review, S0 pause, owner recovery, and final `evidence_completion` without any diagnosis event.

- [ ] **Step 7: Commit the fixture and runner**

```bash
git add enterprise-ai-diagnostic-orchestrator/scripts/run_offline_simulation.py enterprise-ai-diagnostic-orchestrator/tests/test_offline_simulation.py simulations/business-operations-crm-authorization/runtime-simulation/master-record.json simulations/business-operations-crm-authorization/runtime-simulation/scenario.json
git commit -m "feat: add offline diagnostic runtime simulation"
```

## Task 3: Document the Repeatable Run and Execute Regression Checks

**Files:**
- Create: `simulations/business-operations-crm-authorization/runtime-simulation/README.md`
- Modify: `enterprise-ai-diagnostic-orchestrator/tests/test_package.py`

- [ ] **Step 1: Write the failing package expectation**

Add the runner path to `required` in `test_required_package_files_exist`:

```python
            "scripts/run_offline_simulation.py",
```

Run:

```bash
python3 -m unittest enterprise-ai-diagnostic-orchestrator/tests/test_package.py -v
```

Expected: this passes once Task 2 is complete; it prevents the runtime runner from being silently removed later.

- [ ] **Step 2: Write the fixture README**

Create a README containing these exact operational rules:

```markdown
# CRM客户授权离线运行模拟

本目录是 E5 控制夹具，不包含真实客户、员工、OA、CRM或企业材料。

运行：

```bash
python3 enterprise-ai-diagnostic-orchestrator/scripts/run_offline_simulation.py \
  simulations/business-operations-crm-authorization/runtime-simulation/master-record.json \
  simulations/business-operations-crm-authorization/runtime-simulation/scenario.json \
  /tmp/crm-runtime-simulation-result
```

输出目录必须不存在。运行成功后会生成：

- `runtime-log.jsonl`：每个路由决定和明确人工动作；
- `summary.json`：场景标记、事件数量和最终阶段；
- `final-master-record.json`：仅用于审阅的模拟总档案快照。

本夹具验证材料路由、H1人工确认、授权撤回暂停和负责人手动恢复。它不验证真实模型、接口、权限、业务收益或生产写入能力。
```

- [ ] **Step 3: Run a clean command-line simulation**

Run:

```bash
simulation_output="/tmp/enterprise-ai-runtime-simulation-20260817"
rm -rf "$simulation_output"
python3 enterprise-ai-diagnostic-orchestrator/scripts/run_offline_simulation.py \
  simulations/business-operations-crm-authorization/runtime-simulation/master-record.json \
  simulations/business-operations-crm-authorization/runtime-simulation/scenario.json \
  "$simulation_output"
python3 -m json.tool "$simulation_output/summary.json"
```

Expected: command prints `{"scenario_id": "SIM-RUNTIME-CRM-AUTH-001", "result": "completed"}` and the summary reports E5, `simulation_only: true`, `production_write: false`, and final stage `evidence_completion`.

- [ ] **Step 4: Run orchestrator regression tests**

Run:

```bash
python3 -m unittest discover -s enterprise-ai-diagnostic-orchestrator/tests -p 'test_*.py' -v
python3 enterprise-ai-diagnostic-master-record/scripts/validate_master_record.py simulations/business-operations-crm-authorization/05-master-record-v0.2.json
```

Expected: all orchestrator tests pass and the existing CRM master record remains valid.

- [ ] **Step 5: Commit the documentation and package check**

```bash
git add enterprise-ai-diagnostic-orchestrator/tests/test_package.py simulations/business-operations-crm-authorization/runtime-simulation/README.md
git commit -m "docs: explain offline runtime simulation"
```

## Plan Self-Review

| Design requirement | Implementation task |
|---|---|
| Fixed E5-only scenario | Task 2, steps 3-5 |
| Reuse existing router | Task 2, step 5 |
| Material upload during mapping | Task 2, steps 1 and 4-6 |
| H1 minimal human confirmation | Task 2, steps 1, 4 and 5 |
| S0 pause | Task 2, steps 1, 4 and 5 |
| Owner-only manual recovery | Task 1 and Task 2 |
| Recovery cannot enter diagnosis | Task 1 test and Task 2 final-stage assertion |
| Append-only and overwrite protection | Task 2 runner behavior and overwrite test |
| Human-readable operation and regression evidence | Task 3 |

No new external dependency, model call, database connection, browser interface, production integration, or real business evidence is introduced by this plan.
