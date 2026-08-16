# Evidence And Record Integrity

## Evidence Levels

| Level | Source | Allowed statement |
|---|---|---|
| E1 | observed operation, desensitized system record, execution log, or representative real sample | supports a process fact within the observed sample |
| E2 | multiple roles or a concrete meeting/transcript with corroboration | supports a corroborated account, not runtime proof |
| E3 | one employee statement | supports what the employee reports |
| E4 | SOP, policy, form, or intended flow | supports the intended process |
| E5 | model inference | internal lead only; never an employee-confirmed fact |

## Three Records

1. `raw_submission`: original employee answers and uploaded-file references; append-only in a future managed system.
2. `employee_confirmed_card`: the Agent's structured version explicitly confirmed by the employee.
3. `diagnostic_derivation`: later consultant analysis, outside this Skill and never shown as employee-authored content.

For file-based first versions, do not overwrite a prior confirmed card. Create a new version and state what changed. Record stable ID, version, created time, source role, upstream record, evidence file label, and hash when a trusted tool can calculate it.

## Limits

Versioning can reveal changes after submission. It cannot prove the employee disclosed everything before submission. Later diagnosis must use cross-role interviews, samples, system records, coverage gaps, and conflict review. Absence of a submission is not evidence that a process or problem does not exist.

## Privacy

Use project codes and anonymous employee IDs in portable artifacts. Do not place customer names, employee identities, credentials, raw private transcripts, or sensitive business content in reusable Skill files or public fixtures.

