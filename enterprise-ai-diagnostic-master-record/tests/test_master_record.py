import copy
import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "validate_master_record.py"


def load_validator():
    spec = importlib.util.spec_from_file_location("validate_master_record", MODULE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("validator module cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def valid_record() -> dict:
    return {
        "record_type": "enterprise_ai_diagnostic_master_record",
        "schema_version": "0.1",
        "record_id": "MASTER-001",
        "version": 1,
        "enterprise_id": "ENT-001",
        "project_id": "PRJ-001",
        "project_identity": {
            "enterprise_display_name": "模拟企业",
            "project_name": "客诉流程诊断",
            "project_owner_role": "企业项目负责人",
            "created_at": "2026-08-13T10:00:00+08:00",
        },
        "current_stage": {
            "stage": "diagnosis",
            "status": "active",
            "owner_role": "改造方项目负责人",
            "updated_at": "2026-08-13T12:00:00+08:00",
        },
        "research_coverage": [],
        "workflow_cards": [
            {
                "record_id": "CARD-001",
                "record_type": "workflow_card",
                "version": 1,
                "lifecycle_status": "current",
                "enterprise_id": "ENT-001",
                "project_id": "PRJ-001",
                "participant_id": "PART-001",
                "process_id": "PROC-001",
                "authorization_status": "authorized",
                "upstream_records": [],
                "supersedes": None,
                "change_reason": "initial confirmation",
                "storage_ref": "simulations/card-001.md",
                "created_at": "2026-08-13T10:30:00+08:00",
                "created_by_role": "employee",
            }
        ],
        "materials": [
            {
                "record_id": "MAT-001",
                "record_type": "material",
                "version": 1,
                "lifecycle_status": "current",
                "enterprise_id": "ENT-001",
                "project_id": "PRJ-001",
                "authorization_status": "authorized",
                "analysis_status": "analyzed",
                "upstream_records": [],
                "supersedes": None,
                "change_reason": "initial intake",
                "storage_ref": "simulations/material-001.md",
                "created_at": "2026-08-13T10:40:00+08:00",
                "created_by_role": "employee",
            }
        ],
        "conflicts_and_evidence_requests": [],
        "organizational_confirmations": [],
        "diagnoses_and_pilots": [
            {
                "record_id": "DIAG-001",
                "record_type": "process_diagnosis",
                "version": 1,
                "lifecycle_status": "current",
                "review_status": "approved",
                "enterprise_id": "ENT-001",
                "project_id": "PRJ-001",
                "authorization_status": "authorized",
                "upstream_records": ["CARD-001@1", "MAT-001@1"],
                "supersedes": None,
                "change_reason": "initial diagnosis",
                "storage_ref": "simulations/diagnosis-001.md",
                "created_at": "2026-08-13T11:00:00+08:00",
                "created_by_role": "transformation_practitioner",
            }
        ],
        "output_views": [
            {
                "view_id": "VIEW-001",
                "audience_role": "enterprise_leader",
                "publication_status": "published",
                "source_records": ["DIAG-001@1"],
                "allowed_sections": ["findings", "pilot"],
                "excluded_sections": ["raw_employee_materials"],
            }
        ],
    }


def valid_v02_record() -> dict:
    record = valid_record()
    record["schema_version"] = "0.2"
    record["participant_tasks"] = [
        {
            "task_id": "TASK-001",
            "participant_id": "PART-001",
            "department_id": "DEPT-001",
            "role": "门店客服",
            "process_id": "PROC-001",
            "priority": "P0",
            "status": "completed",
            "current_workflow_card": "CARD-001@1",
            "updated_at": "2026-08-13T10:45:00+08:00",
            "updated_by_role": "employee",
            "status_reason": "employee confirmed and no blocking exception remains",
        }
    ]
    record["stops_and_recoveries"] = []
    record["materials"][0]["content_hash"] = "a" * 64
    record["output_views"][0]["metadata_policy"] = "preserve_source_metadata"
    return record


class MasterRecordValidatorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.validator = load_validator()

    def test_valid_record_has_no_errors(self) -> None:
        self.assertEqual([], self.validator.validate_master_record(valid_record()))

    def test_missing_enterprise_id_is_rejected(self) -> None:
        record = valid_record()
        del record["enterprise_id"]
        self.assertIn("STRUCTURE_MISSING:enterprise_id", self.validator.validate_master_record(record))

    def test_unknown_stage_is_rejected_without_jsonschema_dependency(self) -> None:
        record = valid_record()
        record["current_stage"]["stage"] = "magic_stage"
        self.assertIn("STRUCTURE_STAGE:magic_stage", self.validator.validate_master_record(record))

    def test_unknown_authorization_status_is_rejected(self) -> None:
        record = valid_record()
        record["materials"][0]["authorization_status"] = "maybe"
        self.assertIn("STRUCTURE_AUTH:MAT-001@1/maybe", self.validator.validate_master_record(record))

    def test_cross_project_reference_is_rejected(self) -> None:
        record = valid_record()
        record["materials"][0]["project_id"] = "PRJ-OTHER"
        errors = self.validator.validate_master_record(record)
        self.assertIn("SCOPE_PROJECT:materials/MAT-001@1", errors)

    def test_two_current_versions_of_same_record_are_rejected(self) -> None:
        record = valid_record()
        second = copy.deepcopy(record["workflow_cards"][0])
        second["version"] = 2
        second["supersedes"] = "CARD-001@1"
        record["workflow_cards"].append(second)
        errors = self.validator.validate_master_record(record)
        self.assertIn("VERSION_MULTIPLE_CURRENT:CARD-001", errors)

    def test_missing_upstream_record_is_rejected(self) -> None:
        record = valid_record()
        record["diagnoses_and_pilots"][0]["upstream_records"].append("CARD-404@1")
        errors = self.validator.validate_master_record(record)
        self.assertIn("LINEAGE_NOT_FOUND:DIAG-001@1->CARD-404@1", errors)

    def test_withdrawn_material_cannot_support_current_diagnosis(self) -> None:
        record = valid_record()
        record["materials"][0]["authorization_status"] = "withdrawn"
        errors = self.validator.validate_master_record(record)
        self.assertIn("AUTH_WITHDRAWN_UPSTREAM:DIAG-001@1->MAT-001@1", errors)

    def test_withdrawn_material_propagates_through_evidence_pack_to_diagnosis(self) -> None:
        record = valid_record()
        record["materials"][0]["authorization_status"] = "withdrawn"
        evidence_pack = {
            "record_id": "EVIDENCE-001",
            "record_type": "enterprise_material_evidence_pack",
            "version": 1,
            "lifecycle_status": "current",
            "enterprise_id": "ENT-001",
            "project_id": "PRJ-001",
            "authorization_status": "authorized",
            "upstream_records": ["MAT-001@1"],
            "supersedes": None,
            "change_reason": "derived evidence",
            "storage_ref": "simulations/evidence-001.md",
            "created_at": "2026-08-13T10:50:00+08:00",
            "created_by_role": "material_analyst",
        }
        record["conflicts_and_evidence_requests"].append(evidence_pack)
        record["diagnoses_and_pilots"][0]["upstream_records"] = ["EVIDENCE-001@1"]
        errors = self.validator.validate_master_record(record)
        self.assertIn("AUTH_WITHDRAWN_ANCESTOR:DIAG-001@1->MAT-001@1", errors)

    def test_review_required_diagnosis_cannot_be_published(self) -> None:
        record = valid_record()
        record["diagnoses_and_pilots"][0]["review_status"] = "review_required"
        errors = self.validator.validate_master_record(record)
        self.assertIn("PUBLISH_REVIEW_REQUIRED:VIEW-001->DIAG-001@1", errors)

    def test_superseded_card_and_new_current_version_are_valid(self) -> None:
        record = valid_record()
        first = record["workflow_cards"][0]
        first["lifecycle_status"] = "superseded"
        second = copy.deepcopy(first)
        second["version"] = 2
        second["lifecycle_status"] = "current"
        second["supersedes"] = "CARD-001@1"
        second["change_reason"] = "employee correction"
        record["workflow_cards"].append(second)
        record["diagnoses_and_pilots"][0]["upstream_records"] = ["CARD-001@2", "MAT-001@1"]
        self.assertEqual([], self.validator.validate_master_record(record))

    def test_recovery_uses_new_evidence_and_diagnosis_versions(self) -> None:
        record = valid_record()
        old_diagnosis = record["diagnoses_and_pilots"][0]
        old_diagnosis["lifecycle_status"] = "superseded"
        old_diagnosis["review_status"] = "review_required"
        replacement_material = copy.deepcopy(record["materials"][0])
        replacement_material["record_id"] = "MAT-002"
        replacement_material["change_reason"] = "authorized replacement evidence"
        record["materials"].append(replacement_material)
        confirmation = {
            "record_id": "CONFIRM-001",
            "record_type": "organizational_confirmation",
            "version": 1,
            "lifecycle_status": "current",
            "enterprise_id": "ENT-001",
            "project_id": "PRJ-001",
            "authorization_status": "not_required",
            "upstream_records": ["MAT-002@1"],
            "supersedes": None,
            "change_reason": "authorized owner confirmed the rule",
            "storage_ref": "simulations/confirmation-001.md",
            "created_at": "2026-08-13T11:30:00+08:00",
            "created_by_role": "enterprise_owner",
        }
        record["organizational_confirmations"].append(confirmation)
        new_diagnosis = copy.deepcopy(old_diagnosis)
        new_diagnosis["version"] = 2
        new_diagnosis["lifecycle_status"] = "current"
        new_diagnosis["review_status"] = "approved"
        new_diagnosis["upstream_records"] = ["CARD-001@1", "MAT-002@1", "CONFIRM-001@1"]
        new_diagnosis["supersedes"] = "DIAG-001@1"
        new_diagnosis["change_reason"] = "recalculated after replacement evidence and confirmation"
        record["diagnoses_and_pilots"].append(new_diagnosis)
        record["output_views"][0]["source_records"] = ["DIAG-001@2"]
        self.assertEqual([], self.validator.validate_master_record(record))

    def test_retail_example_is_valid_json_and_contract(self) -> None:
        path = ROOT / "examples" / "retail-complaint-master-record.json"
        record = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual([], self.validator.validate_master_record(record))

    def test_schema_declares_required_identity_and_status_enums(self) -> None:
        schema = json.loads((ROOT / "schema" / "master-record.schema.json").read_text(encoding="utf-8"))
        self.assertTrue({"enterprise_id", "project_id", "workflow_cards", "materials", "output_views"} <= set(schema["required"]))
        self.assertEqual(
            ["pending", "authorized", "restricted", "withdrawn", "not_required"],
            schema["$defs"]["authorizationStatus"]["enum"],
        )

    def test_existing_skill_contracts_can_be_wrapped_without_modification(self) -> None:
        workflow_schema = json.loads(
            (ROOT.parent / "enterprise-workflow-mapping" / "templates" / "workflow-card.schema.json").read_text(encoding="utf-8")
        )
        evidence_schema = json.loads(
            (ROOT.parent / "enterprise-material-analysis" / "templates" / "evidence-pack.schema.json").read_text(encoding="utf-8")
        )
        for schema in (workflow_schema, evidence_schema):
            self.assertTrue({"project_id", "version"} <= set(schema["required"]))
            self.assertIn("upstream_records", schema["properties"])
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("employee_id` 映射为 `participant_id", readme)
        self.assertIn("不修改现有三个 Skill", readme)


class MasterRecordV02ValidatorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.validator = load_validator()

    def test_v02_requires_participant_tasks_and_stop_records(self) -> None:
        record = valid_record()
        record["schema_version"] = "0.2"
        errors = self.validator.validate_master_record(record)
        self.assertIn("V02_MISSING:participant_tasks", errors)
        self.assertIn("V02_MISSING:stops_and_recoveries", errors)

    def test_unresolved_p0_task_blocks_diagnosis(self) -> None:
        record = valid_v02_record()
        record["participant_tasks"][0]["status"] = "participant_declined"
        record["participant_tasks"][0].pop("current_workflow_card")
        errors = self.validator.validate_master_record(record)
        self.assertIn("COVERAGE_P0_UNRESOLVED:TASK-001", errors)

    def test_completed_task_requires_current_workflow_card(self) -> None:
        record = valid_v02_record()
        record["participant_tasks"][0].pop("current_workflow_card")
        errors = self.validator.validate_master_record(record)
        self.assertIn("TASK_COMPLETED_WITHOUT_CARD:TASK-001", errors)

    def test_e5_record_requires_visible_hypothesis_label(self) -> None:
        record = valid_v02_record()
        record["diagnoses_and_pilots"][0]["evidence_level"] = "E5"
        errors = self.validator.validate_master_record(record)
        self.assertIn("E5_LABEL_MISSING:DIAG-001@1", errors)

    def test_h2_confirmation_requires_decision_metadata(self) -> None:
        record = valid_v02_record()
        record["organizational_confirmations"].append(
            {
                "record_id": "CONFIRM-H2-001",
                "record_type": "organizational_confirmation",
                "version": 1,
                "lifecycle_status": "current",
                "enterprise_id": "ENT-001",
                "project_id": "PRJ-001",
                "authorization_status": "not_required",
                "upstream_records": ["CARD-001@1"],
                "supersedes": None,
                "change_reason": "future handling rule",
                "storage_ref": "simulations/h2-001.md",
                "created_at": "2026-08-13T11:30:00+08:00",
                "created_by_role": "enterprise_owner",
            }
        )
        errors = self.validator.validate_master_record(record)
        self.assertIn("H2_DECISION_METADATA:CONFIRM-H2-001@1", errors)

    def test_duplicate_content_hash_is_rejected(self) -> None:
        record = valid_v02_record()
        duplicate = copy.deepcopy(record["materials"][0])
        duplicate["record_id"] = "MAT-002"
        duplicate["storage_ref"] = "simulations/material-duplicate.md"
        record["materials"].append(duplicate)
        errors = self.validator.validate_master_record(record)
        self.assertIn("MATERIAL_DUPLICATE_HASH:MAT-001@1,MAT-002@1", errors)

    def test_paused_project_requires_active_s0_record(self) -> None:
        record = valid_v02_record()
        record["current_stage"]["stage"] = "paused"
        record["current_stage"]["status"] = "paused"
        errors = self.validator.validate_master_record(record)
        self.assertIn("S0_ACTIVE_RECORD_MISSING", errors)

    def test_valid_v02_record_has_no_errors(self) -> None:
        self.assertEqual([], self.validator.validate_master_record(valid_v02_record()))

    def test_v02_schema_declares_new_contract_fields(self) -> None:
        path = ROOT / "schema" / "master-record-v0.2.schema.json"
        self.assertTrue(path.exists(), "v0.2 schema file must exist")
        schema = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual("0.2", schema["properties"]["schema_version"]["const"])
        self.assertTrue({"participant_tasks", "stops_and_recoveries"} <= set(schema["required"]))
        self.assertIn("content_hash", schema["$defs"]["materialRecord"]["properties"])
        self.assertIn("decision_class", schema["$defs"]["organizationalConfirmation"]["properties"])
        self.assertTrue({"department_id", "role"} <= set(schema["$defs"]["participantTask"]["required"]))
        self.assertIn("resolved_by_confirmation_record", schema["$defs"]["conflictRecord"]["properties"])
        self.assertIn("outstanding_gaps", schema["$defs"]["diagnosticRecord"]["properties"])
        self.assertIn("metadata_policy", schema["$defs"]["outputView"]["required"])

    def test_retail_v02_example_is_valid(self) -> None:
        path = ROOT / "examples" / "retail-complaint-master-record-v0.2.json"
        self.assertTrue(path.exists(), "v0.2 example file must exist")
        record = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual("0.2", record["schema_version"])
        self.assertEqual([], self.validator.validate_master_record(record))

    def test_unknown_schema_version_is_rejected(self) -> None:
        record = valid_v02_record()
        record["schema_version"] = "9.9"
        self.assertIn("STRUCTURE_SCHEMA_VERSION:9.9", self.validator.validate_master_record(record))

    def test_invalid_content_hash_is_rejected(self) -> None:
        record = valid_v02_record()
        record["materials"][0]["content_hash"] = "not-a-sha256"
        self.assertIn("MATERIAL_HASH_FORMAT:MAT-001@1", self.validator.validate_master_record(record))

    def test_recovered_s0_requires_manual_recovery_metadata(self) -> None:
        record = valid_v02_record()
        record["stops_and_recoveries"] = [
            {
                "stop_id": "STOP-001",
                "status": "recovered",
                "reason": "authorization withdrawn",
                "affected_records": ["MAT-001@1"],
                "recovery_conditions": ["replacement authorization received"],
                "manual_recovery": False,
            }
        ]
        self.assertIn("S0_MANUAL_RECOVERY_REQUIRED:STOP-001", self.validator.validate_master_record(record))

    def test_p0_coverage_plan_requires_matching_participant_task(self) -> None:
        record = valid_v02_record()
        record["research_coverage"].append(
            {
                "department_id": "DEPT-FINANCE",
                "role": "退款审核员",
                "process_id": "PROC-REFUND",
                "priority": "P0",
                "planned_participants": 1,
                "status": "not_scheduled",
                "gap": "尚未创建员工任务",
            }
        )
        self.assertIn(
            "COVERAGE_P0_TASK_MISSING:DEPT-FINANCE/退款审核员/PROC-REFUND",
            self.validator.validate_master_record(record),
        )

    def test_conflict_resolution_must_reference_existing_confirmation(self) -> None:
        record = valid_v02_record()
        record["conflicts_and_evidence_requests"].append(
            {
                "record_id": "X-001",
                "record_type": "evidence_conflict",
                "version": 1,
                "lifecycle_status": "current",
                "enterprise_id": "ENT-001",
                "project_id": "PRJ-001",
                "authorization_status": "not_required",
                "upstream_records": ["CARD-001@1"],
                "supersedes": None,
                "change_reason": "responsibility conflict",
                "storage_ref": "simulations/conflict-001.md",
                "created_at": "2026-08-13T10:50:00+08:00",
                "created_by_role": "material_analyst",
                "resolved_by_confirmation_record": "CONFIRM-404@1",
            }
        )
        self.assertIn(
            "CONFLICT_CONFIRMATION_NOT_FOUND:X-001@1->CONFIRM-404@1",
            self.validator.validate_master_record(record),
        )

    def test_diagnosis_outstanding_gap_must_reference_conflict_record(self) -> None:
        record = valid_v02_record()
        record["diagnoses_and_pilots"][0]["outstanding_gaps"] = ["X-404@1"]
        self.assertIn(
            "DIAG_GAP_NOT_FOUND:DIAG-001@1->X-404@1",
            self.validator.validate_master_record(record),
        )

    def test_s0_affected_records_must_exist(self) -> None:
        record = valid_v02_record()
        record["stops_and_recoveries"] = [
            {
                "stop_id": "STOP-001",
                "status": "active",
                "reason": "source authorization withdrawn",
                "affected_records": ["MAT-404@1"],
                "recovery_conditions": ["replacement evidence received"],
                "created_at": "2026-08-13T11:30:00+08:00",
                "created_by_role": "project_owner",
            }
        ]
        self.assertIn(
            "S0_AFFECTED_RECORD_NOT_FOUND:STOP-001->MAT-404@1",
            self.validator.validate_master_record(record),
        )

    def test_published_view_must_preserve_source_metadata(self) -> None:
        record = valid_v02_record()
        record["output_views"][0].pop("metadata_policy")
        self.assertIn(
            "VIEW_METADATA_POLICY:VIEW-001",
            self.validator.validate_master_record(record),
        )


if __name__ == "__main__":
    unittest.main()
