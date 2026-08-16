---
name: enterprise-interview-preparation
description: >
  Prepare a role-specific interview plan before an enterprise AI application or digital-transformation discovery visit. Use when a transformation practitioner needs to decide whom to interview across an industry, department, role, or bounded process and produce interview objectives, open main questions, adaptive follow-up triggers, minimum evidence requests, coverage gaps, facilitation notes, and client-safe no-promise boundaries. Do not use to conduct the live employee interview, map one employee's workflow, analyze collected transcripts or files, diagnose the transformation route, recommend AI/RPA/Agent technology, estimate ROI, or implement systems.
metadata:
  owner: Kang Jiaxin
  version: "0.2.0"
  maturity: production-candidate
---

# Enterprise Interview Preparation

Prepare the transformation practitioner for one bounded enterprise process discovery. Produce a decision-changing interview plan, not a generic industry questionnaire.

## Boundary

- The primary user is the transformation practitioner or enterprise project lead preparing a visit.
- This Skill plans interviews; it does not conduct the employee workflow interview. Hand live one-employee/one-job mapping to `$enterprise-workflow-mapping`.
- It may use authorized background context to tailor the plan, but it does not perform source-by-source material analysis. Hand collected materials to `$enterprise-material-analysis`.
- It must not recommend technology or write the final diagnosis. Hand evidence-bound route decisions to `$enterprise-ai-process-diagnosis`.
- Never promise API access, integration, automation rate, cost saving, ROI, delivery date or Agent suitability before evidence exists.

## Minimum Inputs

Use supplied context and do not re-ask it. Obtain only what changes the plan:

1. industry or enterprise type;
2. bounded department, process or business problem;
3. discovery goal or decision the visit must support;
4. known participant roles and access constraints;
5. known materials, systems, risk or privacy constraints.
6. total interview time, maximum participants, preferred session length and unavailable roles.

If essentials are missing, ask one concise question per turn. If the user says they do not know, make a labelled planning assumption and identify who can verify it. Unknown resource limits do not justify an invented schedule: show the recommended coverage and a clearly labelled minimum viable combination.

## Workflow

1. Restate the visit scope without a preselected AI solution. If the scope spans multiple end-to-end processes, propose bounded slices by trigger, start, end and decision; ask the user to choose unless one slice is explicitly dominant.
2. Identify decisions the discovery must enable and claims it must not assume. Preserve conflicting inputs as source-labelled claims; do not silently merge them or choose a winner.
3. Build a role coverage matrix from process ownership, actual execution, upstream/downstream handoffs, system/data ownership, approval, finance/risk and exceptions. Include only relevant roles and explain why each is needed.
4. Prioritize interviews as `P0 required`, `P1 conditional`, or `P2 optional`. Fit the plan to total interview time, maximum participants and access. If all P0 lenses cannot fit, narrow scope or mark the plan partial; do not hide the gap or downgrade a safety-critical lens.
5. List expected cross-role disagreements as hypotheses, such as policy versus actual practice, sent versus accepted handoff, system record versus offline work, or estimate versus log. Give both roles mirrored questions and name evidence that could resolve the difference.
6. For each selected role, write 5-8 open main questions. Start from recent concrete events and actual behavior, then cover inputs, steps, decisions, handoffs, exceptions, burden, evidence and system conditions as relevant.
7. Add adaptive follow-up triggers. Follow vague or unsupported answers; do not interrogate employees with every branch by default.
8. Bind each high-value question to the decision it can change and the minimum evidence that could verify it.
9. Prepare facilitation notes: neutral opening, recording/material consent, role-safe language, timebox, and what not to promise.
10. Check coverage and stop conditions. Explicitly mark missing roles, unavailable evidence and questions that cannot be answered in the planned visit.
11. Produce the output contract below and a machine-readable handoff block for the diagnostic master record.

## Follow-Up Triggers

Use [Interview Design Method](references/interview-design-method.md). At minimum follow up when the participant says:

- “normally”, “usually”, “sometimes” or “it depends” without naming the condition;
- “the system handles it” without system, input, output or failure path;
- “someone approves” without actor, threshold or evidence;
- “we all know” without source or owner;
- a future target as if it describes current operation;
- a number, time or loss estimate without a record or sample;
- a handoff without acceptance, timeout or escalation;
- a process step that has no actor, input, output or exception.

## Output Contract

Use [Interview Plan Template](templates/interview-plan.md). Produce:

1. scope, discovery goals, known facts, assumptions and exclusions;
2. planning constraints, recommended coverage and minimum viable interview combination;
3. role coverage matrix and interview priority;
4. expected cross-role disagreement hypotheses with mirrored questions;
5. role-specific interview guides with objective, main questions, follow-up triggers and rationale;
6. minimum evidence request grouped by enterprise owner;
7. facilitation and consent notes;
8. client-safe no-promise list;
9. coverage gaps, stop conditions and next handoff;
10. `enterprise_interview_plan` JSON/YAML block with enterprise/project/process identifiers when available.

Keep the main plan skimmable. Put role questions in tables and avoid repeating the same generic question for every role. Label inferred industry details as assumptions. Do not claim the interview plan itself proves demand, process facts or transformation value.

## Optional Examples

Read one example only when a concrete output pattern would improve the current plan:

- [Manufacturing procurement simulation](reports/runtime-case-manufacturing-procurement.md)
- [Retail complaint simulation](reports/runtime-case-retail-complaint.md)
- [Constrained customer-service simulation](reports/runtime-case-constrained-customer-service.md)

These are simulated fixtures, not enterprise evidence. Reuse their structure, not their industry roles or claims. If a referenced method, template or selected example is missing, report the package as incomplete instead of improvising a generic questionnaire.
