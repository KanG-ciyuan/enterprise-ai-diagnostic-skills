#!/usr/bin/env python3
import argparse
import copy
import importlib.util
import json
import sys
from pathlib import Path


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


def load_router():
    router_path = Path(__file__).with_name("orchestrate_event.py")
    spec = importlib.util.spec_from_file_location("offline_runtime_router", router_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.route_event


def validate_markers(payload: dict, label: str) -> None:
    expected = {
        "evidence_level": "E5",
        "simulation_only": True,
        "production_write": False,
    }
    invalid = [key for key, value in expected.items() if payload.get(key) != value]
    if invalid:
        raise ValueError(f"{label}_SIMULATION_MARKERS_INVALID:{','.join(invalid)}")


def actions_after(actions: list[dict], event_id: str) -> list[dict]:
    return [action for action in actions if action.get("after_event_id") == event_id]


def routing_record(event: dict, proposal: dict) -> dict:
    return {
        "record_kind": "routing",
        "event_id": event["event_id"],
        "event_type": event["event_type"],
        "decision": proposal["decision"],
        "target": proposal["target"],
        "reason_codes": proposal["reason_codes"],
        "next_expected_events": proposal["next_expected_events"],
        "proposal": proposal,
        "evidence_level": "E5",
        "simulation_only": True,
        "production_write": False,
    }


def apply_pause(master: dict, proposal: dict, event_id: str) -> dict:
    stage = master.setdefault("current_stage", {})
    stage["stage"] = proposal["proposed_state_change"]["suggested_stage"]
    stage["status"] = "paused"
    stage["stop_reason"] = proposal["human_summary"]
    return {
        "record_kind": "applied_pause",
        "after_event_id": event_id,
        "stage": stage["stage"],
        "evidence_level": "E5",
        "simulation_only": True,
        "production_write": False,
    }


def apply_action(master: dict, action: dict, proposal: dict) -> dict:
    validate_markers(action, "HUMAN_ACTION")
    action_type = action.get("action_type")
    if action_type == "H1_completed":
        if proposal["decision"] != "request_human":
            raise ValueError("H1_ACTION_WITHOUT_HUMAN_REQUEST")
        return {
            "record_kind": "human_action",
            "action_id": action["action_id"],
            "action_type": action_type,
            "actor_role": action["actor_role"],
            "evidence_level": "E5",
            "simulation_only": True,
            "production_write": False,
        }
    if action_type == "apply_manual_recovery":
        if (
            action.get("actor_role") != "enterprise_project_owner"
            or "MANUAL_RECOVERY_CONFIRMED" not in proposal["reason_codes"]
            or action.get("resume_stage") != proposal["proposed_state_change"].get("suggested_stage")
        ):
            raise ValueError("MANUAL_RECOVERY_ACTION_INVALID")
        stage = master.setdefault("current_stage", {})
        stage["stage"] = action["resume_stage"]
        stage["status"] = "active"
        stage["stop_reason"] = "仍等待真实授权材料和真实员工确认；不得进入诊断。"
        return {
            "record_kind": "human_action",
            "action_id": action["action_id"],
            "action_type": action_type,
            "actor_role": action["actor_role"],
            "applied_stage": stage["stage"],
            "evidence_level": "E5",
            "simulation_only": True,
            "production_write": False,
        }
    raise ValueError(f"HUMAN_ACTION_TYPE_INVALID:{action_type}")


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run_simulation(master_path: Path, scenario_path: Path, output_dir: Path) -> dict:
    """Replay one declared E5 scenario and return its complete in-memory result."""
    if output_dir.exists():
        raise FileExistsError(f"OUTPUT_DIRECTORY_EXISTS:{output_dir}")

    source_master = load_json(master_path)
    scenario = load_json(scenario_path)
    validate_markers(source_master, "MASTER_RECORD")
    validate_markers(scenario, "SCENARIO")
    if not source_master.get("enterprise_id") or not source_master.get("project_id"):
        raise ValueError("MASTER_RECORD_SCOPE_MISSING")

    master = copy.deepcopy(source_master)
    route_event = load_router()
    runtime_records = []
    output_dir.mkdir(parents=True)

    for index, item in enumerate(scenario.get("events", [])):
        event = build_event(master, item, index)
        proposal = route_event(master, event)
        runtime_records.append(routing_record(event, proposal))
        if proposal["decision"] == "pause":
            runtime_records.append(apply_pause(master, proposal, event["event_id"]))
        for action in actions_after(scenario.get("human_actions", []), event["event_id"]):
            runtime_records.append(apply_action(master, action, proposal))

    result = {
        "scenario_id": scenario["scenario_id"],
        "evidence_level": "E5",
        "simulation_only": True,
        "production_write": False,
        "event_count": len(scenario.get("events", [])),
        "runtime_records": runtime_records,
        "final_master_record": master,
    }
    with (output_dir / "runtime-log.jsonl").open("w", encoding="utf-8") as handle:
        for record in runtime_records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    write_json(output_dir / "summary.json", {
        "scenario_id": result["scenario_id"],
        "evidence_level": result["evidence_level"],
        "simulation_only": result["simulation_only"],
        "production_write": result["production_write"],
        "event_count": result["event_count"],
        "final_stage": master["current_stage"],
    })
    write_json(output_dir / "final-master-record.json", master)
    return result


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Run an E5-only offline diagnostic simulation.")
    parser.add_argument("master_record")
    parser.add_argument("scenario")
    parser.add_argument("output_dir")
    args = parser.parse_args(argv[1:])
    result = run_simulation(Path(args.master_record), Path(args.scenario), Path(args.output_dir))
    print(json.dumps({"scenario_id": result["scenario_id"], "result": "completed"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
