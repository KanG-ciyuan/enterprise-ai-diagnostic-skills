#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path


REQUIRED_TOP_LEVEL = (
    "record_type",
    "schema_version",
    "record_id",
    "version",
    "enterprise_id",
    "project_id",
    "project_identity",
    "current_stage",
    "research_coverage",
    "workflow_cards",
    "materials",
    "conflicts_and_evidence_requests",
    "organizational_confirmations",
    "diagnoses_and_pilots",
    "output_views",
)

INDEX_COLLECTIONS = (
    "workflow_cards",
    "materials",
    "conflicts_and_evidence_requests",
    "organizational_confirmations",
    "diagnoses_and_pilots",
)

ALLOWED_STAGES = {
    "interview_preparation",
    "workflow_mapping",
    "evidence_completion",
    "diagnosis",
    "pilot",
    "completed",
    "paused",
}

ALLOWED_AUTHORIZATION_STATUSES = {
    "pending",
    "authorized",
    "restricted",
    "withdrawn",
    "not_required",
}

V02_REQUIRED_TOP_LEVEL = (
    "participant_tasks",
    "stops_and_recoveries",
)

ALLOWED_PARTICIPANT_TASK_STATUSES = {
    "pending_assignment",
    "ready",
    "interviewing",
    "awaiting_material_analysis",
    "awaiting_employee_confirmation",
    "confirmed",
    "participant_declined",
    "unreachable",
    "paused_participant",
    "completed",
}

EVIDENCE_LEVELS = {"E1", "E2", "E3", "E4", "E5"}


def record_ref(item: dict) -> str:
    return f"{item.get('record_id', '?')}@{item.get('version', '?')}"


def indexed_records(record: dict):
    for collection in INDEX_COLLECTIONS:
        for item in record.get(collection, []):
            yield collection, item


def validate_structure(record: dict) -> list[str]:
    errors = []
    if not isinstance(record, dict):
        return ["STRUCTURE_TYPE:root"]
    for key in REQUIRED_TOP_LEVEL:
        if key not in record:
            errors.append(f"STRUCTURE_MISSING:{key}")
    if record.get("record_type") not in (None, "enterprise_ai_diagnostic_master_record"):
        errors.append("STRUCTURE_RECORD_TYPE:record_type")
    schema_version = record.get("schema_version")
    if schema_version is not None and schema_version not in {"0.1", "0.2"}:
        errors.append(f"STRUCTURE_SCHEMA_VERSION:{schema_version}")
    for collection in INDEX_COLLECTIONS + ("research_coverage", "output_views"):
        if collection in record and not isinstance(record[collection], list):
            errors.append(f"STRUCTURE_ARRAY:{collection}")
    stage = record.get("current_stage", {}).get("stage")
    if stage is not None and stage not in ALLOWED_STAGES:
        errors.append(f"STRUCTURE_STAGE:{stage}")
    for _, item in indexed_records(record):
        authorization_status = item.get("authorization_status")
        if authorization_status not in ALLOWED_AUTHORIZATION_STATUSES:
            errors.append(f"STRUCTURE_AUTH:{record_ref(item)}/{authorization_status}")
    return errors


