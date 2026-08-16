import unittest


def coverage_gate(items: list[dict]) -> tuple[bool, list[str]]:
    gaps = []
    for item in items:
        if item["priority"] != "P0":
            continue
        if item["task_status"] == "completed":
            continue
        accepted = all(
            item.get(field)
            for field in ("accepted_by", "alternative_evidence", "residual_risk", "continue_reason")
        )
        if not accepted:
            gaps.append(f'{item["role"]}:{item["task_status"]}')
    return not gaps, gaps


def evidence_output(level: str, text: str, hypothesis_label: str | None = None) -> dict:
    if level == "E5" and hypothesis_label != "AI假设，待验证":
        raise ValueError("E5 must remain visibly labelled")
    return {"evidence_level": level, "text": text, "label": hypothesis_label}


def route_attachment(
    content_hash: str,
    known_materials: dict[str, dict],
    origin_task: str,
    enterprise_id: str,
) -> dict:
    existing = known_materials.get(content_hash)
    if (
        existing
        and existing["enterprise_id"] == enterprise_id
        and existing["authorization_status"] in {"authorized", "restricted"}
    ):
        return {
            "module": "enterprise-material-analysis",
            "action": "reuse_authorized_material_record",
            "material_ref": existing["material_ref"],
            "return_to": origin_task,
        }
    return {
        "module": "enterprise-material-analysis",
        "action": "create_material_record_and_analyze",
        "return_to": origin_task,
    }


def close_h2(source_level: str) -> dict:
    return {
        "record_type": "organizational_confirmation",
        "decision_class": "organization_decision",
        "source_evidence_level": source_level,
        "fact_level_promoted": False,
    }


def resume_s0(block: dict, actor_role: str, conditions_met: bool) -> bool:
    return actor_role == "project_owner" and conditions_met and bool(block.get("recovery_conditions"))


def invalidated_descendants(withdrawn_ref: str, lineage: dict[str, list[str]]) -> set[str]:
    invalid = {withdrawn_ref}
    changed = True
    while changed:
        changed = False
        for record_ref, upstream in lineage.items():
            if record_ref not in invalid and any(ref in invalid for ref in upstream):
                invalid.add(record_ref)
                changed = True
    return invalid


class RoutingContractV02SimulationTest(unittest.TestCase):
    def test_01_normal_path_reaches_diagnosis_only_after_p0_coverage(self) -> None:
        coverage = [
            {"priority": "P0", "role": "门店客服", "task_status": "completed"},
            {"priority": "P0", "role": "店长", "task_status": "completed"},
            {"priority": "P1", "role": "总部品控", "task_status": "interviewing"},
        ]
        allowed, gaps = coverage_gate(coverage)
        self.assertTrue(allowed)
        self.assertEqual([], gaps)
        self.assertEqual(
            "AI假设，待验证",
            evidence_output("E5", "晚补录可能导致风险识别延迟", "AI假设，待验证")["label"],
        )
        with self.assertRaises(ValueError):
            evidence_output("E5", "晚补录已经造成损失")

    def test_02_attachment_is_analyzed_and_returns_to_employee_task(self) -> None:
        first = route_attachment(
            "hash-new", {}, "PART-E017+PROC-COMPLAINT", "ENT-SIM-RTL"
        )
        duplicate = route_attachment(
            "hash-existing",
            {
                "hash-existing": {
                    "material_ref": "MAT-R05@1",
                    "enterprise_id": "ENT-SIM-RTL",
                    "authorization_status": "authorized",
                }
            },
            "PART-E017+PROC-COMPLAINT",
            "ENT-SIM-RTL",
        )
        cross_enterprise = route_attachment(
            "hash-existing",
            {
                "hash-existing": {
                    "material_ref": "MAT-OTHER@1",
                    "enterprise_id": "ENT-OTHER",
                    "authorization_status": "authorized",
                }
            },
            "PART-E017+PROC-COMPLAINT",
            "ENT-SIM-RTL",
        )
        self.assertEqual("create_material_record_and_analyze", first["action"])
        self.assertEqual("reuse_authorized_material_record", duplicate["action"])
        self.assertEqual("MAT-R05@1", duplicate["material_ref"])
        self.assertEqual("PART-E017+PROC-COMPLAINT", duplicate["return_to"])
        self.assertEqual("create_material_record_and_analyze", cross_enterprise["action"])

    def test_03_employee_decline_creates_gap_and_blocks_diagnosis(self) -> None:
        coverage = [{"priority": "P0", "role": "门店客服", "task_status": "participant_declined"}]
        allowed, gaps = coverage_gate(coverage)
        self.assertFalse(allowed)
        self.assertEqual(["门店客服:participant_declined"], gaps)

    def test_04_h2_decision_does_not_promote_source_to_fact(self) -> None:
        confirmation = close_h2("E3")
        self.assertEqual("organizational_confirmation", confirmation["record_type"])
        self.assertEqual("organization_decision", confirmation["decision_class"])
        self.assertEqual("E3", confirmation["source_evidence_level"])
        self.assertFalse(confirmation["fact_level_promoted"])

    def test_05_s0_requires_project_owner_manual_recovery(self) -> None:
        block = {
            "reason": "材料授权撤回",
            "affected_records": ["MAT-R05@1", "EVIDENCE-RTL-001@1"],
            "recovery_conditions": ["获得新授权材料", "完成下游失效检查"],
        }
        self.assertFalse(resume_s0(block, "agent", True))
        self.assertFalse(resume_s0(block, "project_owner", False))
        self.assertTrue(resume_s0(block, "project_owner", True))

    def test_06_material_withdrawal_propagates_to_all_descendants(self) -> None:
        lineage = {
            "EVIDENCE-RTL-001@1": ["MAT-R05@1"],
            "DIAG-RTL-001@1": ["EVIDENCE-RTL-001@1"],
            "VIEW-LEADER-001@1": ["DIAG-RTL-001@1"],
            "CARD-UNRELATED@1": [],
        }
        invalid = invalidated_descendants("MAT-R05@1", lineage)
        self.assertEqual(
            {"MAT-R05@1", "EVIDENCE-RTL-001@1", "DIAG-RTL-001@1", "VIEW-LEADER-001@1"},
            invalid,
        )
        self.assertNotIn("CARD-UNRELATED@1", invalid)


if __name__ == "__main__":
    unittest.main()
