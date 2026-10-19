# Core event and context policy

This local router validates source labels and proposes scheduling. It does not
log users in, execute a Skill, or prove that the caller is the named human.
A future caller must bind `actor_role`, scope and source identity to trusted
identity/authorization data before constructing an event. Payload flags cannot
grant permission or change the master stage.

## Event-source permissions

The executable policy is `EVENT_ROLES` in `scripts/orchestrate_event.py`; the
input Schema and CLI/function validation use the same three canonical labels.
No display name or runner name is an additional role.

| Event | Allowed actor_role |
|---|---|
| management_problem_submitted | enterprise_project_owner |
| interview_plan_submitted | enterprise_project_owner, agent |
| interview_plan_confirmed | enterprise_project_owner |
| participant_task_started | enterprise_project_owner, employee |
| file_uploaded | enterprise_project_owner, employee |
| workflow_card_confirmed | employee, agent |
| material_analysis_completed / material_analysis_blocked | enterprise_project_owner, agent |
| diagnosis_gate_ready | enterprise_project_owner |
| process_diagnosis_completed / process_diagnosis_blocked | enterprise_project_owner, agent |
| h1_required / h2_required / authorization_withdrawn | enterprise_project_owner, employee, agent |
| manual_recovery_confirmed | enterprise_project_owner |

The owner owns scope and diagnosis admission; an employee starts their task,
provides material or reports their own confirmation. An agent reports a child
Skill result, raises a human-review need or records a withdrawal. Owners may
relay analytical artifacts; they cannot make a diagnosis output approved by
sending a routing event. Escalation and withdrawal pause/request a human; they
are not approval powers. These are the minimum labels supported by existing
examples and the responsibility contract. Other human reviewer labels remain
human-task targets, not additional event-source permissions.

Three checks remain independent: permission to originate an event, the
master's diagnosis stage, and the router's ability to propose one target.
`employee` and `agent` cannot originate `diagnosis_gate_ready`. An owner still
cannot invoke diagnosis while the master stage is not `diagnosis`.

Any paused stage, paused status or active stop blocks ordinary events. Recovery
keeps the existing owner + conditions_met + written basis + evidence_completion
requirements. It proposes a state change only. A controller must also record the
actual stop recovery; changing a stage string alone does not close an active
stop. Unknown roles, wrong types, unknown authorization values and invalid event
structures fail closed. Normal routing only accepts authorized/restricted/
not_required, and these labels still need a trusted source and applicable scope.

## Context projection

`PAYLOAD_FIELDS` declares allowed field paths by target. Unknown fields are
omitted. Nested dictionaries/lists are projected rather than copied wholesale;
wrong types are omitted, never coerced. All targets preserve only enumerated
identity, source-reference, version and simulation metadata. In particular,
`restricted_management_notes` is not an allowed path for any target.

- Interview preparation receives the process problem and requested outcome.
- Employee mapping receives task/participant/process identity and explicitly
  enumerated employee-visible purpose/scope/notices, not management framing.
- Material analysis receives material identifiers/type/hash/storage/source
  metadata and the explicit return event.
- Diagnosis receives the evidence-pack reference and declared gate metadata;
  a payload gate flag cannot bypass the master-stage check.
- Owner/human targets receive only known registration/recovery/review-task
  fields; nested human tasks use a separate allowlist as well.

This is field minimization, not semantic classification of arbitrary text. A
caller must not insert management secrets into an otherwise allowed free-text
field. The tests use a synthetic marker in disallowed payload paths and inspect
whole proposals, CLI stdout and every offline output/log. There is no real
Agent/UI consumer or deployed identity boundary in this package, so these local
checks do not constitute online end-to-end data-leak prevention acceptance.

## Readable stop state (PILOT-18A R2)

The router supports a compact master with enterprise/project and a known
current_stage.stage. Stage status and the stop list may be omitted by this
compact interface; if present they must have readable types and known values.
Every supplied stop must be an object with status active or recovered. Missing,
null, wrong-type or unknown stop statuses cause pause, never ordinary routing.
An empty list and declared recovered stops preserve the ordinary route.

This checks the state needed for routing, not all master provenance fields.
The full master validator still checks stop history/recovery metadata; a compact
recovered status alone is not proof of trusted recovery. Manual recovery events
retain the original owner, basis, conditions and evidence_completion rules.
