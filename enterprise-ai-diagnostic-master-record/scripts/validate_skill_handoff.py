#!/usr/bin/env python3
import json
import sys
from pathlib import Path


PRODUCER_EVENTS = {
    "enterprise-workflow-mapping": {"workflow_card_confirmed", "workflow_card_declined"},
    "enterprise-material-analysis": {"material_analysis_completed", "material_analysis_blocked"},
    "enterprise-ai-process-diagnosis": {"process_diagnosis_completed", "process_diagnosis_blocked"},
}

PRODUCER_COLLECTIONS = {
    "enterprise-workflow-mapping": {"workflow_cards"},
    "enterprise-material-analysis": {"materials", "conflicts_and_evidence_requests"},
    "enterprise-ai-process-diagnosis": {"diagnoses_and_pilots"},
}

TASK_UPDATE_FIELDS = {"task_id", "status", "current_workflow_card", "status_reason"}

RECORD_REQUIRED_FIELDS = {
    "record_id",
    "record_type",
    "version",
    "lifecycle_status",
    "enterprise_id",
    "project_id",
    "authorization_status",
    "upstream_records",
    "supersedes",
    "change_reason",
    "storage_ref",
    "created_at",
    "created_by_role",
}


def record_ref(record: dict) -> str:
    return f"{record.get('record_id', '?')}@{record.get('version', '?')}"


def validate_skill_handoff(handoff: dict) -> list[str]:
    if not isinstance(handoff, dict):
        return ["STRUCTURE_TYPE:root"]

    errors = []
    producer = handoff.get("producer_skill")
    event_type = handoff.get("event_type")
    if event_type not in PRODUCER_EVENTS.get(producer, set()):
        errors.append("EVENT_PRODUCER_MISMATCH")
    if handoff.get("write_authority") != "registration_proposal":
        errors.append("WRITE_AUTHORITY")

    if handoff.get("handoff_status") == "ready_for_registration":
        context = handoff.get("routing_context", {})
        for field in ("enterprise_id", "project_id", "process_id"):
            if not context.get(field):
                errors.append(f"READY_CONTEXT_MISSING:{field}")

    allowed_collections = PRODUCER_COLLECTIONS.get(producer, set())
    workflow_card_refs = set()
    for proposal in handoff.get("records_to_register", []):
        collection = proposal.get("collection")
        record = proposal.get("record", {})
        for field in RECORD_REQUIRED_FIELDS:
            if field not in record:
                errors.append(f"RECORD_FIELD_MISSING:{record_ref(record)}/{field}")
        if collection not in allowed_collections:
            errors.append(f"COLLECTION_NOT_ALLOWED:{producer}/{collection}")
        if collection == "workflow_cards":
            workflow_card_refs.add(record_ref(record))
        if producer == "enterprise-ai-process-diagnosis" and record.get("review_status") == "approved":
            errors.append(f"DIAGNOSIS_SELF_APPROVAL:{record_ref(record)}")

    for task_update in handoff.get("participant_task_updates", []):
        for field in task_update:
            if field not in TASK_UPDATE_FIELDS:
                errors.append(f"TASK_UPDATE_FORBIDDEN_FIELD:{field}")

    if producer == "enterprise-workflow-mapping" and event_type == "workflow_card_confirmed":
        task_card_refs = {
            item.get("current_workflow_card")
            for item in handoff.get("participant_task_updates", [])
            if item.get("current_workflow_card")
        }
        if not workflow_card_refs or task_card_refs != workflow_card_refs:
            errors.append("WORKFLOW_CARD_TASK_MISMATCH")

    return sorted(set(errors))


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: validate_skill_handoff.py <handoff.json>")
        return 2
    try:
        handoff = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"INPUT_INVALID:{type(exc).__name__}")
        return 1
    errors = validate_skill_handoff(handoff)
    if errors:
        for error in errors:
            print(error)
        return 1
    print("valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
