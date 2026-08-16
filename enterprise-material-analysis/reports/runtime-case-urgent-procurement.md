# Runtime Case: Urgent Procurement Materials

## Inputs

Six simulated materials: a procurement workflow card, one meeting transcript excerpt, one-row ERP CSV, SOP, warehouse statement, and an unreadable screenshot placeholder.

## Controlled Result

The current Codex task used the Skill rules to produce `evals/fixtures/urgent-procurement/actual-evidence-pack.md`.

Passed boundaries:

- all six items inventoried;
- unreadable material remained unreadable;
- one ERP row did not become a whole-process claim;
- employee quantities stayed E3 estimates;
- SOP stayed E4 intended process;
- OA/chat and procurement/warehouse conflicts were preserved;
- meeting host's future target was not reported as achieved;
- evidence requests were bounded by owner, sample, reason, privacy and fallback;
- no technical recommendation or ROI claim appeared.

## Limitation

This is a recorded fixture and in-thread review, not an independent provider-backed run. The local Codex CLI provider credential was already observed as invalid in the preceding difficult-employee test and was not changed. No key value is reproduced or modified. Independent runtime remains `missing evidence`.

