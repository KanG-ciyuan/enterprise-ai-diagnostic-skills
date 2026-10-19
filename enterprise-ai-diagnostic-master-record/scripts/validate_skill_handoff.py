#!/usr/bin/env python3
import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
try:
    from diagnostic_contract_schema import validate_schema
finally:
    sys.path.pop(0)

SCHEMA_ROOT = Path(__file__).resolve().parents[1] / "schema"
HANDOFF_SCHEMA = json.loads((SCHEMA_ROOT / "skill-handoff-v0.2.schema.json").read_text(encoding="utf-8"))
MASTER_SCHEMA = json.loads((SCHEMA_ROOT / "master-record-v0.2.schema.json").read_text(encoding="utf-8"))
COLLECTION_SCHEMAS = {
    name: {**rule["items"], "$defs": MASTER_SCHEMA["$defs"]}
    for name, rule in MASTER_SCHEMA["properties"].items()
    if name in {"workflow_cards", "materials", "conflicts_and_evidence_requests",
                "organizational_confirmations", "diagnoses_and_pilots"}
}
# Only administrative registration context may remain explicitly unknown.
# Record identity/version, producer and employee confirmation are never deferred.
DEFERRED_REGISTRATION_FIELDS = frozenset(
    HANDOFF_SCHEMA["$defs"]["routingContext"]["properties"]
) | {"authorization_status", "storage_ref", "upstream_records", "review_status"}


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


def registration_schema(collection, record, deferred):
    schema = COLLECTION_SCHEMAS.get(collection, COLLECTION_SCHEMAS["workflow_cards"])
    unknown = {field for field in deferred if record.get(field) is None}
    if not unknown:
        return schema
    schema = copy.deepcopy(schema)
    for definition in schema["$defs"].values():
        properties = definition.get("properties", {})
        for field in unknown & properties.keys():
            # A pending proposal can carry null, not an invented placeholder.
            # Existing required keys remain required; ready uses the master rule.
            properties[field] = {"type": "null"}
    return schema


def identity_errors(context, record, fields, deferred, prefix, separator=":"):
    errors = []
    for field in fields:
        values = (context.get(field), record.get(field))
        missing = [value for value in values if not isinstance(value, str) or not value.strip()]
        if missing:
            if field not in deferred or any(value is not None for value in missing):
                errors.append(f"{prefix}{separator}{field}")
        elif values[0] != values[1]:
            errors.append(f"{prefix}{separator}{field}")
    return errors


