# Master Record Handoff

Use this adapter only when a total-control context or the user requests an exportable project handoff. The employee-visible workflow card remains unchanged.

Canonical suite schema: `enterprise-ai-diagnostic-master-record/schema/skill-handoff-v0.2.schema.json`.

## Boundary

- The handoff is a `registration proposal`, never a direct master-record write.
- Do not infer `enterprise_id`, `project_id`, `process_id`, `participant_id`, `department_id`, `role`, `task_id`, authorization, storage location, or task priority.
- If a required administrative field is absent, set `handoff_status: needs_registration_context`, list it in `missing_registration_fields`, and leave the value null.
- Never infer P0, P1, or P2. The interview plan and total controller own priority.
- Keep the handoff outside the employee-visible card so internal routing metadata is not shown as employee content.

## Events

| Event | Required condition | Record proposal | Task proposal |
|---|---|---|---|
| `workflow_card_confirmed` | Employee explicitly approved the current card version | One `workflow_cards` record | `confirmed` with matching `current_workflow_card` |
| `workflow_card_declined` | Employee explicitly refused or rejected confirmation | Optional draft `workflow_cards` record | `participant_declined`; no confirmed card claim |

The Skill may propose `confirmed`; only the total controller may advance the task to `completed` after material, conflict, authorization, and project gates are checked.

Place task proposals in `participant_task_updates`. The workflow-card reference in that array must match the card in `records_to_register`.

## Mapping

| Workflow artifact | Handoff field |
|---|---|
| Card `record_id` and `version` | Proposed workflow-card identity |
| `project_id` | `routing_context.project_id` and proposed record |
| Employee identity supplied by the project | `participant_id`; do not expose private identity in portable output |
| Department and role | Routing context only when supplied |
| Confirmed card file or controlled artifact | `storage_ref` |
| Card source records | `upstream_records` |
| Open questions or contradictions | `unresolved_items` with evidence-bound summaries |

The task update must not contain priority, department, role, participant, process ownership, residual-risk acceptance, or approval fields. Those belong to the total controller or authorized project owner.
