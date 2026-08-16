# Routing Method

## One Event, One Primary Decision

Handle one current event. Never return multiple primary Skills. A child result is a new event and must pass through the orchestrator again.

| Event | Decision | Target | Next expected event |
|---|---|---|---|
| `management_problem_submitted` | `invoke_skill` | `enterprise-interview-preparation` | `interview_plan_submitted` |
| `interview_plan_submitted` | `wait_external` | enterprise project owner | `interview_plan_confirmed` |
| `interview_plan_confirmed` | `wait_external` | enterprise project owner | participant identities or employee task start |
| `participant_task_started` | `invoke_skill` | `enterprise-workflow-mapping` | workflow-card confirmation or attachment |
| `file_uploaded` | `invoke_skill` | `enterprise-material-analysis` | material analysis completed/blocked |
| `material_analysis_blocked` | `wait_external` | enterprise project owner | `file_uploaded` with the minimum authorized evidence |
| `diagnosis_gate_ready` | `invoke_skill` only when master stage is `diagnosis` | `enterprise-ai-process-diagnosis` | process diagnosis completed/blocked |
| `process_diagnosis_completed` | `request_human` | enterprise project owner | diagnosis reviewed |
| `authorization_withdrawn` | `pause` | enterprise project owner | manual recovery confirmed |

## Safety Gates Before Routing

Apply in this order:

1. event enterprise and project equal the master record;
2. authorization is `authorized`, `restricted`, or `not_required` for the declared action;
3. source is known and readable enough for the action;
4. a paused project does not resume without manual recovery metadata;
5. diagnosis is not invoked until the master stage is `diagnosis`;
6. the target is one of four named professional Skills or one responsible human role.

## Exception Levels

- A0: the active professional Skill can ask for an ordinary missing field.
- A1: employee or source owner confirms a small ambiguity.
- H1: one targeted demonstration or sensitive clarification needs an authorized reviewer.
- H2: responsibility, permission, money, compliance, promise or adopted rule needs an authorized management role.
- S0: missing/withdrawn authorization, cross-enterprise scope, unknown source or forced conclusion pauses derivation.

Never replace an H1 task with “repeat the whole interview.” Never let H2 rewrite historical evidence. S0 always names recovery conditions and requires manual resumption.
