---
name: enterprise-ai-diagnostic-orchestrator
description: >
  Coordinate one enterprise AI flow-diagnosis event from a master record, interview plan, workflow-card handoff, material evidence handoff, or diagnosis handoff. Use when an enterprise project owner or platform operator needs to continue a multi-stage flow diagnosis, decide which bounded professional Skill or responsible role handles the current event, preserve enterprise scope, authorization, evidence, versions and human gates, and produce the next scheduling proposal. Typical routing events include an employee file upload during workflow mapping and an owner-confirmed interview plan that needs a coverage proposal without invented participant tasks（员工摸排中的附件上传或“上传了Excel”；管理层访谈计划已确认后生成覆盖建议，但不虚构员工任务）. Do not use for a single employee interview, standalone material analysis, standalone process diagnosis, generic project management, software implementation, database development, or free-form multi-agent orchestration.
metadata:
  owner: Kang Jiaxin
  version: "0.1.0"
  maturity: personal-experiment
---

# Enterprise AI Diagnostic Orchestrator

Coordinate one current event in one enterprise flow diagnosis. Do not run the whole diagnosis in one pass.

## Boundary

- Read the current master record, one current event, the actor role, and only the context that role may access.
- Preserve `enterprise_id`, `project_id`, authorization, evidence labels, exact record versions and upstream references.
- Select exactly one decision: `invoke_skill`, `wait_external`, `request_human`, `pause`, or `no_action`.
- Invoke at most one primary Skill for the current event. A returned result must re-enter this orchestrator as a new event.
- Child Skills return a `registration proposal`; the proposal is not a completed master-record write.
- The orchestrator must not write the master record, change source artifacts, close H2, self-approve a diagnosis, or promise ROI.
- Never expose restricted management context to employee workflow mapping.
- A0/A1 may remain in the current conversation. H1, H2 and S0 require the bounded task or stop behavior in [Routing Method](references/routing-method.md).

## Workflow

1. Validate enterprise/project scope, authorization, source identity and current stop state before interpreting content.
2. Classify the current event using [Routing Method](references/routing-method.md). If uncertain, return `no_action` with the missing routing context; do not guess.
3. For a professional event, select one primary Skill only:
   - management problem or unclear scope: `enterprise-interview-preparation`
   - employee task start: `enterprise-workflow-mapping`
   - file event: `enterprise-material-analysis`
   - verified diagnosis gate: `enterprise-ai-process-diagnosis`
4. When another person must act, use [External Task Package](references/external-task-package.md). Ask the smallest question that can resume the flow.
5. When an interview plan is confirmed, use [Interview Plan Adapter](references/interview-plan-adapter.md). Never create participant tasks without real participant IDs and authorization.
6. Validate every returned registration proposal with the shared master-record handoff rules before proposing any state change.
7. Return a short human explanation followed by one machine-readable scheduling proposal matching `schema/orchestrator-output.schema.json`.

## Output

Human explanation:

1. current stage and event;
2. decision and auditable reason;
3. who acts next and what they must return;
4. blocking impact and recovery condition when relevant.

Machine block:

- `write_authority` is always `scheduling_proposal`;
- `target` is one Skill or one responsible role, never a hidden chain;
- `proposed_state_change` is a proposal only;
- `next_expected_events` states how the flow can resume.

Use `scripts/orchestrate_event.py` when the master record and event are available as JSON. Use `scripts/validate_orchestrator_output.py` before handing a scheduling proposal to another system.

Copyright (c) 2026 Kang Jiaxin
