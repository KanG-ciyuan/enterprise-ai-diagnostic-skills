# Interview Design Method

## 1. Scope before questions

Define one bounded process or business problem. Record where it starts, where it ends, what decision the discovery must support and which tempting conclusions are not yet evidence.

## 2. Role coverage

Choose roles because they own a decision, perform a step, receive a handoff, maintain data/system access, approve money/risk, or handle exceptions. Do not invite every title by default.

| Role lens | What only this lens may reveal |
|---|---|
| Process owner | intended result, policy, success measure, unresolved authority |
| Actual executor | real steps, workarounds, waiting, rework, exceptions |
| Upstream/downstream | input quality, handoff acceptance, downstream usability |
| System/data owner | fields, stable IDs, access, export/API evidence, failure logs |
| Finance/risk/quality | money, compliance, high-risk gates, audit and final approval |
| Manager/approver | thresholds, escalation, responsibility transfer and closure |

Use `P0` when missing the role blocks a business or safety decision, `P1` when the role verifies a material assumption, and `P2` when the role adds useful context but cannot change the current route.

## 3. Resource-constrained planning

Record total interview time, maximum participants, preferred session length and roles that cannot be reached. Produce two views:

- **recommended coverage**: every role lens needed to support the stated decision;
- **minimum viable combination**: the smallest set of available people who cover distinct P0 lenses within the limit.

Do not select people only because they are convenient or senior. One person may cover multiple lenses only when their actual responsibilities support it. If the limit cannot cover every P0 business or safety lens, narrow the process slice or mark the plan partial and name the residual risk.

## 4. Conflicting inputs

When supplied facts disagree, preserve each source-labelled claim. Do not average, silently merge or choose the manager's version by authority. Ask one clarification only when it changes the interview boundary; otherwise convert the disagreement into a hypothesis to test.

If the requested scope contains multiple triggers, owners, outcomes or end points, propose 2-3 bounded slices. Prefer the slice that supports the stated discovery decision, but require confirmation before dropping a material process.

## 5. Expected cross-role disagreement

Predict disagreements only as planning hypotheses:

| Likely tension | Mirrored probe |
|---|---|
| Policy owner says “always”; executor describes exceptions | Ask both for the latest concrete case and the exception condition |
| Sender says work was handed off; receiver says it was incomplete | Ask both what action proves acceptance and what happens on timeout |
| Manager estimates effort; executor reports rework and waiting | Ask for the same time window and the smallest comparable record |
| System owner says everything is recorded; staff use chat or spreadsheets | Ask both for one traceable case from trigger to closure |

Record the roles, competing claims, mirrored questions and minimum resolving evidence. The plan must not decide which claim is true; resolution belongs to later workflow mapping and material analysis.

## 6. Decision-changing questions

Every critical question must state what decision it can change. Remove questions whose answer would not alter scope, evidence status, route, feasibility or pilot.

### Recent concrete event

> 请回忆最近一次实际发生的这类工作，从你收到什么开始，按时间顺序说到结果被谁使用或确认。

Then adapt across relevant dimensions:

- trigger and input;
- actual steps and tools;
- decision conditions and authority;
- handoff, acceptance, waiting and timeout;
- exception, failure, escalation and recovery;
- frequency, active time, waiting, rework and consequence;
- evidence, records and system boundaries.

Do not ask one role to answer another role's authority. Record the owner to ask next.

## 7. Vague-answer follow-up

| Signal | Follow-up |
|---|---|
| “一般/通常/有时候” | 哪个具体条件会让处理方式不同？最近一次是哪种？ |
| “看情况” | 实际看哪些字段、金额、类型、时间或风险？谁定的？ |
| “系统会处理” | 哪个系统收到什么，产生什么；失败时谁知道？ |
| “领导批准” | 哪个角色、什么阈值、如何留下批准证据？ |
| “已经交给他了” | 什么动作代表正式接管；未接管多久升级？ |
| “我们都知道” | 口径写在哪里，谁维护，最近何时变化？ |
| 数量/耗时/损失估计 | 哪个记录或最小样本可以验证？ |
| 未来目标当现状 | 这是目标、制度还是已经运行的事实？ |

Follow only the triggered branch. Do not turn the interview into an accusation or display internal suspicion to the employee.

## 8. Minimum evidence

Request only evidence that can change a decision. For every request record:

- the claim or question it verifies;
- smallest useful sample and time range;
- enterprise owner who can authorize/provide it;
- permitted format and desensitization;
- what happens if it is unavailable.

Examples: five recent approvals instead of all finance records; one month of linkable exports instead of permanent system access; an interface document or sandbox proof instead of an oral claim that an API exists.

## 9. Facilitation and consent

- Explain the purpose in business language and state that this is not employee performance evaluation.
- Ask permission before recording or collecting screenshots/files.
- Let participants refuse, correct or clarify their statements.
- Separate participant statements from policy and system evidence.
- Do not expose internal opportunity ranking or sales tactics to employee participants.

## 10. Do-not-promise

During discovery do not promise:

- a named technology, Agent, RPA or model will be used;
- an existing system has an API or can be written back;
- a percentage of automation, headcount reduction, cost saving or ROI;
- a delivery date before access, scope and acceptance are confirmed;
- that employee statements are already enterprise facts;
- autonomous approval, payment, compensation, high-risk decisions or customer commitments.

## 11. Stop conditions

Mark the plan blocked or partial when the process boundary is unknown, contradictory scope claims cannot be separated, available time cannot cover critical P0 lenses, no authorized participant can speak to a critical role, recording/material consent is absent, the user demands a predetermined technology conclusion, or the visit cannot obtain evidence needed for the stated decision.
