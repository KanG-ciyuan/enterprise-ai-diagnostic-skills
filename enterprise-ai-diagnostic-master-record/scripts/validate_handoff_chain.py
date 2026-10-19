#!/usr/bin/env python3
import json
import sys
from pathlib import Path

from validate_skill_handoff import validate_skill_handoff
from validate_master_record import validate_master_record, validate_authorization


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
    master_errors = validate_master_record(master_record)
    if master_errors:
        return [f"CHAIN_MASTER_INVALID:{error}" for error in master_errors]
    if not isinstance(handoffs, list):
        return ["CHAIN_HANDOFFS_ARRAY_REQUIRED"]
    errors = []
    enterprise_id = master_record.get("enterprise_id")
    project_id = master_record.get("project_id")
    virtual_records = {collection: list(master_record.get(collection, []))
                       for collection in INDEX_COLLECTIONS}
    available = {
        record_ref(record): record
        for collection in INDEX_COLLECTIONS
        for record in master_record.get(collection, [])
    }
    record_collections = {record_ref(record): collection for collection in INDEX_COLLECTIONS
                          for record in master_record.get(collection, [])}
    if sum(map(len, virtual_records.values())) != len(available):
        errors.append("CHAIN_DUPLICATE_MASTER_REFERENCE")
    tasks = {task.get("task_id"): task for task in master_record.get("participant_tasks", [])}
    task_ids = set(tasks)

    for handoff in handoffs:
        handoff_errors = validate_skill_handoff(handoff)
        errors.extend(handoff_errors)
        if not isinstance(handoff, dict) or any(error.startswith(("SCHEMA_TYPE:", "SCHEMA_REF_", "SCHEMA_UNSUPPORTED:")) for error in handoff_errors):
            continue
        handoff_id = handoff.get("handoff_id", "?")
        if handoff.get("handoff_status") != "ready_for_registration":
            errors.append(f"CHAIN_HANDOFF_NOT_READY:{handoff_id}")
            continue
        context = handoff.get("routing_context", {})
        if context.get("enterprise_id") != enterprise_id:
            errors.append(f"CHAIN_ENTERPRISE_SCOPE:{handoff_id}/{context.get('enterprise_id')}")
        if context.get("project_id") != project_id:
            errors.append(f"CHAIN_PROJECT_SCOPE:{handoff_id}/{context.get('project_id')}")

        for proposal in handoff.get("records_to_register", []):
            collection = proposal.get("collection")
            if collection not in INDEX_COLLECTIONS:
                continue  # The handoff validator already reports the bad collection.
            record = proposal.get("record", {})
            ref = record_ref(record)
            if ref in available:
                errors.append(f"CHAIN_RECORD_REF_EXISTS:{ref}")
                continue  # Never overwrite an existing reference to hide its authorization.
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
            gaps = record.get("outstanding_gaps", []) if collection == "diagnoses_and_pilots" else []
            for gap_ref in gaps:
                if gap_ref not in available:
                    errors.append(f"CHAIN_GAP_NOT_FOUND:{ref}->{gap_ref}")
            available[ref] = record
            record_collections[ref] = collection
            virtual_records[collection].append(record)

        for task_update in handoff.get("participant_task_updates", []):
            task_id = task_update.get("task_id")
            if task_id not in task_ids:
                errors.append(f"CHAIN_TASK_NOT_FOUND:{handoff_id}->{task_id}")
                continue
            task = tasks[task_id]
            if task_id != context.get("task_id"):
                errors.append(f"CHAIN_TASK_CONTEXT:{handoff_id}->{task_id}")
            for field in ("participant_id", "department_id", "role", "process_id"):
                if context.get(field) != task.get(field):
                    errors.append(f"CHAIN_TASK_IDENTITY:{handoff_id}/{field}")
            card_ref = task_update.get("current_workflow_card")
            if card_ref:
                card = available.get(card_ref)
                if card is None:
                    errors.append(f"CHAIN_TASK_CARD_NOT_FOUND:{task_id}->{card_ref}")
                elif record_collections[card_ref] != "workflow_cards" or card.get("record_type") != "workflow_card":
                    errors.append(f"CHAIN_TASK_CARD_NOT_WORKFLOW:{task_id}->{card_ref}")
                else:
                    for field in ("participant_id", "process_id"):
                        if card.get(field) != task.get(field):
                            errors.append(f"CHAIN_TASK_CARD_IDENTITY:{task_id}/{field}")
    # Same direct and ancestor withdrawal predicate as a candidate master.
    # This is a read-only virtual index, not a registration/state-transition executor.
    errors.extend(validate_authorization(virtual_records))
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
