#!/usr/bin/env python3
import copy
import json
import sys
from pathlib import Path


ROUTES = {
    "management_problem_submitted": ("enterprise-interview-preparation", "MANAGEMENT_SCOPE_DISCOVERY"),
    "participant_task_started": ("enterprise-workflow-mapping", "EMPLOYEE_MAPPING_TASK_READY"),
    "file_uploaded": ("enterprise-material-analysis", "AUTHORIZED_FILE_EVENT"),
    "diagnosis_gate_ready": ("enterprise-ai-process-diagnosis", "DIAGNOSIS_GATE_CONFIRMED"),
}


def task(task_type, responsible_role, question, reason, required_evidence, affected_decision, recovery_conditions, expected_return_event):
    return {
        "task_type": task_type,
        "responsible_role": responsible_role,
        "question": question,
        "reason": reason,
        "required_evidence": required_evidence,
        "affected_decision": affected_decision,
        "recovery_conditions": recovery_conditions,
        "expected_return_event": expected_return_event,
    }


def proposal(event, decision, target, reason_codes, summary, *, human_task=None, state_change=None, next_events=None):
    return {
        "contract_type": "enterprise_ai_diagnostic_scheduling_proposal",
        "contract_version": "0.1",
        "event_id": event.get("event_id", "unknown-event"),
        "decision": decision,
        "target": target,
        "reason_codes": reason_codes,
        "human_summary": summary,
        "context_package": {
            "enterprise_id": event.get("enterprise_id"),
            "project_id": event.get("project_id"),
            "event_type": event.get("event_type"),
            "actor_role": event.get("actor_role"),
            "payload": copy.deepcopy(event.get("payload", {})),
        },
        "human_task": human_task,
        "proposed_state_change": state_change or {},
        "next_expected_events": next_events or [],
        "write_authority": "scheduling_proposal",
        "created_at": event.get("created_at", ""),
    }


def pause(event, code, summary, question, recovery_conditions):
    return proposal(
        event,
        "pause",
        "enterprise_project_owner",
        [code, "S0"],
        summary,
        human_task=task(
            "S0_recovery",
            "enterprise_project_owner",
            question,
            summary,
            "有权角色提供书面确认和受影响记录范围",
            "是否允许当前流程诊断继续派生记录",
            recovery_conditions,
            "manual_recovery_confirmed",
        ),
        state_change={"suggested_stage": "paused", "automatic_write": False},
        next_events=["manual_recovery_confirmed"],
    )


def coverage_from_plan(payload: dict) -> tuple[list[dict], list[str]]:
    proposals = []
    missing = []
    required = ("department_id", "role", "process_id", "priority", "planned_participants")
    for index, role in enumerate(payload.get("participant_roles", [])):
        absent = [field for field in required if role.get(field) in (None, "")]
        missing.extend(f"participant_roles[{index}].{field}" for field in absent)
        if absent:
            continue
        proposals.append({
            "department_id": role["department_id"],
            "role": role["role"],
            "process_id": role["process_id"],
            "priority": role["priority"],
            "planned_participants": role["planned_participants"],
            "status": "not_scheduled",
            "gap": "",
        })
    return proposals, sorted(set(missing))


def participant_tasks_from_plan(payload: dict) -> list[dict]:
    tasks = []
    for participant in payload.get("participants", []):
        required = ("task_id", "participant_id", "department_id", "role", "process_id", "priority")
        if participant.get("authorization_status") != "authorized":
            continue
        if any(participant.get(field) in (None, "") for field in required):
            continue
        tasks.append({
            "task_id": participant["task_id"],
            "participant_id": participant["participant_id"],
            "department_id": participant["department_id"],
            "role": participant["role"],
            "process_id": participant["process_id"],
            "priority": participant["priority"],
            "status": "pending_assignment",
        })
    return tasks


