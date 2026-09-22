# Enterprise AI Diagnostic Skills

English | [简体中文](README.zh-CN.md)

[![Status: Prototype](https://img.shields.io/badge/status-prototype-lightgrey.svg)](#status)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Understand how the business actually works before deciding what AI should automate.**

This repository is a set of agent-instruction packages ("Skills") that run one bounded enterprise process diagnosis: management discovery, employee workflow mapping, authorized material analysis, evidence-gated diagnosis, a 3–7 day shadow pilot design, and a human decision gate. It is built for transformation practitioners and enterprise project owners who must decide where AI is justified — and where it is not, and where the process itself must be fixed first.

Every finding carries an evidence level. Nothing advances on assertion alone.

> ### AI-generated coherence is not evidence.
>
> A fluent, well-structured diagnosis is the easiest artifact to produce and the hardest to verify. This system refuses to treat it as a finding. Every substantive claim must cite a material ID and a locator, carry an evidence level, and stay separable from model inference — which is labelled `E5`, stamped `AI假设，待验证`, and rejected by a validator when the label is missing.
>
> The same rule applies to this README. Where the repository has no evidence, this document says so.

---

## Why Enterprise AI Projects Fail Before the Model Matters

By the time a team argues about models, retrieval, agents or vendors, the decisions that determine the outcome have usually already been made badly. The repository's own framing (`README.md` in the working tree) is that the goal is *not* to let AI make high-risk decisions for an enterprise, but to make the process facts, evidence gaps, role boundaries and next actions clear.

The failure modes this system is designed against:

| Failure mode | Why it breaks the project | What this system does instead |
| --- | --- | --- |
| Scope is taken from the org chart, not from the work | The unit of analysis is a department, so there is no process with a trigger, an end state, or a decision | Bounded discovery slices by trigger, start, end and decision; a slice must be chosen before planning |
| Policy is read as practice | A SOP describes the intended rule. It does not describe what anyone actually does | SOPs are classified `E4`, which supports the intended rule only — never actual compliance or execution frequency |
| One loud account becomes an enterprise fact | A manager's summary is repeated until it reads like documentation | A single statement is `E3`: it supports what that person reports, not an enterprise-wide fact or a measured quantity |
| Conflicts are averaged away | Two incompatible accounts are reconciled by seniority or by whichever document looks more formal | Conflicts are preserved and typed; resolution requires new evidence, not a more official-looking file |
| The conclusion outruns the evidence | A route is recommended before demand, data, ownership and access are confirmed | Business value and technical readiness are judged separately; a component can be `阻塞` regardless of how real the need is |
| AI is chosen before the process is fixed | The automation encodes a broken handoff at machine speed | Responsibility allocation prefers process redesign and deterministic rules; `先改造原业务流程` and `不需要AI，采用普通数字化或自动化方案` are first-class conclusions |
| The model is asked to own the risk | A generated recommendation is treated as a decision | A named human role decides; the agent must stop at the gate rather than proceed |

---

## Traditional vs Evidence-Gated Diagnosis

The left column describes the pattern this repository is designed against — it is the contrast the method is built around, not a measured survey of anyone's projects.

| | Traditional AI diagnosis | Evidence-gated diagnosis here |
| --- | --- | --- |
| Starting point | Org chart, stakeholder interviews, a preferred solution | One bounded process and the decision it must support |
| What counts as a fact | Whatever the most senior or most fluent source says | A claim with a source locator and an evidence level (`E1`–`E5`) |
| Official documents | Treated as proof of how work happens | `E4` — supports the intended rule, not execution |
| Model output | Presented as the analysis | `E5` — a lead to verify, labelled and machine-checked |
| Conflicts | Resolved by preference, seniority or formatting | Preserved and typed; only new evidence resolves them |
| Unreadable / missing material | Skipped silently | Recorded, plus a prioritized minimum evidence request naming the owner |
| Technical route | Selected up front, per project | Assessed per component as `可开发` / `有条件` / `阻塞` |
| Pilot | Promises a rollout | Offline shadow pilot design with pass / observe / stop criteria and rollback |
| Delivery authority | The deliverable recommends and the work proceeds | The agent proposes; a human role decides |

---

## How It Works

```text
Create the diagnosis project
  -> Management kickoff interview
  -> Fix roles, process scope and P0 must-interview participants
  -> Agent maps frontline employees, one job at a time
  -> Employee confirms their own workflow card
  -> Authorized materials uploaded at any stage enter material analysis
  -> Check evidence coverage, versions and conflicts
  -> Once the diagnosis gate is met, enter process diagnosis
  -> Design a 3-7 day shadow pilot
  -> Enterprise owner approves, pauses, or requests more evidence
```

This is not a rigid pipeline that must run end to end. An orchestrator routes each event against the master record: a file uploaded mid-mapping can enter material analysis first; insufficient evidence returns the project to evidence completion; withdrawn authorization, unknown source or unmanaged high-risk conflict forces a pause.

The router is real code, not prose. [`enterprise-ai-diagnostic-orchestrator/scripts/orchestrate_event.py`](enterprise-ai-diagnostic-orchestrator/scripts/orchestrate_event.py) maps four event types to four targets:

| Event | Target Skill | Reason code |
| --- | --- | --- |
| `management_problem_submitted` | `enterprise-interview-preparation` | `MANAGEMENT_SCOPE_DISCOVERY` |
| `participant_task_started` | `enterprise-workflow-mapping` | `EMPLOYEE_MAPPING_TASK_READY` |
| `file_uploaded` | `enterprise-material-analysis` | `AUTHORIZED_FILE_EVENT` |
| `diagnosis_gate_ready` | `enterprise-ai-process-diagnosis` | `DIAGNOSIS_GATE_CONFIRMED` |

Per event the orchestrator selects exactly one decision — `invoke_skill`, `wait_external`, `request_human`, `pause`, or `no_action` — invokes at most one primary Skill, and always returns `"write_authority": "scheduling_proposal"`. The proposal is not a write: the orchestrator cannot write the master record, change source artifacts, close an H2 gate, self-approve a diagnosis, or promise ROI.

---

## Core Capabilities

| Capability | What it actually does |
| --- | --- |
| **Management Discovery** | Produces a decision-changing interview plan for one bounded process: scope, role coverage matrix, per-role question guides, follow-up triggers, minimum evidence requests, coverage gaps and a client-safe no-promise list. It plans interviews; it does not conduct them |
| **Employee Workflow Mapping** | Maps one employee's one concrete recurring job through an adaptive interview, one question per turn, and produces (a) a compact Mermaid flowchart, (b) a human-readable workflow card, and (c) a portable record. The card is not final until the employee explicitly confirms it |
| **Authorized Material Analysis** | Reads only in-scope authorized materials and produces a material inventory, an atomic evidence ledger, a claim-to-source and process-node map, an agreement and contradiction register, coverage and unreadable-material gaps, and a prioritized minimum evidence request. It keeps originals unchanged and never resolves conflicts on its own |
| **Evidence-Gated Diagnosis** | Consumes the evidence contract, maps supporting and conflicting claim IDs to process nodes, assesses demand reality, discovers system and interface conditions, and issues an early diagnosis with confidence, key risks, and the new evidence that could change it |
| **AI Opportunity / Boundary** | Allocates responsibility across process redesign, rules, official API, workflow, RPA, AI workflow, RAG, bounded Agent and human confirmation — choosing the *minimum sufficient* combination, recording rejected routes, and stating where AI must not operate |
| **3–7 Day Shadow Pilot** | Designs an offline pilot with desensitized samples, one normal path and one realistic exception, human takeover, an old-process baseline, measurable output comparison, pass / observe / stop criteria, explicit in-scope and out-of-scope items, and rollback to the original process |
| **Human Decision Gate** | Gates `A0`/`A1`/`H1`/`H2`/`S0` define where the agent must stop and a human must act. The agent may propose; it may not approve, publish, notify, pay, or commit |

---

## The Specialist Skills

The diagnostic chain routes to **four specialist skills plus one orchestrator**. This is stated by the repository's own contract — `enterprise-ai-diagnostic-orchestrator/README.md` heads its list `## 四个专业出口`, and `manifest.json` declares exactly four `upstream_skills`. Earlier revisions of this document described the repository as having "five core Skills", which counted `SKILL.md` packages rather than specialist skills; the fifth package is the orchestrator itself.

| Package | Role | Version | Maturity tier |
| --- | --- | --- | --- |
| [`enterprise-interview-preparation`](enterprise-interview-preparation/) | Specialist — management discovery and interview planning | `0.2.0` | `production-candidate` |
| [`enterprise-workflow-mapping`](enterprise-workflow-mapping/) | Specialist — one employee, one job, employee-confirmed workflow card | `0.1.1` | `scaffold` |
| [`enterprise-material-analysis`](enterprise-material-analysis/) | Specialist — authorized material analysis and the evidence pack | `0.1.0` | `production-candidate` |
| [`enterprise-ai-process-diagnosis`](enterprise-ai-process-diagnosis/) | Specialist — business diagnosis, conditional technical plan, shadow pilot design | `0.2.0` | `production-candidate` |
| [`enterprise-ai-diagnostic-orchestrator`](enterprise-ai-diagnostic-orchestrator/) | Orchestrator — routing only, and the only package with runnable code | `0.1.0` | `production-candidate` |
| [`enterprise-ai-diagnostic-master-record`](enterprise-ai-diagnostic-master-record/) | Shared record contract — **not a Skill**: it has a `README.md`, but no `SKILL.md` and no `manifest.json` | schemas `v0.1` / `v0.2` | — |

Two honest notes on this table. `maturity_tier` is the repository's own declared field, not an assessment — `enterprise-workflow-mapping` declares `scaffold` where the other four declare `production-candidate`, and every package declares `manifest.json` `"status": "personal-experiment"` and `"publication": "local-only"`. Package versions are independent; there is no single repository-wide version.

Each package carries its own `references/`, `templates/`, `evals/`, `reports/` and `tests/`, and `SKILL.md` is the execution entry point. Copying a lone `SKILL.md` out of its package is not a supported use.

---

## Evidence-Gated Diagnosis

The method is one idea applied consistently: **separate what was observed from what was said, from what was written down, from what a model produced — and never let a lower level answer a higher level's question.**

The canonical definition is [`enterprise-material-analysis/references/evidence-model.md`](enterprise-material-analysis/references/evidence-model.md):

| Level | Source | Supports | Does not automatically support |
| --- | --- | --- | --- |
| `E1` | observed operation, system record, execution log, or representative real/desensitized sample | a process fact inside the observed item and period | all cases, causal explanations, employee intent, or ROI |
| `E2` | materially independent roles or sources corroborating the same concrete claim | a corroborated account | actual runtime execution unless one source is `E1` |
| `E3` | one employee, manager, customer, or supplier statement | what that person reports | enterprise-wide fact or measured quantity |
| `E4` | SOP, policy, form, specification, or intended flow | intended rule, design, or required process | actual compliance or execution frequency |
| `E5` | model inference or analyst hypothesis | a lead to verify | a fact, contradiction resolution, or external claim |

The independence rule is part of the definition: *two documents copied from the same meeting, or one manager repeating an employee's account, are not independent corroboration.* Source lineage is recorded and a claim is upgraded to `E2` only when the supporting roles or source origins are materially independent.

### It is enforced in code, not only in prose

- `enterprise-ai-diagnostic-master-record/schema/master-record-v0.2.schema.json` constrains `evidenceLevel` to the enum `["E1","E2","E3","E4","E5"]`.
- [`enterprise-ai-diagnostic-master-record/scripts/validate_master_record.py`](enterprise-ai-diagnostic-master-record/scripts/validate_master_record.py) defines `EVIDENCE_LEVELS = {"E1", "E2", "E3", "E4", "E5"}` and emits `E5_LABEL_MISSING` when an `E5` record does not carry the label `AI假设，待验证`.
- `tests/test_master_record.py` asserts that rejection; `tests/test_routing_contract_v02.py` raises `ValueError("E5 must remain visibly labelled")`.
- The offline simulation runner stamps `"evidence_level": "E5"` on every emitted record, and its test asserts it.

The routing contract states the operating rule directly: `E5` content must be marked `AI假设，待验证`, must not be mixed into `E1`/`E2` fact paragraphs or have its level stripped in management views, and a diagnosis may use `E5` to propose verification but may not form a settled conclusion from `E5` alone.

### What this model is *not*

The `E1`–`E5` model is real and code-enforced, but it is **not uniformly implemented across every package**, and this document will not pretend otherwise:

- It is restated in several places inside the repository with non-identical wording. The table above is the canonical source; treat divergent restatements elsewhere in the tree as drift.
- `enterprise-interview-preparation` contains **zero** `E1`–`E5` references. One package in the chain does not use the model.
- `enterprise-ai-diagnostic-orchestrator/SKILL.md` never defines the levels; the string `E5` appears in that package only in its simulation script and test.
- Only the JSON record layer is machine-enforced. The Markdown outputs are constrained by instruction, not by a validator.

---

## What You Get

Each item below is defined by a template, schema, or code path that exists in this repository.

| Deliverable | Defined at | Nature |
| --- | --- | --- |
| **Interview plan** (`enterprise_interview_plan`) | [`enterprise-interview-preparation/templates/interview-plan.md`](enterprise-interview-preparation/templates/interview-plan.md) + JSON Schema | Template + schema, filled by a model following `SKILL.md` |
| **Employee workflow card** (employee-confirmed) | [`enterprise-workflow-mapping/templates/workflow-card.md`](enterprise-workflow-mapping/templates/workflow-card.md) + JSON Schema | Template + schema; requires explicit employee confirmation before it is final |
| **Atomic evidence ledger** | [`enterprise-material-analysis/templates/evidence-pack.md`](enterprise-material-analysis/templates/evidence-pack.md); row fields defined in the evidence model | Claim ID, exact claim, material ID and locator, source role/system and date, evidence level, process node, status, scope limit, sensitive-data note, related or conflicting claim IDs |
| **Conflict register** | `evidence-pack.schema.json` requires `conflicts`; conflict taxonomy in the evidence model | Seven typed conflicts: `factual`, `definition`, `time`, `policy-practice`, `scope`, `handoff`, `measurement` — preserved, not silently resolved |
| **Evidence gaps and minimum evidence request** | `evidence-pack.schema.json` requires `coverage` and `evidence_requests`; master record carries `outstanding_gaps` | Coverage gaps, unreadable-material gaps, and a prioritized request naming what is needed, from whom, why, and the minimum scope |
| **AI / Agent boundary plan** | [`enterprise-ai-process-diagnosis/templates/conditional-technical-plan.md`](enterprise-ai-process-diagnosis/templates/conditional-technical-plan.md) | Responsibility allocation, rejected routes, per-component `可开发` / `有条件` / `阻塞` state, and mandatory human confirmation points |
| **Shadow pilot plan (3–7 day design)** | [`enterprise-ai-process-diagnosis/SKILL.md`](enterprise-ai-process-diagnosis/SKILL.md), [diagnosis framework](enterprise-ai-process-diagnosis/references/diagnosis-framework.md) | A designed offline pilot with baseline, exceptions, human takeover, pass / observe / stop criteria and rollback |
| **Management diagnostic deliverable** | Two aligned outputs: internal diagnosis and client communication | Same facts and risks; the client version omits internal tactics, never material uncertainty |

**Supporting records.** A master record schema and validator ([`enterprise-ai-diagnostic-master-record`](enterprise-ai-diagnostic-master-record/)) hold project identity, status, record index, versions, authorization and upstream references — it does not store full transcripts or attachments. Sub-skills emit a `registration proposal` rather than writing the master record. The orchestrator emits a `scheduling_proposal`. The offline runtime simulation emits `runtime-log.jsonl`, `summary.json` and `final-master-record.json`.

**Presentation artifacts.** [`deliverables/management-diagnostic-report-v0.1/index.html`](deliverables/management-diagnostic-report-v0.1/index.html) is a real interactive HTML report (215-line HTML, 14.9 KB CSS, 2.9 KB JS with keyboard tab navigation, `IntersectionObserver` and print support) built on fixed `E5` synthetic data — it does not connect to the master record, a database, a queue, an OA system or a CRM. The four `design/*.png` files are design concept mockups, not screenshots. [`deliverables/enterprise-ai-platform-v0.1/`](deliverables/enterprise-ai-platform-v0.1/) is a business-development proposal — a 5-page PDF printed from the HTML plus a 5-slide PPTX — not a diagnostic deliverable; its own slide 4 states that the method is validated by simulated cases and local tests only, and that real enterprise returns, production readiness, cross-platform compatibility and paying customers cannot yet be claimed.

---

## Human / Rule / Agent Boundary

The division of responsibility is declared, not implied:

```text
Workflow owns sequence and state.
Rules own deterministic checks.
AI owns understanding, classification, summarization, and drafting.
Agent owns bounded dynamic judgment and limited tool selection.
Humans own high-risk decisions and final responsibility.
```

**Who sees what.** The enterprise owner sees process scope, key breakpoints, role boundaries, evidence gaps, the recommended route and pending approvals. A frontline employee sees only what concerns their own mapping and confirmation, and never receives restricted management context such as role changes or cost-reduction assessments. There is an explicit information barrier: restricted management context may help the orchestrator identify a reviewer, but it must not appear in employee questions or in that employee's own workflow card.

**What the agent may not do.** The orchestrator must not write the master record, change source artifacts, close an `H2` gate, self-approve a diagnosis, or promise ROI. The diagnosis Skill must never implement, publish, write back, notify external people, approve, pay, or make customer commitments. Skills generate proposals, records and registration proposals by default — they do not contact employees, send messages, modify business systems or execute production operations.

**What a gate is.** `A0`/`A1` may be settled inside the current conversation. `H1`, `H2` and `S0` require a bounded task or a stop. Closing `H2` requires an independent organizational confirmation record with the confirmer's authority basis, the interpretation adopted, scope, effective time, source evidence and affected records. An authorization withdrawal is not a note — it propagates: material → evidence pack → diagnosis → management view, each entering invalidated/recompute/publish-withdrawn state.

---

## CRM Case Study

> ## Synthetic / `E5` — Method Validation Only
>
> The entire case study is a synthetic `E5` simulation used to validate the method and the routing. It is **not** a real enterprise, **not** an anonymized client, and **not** a recorded result.

[`simulations/business-operations-crm-authorization/`](simulations/business-operations-crm-authorization/) is an end-to-end walkthrough of a CRM customer-ownership handover process (`客户归属交接`) across 43 numbered files, plus a runnable offline control fixture in `runtime-simulation/` and five synthetic upload materials in `synthetic-inputs/`. It covers the management kickoff, role mapping for the sales applicant, sales manager, business-operations lead and CRM administrator, the breakpoints between an Excel list, OA approvals and CRM changes, the evidence gate, process diagnosis, an offline shadow pilot, and a waiting-for-evidence state.

The labels are explicit and repeated:

- [`synthetic-inputs/README.md`](simulations/business-operations-crm-authorization/synthetic-inputs/README.md) — `证据等级：E5 AI模拟，待真实企业验证。` and `所有企业、员工、客户、编号和时间均为虚构，不对应任何真实主体。`
- [`40-synthetic-test-matrix.json`](simulations/business-operations-crm-authorization/40-synthetic-test-matrix.json) — `"evidence_level": "E5"`, `"evidence_label": "AI模拟，待真实企业验证"`, `"simulation_only": true`, over 14 scenarios (6 route cases + 8 business-control cases).
- Every identifier carries a `SIM` or `SYN` marker: `ENT-SIM-RTL`, `PRJ-SIM-CRM-OWNER-TRANSFER-001`, `MASTER-SIM-RTL-001`, `SHADOW-SYN-CRM-001`.
- [`36-real-evidence-intake-checklist.md`](simulations/business-operations-crm-authorization/36-real-evidence-intake-checklist.md) exists specifically to list the real desensitized evidence a real engagement would still require.

### The shadow pilot: designed, never executed

The 3–7 day shadow pilot is a **real design specification** (`Design a 3-7 day shadow pilot: use desensitized samples, one normal path, one exception, human takeover, baseline, pass/observe/stop criteria, and rollback.`). No real pilot has been run. The only execution record is an accelerated one-session simulation:

> `试点性质：E5 AI模拟，待真实企业验证。本记录使用现有合成XLSX、CSV和文字材料完成一次加速模拟。它不代表真实企业运行结果，不连接、不读取、不写入生产OA/CRM，不通知任何外部人员，也不形成生产实施授权。`

That record also caps its own claim: of 8 target scenarios, 6 have row-level samples and 2 completed only rule-level checks, so the round cannot be written up as "all 8 passed".

One further discrepancy is worth stating rather than smoothing over. `outputs/crm-shadow-pilot-20260816/crm-shadow-pilot-result.xlsx` is a committed XLSX with seven named sheets for which **no generating script exists in this repository** — its declared result fingerprint cannot be recomputed from the tree.

The day counts were previously inconsistent: a blocked-path document said `3-5天` while its own table ran five days, the specification says `3-7 day`, and the concrete artifacts are 5-day runs. That outlier has been corrected to `3-7天` to match the specification; the 5-day artifacts remain inside that range. The resolution is recorded in [`CHANGELOG.md`](CHANGELOG.md).

[`simulations/manufacturing-emergency-procurement/`](simulations/manufacturing-emergency-procurement/) and [`simulations/retail-complaint-refund/`](simulations/retail-complaint-refund/) are two smaller simulations, equally synthetic.

---

## Who This Is For

**This is for you if**

- you are a transformation practitioner or consultant who must produce a defensible diagnosis of one bounded enterprise process;
- you are an enterprise project owner who needs to know which steps carry evidence, which are assumption, and what would have to be true before automation is justified;
- you want a method that can return `先改造原业务流程`, `现阶段不建议实施`, or `不需要AI，采用普通数字化或自动化方案` as legitimate answers;
- you are building on an agent platform and want skill packages with explicit boundaries and typed outputs, not a prompt that always says yes.

**This is not for you if**

- you want a tool or vendor recommendation, an ROI number, or a savings estimate — the method explicitly refuses to produce these without evidence;
- you want the model to decide whether to proceed, or to approve, publish or act;
- you need a scheduler, a database, a unified entry point or a runtime service — none exists here;
- you want an enterprise deployment or a production integration.

---

## What This Is NOT

This section is deliberate. The repository's honesty is its main asset, and overstating it would destroy the thing being documented.

- **Not a real enterprise deployment.** No real enterprise record exists anywhere in the tree. Every enterprise identifier carries a `SIM` or `SYN` marker.
- **No real client results.** No ROI, efficiency gain, cost saving, quality improvement, accuracy figure or adoption number has been measured, because no real engagement has taken place.
- **No independent or provider-backed validation.** The repository's own artifact records `"provider_backed": false`: *"The output was reviewed in the creating Codex task, not generated by an independent provider run."* A runtime case record states plainly that independent runtime remains `missing evidence`.
- **No executed shadow pilot.** Only a synthetic, accelerated, single-session simulation exists. Nothing was connected to a production OA or CRM.
- **CI runs, but it only proves the repository agrees with itself.** `.github/workflows/local-checks.yml` runs the eight suites and the provenance guard on every push and pull request, via `scripts/run_local_checks.sh`. That catches drift and stale assertions; it does not test the method, and nothing in it invokes a model.
- **Tagged, but not a package release.** The repository carries a `CHANGELOG.md` and a `v0.1.0` snapshot tag of a consistent, fully-validated set of packages. There is still no installable package and no published version to depend on: package versions are independent, and the tag does not override any package's declared `status` or `publication`.
- **Not cross-platform.** All five `manifest.json` files declare `"target_platforms": ["codex"]`, and the orchestrator's adapter declaration for `openai` reads *"local deterministic routing tests only; cross-Agent runtime pending"*.
- **Not production-ready.** Every manifest declares `"status": "personal-experiment"` and `"publication": "local-only"`.
- **Not a runtime system.** No database, no unified entry point, no task queue, no scheduler, no web service. The only executable logic is a deterministic router, an offline simulation runner, four validators, and the root provenance guard.
- **Not a substitute for the people.** It does not interview employees autonomously, contact anyone, send messages, modify business systems, or make commitments.

---

## Validation Status

### What was actually run

Eight `unittest` suites plus a provenance guard, all executed from the repository root with the Python standard library. **131 tests, all passing.**

```bash
python3 -m unittest discover -s enterprise-interview-preparation/tests          # 9 tests,  OK
python3 -m unittest discover -s enterprise-workflow-mapping/tests               # 7 tests,  OK
python3 -m unittest discover -s enterprise-material-analysis/tests              # 7 tests,  OK
python3 -m unittest discover -s enterprise-ai-process-diagnosis/tests           # 7 tests,  OK
python3 -m unittest discover -s enterprise-ai-diagnostic-orchestrator/tests     # 23 tests, OK
python3 -m unittest discover -s enterprise-ai-diagnostic-master-record/tests    # 56 tests, OK
python3 -m unittest discover -s simulations/business-operations-crm-authorization/tests  # 17 tests, OK
python3 -m unittest discover -s deliverables/management-diagnostic-report-v0.1/tests     # 5 tests,  OK
python3 scripts/validate_personal_skill_ownership.py                            # personal_skill_ownership_valid
```

`pytest` is not used and is not required; every suite runs on stdlib `unittest`. `scripts/run_local_checks.sh` runs all eight suites and the guard in one command and exits non-zero on any failure, and CI calls that same script so local and CI execution cannot drift.

Extended validation, all of which passes:

<details>
<summary>Router, offline simulator, and the master-record validators</summary>

The router produces a real scheduling proposal. Example, using the committed synthetic master record:

```bash
python3 enterprise-ai-diagnostic-orchestrator/scripts/orchestrate_event.py \
  enterprise-ai-diagnostic-master-record/examples/retail-complaint-master-record-v0.2.json \
  enterprise-ai-diagnostic-orchestrator/examples/events/management-problem.json
```

It returns `"decision": "invoke_skill"`, `"target": "enterprise-interview-preparation"`, `"reason_codes": ["MANAGEMENT_SCOPE_DISCOVERY"]` and `"write_authority": "scheduling_proposal"`.

The offline runtime simulation replays a scenario and writes `runtime-log.jsonl`, `summary.json` and `final-master-record.json` into a **new** output directory — it refuses to overwrite an existing one with `OUTPUT_DIRECTORY_EXISTS`:

```bash
python3 enterprise-ai-diagnostic-orchestrator/scripts/run_offline_simulation.py \
  simulations/business-operations-crm-authorization/runtime-simulation/master-record.json \
  simulations/business-operations-crm-authorization/runtime-simulation/scenario.json \
  /tmp/shadow-sim-out          # must not already exist
```

It prints `{"scenario_id": "SIM-RUNTIME-CRM-AUTH-001", "result": "completed"}` and writes a summary carrying `"evidence_level": "E5"`, `"simulation_only": true`, `"production_write": false`, `"event_count": 7`, with the final stage left in `evidence_completion` because the scenario is still waiting for real authorized material and real employee confirmation.

The master-record validators return `valid` on both committed examples, on all three handoff proposals, on the ordered handoff chain, and on all six orchestrator output examples. The orchestrator output validator takes one file per invocation:

```bash
cd enterprise-ai-diagnostic-master-record
python3 scripts/validate_master_record.py examples/retail-complaint-master-record.json
python3 scripts/validate_master_record.py examples/retail-complaint-master-record-v0.2.json
python3 scripts/validate_skill_handoff.py examples/skill-handoffs/workflow-mapping.json
python3 scripts/validate_handoff_chain.py \
  examples/retail-complaint-master-record-v0.2.json \
  examples/skill-handoffs/workflow-mapping.json \
  examples/skill-handoffs/material-analysis.json \
  examples/skill-handoffs/diagnosis.json
```

</details>

### What the tests do and do not prove

They genuinely exercise the mechanics: the router is driven by 13 tests asserting decision, target and reason codes for cross-enterprise input, authorization withdrawal, unknown source, premature diagnosis and non-owner recovery, plus an anti-drift test that re-runs the router and field-compares against all six saved outputs. The master-record validator is exercised with deliberate mutation cases. The offline runner is executed end to end. The committed XLSX is opened as a real ZIP and its seven sheet names are asserted.

They do **not** validate the method. The large majority of the 131 tests are string-containment assertions on Markdown — they pass if a sentence is present and fail if it is reworded. **Nothing in this repository tests an actual model.** The trigger evaluation is a keyword-concept scorer over recorded prompts, not an activation test and not model-scored evaluation. Every test here validates the repository against itself, never efficacy against a real enterprise.

### Evidence the repository's own tooling recorded as failing

Both committed local release checks — `enterprise-material-analysis/reports/local-release-check.json` and `enterprise-ai-process-diagnosis/reports/local-release-check.json` — report `"ok": false` with `{"pass": 3, "warn": 3, "block": 3}`. The blocked gates are `package_validation`, `git_diff_check` and `feature_branch`; the warnings are `clean_worktree`, `clean_install` and `provider_or_human_output_evidence`. The provider-or-human output evidence gate is the one that matters most, and the reason is recorded next to it.

Also worth knowing before relying on this tree: two internal cross-references elsewhere in the repository point at paths that do not resolve (a design document under `docs/superpowers/specs/` and an `evals/fixtures/...` path resolved from the wrong base directory). Neither is cited as a link from this document.

### Evidence classification for this README

| Claim | Class |
| --- | --- |
| The router, the offline simulator and the four validators execute and produce the outputs shown | `VERIFIED` |
| 131 tests across eight suites pass | `VERIFIED` |
| The `E1`–`E5` model exists and is enforced in schema, validator and tests | `VERIFIED` |
| Governance rules are substantive and partly machine-enforced | `VERIFIED` |
| The CRM case study, both smaller simulations, the master-record examples and every deliverable's content | `SIMULATED` (`E5`) |
| The 3–7 day shadow pilot as an executed run | **not claimed** — design only; the sole record is a synthetic acceleration |
| Real enterprise results, ROI, pilot outcomes, independent provider validation | `TO_VERIFY` — and the repository's own artifacts say they do not exist yet |

---

## Status

The repository's declared status vocabulary, taken from the files themselves:

| Field | Declared value |
| --- | --- |
| `manifest.json` `status` (all five packages) | `personal-experiment` |
| `manifest.json` `publication` (all five packages) | `local-only` |
| `manifest.json` `target_platforms` (all five packages) | `["codex"]` |
| `manifest.json` `maturity_tier` | `production-candidate` (four packages), `scaffold` (`enterprise-workflow-mapping`) |
| `SKILL.md` `metadata.maturity` | `personal-experiment` |
| Git tags / GitHub Releases / `CHANGELOG` | none |

The badge above therefore reads **Prototype**, not Experimental, Production or Enterprise Ready. `production-candidate` is the repository's own per-package tier label; it is a candidate tier, not a production claim, and it does not override `status: personal-experiment` or `publication: local-only`.

Even though every package declares `local-only` publication, the repository is public on GitHub under the MIT License. Maintainer metadata names **Kang Jiaxin** in the manifests, `SKILL.md` files and `agents/interface.yaml`; `LICENSE` names the copyright holder as **Kang**. The two are not unified here, and `LICENSE` has not been altered.

---

## Security & Governance

The governance content in this repository is substantive and partly machine-enforced, not decorative.

**Data scope.** Only enterprise materials the user has explicitly authorized and placed in scope are processed. Real API keys, tokens, cookies or credential files are never recorded in the repository, replies, documents or logs. `.env` files, key files, raw personal information and undesensitized enterprise data are not committed. No API key, token, cookie, password, private key or credential value exists anywhere in the tree, and a secret-scan gate records zero findings.

**Privacy in reusable artifacts.** Use project codes and anonymous identifiers in portable artifacts. Do not place customer names, employee identities, credentials, raw private transcripts or sensitive business content in reusable Skill files or public fixtures. Originals stay unchanged; unreadable, truncated, image-only, password-protected or corrupted files are recorded rather than guessed at. Do not silently scan unrelated chats, files, logs, accounts or knowledge bases.

**Authorization withdrawal.** When authorization is withdrawn, the upstream material and everything derived from it must enter review state and may not continue to be used externally. This is enforced in code, in the validator, and in tests: the router requires `H2` human review on withdrawal, and `test_withdrawn_material_propagates_through_evidence_pack_to_diagnosis` proves the propagation. Output views must use `metadata_policy: preserve_source_metadata` — a view may filter content but may not strip evidence level, `E5` label, conflict status, authorization status or version lineage.

**Anti-overclaim rules.** Do not claim efficiency, cost, quality, integration readiness or business improvement without the required evidence. Client communication must not hide a material risk or evidence gap, turn an assumption into a confirmed fact, or promise ROI, accuracy, delivery or compliance without evidence.

**Attribution guard.** [`scripts/validate_personal_skill_ownership.py`](scripts/validate_personal_skill_ownership.py) walks every text file in the five package directories and fails if a package does not declare `owner: Kang Jiaxin`, if a forbidden attribution marker appears, if an external URL other than the JSON Schema dialect URI is present, or if a package declares an `upstream_inspiration`. It is a real provenance guard, and it is the reason former attribution names appear in this repository only as forbidden-marker constants inside the guard itself. Its scope is limited to the five package directories: it does not scan the root `README.md`, `docs/`, `simulations/`, `deliverables/`, `outputs/`, `scripts/` or `enterprise-ai-diagnostic-master-record/`, so the URL-bearing prior-art research reports outside those directories are not covered by it.

**Enforcement limits.** What is machine-enforced covers the JSON record layer and the routing layer. The Markdown outputs are constrained by instruction only — there is no validator for them, and nothing here tests whether a model actually obeys `SKILL.md`.

---

## Quick Start

### Requirements

Python 3 with only the standard library — the tests, router, simulator and validators import nothing outside it. No root `package.json`, `pyproject.toml`, `setup.py` or `requirements.txt` exists, so there is nothing to install for validation.

### Repository layout

```text
enterprise-ai-diagnostic-skills/
├── enterprise-interview-preparation/      # specialist Skill - management discovery
├── enterprise-workflow-mapping/           # specialist Skill - employee workflow card
├── enterprise-material-analysis/          # specialist Skill - evidence pack
├── enterprise-ai-process-diagnosis/       # specialist Skill - diagnosis + shadow pilot
├── enterprise-ai-diagnostic-orchestrator/ # orchestrator Skill - router + runnable code
├── enterprise-ai-diagnostic-master-record/# shared record contract (not a Skill)
├── simulations/                           # synthetic end-to-end cases
├── deliverables/                          # static report and proposal artifacts
├── outputs/                               # one committed XLSX artifact, no generator
├── docs/                                  # offline-runtime design note and plan
└── scripts/                               # the ownership/provenance guard
```

### Using the Skill packages

There is no published package, no `npx` install command and no release to pin. The supported use is to copy an entire package directory into the skill directory your agent platform reads — each package declares `"target_platforms": ["codex"]`, and each package's own `README.md` documents the path for that platform. Copy the whole directory, not a lone `SKILL.md`: the `references/`, `templates/`, `evals/` and `tests/` directories are part of the contract.

The packages have not been verified on any platform other than the declared one, and no cross-platform activation evidence exists.

### Running the checks

From the repository root, the eight suites and the guard shown in [Validation Status](#validation-status) are the complete local check. To reproduce the executable behaviour rather than only the tests, use the router and offline simulator commands in the collapsed block above; write simulation output to a directory that does not exist yet.

---

## Kang Ecosystem

```text
DISCOVER
Enterprise AI Diagnostic Skills
        ↓
DEFINE
Kang Product Architect
Kang Enterprise Process Reviewer
        ↓
BUILD & COORDINATE
Kang Agent Workforce
Kang Agent Collab
Kang Frontend Standard
        ↓
VERIFY
Kang B2B UX Auditor
Kang Product Acceptance Auditor
        ↓
DELIVER
Kang GitHub README
Kang PPT Skill
```

> This is an ecosystem map, not a strict runtime pipeline. The stages describe where
> each project sits in the work, not a mandatory execution order.

---

## Part of the Kang Open-Source AI System

This project is one part of an evidence-driven system for enterprise AI transformation, agent collaboration, and AI-native product delivery.

| Stage | Project | Role |
| --- | --- | --- |
| DISCOVER | [enterprise-ai-diagnostic-skills](https://github.com/KanG-ciyuan/enterprise-ai-diagnostic-skills) | Understand how the business actually works before automating it |
| DEFINE | [kang-product-architect](https://github.com/KanG-ciyuan/kang-product-architect) | Turn ambiguous requirements into an implementation-ready product contract |
| DEFINE | [kang-enterprise-process-reviewer](https://github.com/KanG-ciyuan/kang-enterprise-process-reviewer) | Review whether workflows are executable, accountable and recoverable |
| BUILD & COORDINATE | [kang-agent-workforce](https://github.com/KanG-ciyuan/kang-agent-workforce) | Role-based AI product workforce with explicit handoffs |
| BUILD & COORDINATE | [kang-agent-collab](https://github.com/KanG-ciyuan/kang-agent-collab) | Agent collaboration and handoff protocol |
| BUILD & COORDINATE | [kang-frontend-standard](https://github.com/KanG-ciyuan/kang-frontend-standard) | Frontend quality standard for AI-built interfaces |
| VERIFY | [kang-b2b-ux-auditor](https://github.com/KanG-ciyuan/kang-b2b-ux-auditor) | Can users actually finish the work? |
| VERIFY | [kang-product-acceptance-auditor](https://github.com/KanG-ciyuan/kang-product-acceptance-auditor) | Independent acceptance of AI-built products |
| DELIVER | [kang-github-readme](https://github.com/KanG-ciyuan/kang-github-readme) | Evidence-aware README engineering |
| DELIVER | [kang-ppt-skill](https://github.com/KanG-ciyuan/kang-ppt-skill) | Evidence-aware presentation design |

**Cross-cutting infrastructure:** [kang-meta-skill](https://github.com/KanG-ciyuan/kang-meta-skill) —
Skill engineering, evaluation and release governance.

**Earlier work:** [ai-agent-rules](https://github.com/KanG-ciyuan/ai-agent-rules),
[workflow-five-steps](https://github.com/KanG-ciyuan/workflow-five-steps),
[renovation-agent](https://github.com/KanG-ciyuan/renovation-agent).

---

## License

Released under the [MIT License](LICENSE).
