#!/usr/bin/env python3
import json
import sys
from pathlib import Path


ALLOWED_DECISIONS = {"invoke_skill", "wait_external", "request_human", "pause", "no_action"}
ALLOWED_SKILLS = {
    "enterprise-interview-preparation",
    "enterprise-workflow-mapping",
    "enterprise-material-analysis",
    "enterprise-ai-process-diagnosis",
}
REQUIRED_FIELDS = {
    "contract_type", "contract_version", "event_id", "decision", "target",
    "reason_codes", "human_summary", "context_package", "human_task",
    "proposed_state_change", "next_expected_events", "write_authority", "created_at",
}


def validate_output(output: dict) -> list[str]:
    errors = []
    missing = sorted(REQUIRED_FIELDS - set(output))
    errors.extend(f"FIELD_MISSING:{field}" for field in missing)
    if output.get("contract_type") != "enterprise_ai_diagnostic_scheduling_proposal":
        errors.append("CONTRACT_TYPE_INVALID")
    if output.get("contract_version") != "0.1":
        errors.append("CONTRACT_VERSION_INVALID")
    if output.get("write_authority") != "scheduling_proposal":
        errors.append("WRITE_AUTHORITY_INVALID")
    decision = output.get("decision")
    if decision not in ALLOWED_DECISIONS:
        errors.append("DECISION_INVALID")
    target = output.get("target")
    if decision == "invoke_skill":
        if isinstance(target, list):
            errors.append("MULTIPLE_PRIMARY_TARGETS")
        elif target not in ALLOWED_SKILLS:
            errors.append("SKILL_TARGET_INVALID")
    reasons = output.get("reason_codes")
    if not isinstance(reasons, list) or not reasons or not all(isinstance(item, str) and item for item in reasons):
        errors.append("REASON_CODES_REQUIRED")
    if decision == "pause":
        task = output.get("human_task")
        if not isinstance(task, dict) or not task.get("recovery_conditions"):
            errors.append("PAUSE_RECOVERY_REQUIRED")
    if not isinstance(output.get("context_package"), dict):
        errors.append("CONTEXT_PACKAGE_INVALID")
    if not isinstance(output.get("proposed_state_change"), dict):
        errors.append("STATE_CHANGE_INVALID")
    if not isinstance(output.get("next_expected_events"), list):
        errors.append("NEXT_EVENTS_INVALID")
    return sorted(set(errors))


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: validate_orchestrator_output.py <output.json>")
        return 2
    try:
        output = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"INPUT_INVALID:{type(exc).__name__}")
        return 1
    errors = validate_output(output)
    if errors:
        print("\n".join(errors))
        return 1
    print("valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

