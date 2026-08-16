---
name: enterprise-workflow-mapping
description: >
  Map one concrete recurring employee workflow through an adaptive interview and optional supporting materials. Use when an enterprise employee wants to梳理、摸排、还原一项日常工作或重复工作，说明实际步骤、系统、材料、判断、异常、耗时与交接，并生成供本人确认的工作流程卡。Do not use for department-wide audits, consultant diagnosis, AI transformation plans, technology selection, implementation, or ordinary meeting summaries.
metadata:
  owner: Kang Jiaxin
  version: "0.1.1"
  maturity: personal-experiment
---

# Enterprise Workflow Mapping

Help one employee accurately describe one concrete recurring job. Produce a confirmation artifact, not a transformation proposal.

## Boundary

- Interview one employee about one job at a time.
- Ask one question per turn. Never display the full internal question bank.
- Treat the employee as the authority on their own account, not as proof of the entire enterprise process.
- Do not expose consultant modes, hidden scoring, opportunity rankings, AI/RPA/Agent recommendations, ROI estimates, or final diagnosis.
- Do not contact other people, upload externally, modify source systems, or make business commitments.
- Use only authorized, necessary materials. Do not reproduce secrets, personal identifiers, or raw sensitive content in the reusable card.

## Start

If department, role, and job are all known, briefly restate them and ask the first decision-changing question.

If any are missing, ask one combined opening question:

> 请告诉我你的部门、岗位，以及这次想梳理的一项具体工作。优先选择经常重复、比较耗时、容易出错，或者需要多人协作的工作。

If the employee cannot choose a job, help them select one by asking about the most time-consuming or error-prone daily/weekly task. Do not show a role or mode menu.

## Interview

Follow [Interview Method](references/interview-method.md).

Maintain an internal ledger after every answer:

- confirmed employee statement;
- vague term requiring follow-up;
- step, input, output, system, decision, exception, handoff, burden, or risk;
- evidence reference and level;
- open question or contradiction.

Ask only the next question that can materially improve the workflow card. Stop when the normal path, one realistic exception, decision points, handoffs, burden, evidence status, and open questions are sufficiently clear. Use 10-15 main questions as a ceiling, not a quota.

## Materials

Accept optional transcripts, meeting notes, Markdown, text, Word, PDF, Excel, CSV, SOPs, forms, screenshots, emails, chat excerpts, and existing diagrams when the current Agent can read them.

- Employee statements without supporting material are `E3 employee statement`.
- Supporting files do not automatically prove actual operation; classify them using [Evidence Integrity](references/evidence-integrity.md).
- Refer to evidence by a safe label or file name. Do not embed raw private material in the card.
- If a file cannot be read, say so and continue with clearly labelled employee statements.

## Confirm And Deliver

Before finalizing, show a concise draft of the understood workflow and ask the employee what is wrong or missing. Do not mark it confirmed until the employee explicitly approves it.

After approval, produce:

1. a compact Mermaid flowchart using natural job-language labels;
2. the human-readable card in [Workflow Card Template](templates/workflow-card.md);
3. the portable record defined by [Workflow Card Schema](references/workflow-card-schema.md), when the user requests a file or handoff artifact.

When the run is part of the enterprise diagnostic suite, or the user requests a project handoff, also follow [Master Record Handoff](references/master-record-handoff.md). Emit the machine block separately from the employee-visible card. It is a registration proposal only: never write the master record, choose the next Skill, or claim the project gate has passed. Never infer P0/P1/P2 priority, organizational approval, authorization, storage location, or missing IDs.

The final card must separate:

- employee-confirmed facts;
- material-supported facts;
- open questions;
- unverified statements or conflicts.

Never add transformation opportunities or recommend rules, workflow, RPA, AI, RAG, or Agent in the employee-facing card. A later authorized diagnosis Skill owns that work.

## Completion Check

Do not claim completion unless:

- exactly one concrete job is mapped;
- the employee reviewed the draft;
- every workflow step has actor, action, input/output, system or material, decision basis when applicable, exception handling, and evidence status;
- uncertainties remain visible;
- the card contains no technical transformation recommendation.
