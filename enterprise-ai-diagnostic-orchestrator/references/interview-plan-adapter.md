# Interview Plan Adapter

`enterprise-interview-preparation` outputs an `enterprise_interview_plan`, not a master-record registration proposal.

## Owner Confirmation Gate

- Before `owner_confirmed: true`, keep roles, priority and coverage as a draft. Do not update `research_coverage`.
- After owner confirmation, map only supplied fields into `research_coverage_proposals`:
  `department_id`, `role`, `process_id`, `priority`, `planned_participants`, `status` and `gap`.
- Use `not_scheduled` as the initial coverage status unless an authorized source supplied another valid state.
- Missing `department_id`, `process_id`, priority or planned count goes to `missing_registration_fields`; do not invent it.

## Participant Task Gate

A role plan is not an employee identity. Create no `participant_task_proposals` until the enterprise supplies a real `participant_id`, applicable authorization and an explicit assignment. P0/P1/P2 comes from the confirmed plan, never from employee workflow mapping.

