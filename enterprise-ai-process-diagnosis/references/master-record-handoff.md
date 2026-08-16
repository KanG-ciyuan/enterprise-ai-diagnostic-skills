# Master Record Handoff

Use this adapter only for a total-control run or an explicit exportable project handoff. Internal and client-facing diagnoses remain the substantive artifacts.

Canonical suite schema: `enterprise-ai-diagnostic-master-record/schema/skill-handoff-v0.2.schema.json`.

## Boundary

- The handoff is a `registration proposal`, not a direct master-record update.
- Allowed collection: `diagnoses_and_pilots` only.
- A diagnosis proposal may use `review_status: draft` or `review_required`; this Skill must never set `review_status: approved`.
- Do not generate organizational confirmations, rewrite evidence levels, close H2, change participant tasks, or choose the next route.
- Missing enterprise, project, process, authorization, storage, upstream, or review context goes to `missing_registration_fields`.

## Events

| Event | Use when |
|---|---|
| `process_diagnosis_completed` | The Skill produced its required conclusions and evidence-bound outputs, even if human review is still required |
| `process_diagnosis_blocked` | Missing authorization, P0 coverage, decisive evidence, process ownership, or system conditions prevent a defensible diagnosis |

## Mapping

| Diagnosis artifact | Registration proposal |
|---|---|
| Internal diagnosis | `diagnoses_and_pilots` record with `record_type: process_diagnosis` |
| Shadow pilot | Separate `diagnoses_and_pilots` record with draft review status |
| Evidence pack, workflow cards, and confirmations used | Exact `upstream_records` versions |
| Unclosed conflicts or evidence requests accepted as residual risk | `outstanding_gaps` with exact record references |
| E5 assumptions | Preserve E5 label; never restate as confirmed findings |
| Blocking conditions | `unresolved_items` with the narrowest appropriate A0/A1/H1/H2/S0 suggestion |

`process_diagnosis_completed` means the Skill finished its analytical artifact. It does not mean the enterprise approved the conclusion, the project passed the diagnosis gate, or production implementation is authorized.
