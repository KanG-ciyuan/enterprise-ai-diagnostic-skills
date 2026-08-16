---
name: enterprise-ai-process-diagnosis
description: >
  Diagnose one concrete enterprise AI or digital-transformation process from an evidence pack, workflow card, interview synthesis, or bounded process materials. Use when an AI implementation practitioner must verify demand reality, preserve evidence conflicts, choose the minimum sufficient combination of process redesign, rules, API, workflow, RPA, AI workflow, RAG, bounded Agent, and human work, determine whether implementation is developable, conditional, or blocked, and produce an internal diagnosis plus a client-facing 3-7 day shadow pilot. Do not use to merely organize raw materials, interview an employee, audit an entire enterprise, directly implement a settled solution, or recommend tools without process evidence and system conditions.
metadata:
  owner: Kang Jiaxin
  version: "0.2.0"
  maturity: production-candidate
---

# Enterprise AI Process Diagnosis

Diagnose one business process at a time for the transformation practitioner. Give an evidence-bound business conclusion and a condition-bound technical plan, not an AI sales pitch.

## Operating Boundary

- The primary user is the practitioner. Employees and process owners provide evidence; enterprise decision-makers approve business rules and risk.
- The user owns goals, commercial tradeoffs, and the final recommendation. The enterprise owns rules, permissions, acceptance, and production decisions.
- Never treat "use AI", "build an Agent", or a named tool as the problem statement.
- Never infer an API, permission, data field, deployment option, or integration capability merely because a system exists.
- Never implement, publish, write back, notify external people, approve, pay, or make customer commitments.

## Inputs And Skill Handoffs

Prefer these inputs in order:

1. an `enterprise_material_evidence_pack` containing supported, conflicted, unsupported, and unknown claims, evidence requests, and `prohibited_conclusions`;
2. one or more confirmed employee workflow cards with statement-level evidence links;
3. a bounded interview synthesis or simple process description;
4. raw materials only when the set is small enough to inspect without hiding source boundaries.

When complex raw materials need source-by-source verification, hand off first to `$enterprise-material-analysis`. When an employee's recurring work is still unclear, hand off first to `$enterprise-workflow-mapping`. Do not silently perform those entire jobs inside this skill.

If an evidence pack is provided:

- preserve its claim IDs, conflict IDs, scope limits, and prohibited conclusions;
- do not upgrade E3/E4 claims to operating facts;
- separate business confidence from integration confidence;
- request only evidence that can change the conclusion, route, feasibility state, or pilot.

Follow [Evidence And Safety](references/evidence-and-safety.md).

## Workflow

1. **Restate the job**: identify actor, trigger, current steps, output, consumer, frequency, pain, and desired business result. Remove any preselected solution.
2. **Consume the evidence contract**: map supporting and conflicting claim IDs to process nodes. Explicitly carry forward `prohibited_conclusions`.
3. **Issue an early business diagnosis**: state the current primary conclusion, confidence, and why. Do not trap the user in a long questionnaire.
4. **Ask only decision-changing questions**: one question per turn during conversation. Group evidence requests by owner in a written artifact.
5. **Diagnose demand reality**: assess recurrence, cost/risk, workaround, stability, authorized data, owner, and success measure. If roles or rules are broken, recommend process redesign before automation.
6. **Discover system and interface conditions**: complete the minimum fields in [System And Interface Discovery](references/system-interface-discovery.md) using the [discovery card](templates/system-interface-discovery-card.md). Mark every item `已确认`, `仅口述`, `未知`, or `不可用`.
7. **Allocate responsibilities**: choose the minimum sufficient combination of process redesign, rules, official API, workflow, RPA, AI workflow, RAG, bounded Agent, and human confirmation. Follow [Diagnosis Framework](references/diagnosis-framework.md).
8. **Set the technical feasibility state** for every proposed component:
   - `可开发`: required evidence, access, owner, and acceptance condition are confirmed;
   - `有条件`: the design is plausible but named prerequisites remain unverified;
   - `阻塞`: a required interface, permission, owner, security approval, or stable business rule is absent.
9. **Produce a conditional technical plan**: use [Conditional Technical Design](references/conditional-technical-design.md) and its [plan template](templates/conditional-technical-plan.md). Show logical components, data flow, fields, state, exceptions, human gates, audit, maintenance, and branches for API/file/RPA access. Never fabricate vendor-specific endpoints.
10. **Design a 3-7 day shadow pilot**: use desensitized samples, one normal path, one exception, human takeover, baseline, pass/observe/stop criteria, and rollback. If interfaces are unknown, begin with offline files or manual observations rather than production integration.
11. **Produce two aligned outputs**: an honest internal diagnosis and a client-facing version. They share facts and risks; the client version omits internal sales tactics, not material uncertainty.

When the run is part of the enterprise diagnostic suite, or the user requests a project handoff, also follow [Master Record Handoff](references/master-record-handoff.md). Emit the machine block outside both readable reports. It is a registration proposal only: the Skill cannot write the master record, approve its own diagnosis, resolve H2 on behalf of management, or route the project automatically.

## Required Conclusions

Choose exactly one primary business conclusion:

- `建议进入试点`
- `补充调研后再判断`
- `先改造原业务流程`
- `现阶段不建议实施`
- `不需要AI，采用普通数字化或自动化方案`

Also state one overall technical maturity:

- `可进入离线影子验证`
- `补齐系统条件后可设计集成`
- `技术条件不足，暂不可开发`

Always include confidence (`高/中/低`), evidence IDs, key risks, and the new evidence that could change either result.

## Output Contract

### A. Internal Diagnosis

1. Primary business conclusion, confidence, and technical maturity
2. Restated business problem and current process
3. Evidence ledger, contradictions, and prohibited conclusions
4. Demand reality assessment
5. Responsibility allocation and rejected routes
6. System/interface discovery card with evidence status
7. Conditional technical plan and per-component `可开发/有条件/阻塞` state
8. Risks, permission boundary, maintenance responsibility, and internal deal advice
9. Missing evidence grouped by responsible enterprise role
10. 3-7 day shadow pilot with actual build/test activities and pass/observe/stop criteria

### B. Client Communication

1. Confirmed need and current findings
2. Recommended route in plain business language
3. Confirmed prerequisites and conditions still requiring client verification
4. 3-7 day shadow pilot, acceptance measures, and client participants
5. Responsibilities, exclusions, risks, and next decision gate

Use diagrams or compact tables where relationships matter. Label unverified claims. Do not claim efficiency, cost, quality, integration readiness, or business improvement without the required evidence.
