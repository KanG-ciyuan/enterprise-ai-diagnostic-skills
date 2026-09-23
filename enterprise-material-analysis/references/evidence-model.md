# Evidence Model

## Levels

| Level | Source | Supports | Does not automatically support |
|---|---|---|---|
| E1 | observed operation, system record, execution log, or representative real/desensitized sample | a process fact inside the observed item and period | all cases, causal explanations, employee intent, or ROI |
| E2 | materially independent roles or sources corroborating the same concrete claim | a corroborated account | actual runtime execution unless one source is E1 |
| E3 | one employee, manager, customer, or supplier statement | what that person reports | enterprise-wide fact or measured quantity |
| E4 | SOP, policy, form, specification, or intended flow | intended rule, design, or required process | actual compliance or execution frequency |
| E5 | model inference or analyst hypothesis | a lead to verify | a fact, contradiction resolution, or external claim |

## Assign A Level From The Source, Not From Confidence

Take the level from **where the claim came from**, never from how firmly it was stated. A person who asserts "the policy requires X" without producing the document is still `E3`. `E4` is reserved for the document itself.

Without the document there is no way to separate *the rule really says this* from *this is how the person remembers the rule*. A rule can be revised, and a recollection can be stale or simply wrong. Accepting a verbal rule claim as `E4` lets a confident statement pass as institutional evidence — which is the same failure the `E5` label exists to prevent, one level up.

A rule claim that cannot be documented stays `E3` for the whole engagement, and every downstream artifact must carry that limit rather than quietly upgrading it.

## Unwritten Rules Stay E3

An unwritten rule — a practice a role is *expected* to follow, which no document states — is `E3`, because it rests on one person's account. It is not `E4`: there is no document whose authority can be checked.

Record it, label it unwritten, and do not let it acquire the standing of a documented rule through repetition.

Unwritten rules are the most fragile class in the model. With no document to hand over, they survive only by word of mouth and demonstration, so they are the first thing lost when the person leaves the role — and nothing in the record shows that something was lost.

## Document Provenance Is Not Self-Evident (known gap)

This model has **no mechanism to establish that an uploaded file is an institutional document**. Anyone can upload a file that presents itself as an SOP, a policy, or a signed approval.

This is the document-side form of the rule that fluent model output is not evidence:

> A document that looks official is not thereby authoritative.

Until a provenance mechanism exists, an `E4` classification rests on the upload alone. A reusable primitive already exists elsewhere in this suite — the named-authorizer capability in `enterprise_authorizations` (a named enterprise confirmer, a one-time capability, and a recorded confirmation with reason and time). Extending it to documents would require a **named enterprise confirmer to attest the document's authority and effective scope**, instead of letting the uploader self-certify.

**Status: open.** Do not present an `E4` claim as authoritative where document provenance has not been established, and say so in the evidence pack rather than leaving the gap implicit.

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

