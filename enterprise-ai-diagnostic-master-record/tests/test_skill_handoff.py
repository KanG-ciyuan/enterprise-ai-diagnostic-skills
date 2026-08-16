import json
import importlib.util
import copy
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "schema" / "skill-handoff-v0.2.schema.json"
VALIDATOR_PATH = ROOT / "scripts" / "validate_skill_handoff.py"
CHAIN_VALIDATOR_PATH = ROOT / "scripts" / "validate_handoff_chain.py"
EXAMPLE_DIR = ROOT / "examples" / "skill-handoffs"


def load_validator():
    spec = importlib.util.spec_from_file_location("validate_skill_handoff", VALIDATOR_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("handoff validator cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_chain_validator():
    sys.path.insert(0, str(CHAIN_VALIDATOR_PATH.parent))
    try:
        spec = importlib.util.spec_from_file_location("validate_handoff_chain", CHAIN_VALIDATOR_PATH)
        if spec is None or spec.loader is None:
            raise RuntimeError("handoff chain validator cannot be loaded")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.pop(0)


def base_handoff(producer: str, event_type: str) -> dict:
    return {
        "contract_type": "enterprise_ai_diagnostic_skill_handoff",
        "contract_version": "0.2",
        "handoff_id": "HANDOFF-001",
        "producer_skill": producer,
        "event_type": event_type,
        "handoff_status": "ready_for_registration",
        "write_authority": "registration_proposal",
        "routing_context": {
            "enterprise_id": "ENT-001",
            "project_id": "PRJ-001",
            "process_id": "PROC-001",
            "participant_id": None,
            "department_id": None,
            "role": None,
            "task_id": None,
        },
        "records_to_register": [],
        "participant_task_updates": [],
        "unresolved_items": [],
        "missing_registration_fields": [],
        "created_at": "2026-08-14T16:00:00+08:00",
    }


def indexed_record(record_id: str, record_type: str) -> dict:
    return {
        "record_id": record_id,
        "record_type": record_type,
        "version": 1,
        "lifecycle_status": "current",
        "enterprise_id": "ENT-001",
        "project_id": "PRJ-001",
        "authorization_status": "authorized",
        "upstream_records": [],
        "supersedes": None,
        "change_reason": "new source artifact",
        "storage_ref": f"artifacts/{record_id}.md",
        "created_at": "2026-08-14T16:00:00+08:00",
        "created_by_role": "agent",
    }


def valid_workflow_handoff() -> dict:
    handoff = base_handoff("enterprise-workflow-mapping", "workflow_card_confirmed")
    handoff["routing_context"].update(
        {
            "participant_id": "PART-001",
            "department_id": "DEPT-001",
            "role": "门店客服",
            "task_id": "TASK-001",
        }
    )
    handoff["records_to_register"] = [
        {"collection": "workflow_cards", "record": indexed_record("CARD-001", "workflow_card")}
    ]
    handoff["participant_task_updates"] = [
        {
            "task_id": "TASK-001",
            "status": "confirmed",
            "current_workflow_card": "CARD-001@1",
            "status_reason": "employee explicitly confirmed the card",
        }
    ]
    return handoff


def valid_material_handoff() -> dict:
    handoff = base_handoff("enterprise-material-analysis", "material_analysis_completed")
    material = indexed_record("MAT-001", "spreadsheet_sample")
    material["analysis_status"] = "analyzed"
    handoff["records_to_register"] = [{"collection": "materials", "record": material}]
    return handoff


def valid_diagnosis_handoff() -> dict:
    handoff = base_handoff("enterprise-ai-process-diagnosis", "process_diagnosis_completed")
    diagnosis = indexed_record("DIAG-001", "process_diagnosis")
    diagnosis["review_status"] = "review_required"
    diagnosis["outstanding_gaps"] = []
    handoff["records_to_register"] = [
        {"collection": "diagnoses_and_pilots", "record": diagnosis}
    ]
    return handoff


class SkillHandoffPackageTest(unittest.TestCase):
    def test_shared_handoff_schema_and_validator_exist(self) -> None:
        self.assertTrue(SCHEMA_PATH.is_file(), "shared handoff schema must exist")
        self.assertTrue(VALIDATOR_PATH.is_file(), "zero-dependency handoff validator must exist")
        self.assertTrue(CHAIN_VALIDATOR_PATH.is_file(), "read-only handoff chain validator must exist")

    def test_schema_declares_three_producers_and_registration_boundary(self) -> None:
        self.assertTrue(SCHEMA_PATH.is_file(), "shared handoff schema must exist")
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        producers = schema["properties"]["producer_skill"]["enum"]
        self.assertEqual(
            [
                "enterprise-workflow-mapping",
                "enterprise-material-analysis",
                "enterprise-ai-process-diagnosis",
            ],
            producers,
        )
        self.assertTrue(
            {"routing_context", "records_to_register", "participant_task_updates", "unresolved_items"}
            <= set(schema["required"])
        )
        self.assertEqual("registration_proposal", schema["properties"]["write_authority"]["const"])
        record_required = set(schema["$defs"]["recordProposal"]["properties"]["record"]["required"])
        self.assertTrue({"supersedes", "change_reason"} <= record_required)


class SkillHandoffValidatorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.validator = load_validator()

    def test_three_valid_producer_handoffs_pass(self) -> None:
        for handoff in (valid_workflow_handoff(), valid_material_handoff(), valid_diagnosis_handoff()):
            self.assertEqual([], self.validator.validate_skill_handoff(handoff))

    def test_event_must_match_producer(self) -> None:
        handoff = valid_workflow_handoff()
        handoff["event_type"] = "process_diagnosis_completed"
        self.assertIn("EVENT_PRODUCER_MISMATCH", self.validator.validate_skill_handoff(handoff))

    def test_ready_handoff_requires_real_routing_context(self) -> None:
        handoff = valid_material_handoff()
        handoff["routing_context"]["enterprise_id"] = None
        self.assertIn("READY_CONTEXT_MISSING:enterprise_id", self.validator.validate_skill_handoff(handoff))

    def test_workflow_card_and_task_update_must_reference_same_record(self) -> None:
        handoff = valid_workflow_handoff()
        handoff["participant_task_updates"][0]["current_workflow_card"] = "CARD-OTHER@1"
        self.assertIn("WORKFLOW_CARD_TASK_MISMATCH", self.validator.validate_skill_handoff(handoff))

    def test_material_analysis_cannot_propose_diagnosis_record(self) -> None:
        handoff = valid_material_handoff()
        diagnosis = indexed_record("DIAG-001", "process_diagnosis")
        diagnosis["review_status"] = "review_required"
        handoff["records_to_register"] = [
            {"collection": "diagnoses_and_pilots", "record": diagnosis}
        ]
        self.assertIn(
            "COLLECTION_NOT_ALLOWED:enterprise-material-analysis/diagnoses_and_pilots",
            self.validator.validate_skill_handoff(handoff),
        )

    def test_diagnosis_skill_cannot_self_approve(self) -> None:
        handoff = valid_diagnosis_handoff()
        handoff["records_to_register"][0]["record"]["review_status"] = "approved"
        self.assertIn("DIAGNOSIS_SELF_APPROVAL:DIAG-001@1", self.validator.validate_skill_handoff(handoff))

    def test_workflow_task_update_cannot_change_priority(self) -> None:
        handoff = valid_workflow_handoff()
        handoff["participant_task_updates"][0]["priority"] = "P0"
        self.assertIn("TASK_UPDATE_FORBIDDEN_FIELD:priority", self.validator.validate_skill_handoff(handoff))

    def test_handoff_has_no_direct_write_authority(self) -> None:
        handoff = valid_material_handoff()
        handoff["write_authority"] = "write_master_record"
        self.assertIn("WRITE_AUTHORITY", self.validator.validate_skill_handoff(handoff))

    def test_record_proposal_requires_master_index_fields(self) -> None:
        handoff = valid_material_handoff()
        handoff["records_to_register"][0]["record"].pop("change_reason", None)
        self.assertIn(
            "RECORD_FIELD_MISSING:MAT-001@1/change_reason",
            self.validator.validate_skill_handoff(handoff),
        )

    def test_three_example_handoffs_are_valid(self) -> None:
        paths = sorted(EXAMPLE_DIR.glob("*.json"))
        self.assertEqual(
            ["diagnosis.json", "material-analysis.json", "workflow-mapping.json"],
            [path.name for path in paths],
        )
        for path in paths:
            handoff = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual([], self.validator.validate_skill_handoff(handoff), path.name)

    def test_example_handoffs_preserve_producer_boundaries(self) -> None:
        for name in ("workflow-mapping.json", "material-analysis.json", "diagnosis.json"):
            self.assertTrue((EXAMPLE_DIR / name).is_file(), f"missing example: {name}")
        workflow = json.loads((EXAMPLE_DIR / "workflow-mapping.json").read_text(encoding="utf-8"))
        material = json.loads((EXAMPLE_DIR / "material-analysis.json").read_text(encoding="utf-8"))
        diagnosis = json.loads((EXAMPLE_DIR / "diagnosis.json").read_text(encoding="utf-8"))
        self.assertNotIn("priority", workflow["participant_task_updates"][0])
        self.assertTrue(
            {item["collection"] for item in material["records_to_register"]}
            <= {"materials", "conflicts_and_evidence_requests"}
        )
        diagnosis_record = diagnosis["records_to_register"][0]["record"]
        self.assertEqual("review_required", diagnosis_record["review_status"])
        self.assertIn("outstanding_gaps", diagnosis_record)


class SkillHandoffChainValidatorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.validator = load_chain_validator()
        cls.master = json.loads(
            (ROOT / "examples" / "retail-complaint-master-record-v0.2.json").read_text(encoding="utf-8")
        )
        cls.handoffs = [
            json.loads((EXAMPLE_DIR / name).read_text(encoding="utf-8"))
            for name in ("workflow-mapping.json", "material-analysis.json", "diagnosis.json")
        ]

    def test_sequential_examples_form_valid_virtual_chain(self) -> None:
        self.assertEqual([], self.validator.validate_handoff_chain(self.master, self.handoffs))

    def test_handoff_project_must_match_master_record(self) -> None:
        handoffs = copy.deepcopy(self.handoffs)
        handoffs[0]["routing_context"]["project_id"] = "PRJ-OTHER"
        self.assertIn(
            "CHAIN_PROJECT_SCOPE:HANDOFF-WORKFLOW-001/PRJ-OTHER",
            self.validator.validate_handoff_chain(self.master, handoffs),
        )

    def test_upstream_reference_must_exist_in_master_or_prior_proposal(self) -> None:
        handoffs = copy.deepcopy(self.handoffs)
        handoffs[1]["records_to_register"][1]["record"]["upstream_records"] = ["CARD-404@1"]
        self.assertIn(
            "CHAIN_UPSTREAM_NOT_FOUND:X-H2-002@1->CARD-404@1",
            self.validator.validate_handoff_chain(self.master, handoffs),
        )

    def test_task_update_must_reference_existing_master_task(self) -> None:
        handoffs = copy.deepcopy(self.handoffs)
        handoffs[0]["participant_task_updates"][0]["task_id"] = "TASK-404"
        self.assertIn(
            "CHAIN_TASK_NOT_FOUND:HANDOFF-WORKFLOW-001->TASK-404",
            self.validator.validate_handoff_chain(self.master, handoffs),
        )


if __name__ == "__main__":
    unittest.main()
