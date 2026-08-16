---
name: enterprise-material-analysis
description: >
  Analyze and verify authorized enterprise process materials through evidence analysis that finds policy-versus-practice gaps, source conflicts, and missing proof, then produces a traceable evidence ledger, claim-to-source map, contradiction register, coverage gaps, and minimum evidence request for a later enterprise AI application diagnosis. Use when an implementation practitioner has workflow cards, meeting notes, transcripts, SOPs, spreadsheets, screenshots, forms, PDFs, system records, logs, or samples and needs to analyze or find what the materials can prove, distinguish actual operation, employee statements, intended policy, and model inference. Do not use to interview employees, ask questions one by one, generate an employee workflow card, produce ordinary summaries, perform legal or compliance audits, select technology, recommend transformation, claim ROI, or implement systems.
metadata:
  owner: Kang Jiaxin
  version: "0.1.0"
  maturity: personal-experiment
---

# Enterprise Material Analysis

Turn a bounded set of authorized enterprise materials into evidence a later diagnosis can inspect. Do not diagnose or recommend technology.

## Boundary

- Work only on the project, process, roles, period, and files the user placed in scope.
- Read materials before drawing conclusions. If a file cannot be read, record it as unreadable; do not infer its contents.
- Never silently scan unrelated folders, chats, accounts, systems, or knowledge bases.
- Do not treat employee confirmation, meeting detail, an SOP, or a polished document as runtime proof.
- Do not recommend process redesign, rules, API, workflow, RPA, AI, RAG, Agent, products, vendors, or ROI.
- Do not alter source files. Create an analysis artifact only when requested.
- Redact secrets and unnecessary personal or customer identifiers from portable outputs.

## Start

Establish four items from the request or ask one combined question for what is missing:

1. project/process in scope;
2. authorized materials or file paths;
3. known roles and period;
4. expected handoff: inline review, Markdown, or Markdown plus JSON.

If scope contains multiple unrelated processes, ask the user to select one. If there are no readable materials, stop with a missing-material request; do not invent evidence.

## Analyze

Follow [Analysis Method](references/analysis-method.md) and [Evidence Model](references/evidence-model.md).

1. **Inventory** every supplied item with material ID, type, source role/system, date/period, version, sensitivity, readability, and integrity status.
2. **Extract atomic claims** with the smallest useful source locator: page, section, row, record ID, timestamp, speaker turn, or screenshot region.
3. **Classify evidence** as E1-E5 and state exactly what each item supports and does not support.
4. **Map claims to process nodes**: actor, trigger, action, input/output, system, decision, exception, handoff, burden, or outcome.
5. **Compare materials** for agreement, contradiction, policy-practice gaps, version drift, missing roles, missing periods, and unsupported quantities.
6. **Create pending hypotheses** only when useful. Label them E5 and never merge them into confirmed facts.
7. **Prioritize minimum evidence requests** by which missing item could change process understanding, risk, route, or pilot design. Name the likely source and authorized owner; never request a broad data dump by default.

## Output

Use [Evidence Pack Template](templates/evidence-pack.md). Produce:

1. material inventory;
2. atomic evidence ledger;
3. claim-to-source and process-node map;
4. agreement and contradiction register;
5. coverage and unreadable-material gaps;
6. prioritized minimum evidence request;
7. handoff block for the later diagnosis Skill.

When the run is part of the enterprise diagnostic suite, or the user requests a project handoff, also follow [Master Record Handoff](references/master-record-handoff.md). Keep this machine block separate from the evidence-pack正文. It is a registration proposal only and cannot write the master record, close an H2 conflict, approve a diagnosis, or choose the next Skill.

Every substantive finding must cite one or more material IDs and a locator. Use these statuses:

- `supported`: the cited evidence supports the claim within a stated scope;
- `corroborated`: two or more materially independent roles/sources support it;
- `conflicted`: relevant sources disagree or use incompatible definitions;
- `unsupported`: a claim is present but lacks adequate support;
- `unknown`: required information is absent or unreadable.

## Completion Check

Do not claim completion unless:

- every supplied material has an inventory status;
- each finding has a source locator or is explicitly E5/unknown;
- E1 sample scope, E2 corroboration, E3 statements, E4 intended process, and E5 inference remain separate;
- conflicts are preserved rather than silently resolved;
- missing evidence names what is needed, from whom/system, why, and the minimum scope;
- no technology route, implementation promise, or savings claim appears.
