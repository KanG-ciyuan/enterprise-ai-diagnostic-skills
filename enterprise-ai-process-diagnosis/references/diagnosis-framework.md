# Diagnosis Framework

## 1. Demand Reality Gate

Check these dimensions before discussing tools:

| Dimension | Diagnostic question | Warning signal |
|---|---|---|
| Actor | Who performs and who consumes the process? | Only a sponsor describes it; no operator is identified |
| Trigger | What event starts it? | Trigger varies or is undefined |
| Frequency | How often does it occur? | Rare event with low consequence |
| Current cost | What time, error, delay, or risk exists? | No measurable pain or baseline |
| Workaround | How is it handled today? | Existing low-cost method already works well |
| Stability | Are main steps and exceptions understood? | Every case requires unrelated judgment |
| Data | Do representative, authorized samples exist? | Data is missing, inaccessible, sensitive, or inconsistent |
| Owner | Who owns rules, acceptance, and maintenance? | Nobody can approve rules or maintain the result |
| Outcome | What result changes if this works? | Success is merely "we used AI" |

Do not automate a broken or politically unresolved process. Recommend process clarification when roles, rules, or ownership are the main failure.

## 2. Minimum-Sufficient Route

Choose by responsibility, not novelty.

| Route | Use when | Do not use as default when |
|---|---|---|
| Process redesign | Roles, handoffs, inputs, or decisions are unclear | The current process is stable and the problem is execution cost |
| Deterministic rules | Conditions and results must be explainable and repeatable | Meaning depends on ambiguous language or context |
| Official API | Systems expose supported interfaces | Access is unavailable or prohibited |
| Workflow | Steps, branches, state, and retries can be predefined | The next action cannot be bounded in advance |
| RPA | Authorized browser/desktop work lacks a usable API | A supported API or simpler import exists |
| AI workflow | Text understanding, classification, summarization, extraction, or drafting is needed inside a known sequence | Deterministic rules already establish the answer |
| RAG | Answers require retrieval from an authoritative, maintained corpus | The source is tiny, static, or can be handled by direct lookup |
| Bounded Agent | The next step requires limited dynamic judgment and tool choice within explicit permissions | A deterministic workflow can do the job |
| Human | Decision involves high consequence, trust, ethics, approval, payment, or customer commitment | The work is low-risk and fully deterministic |

Responsibility invariant:

```text
Workflow owns sequence and state.
Rules own deterministic checks.
AI owns understanding, classification, summarization, and drafting.
Agent owns bounded dynamic judgment and limited tool selection.
Humans own high-risk decisions and final responsibility.
```

Prefer official API, then authorized structured access, then UI RPA. Preserve a non-AI path when AI is unavailable and deterministic work can continue.

## 3. Tool Recommendation Gate

Do not name a product until these are sufficiently known:

- existing systems and licensed tools
- API, webhook, database, file, or UI access
- local, cloud, or private deployment requirement
- data classification and privacy boundary
- budget and expected operating cost
- team skill and maintenance owner
- required reliability, logging, retry, and audit behavior

When naming a product, state:

1. why it fits;
2. prerequisites;
3. material limitations;
4. maintenance owner and operating burden;
5. at least one alternative;
6. unverified conditions.

## 4. Technical Feasibility Gate

Business value and technical readiness are separate judgments. A real need can still be blocked from integration.

| State | Meaning | Allowed output |
|---|---|---|
| 可开发 | required rule, data, access, owner, security boundary, and acceptance evidence are confirmed | component-level implementation or controlled PoC plan |
| 有条件 | design is plausible, but named prerequisites remain unverified | conditional architecture plus the smallest evidence request |
| 阻塞 | a required rule, interface, permission, owner, or safety condition is absent | no implementation commitment; state the blocker and alternative observation path |

Apply the state to every component, not just the project as a whole. Integration confidence cannot exceed the supporting system/interface evidence.

Compare at least two viable access branches when the route is undecided. Do not use a numerical average to conceal a blocking condition.

## 5. 3-7 Day Shadow Pilot

A valid pilot contains:

- one bounded actor and one concrete process
- one end-to-end normal path
- at least one realistic exception path
- desensitized representative samples
- human review and takeover
- no production write-back or external action
- old-process baseline
- measurable output comparison
- pass, observe, and stop criteria
- explicit in-scope and out-of-scope items
- rollback to the original process

Select metrics based on the job:

- time: elapsed time, waiting time, active human time
- quality: error, omission, rework, consistency
- cost: labor, API/model, software, maintenance
- stability: completion, exception detection, takeover success
- business: response, conversion, payment, compliance only when measurable in the pilot window

Do not use a universal accuracy threshold. Risk determines the required standard. Internal drafting and customer-facing commitments require different evidence.
