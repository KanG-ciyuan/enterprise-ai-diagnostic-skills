# Workflow Card Schema

## Required Record

```yaml
record_type: workflow_card
schema_version: "0.1"
record_id: "stable-id"
version: 1
project_id: "project-code"
employee_id: "anonymous-employee-id"
department: "department"
role: "role"
work_name: "one concrete job"
trigger: "start event"
frequency: "frequency"
consumer: "result consumer"
steps: []
systems: []
inputs: []
outputs: []
decision_points: []
exceptions: []
burden: {}
evidence: []
open_questions: []
employee_confirmed: false
created_at: "ISO-8601 timestamp"
confirmed_at: null
upstream_records: []
```

Each step contains `step_id`, `actor`, `action`, `input`, `system_or_material`, `output`, `decision_basis`, `exception_handling`, `evidence_refs`, and `evidence_level`.

Each evidence entry contains `evidence_id`, `type`, `safe_label`, `supports`, `level`, `source_role`, `captured_at`, and optional `sha256`. Never invent a hash.

`burden` separates `frequency`, `typical_volume`, `peak_volume`, `active_time`, `waiting_time`, `rework`, and `consequence`, with an evidence reference or “employee estimate” label.

## Confirmation State

- Draft: `employee_confirmed: false`; may contain open questions.
- Confirmed: explicit employee approval is recorded and `confirmed_at` is set.
- Revised: increment `version`, retain upstream record ID, and describe changes. Do not silently overwrite a confirmed version.

