# Master Record Handoff

Use this adapter only for a total-control run or an explicit exportable project handoff. The evidence pack remains the factual source artifact.

Canonical suite schema: `enterprise-ai-diagnostic-master-record/schema/skill-handoff-v0.2.schema.json`.

## Boundary

- The handoff is a `registration proposal`, not permission to modify the master record.
- Allowed collections are `materials` and `conflicts_and_evidence_requests` only; this Skill must not propose `diagnoses_and_pilots`.
- Do not create workflow-card confirmations, organizational decisions, task priorities, diagnosis approvals, or next-route decisions.
- Missing enterprise, project, process, authorization, storage, or source metadata goes to `missing_registration_fields`; never fabricate it.
- Include `content_hash` only when a deterministic tool or source system supplied a SHA-256 value. Never invent or visually estimate a hash.

## Events

| Event | Use when |
|---|---|
| `material_analysis_completed` | Every supplied item has an inventory status and the evidence pack passes its completion check |
| `material_analysis_blocked` | Authorization, source identity, readability, or minimum material requirements prevent reliable analysis |

## Mapping

| Evidence-pack artifact | Registration proposal |
|---|---|
| Each supplied material | One `materials` record with authorization, analysis status, evidence level, storage reference, and hash when available |
| Each conflict or evidence request | One `conflicts_and_evidence_requests` record |
| Evidence pack itself | One `conflicts_and_evidence_requests` record with `record_type: enterprise_material_evidence_pack` |
| E5 hypothesis | Preserve `evidence_level: E5` and `evidence_label: AI假设，待验证` |
| Unreadable or missing evidence | `unresolved_items`; mark blocking only when it prevents the declared handoff |

Leave `resolved_by_confirmation_record` empty until a real H2 organizational confirmation exists. Material analysis identifies conflicts; it does not close them.