def validate_v02(record: dict) -> list[str]:
    if record.get("schema_version") != "0.2":
        return []

    errors = []
    for key in V02_REQUIRED_TOP_LEVEL:
        if key not in record:
            errors.append(f"V02_MISSING:{key}")
        elif not isinstance(record[key], list):
            errors.append(f"V02_ARRAY:{key}")

    available = {record_ref(item) for _, item in indexed_records(record)}
    diagnosis_stages = {"diagnosis", "pilot", "completed"}
    current_stage = record.get("current_stage", {}).get("stage")
    p0_task_keys = set()
    for task in record.get("participant_tasks", []):
        task_id = task.get("task_id", "?")
        status = task.get("status")
        if status not in ALLOWED_PARTICIPANT_TASK_STATUSES:
            errors.append(f"TASK_STATUS:{task_id}/{status}")
        card_ref = task.get("current_workflow_card")
        if status == "completed" and not card_ref:
            errors.append(f"TASK_COMPLETED_WITHOUT_CARD:{task_id}")
        if card_ref and card_ref not in available:
            errors.append(f"TASK_CARD_NOT_FOUND:{task_id}->{card_ref}")
        if task.get("priority") == "P0" and status != "completed" and current_stage in diagnosis_stages:
            acceptance = task.get("risk_acceptance", {})
            required = (
                "accepted_by_role",
                "alternative_evidence",
                "residual_risk",
                "continue_reason",
                "applicable_scope",
            )
            if not all(acceptance.get(field) for field in required):
                errors.append(f"COVERAGE_P0_UNRESOLVED:{task_id}")
        if task.get("priority") == "P0":
            p0_task_keys.add((task.get("department_id"), task.get("role"), task.get("process_id")))

    if current_stage in diagnosis_stages:
        for coverage in record.get("research_coverage", []):
            if coverage.get("priority") != "P0" or coverage.get("planned_participants", 0) < 1:
                continue
            key = (coverage.get("department_id"), coverage.get("role"), coverage.get("process_id"))
            if key not in p0_task_keys:
                errors.append(f"COVERAGE_P0_TASK_MISSING:{'/'.join(str(part) for part in key)}")

    for _, item in indexed_records(record):
        level = item.get("evidence_level")
        if level is not None and level not in EVIDENCE_LEVELS:
            errors.append(f"EVIDENCE_LEVEL:{record_ref(item)}/{level}")
        if level == "E5" and item.get("evidence_label") != "AI假设，待验证":
            errors.append(f"E5_LABEL_MISSING:{record_ref(item)}")

    required_confirmation_fields = (
        "decision_class",
        "source_evidence_level",
        "authority_basis",
        "applicable_scope",
        "effective_at",
    )
    for confirmation in record.get("organizational_confirmations", []):
        if confirmation.get("record_type") != "organizational_confirmation":
            continue
        if confirmation.get("decision_class") != "organization_decision" or not all(
            confirmation.get(field) for field in required_confirmation_fields[1:]
        ):
            errors.append(f"H2_DECISION_METADATA:{record_ref(confirmation)}")

    confirmation_refs = {
        record_ref(item) for item in record.get("organizational_confirmations", [])
    }
    conflict_refs = {
        record_ref(item) for item in record.get("conflicts_and_evidence_requests", [])
    }
    for conflict in record.get("conflicts_and_evidence_requests", []):
        confirmation_ref = conflict.get("resolved_by_confirmation_record")
        if confirmation_ref and confirmation_ref not in confirmation_refs:
            errors.append(
                f"CONFLICT_CONFIRMATION_NOT_FOUND:{record_ref(conflict)}->{confirmation_ref}"
            )
    for diagnosis in record.get("diagnoses_and_pilots", []):
        for gap_ref in diagnosis.get("outstanding_gaps", []):
            if gap_ref not in conflict_refs:
                errors.append(f"DIAG_GAP_NOT_FOUND:{record_ref(diagnosis)}->{gap_ref}")

    hashes: dict[str, list[str]] = {}
    for material in record.get("materials", []):
        content_hash = material.get("content_hash")
        if content_hash and not re.fullmatch(r"[a-fA-F0-9]{64}", content_hash):
            errors.append(f"MATERIAL_HASH_FORMAT:{record_ref(material)}")
        if content_hash and material.get("lifecycle_status") == "current":
            hashes.setdefault(content_hash, []).append(record_ref(material))
    for refs in hashes.values():
        if len(refs) > 1:
            errors.append(f"MATERIAL_DUPLICATE_HASH:{','.join(sorted(refs))}")

    active_stops = [
        stop for stop in record.get("stops_and_recoveries", []) if stop.get("status") == "active"
    ]
    if current_stage == "paused" and not active_stops:
        errors.append("S0_ACTIVE_RECORD_MISSING")
    recovery_fields = ("recovered_at", "recovered_by_role", "recovery_basis", "resume_stage")
    for stop in record.get("stops_and_recoveries", []):
        stop_id = stop.get("stop_id", "?")
        for affected_ref in stop.get("affected_records", []):
            if affected_ref not in available:
                errors.append(f"S0_AFFECTED_RECORD_NOT_FOUND:{stop_id}->{affected_ref}")
        if stop.get("status") != "recovered":
            continue
        if stop.get("manual_recovery") is not True or not all(stop.get(field) for field in recovery_fields):
            errors.append(f"S0_MANUAL_RECOVERY_REQUIRED:{stop.get('stop_id', '?')}")

    for view in record.get("output_views", []):
        if view.get("metadata_policy") != "preserve_source_metadata":
            errors.append(f"VIEW_METADATA_POLICY:{view.get('view_id', '?')}")
    return errors


