# Conditional Technical Design

The purpose is to describe a buildable next experiment without pretending unknown enterprise conditions are settled.

## Design Sequence

1. Map each proposed component to a verified process node, business responsibility, and evidence ID.
2. State the component's feasibility as `可开发`, `有条件`, or `阻塞`.
3. Write explicit prerequisites and the evidence needed to satisfy them.
4. Choose the least invasive access branch currently supported.
5. Define data contracts, state, exceptions, human approval, audit, and maintenance before naming products.
6. Define the smallest experiment that can invalidate the riskiest assumption.

## Access Branches

| Condition | Conditional route | Required controls |
|---|---|---|
| Official API or webhook confirmed | API connector plus workflow orchestration | auth, least privilege, schema, rate limits, retry, idempotency, test environment, audit |
| Repeatable export/import confirmed | file-based batch or shadow workflow | file version, deduplication key, validation, quarantine, replay, manual reconciliation |
| No supported interface but stable authorized UI | RPA adapter, preferably read-only first | selector stability, screenshots/logs, timeout, retry cap, manual takeover, maintenance owner |
| Only manual observation is allowed | observation sheet or offline prototype | sampling protocol, human-entered timestamps, double-check, no production claims |

Do not hide unsupported branches. State why each branch is accepted, conditional, or rejected.

## Responsibility Rules

- Workflow owns sequence, state, wait, retry, escalation, and recovery.
- Deterministic rules own required fields, thresholds, permissions, deadlines, and compliance checks.
- AI owns bounded text understanding, classification, extraction, summarization, and drafting. Require structured output, source span, confidence, validation, and human review when consequences matter.
- RAG is justified only by an authoritative, maintained corpus with access and update ownership.
- A bounded Agent is justified only when the next action requires dynamic choice among explicitly permitted tools and cannot be represented adequately as a workflow. It also needs an action allowlist, tool permissions, budget/time limit, audit, stop rule, and fallback.
- Humans retain high-risk approval, payment, supplier selection, formal commitments, and rule changes.

## Minimum Technical Plan

For each component specify:

- purpose and owning process node;
- evidence and factual prerequisite;
- input/output fields and stable identifiers;
- feasibility state and reason;
- normal data flow and state transition;
- validation, exception, duplicate, timeout, retry, and manual takeover;
- read/write permission and security boundary;
- logs, evidence retention, alert, and kill switch;
- maintenance owner and change trigger;
- acceptance test and rejected alternatives.

Avoid false precision. Do not invent endpoint URLs, throughput, dates, savings, model accuracy, or delivery effort. Use ranges or conditional branches only when their assumptions are stated.

