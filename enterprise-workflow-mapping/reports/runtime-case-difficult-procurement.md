# Runtime Case: Difficult Procurement Employee

## Intended Test

- Case: a mildly defensive procurement specialist handling urgent purchase requests
- Stressors: vague verbs, initial denial of an unofficial spreadsheet, inconsistent “all in system” statement, tacit supplier judgment, missing statistics, and employee corrections before confirmation
- Skill: installed `enterprise-workflow-mapping` 0.1.0
- Runner requested: Codex CLI 0.147.0-alpha.6.6, `gpt-5.6-terra`, ephemeral, read-only
- Inputs allowed: `employee-background.md`, `sample-evidence.md`
- Hidden from runner: `expected-workflow-card.md`, reports, and prior fixtures

## Runtime Result

`blocked by provider authentication`, not a Skill pass or fail.

The CLI initialized the read-only run, then the provider rejected the locally configured credential. No credential value is reproduced here. The existing credential was not moved, replaced, revoked, or edited.

## Controlled In-Thread Simulation

The current Codex task applied the installed Skill rules to the same fixture and produced the reviewable transcript and confirmed card in:

- `simulations/manufacturing-emergency-procurement/01-difficult-employee-mapping.md`

This proves that the test fixture and review rubric are usable. It is not independent provider-backed evidence and must not be reported as such. A fresh isolated model run remains required after authentication is repaired.