def validate_identity_scope(record: dict) -> list[str]:
    errors = []
    enterprise_id = record.get("enterprise_id")
    project_id = record.get("project_id")
    for collection, item in indexed_records(record):
        ref = record_ref(item)
        if item.get("enterprise_id") != enterprise_id:
            errors.append(f"SCOPE_ENTERPRISE:{collection}/{ref}")
        if item.get("project_id") != project_id:
            errors.append(f"SCOPE_PROJECT:{collection}/{ref}")
    return errors


def validate_current_versions(record: dict) -> list[str]:
    current_by_id: dict[str, int] = {}
    for _, item in indexed_records(record):
        if item.get("lifecycle_status") != "current":
            continue
        record_id = item.get("record_id")
        if record_id:
            current_by_id[record_id] = current_by_id.get(record_id, 0) + 1
    return [
        f"VERSION_MULTIPLE_CURRENT:{record_id}"
        for record_id, count in sorted(current_by_id.items())
        if count > 1
    ]


def validate_lineage(record: dict) -> list[str]:
    available = {record_ref(item) for _, item in indexed_records(record)}
    errors = []
    for _, item in indexed_records(record):
        source = record_ref(item)
        for upstream in item.get("upstream_records", []):
            if upstream not in available:
                errors.append(f"LINEAGE_NOT_FOUND:{source}->{upstream}")
        supersedes = item.get("supersedes")
        if supersedes and supersedes not in available:
            errors.append(f"SUPERSEDES_NOT_FOUND:{source}->{supersedes}")
    for view in record.get("output_views", []):
        for source in view.get("source_records", []):
            if source not in available:
                errors.append(f"VIEW_SOURCE_NOT_FOUND:{view.get('view_id', '?')}->{source}")
    return errors


def validate_authorization(record: dict) -> list[str]:
    by_ref = {record_ref(item): item for _, item in indexed_records(record)}
    errors = []

    def withdrawn_ancestors(source_ref: str, visited: set[str] | None = None) -> set[str]:
        visited = set() if visited is None else visited
        if source_ref in visited:
            return set()
        visited.add(source_ref)
        source = by_ref.get(source_ref)
        if not source:
            return set()
        withdrawn = set()
        for upstream_ref in source.get("upstream_records", []):
            upstream = by_ref.get(upstream_ref)
            if not upstream:
                continue
            if upstream.get("authorization_status") == "withdrawn":
                withdrawn.add(upstream_ref)
            withdrawn.update(withdrawn_ancestors(upstream_ref, visited.copy()))
        return withdrawn

    for _, item in indexed_records(record):
        if item.get("lifecycle_status") != "current":
            continue
        source = record_ref(item)
        direct_upstreams = set(item.get("upstream_records", []))
        for upstream_ref in item.get("upstream_records", []):
            upstream = by_ref.get(upstream_ref)
            if upstream and upstream.get("authorization_status") == "withdrawn":
                errors.append(f"AUTH_WITHDRAWN_UPSTREAM:{source}->{upstream_ref}")
        for withdrawn_ref in withdrawn_ancestors(source):
            if withdrawn_ref not in direct_upstreams:
                errors.append(f"AUTH_WITHDRAWN_ANCESTOR:{source}->{withdrawn_ref}")
    return errors


def validate_publishability(record: dict) -> list[str]:
    by_ref = {record_ref(item): item for _, item in indexed_records(record)}
    errors = []
    for view in record.get("output_views", []):
        if view.get("publication_status") != "published":
            continue
        view_id = view.get("view_id", "?")
        for source_ref in view.get("source_records", []):
            source = by_ref.get(source_ref)
            if source and source.get("review_status") == "review_required":
                errors.append(f"PUBLISH_REVIEW_REQUIRED:{view_id}->{source_ref}")
            if source and source.get("authorization_status") == "withdrawn":
                errors.append(f"PUBLISH_WITHDRAWN:{view_id}->{source_ref}")
    return errors


def validate_master_record(record: dict) -> list[str]:
    validators = (
        validate_structure,
        validate_v02,
        validate_identity_scope,
        validate_current_versions,
        validate_lineage,
        validate_authorization,
        validate_publishability,
    )
    errors = []
    for validator in validators:
        errors.extend(validator(record))
    return sorted(set(errors))


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: validate_master_record.py <record.json>")
        return 2
    path = Path(argv[1])
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"INPUT_INVALID:{type(exc).__name__}")
        return 1
    errors = validate_master_record(record)
    if errors:
        for error in errors:
            print(error)
        return 1
    print("valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
