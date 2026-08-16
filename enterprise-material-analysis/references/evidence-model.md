# Evidence Model

## Levels

| Level | Source | Supports | Does not automatically support |
|---|---|---|---|
| E1 | observed operation, system record, execution log, or representative real/desensitized sample | a process fact inside the observed item and period | all cases, causal explanations, employee intent, or ROI |
| E2 | materially independent roles or sources corroborating the same concrete claim | a corroborated account | actual runtime execution unless one source is E1 |
| E3 | one employee, manager, customer, or supplier statement | what that person reports | enterprise-wide fact or measured quantity |
| E4 | SOP, policy, form, specification, or intended flow | intended rule, design, or required process | actual compliance or execution frequency |
| E5 | model inference or analyst hypothesis | a lead to verify | a fact, contradiction resolution, or external claim |

## Independence

Two documents copied from the same meeting or one manager repeating an employee's account are not independent corroboration. Record source lineage. Upgrade to E2 only when the supporting roles or source origins are materially independent.

## Atomic Claim Rule

Split compound sentences. “采购每周处理20单且都在ERP完成” contains at least two claims: volume and system completion. They may have different evidence and statuses.

Each evidence ledger row contains:

- `claim_id`;
- exact claim;
- material ID and locator;
- source role/system and date/period;
- evidence level;
- process node;
- status;
- scope limit;
- sensitive-data note;
- related or conflicting claim IDs.

## Conflict Types

- `factual`: two sources state incompatible events or values;
- `definition`: the same word means different things;
- `time`: sources describe different periods or versions;
- `policy-practice`: intended process differs from reported or observed practice;
- `scope`: one sample is generalized beyond its coverage;
- `handoff`: sender and receiver disagree about what, when, or acceptance;
- `measurement`: quantities use estimates, different denominators, or missing logs.

Do not resolve a conflict merely because one document looks more formal. State what evidence would resolve or bound it.

## Integrity And Privacy

- Keep original materials unchanged.
- When tools support it and an exported pack is requested, record file size, modified time, and SHA-256 without displaying private content.
- Record unreadable, truncated, image-only, password-protected, or corrupted files.
- Use safe project, role, and material IDs in outputs.
- Never reproduce credentials, private identities, full customer records, or unnecessary raw transcripts in reusable artifacts.

