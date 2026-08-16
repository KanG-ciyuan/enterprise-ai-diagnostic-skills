# Evidence And Safety

## Evidence Levels

| Level | Evidence | Allowed claim |
|---|---|---|
| E1 | Observed operation, desensitized real sample, system record, execution log | Supports a verified process statement or high-confidence pilot decision within the observed scope |
| E2 | Multi-role interviews, meeting minutes, recording transcripts with concrete examples | Supports corroborated oral evidence, not actual runtime proof |
| E3 | One manager or operator statement | Supports a preliminary hypothesis |
| E4 | SOP, policy, flowchart, system description | Shows intended process, not necessarily actual behavior |
| E5 | Industry convention, inference, or AI-generated content | Provides a lead to verify, not evidence of this client's reality |

Evidence precedence is not mechanical. Prefer current direct observation, but retain contradictions and scope limits. A meeting transcript never becomes E1 merely because it is detailed.

## Transcript Handling

For meeting minutes, recordings, and interview notes:

1. identify speaker role when available;
2. separate observed facts, personal opinions, goals, and proposed solutions;
3. extract concrete examples and quantities without treating them as verified;
4. identify agreement and contradiction across roles;
5. list the minimum samples or observation needed next.

## Confidence

- `高`: central process claims have relevant E1 support; material exceptions, permissions, ownership, and acceptance measures are known.
- `中`: the need and route have corroborated evidence, but one or more material implementation conditions remain unverified.
- `低`: the conclusion relies mainly on single-role statements, documents, assumptions, or missing samples.

High-confidence `建议进入试点` normally requires at least one relevant E1 source. If none exists, downgrade confidence and request the smallest real sample or observation.

## Privacy And Permission

- Use only authorized materials required for the current diagnosis.
- Do not expose or persist API keys, tokens, passwords, internal identities, real customer data, or raw private transcripts in the skill package, public reports, or examples.
- Redact names and sensitive values when producing reusable lessons.
- Do not silently scan unrelated chats, files, logs, accounts, or knowledge bases.
- Do not write to production, notify external people, approve, pay, publish, or make commitments.
- Require explicit authorization before any later implementation action that changes external state.

## Client Communication Integrity

The client-facing version may simplify language and soften tone, but it must not:

- hide a material risk or evidence gap;
- turn an assumption into a confirmed fact;
- promise ROI, accuracy, delivery, or compliance without evidence;
- recommend AI merely to make the proposal appear more advanced;
- omit the client's responsibilities, exclusions, or human-confirmation points.