def validate_skill_handoff(handoff: dict) -> list[str]:
    if not isinstance(handoff, dict):
        return ["STRUCTURE_TYPE:root"]

    errors = validate_schema(handoff, HANDOFF_SCHEMA)
    if any(error.startswith(("SCHEMA_TYPE:", "SCHEMA_REF_", "SCHEMA_UNSUPPORTED:")) for error in errors):
        return errors
    producer = handoff.get("producer_skill")
    event_type = handoff.get("event_type")
    if event_type not in PRODUCER_EVENTS.get(producer, set()):
        errors.append("EVENT_PRODUCER_MISMATCH")
    if handoff.get("write_authority") != "registration_proposal":
        errors.append("WRITE_AUTHORITY")

    context = handoff.get("routing_context", {})
    missing_fields = set(handoff.get("missing_registration_fields", []))
    deferred = missing_fields if handoff.get("handoff_status") == "needs_registration_context" else set()
    if handoff.get("handoff_status") == "needs_registration_context" and not deferred:
        errors.append("MISSING_REGISTRATION_FIELDS_REQUIRED")
    errors.extend(f"MISSING_REGISTRATION_FIELD_UNKNOWN:{field}"
                  for field in missing_fields - DEFERRED_REGISTRATION_FIELDS)
    deferred = deferred & DEFERRED_REGISTRATION_FIELDS
    for field in ("enterprise_id", "project_id", "process_id"):
        if context.get(field) is None and field not in deferred:
            errors.append(f"REGISTRATION_CONTEXT_UNDECLARED:{field}")
    if handoff.get("handoff_status") == "ready_for_registration":
        if missing_fields:
            errors.append("READY_HAS_MISSING_REGISTRATION_FIELDS")
        for field in ("enterprise_id", "project_id", "process_id"):
            if not context.get(field) or not context[field].strip():
                errors.append(f"READY_CONTEXT_MISSING:{field}")

    allowed_collections = PRODUCER_COLLECTIONS.get(producer, set())
    workflow_card_refs = set()
    for proposal in handoff.get("records_to_register", []):
        collection = proposal.get("collection")
        record = proposal.get("record", {})
        record_errors = validate_schema(record, registration_schema(collection, record, deferred))
        errors.extend(record_errors)
        if any(error.startswith("SCHEMA_TYPE:") for error in record_errors):
            continue
        # Scope and known identities remain binding even in a pending proposal.
        errors.extend(identity_errors(context, record, ("enterprise_id", "project_id"),
                                      deferred, f"HANDOFF_RECORD_SCOPE:{record_ref(record)}", "/"))
        for field in RECORD_REQUIRED_FIELDS:
            if field not in record:
                errors.append(f"RECORD_FIELD_MISSING:{record_ref(record)}/{field}")
        if collection not in allowed_collections:
            errors.append(f"COLLECTION_NOT_ALLOWED:{producer}/{collection}")
        if collection == "workflow_cards":
            workflow_card_refs.add(record_ref(record))
            if record.get("record_type") != "workflow_card":
                errors.append(f"WORKFLOW_CARD_TYPE:{record_ref(record)}")
            errors.extend(identity_errors(context, record, ("participant_id", "process_id"),
                                          deferred, "WORKFLOW_CONTEXT_MISMATCH"))
            if event_type == "workflow_card_confirmed":
                if record.get("employee_confirmed") is not True or not record.get("confirmed_at"):
                    errors.append(f"WORKFLOW_CONFIRMATION_REQUIRED:{record_ref(record)}")
                unknown_auth = record.get("authorization_status") is None and "authorization_status" in deferred
                if record.get("lifecycle_status") != "current" or (
                    record.get("authorization_status") not in {"authorized", "restricted", "not_required"}
                    and not unknown_auth
                ):
                    errors.append(f"WORKFLOW_CARD_NOT_READY:{record_ref(record)}")
            elif event_type == "workflow_card_declined" and (
                record.get("employee_confirmed") is True or record.get("confirmed_at") is not None
            ):
                errors.append(f"WORKFLOW_DECLINED_CONFIRMATION_CLAIM:{record_ref(record)}")
        if producer == "enterprise-ai-process-diagnosis" and record.get("review_status") == "approved":
            errors.append(f"DIAGNOSIS_SELF_APPROVAL:{record_ref(record)}")

    if handoff.get("participant_task_updates") and producer != "enterprise-workflow-mapping":
        errors.append(f"PRODUCER_TASK_UPDATE_FORBIDDEN:{producer}")
    for task_update in handoff.get("participant_task_updates", []):
        if task_update.get("status") == "completed":
            errors.append(f"TASK_STATUS_NOT_ALLOWED:{producer}/completed")
        expected_status = {"workflow_card_confirmed": "confirmed", "workflow_card_declined": "participant_declined"}.get(event_type)
        if producer == "enterprise-workflow-mapping" and task_update.get("status") != expected_status:
            errors.append("WORKFLOW_EVENT_TASK_STATUS")
        for field in task_update:
            if field not in TASK_UPDATE_FIELDS:
                errors.append(f"TASK_UPDATE_FORBIDDEN_FIELD:{field}")

    if producer == "enterprise-workflow-mapping" and (
        event_type == "workflow_card_confirmed" or workflow_card_refs
    ):
        task_card_refs = {
            item.get("current_workflow_card")
            for item in handoff.get("participant_task_updates", [])
            if item.get("current_workflow_card")
        }
        waiting_for_task = ("task_id" in deferred and context.get("task_id") is None
                            and not handoff.get("participant_task_updates"))
        if not workflow_card_refs or (task_card_refs != workflow_card_refs and not waiting_for_task):
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
