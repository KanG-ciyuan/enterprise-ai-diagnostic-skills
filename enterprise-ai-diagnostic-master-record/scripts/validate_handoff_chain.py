#!/usr/bin/env python3
import json
import sys
from pathlib import Path

from validate_skill_handoff import validate_skill_handoff


INDEX_COLLECTIONS = (
    "workflow_cards",
    "materials",
    "conflicts_and_evidence_requests",
    "organizational_confirmations",
    "diagnoses_and_pilots",
)


def record_ref(record: dict) -> str:
    return f"{record.get('record_id', '?')}@{record.get('version', '?')}"


def validate_handoff_chain(master_record: dict, handoffs: list[dict]) -> list[str]:
    errors = []
    enterprise_id = master_record.get("enterprise_id")
    project_id = master_record.get("project_id")
    available = {
        record_ref(record)
        for collection in INDEX_COLLECTIONS
        for record in master_record.get(collection, [])
    }
    task_ids = {task.get("task_id") for task in master_record.get("participant_tasks", [])}

    for handoff in handoffs:
        errors.extend(validate_skill_handoff(handoff))
        handoff_id = handoff.get("handoff_id", "?")
        context = handoff.get("routing_context", {})
        if context.get("enterprise_id") != enterprise_id:
            errors.append(f"CHAIN_ENTERPRISE_SCOPE:{handoff_id}/{context.get('enterprise_id')}")
        if context.get("project_id") != project_id:
            errors.append(f"CHAIN_PROJECT_SCOPE:{handoff_id}/{context.get('project_id')}")

        for proposal in handoff.get("records_to_register", []):
            record = proposal.get("record", {})
            ref = record_ref(record)
            if record.get("enterprise_id") != enterprise_id:
                errors.append(f"CHAIN_RECORD_ENTERPRISE_SCOPE:{ref}/{record.get('enterprise_id')}")
            if record.get("project_id") != project_id:
                errors.append(f"CHAIN_RECORD_PROJECT_SCOPE:{ref}/{record.get('project_id')}")
            for upstream_ref in record.get("upstream_records", []):
                if upstream_ref not in available:
                    errors.append(f"CHAIN_UPSTREAM_NOT_FOUND:{ref}->{upstream_ref}")
            supersedes = record.get("supersedes")
            if supersedes and supersedes not in available:
                errors.append(f"CHAIN_SUPERSEDES_NOT_FOUND:{ref}->{supersedes}")
            for gap_ref in record.get("outstanding_gaps", []):
                if gap_ref not in available:
                    errors.append(f"CHAIN_GAP_NOT_FOUND:{ref}->{gap_ref}")
            available.add(ref)

        for task_update in handoff.get("participant_task_updates", []):
            task_id = task_update.get("task_id")
            if task_id not in task_ids:
                errors.append(f"CHAIN_TASK_NOT_FOUND:{handoff_id}->{task_id}")
    return sorted(set(errors))


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print("usage: validate_handoff_chain.py <master-record.json> <handoff.json> [handoff.json ...]")
        return 2
    try:
        master_record = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
        handoffs = [json.loads(Path(path).read_text(encoding="utf-8")) for path in argv[2:]]
    except (OSError, json.JSONDecodeError) as exc:
        print(f"INPUT_INVALID:{type(exc).__name__}")
        return 1
    errors = validate_handoff_chain(master_record, handoffs)
    if errors:
        for error in errors:
            print(error)
        return 1
    print("valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