def route_event(master_record: dict, event: dict) -> dict:
    event = copy.deepcopy(event)
    master = copy.deepcopy(master_record)
    if event.get("enterprise_id") != master.get("enterprise_id"):
        return pause(event, "CROSS_ENTERPRISE_SCOPE", "事件与总档案不属于同一企业，已停止处理。", "请确认正确的企业范围。", ["事件与总档案enterprise_id一致", "项目负责人手动恢复"])
    if event.get("project_id") != master.get("project_id"):
        return pause(event, "CROSS_PROJECT_SCOPE", "事件与总档案不属于同一内部诊断项目，已停止处理。", "请确认正确的流程诊断记录。", ["事件与总档案project_id一致", "项目负责人手动恢复"])
    if event.get("source_status") != "known":
        return pause(event, "SOURCE_UNKNOWN", "当前事件来源不明或不可读，不能可靠路由。", "请确认来源身份并提供可读取的最小材料。", ["来源身份可追溯", "材料达到当前任务最小可读范围", "项目负责人手动恢复"])
    if event.get("event_type") == "authorization_withdrawn":
        return pause(event, "AUTHORIZATION_WITHDRAWN", "材料或参与授权已经撤回，相关派生必须暂停。", "请确认撤回范围和受影响记录。", ["授权方重新书面确认或明确终止", "复核所有下游引用", "项目负责人手动恢复"])
    if event.get("authorization_status") in {"pending", "withdrawn", None}:
        return pause(event, "AUTHORIZATION_BLOCKED", "当前授权不足或已撤回，不能继续派生记录。", "请由有权角色确认授权状态和适用范围。", ["授权状态恢复为authorized或明确not_required", "复核受影响下游记录", "项目负责人手动恢复"])

    event_type = event.get("event_type")
    if event_type == "diagnosis_gate_ready" and master.get("current_stage", {}).get("stage") != "diagnosis":
        return proposal(
            event,
            "request_human",
            "enterprise_project_owner",
            ["DIAGNOSIS_GATE_NOT_CONFIRMED", "H2"],
            "总档案尚未进入诊断阶段，不能调用流程诊断Skill。",
            human_task=task(
                "H2",
                "enterprise_project_owner",
                "请确认P0覆盖、授权、关键冲突和残余风险是否满足进入诊断的条件。",
                "事件声称诊断门已就绪，但总档案阶段不一致。",
                "更新后的总档案阶段和覆盖门依据",
                "是否允许进入正式流程诊断",
                ["总档案阶段由有权角色更新为diagnosis"],
                "diagnosis_gate_ready",
            ),
            next_events=["diagnosis_gate_ready"],
        )
    if event_type in ROUTES:
        target, reason = ROUTES[event_type]
        next_map = {
            "management_problem_submitted": ["interview_plan_submitted"],
            "participant_task_started": ["workflow_card_confirmed", "file_uploaded"],
            "file_uploaded": ["material_analysis_completed", "material_analysis_blocked"],
            "diagnosis_gate_ready": ["process_diagnosis_completed", "process_diagnosis_blocked"],
        }
        return proposal(event, "invoke_skill", target, [reason], f"当前事件应由{target}处理；一次只调用一个主要Skill。", next_events=next_map[event_type])
    if event_type == "interview_plan_submitted":
        return proposal(
            event,
            "wait_external",
            "enterprise_project_owner",
            ["PLAN_OWNER_CONFIRMATION_REQUIRED"],
            "访谈计划仍是范围草稿，等待企业负责人确认后才能形成岗位覆盖建议。",
            human_task=task(
                "external_participation", "enterprise_project_owner", "请确认候选流程、P0/P1/P2岗位和计划人数。",
                "未确认计划不能改变research_coverage。", "负责人确认后的访谈计划", "员工摸排覆盖范围",
                ["owner_confirmed为true"], "interview_plan_confirmed",
            ),
            next_events=["interview_plan_confirmed"],
        )
    if event_type == "material_analysis_blocked":
        missing = event.get("payload", {}).get("missing_evidence", [])
        required_evidence = "、".join(missing) if missing else "材料分析记录中列出的最小授权材料"
        return proposal(
            event,
            "wait_external",
            "enterprise_project_owner",
            ["MATERIAL_EVIDENCE_REQUIRED"],
            "当前材料不足以继续分析，等待企业项目负责人补充最小授权材料。",
            human_task=task(
                "external_participation",
                "enterprise_project_owner",
                "请提供材料分析记录中列出的最小授权、脱敏且可读取的材料。",
                "材料分析已阻断，不能用模拟、未知来源或不可读材料替代真实证据。",
                required_evidence,
                "是否可以重新执行材料分析并评估诊断门",
                ["材料来源和授权状态可确认", "材料可读取且属于当前流程", "以file_uploaded事件重新进入总控"],
                "file_uploaded",
            ),
            next_events=["file_uploaded"],
        )
    if event_type == "interview_plan_confirmed":
        payload = event.get("payload", {})
        if not payload.get("owner_confirmed"):
            return proposal(event, "wait_external", "enterprise_project_owner", ["PLAN_OWNER_CONFIRMATION_REQUIRED"], "负责人尚未确认访谈计划，未生成覆盖建议。", next_events=["interview_plan_confirmed"])
        coverage, missing = coverage_from_plan(payload)
        participant_tasks = participant_tasks_from_plan(payload)
        next_events = ["participant_task_started"] if participant_tasks else ["participant_identities_supplied"]
        return proposal(
            event,
            "wait_external",
            "enterprise_project_owner",
            ["CONFIRMED_PLAN_MAPPED", "PARTICIPANT_IDENTITY_REQUIRED" if not participant_tasks else "PARTICIPANT_TASKS_PROPOSED"],
            "已把负责人确认的岗位范围转换为覆盖建议；只有获得真实员工身份和授权后才能创建员工任务。",
            state_change={
                "research_coverage_proposals": coverage,
                "participant_task_proposals": participant_tasks,
                "missing_registration_fields": missing,
                "automatic_write": False,
            },
            next_events=next_events,
        )
    if event_type == "process_diagnosis_completed":
        return proposal(
            event,
            "request_human",
            "enterprise_project_owner",
            ["DIAGNOSIS_REVIEW_REQUIRED", "H2"],
            "诊断分析已完成，但必须由有权负责人审核后才能进入交付或试点。",
            human_task=task(
                "H2", "enterprise_project_owner", "请审核诊断依据、残余风险和影子试点条件。",
                "流程诊断Skill不能自行批准。", "诊断正文、证据引用和未关闭缺口", "是否批准管理层交付与影子试点",
                ["形成诊断审核事件"], "diagnosis_reviewed",
            ),
            next_events=["diagnosis_reviewed"],
        )
    if event_type == "h1_required":
        return proposal(event, "request_human", "authorized_reviewer", ["TARGETED_HUMAN_REVIEW", "H1"], "需要一次最小人工复核，不重复完整访谈。", human_task=copy.deepcopy(event.get("payload", {}).get("human_task")), next_events=["h1_completed"])
    if event_type == "h2_required":
        return proposal(event, "request_human", "authorized_management_role", ["ORGANIZATIONAL_CONFIRMATION_REQUIRED", "H2"], "责任、权限或规则口径必须由有权管理角色确认。", human_task=copy.deepcopy(event.get("payload", {}).get("human_task")), next_events=["h2_confirmed"])
    return proposal(event, "no_action", None, ["NO_ROUTE_FOR_CURRENT_EVENT"], "当前事件没有可安全执行的路由；请补充事件类型或等待预期事件。")


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: orchestrate_event.py <master-record.json> <event.json>")
        return 2
    try:
        master = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
        event = json.loads(Path(argv[2]).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"INPUT_INVALID:{type(exc).__name__}")
        return 1
    print(json.dumps(route_event(master, event), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
