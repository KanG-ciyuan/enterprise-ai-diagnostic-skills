# 企业 AI 流程诊断 Skills

[English](README.md) | 简体中文

[![Status: Prototype](https://img.shields.io/badge/status-prototype-lightgrey.svg)](#状态)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**在决定让 AI 自动化什么之前，先弄清企业真实业务究竟如何运行。**

本仓库是一组 Agent 指令包（Skill），用于完成一次边界清晰的企业流程诊断：管理层发现、员工工作摸排、授权材料分析、证据门诊断、3–7 天影子试点设计，以及人工决策门。它面向转型顾问与企业项目负责人——他们必须判断 AI 在哪里值得做、在哪里不值得做，以及哪些环节必须先改流程而不是先上模型。

每一项结论都带证据等级。没有证据，流程不往前走。

> ### AI 能把信息解释得很连贯，但“连贯”本身不是证据。
>
> 一份通顺、结构漂亮的诊断，是最容易产出、也最难核验的产物。本体系拒绝把它当成结论：任何实质性主张都必须引用材料编号和定位，必须带证据等级，并且必须与模型推断保持可区分——模型推断标记为 `E5`，打上 `AI假设，待验证`，缺少该标签会被校验器直接拒绝。
>
> 这份 README 也适用同一条规则。仓库没有证据的地方，本文就写没有证据。

---

## 为什么企业 AI 项目在模型上场之前就已经失败

等到团队开始争论模型、检索、Agent 或供应商时，真正决定成败的那些判断往往已经做错了。仓库自己的定位是：目标**不是**让 AI 替企业作出高风险决定，而是把流程事实、证据缺口、岗位边界和下一步行动整理清楚。

这套方法针对的典型失败模式：

| 失败模式 | 为什么会毁掉项目 | 本体系的处理方式 |
| --- | --- | --- |
| 范围来自组织架构图，而不是来自工作本身 | 分析单元是一个部门，于是根本不存在带触发条件、结束状态和决策点的流程 | 按触发、起点、终点和决策点切成有边界的摸排切片；规划之前必须先选定切片 |
| 把制度当成实际做法 | SOP 描述的是应有规则，不是任何人的真实操作 | SOP 归为 `E4`，只支持应有规则，永远不能证明实际合规或执行频次 |
| 一个大声音的说法变成企业事实 | 管理者的总结被反复转述，最后看起来像文档 | 单一口述是 `E3`，只支持“该人如此陈述”，不支持全企业事实或可测量数值 |
| 冲突被“平均”掉 | 两份互不相容的说法，按职级高低或文件正式程度来裁决 | 冲突被保留并分类；只有新证据才能解决，文件更正式不算证据 |
| 结论跑在证据前面 | 需求、数据、归属和权限都还没确认，路线已经定了 | 业务价值与技术就绪度分开判断；无论需求多真实，组件都可以是 `阻塞` |
| 流程没修就先选 AI | 把一条坏掉的交接按机器速度放大 | 责任分配优先考虑流程改造与确定性规则；`先改造原业务流程` 和 `不需要AI，采用普通数字化或自动化方案` 都是一等结论 |
| 让模型承担风险 | 一条生成的建议被当成决定执行 | 由具名的人类角色决定；Agent 必须停在门上，而不是继续往下走 |

---

## 传统诊断 vs 证据门诊断

左列描述的是本仓库针对性设计的做法，是这套方法赖以成立的对照面，不是对任何具体项目的调研统计。

| | 传统 AI 诊断 | 本仓库的证据门诊断 |
| --- | --- | --- |
| 起点 | 组织架构图、干系人访谈、已选定的方案 | 一条有边界的流程，以及它必须支撑的那个决策 |
| 什么算事实 | 职级最高或表达最流畅的那一方说了什么 | 带来源定位和证据等级（`E1`–`E5`）的主张 |
| 正式文件 | 当作“工作如何发生”的证明 | `E4`——只支持应有规则，不支持执行情况 |
| 模型输出 | 直接当成分析结论 | `E5`——待验证的线索，带标签且受机器校验 |
| 冲突 | 按偏好、职级或排版格式裁决 | 保留并分类；只有新证据能解决 |
| 不可读/缺失材料 | 静默跳过 | 记录在案，并给出指明责任人的最小补证请求 |
| 技术路线 | 项目开始时就整体选定 | 逐个组件判定 `可开发` / `有条件` / `阻塞` |
| 试点 | 承诺直接上线 | 离线影子试点设计，含通过/观察/停止条件与回滚 |
| 交付权限 | 交付物给出建议，然后项目继续推进 | Agent 只提建议；由人类角色决定 |

---

## 工作方式

```text
创建诊断项目
  -> 管理层启动访谈
  -> 确定角色、流程范围和 P0 必访对象
  -> Agent 逐个摸排一线员工，一次一项工作
  -> 员工确认本人的流程卡
  -> 任意阶段上传的授权材料进入材料分析
  -> 检查证据覆盖、版本和冲突
  -> 达到诊断门后进入流程诊断
  -> 设计 3-7 天影子试点
  -> 企业负责人批准、暂停，或要求补充证据
```

这不是一条必须从头跑到尾的固定流水线。总控针对总档案对每个事件做出路由：摸排过程中上传的附件可以先进入材料分析；证据不足则把项目退回补证状态；授权撤回、来源不明或未处置的高风险冲突则强制暂停。

路由器是真实代码，不是文字说明。[`enterprise-ai-diagnostic-orchestrator/scripts/orchestrate_event.py`](enterprise-ai-diagnostic-orchestrator/scripts/orchestrate_event.py) 把 4 类事件映射到 4 个出口：

| 事件 | 目标 Skill | 原因码 |
| --- | --- | --- |
| `management_problem_submitted` | `enterprise-interview-preparation` | `MANAGEMENT_SCOPE_DISCOVERY` |
| `participant_task_started` | `enterprise-workflow-mapping` | `EMPLOYEE_MAPPING_TASK_READY` |
| `file_uploaded` | `enterprise-material-analysis` | `AUTHORIZED_FILE_EVENT` |
| `diagnosis_gate_ready` | `enterprise-ai-process-diagnosis` | `DIAGNOSIS_GATE_CONFIRMED` |

针对每个事件，总控只选一个决定——`invoke_skill`、`wait_external`、`request_human`、`pause` 或 `no_action`——最多只调用一个主 Skill，并且始终返回 `"write_authority": "scheduling_proposal"`。提案不等于写入：总控不能改写总档案、不能修改源材料、不能关闭 H2、不能自我批准诊断，也不能承诺 ROI。

---

## 核心能力

| 能力 | 实际做什么 |
| --- | --- |
| **管理层发现 Management Discovery** | 为一条有边界的流程产出能改变决策的访谈计划：范围、角色覆盖矩阵、分角色问题清单、追问触发条件、最小补证请求、覆盖缺口和面向客户的无承诺清单。它负责策划访谈，不负责执行访谈 |
| **员工工作摸排 Employee Workflow Mapping** | 通过自适应访谈摸排一名员工的一项具体重复性工作，一次只问一个问题，产出（a）紧凑的 Mermaid 流程图、（b）人类可读的流程卡、（c）可移植记录。员工未明确确认之前，流程卡不算定稿 |
| **授权材料分析 Authorized Material Analysis** | 只读取范围内已授权材料，产出材料清单、原子证据账本、主张到来源与流程节点的映射、一致与冲突登记、覆盖与不可读材料缺口，以及按优先级排序的最小补证请求。原始材料保持不变，冲突不自行裁决 |
| **证据门诊断 Evidence-Gated Diagnosis** | 消费证据契约，把支持与冲突的主张编号映射到流程节点，评估需求真实性，发现系统与接口条件，并给出带置信度、关键风险和“哪些新证据会改变结论”的早期诊断 |
| **AI 机会与边界 AI Opportunity / Boundary** | 在流程改造、确定性规则、官方 API、工作流、RPA、AI 工作流、RAG、受限 Agent 和人工确认之间分配责任——选择*最小充分*组合，记录被否决的路线，并写明 AI 不得介入的位置 |
| **3–7 天影子试点 3–7 Day Shadow Pilot** | 设计离线影子试点：脱敏样本、一条正常路径和一条真实异常路径、人工接管、原流程基线、可测量的输出对比、通过/观察/停止条件、明确的范围内外事项，以及回滚到原流程 |
| **人工决策门 Human Decision Gate** | `A0`/`A1`/`H1`/`H2`/`S0` 门定义了 Agent 必须停下、由人行动的位置。Agent 只能提建议，不能批准、发布、通知、付款或作出承诺 |

---

## 专业 Skill 构成

诊断链路路由到 **四个专业 Skill 加一个总控**。这一点由仓库自身契约说明——`enterprise-ai-diagnostic-orchestrator/README.md` 的小标题就是 `## 四个专业出口`，`manifest.json` 也正好声明了 4 个 `upstream_skills`。本文档此前的版本把仓库描述为“五个核心 Skill”，那是把 `SKILL.md` 包的数量当成了专业 Skill 数量；第五个包正是总控本身。

| 包 | 角色 | 版本 | maturity_tier |
| --- | --- | --- | --- |
| [`enterprise-interview-preparation`](enterprise-interview-preparation/) | 专业 Skill——管理层发现与访谈策划 | `0.2.0` | `production-candidate` |
| [`enterprise-workflow-mapping`](enterprise-workflow-mapping/) | 专业 Skill——一名员工、一项工作、员工确认流程卡 | `0.1.1` | `scaffold` |
| [`enterprise-material-analysis`](enterprise-material-analysis/) | 专业 Skill——授权材料分析与证据包 | `0.1.0` | `production-candidate` |
| [`enterprise-ai-process-diagnosis`](enterprise-ai-process-diagnosis/) | 专业 Skill——业务诊断、条件式技术方案、影子试点设计 | `0.2.0` | `production-candidate` |
| [`enterprise-ai-diagnostic-orchestrator`](enterprise-ai-diagnostic-orchestrator/) | 总控——只做路由，也是唯一带可运行代码的包 | `0.1.0` | `production-candidate` |
| [`enterprise-ai-diagnostic-master-record`](enterprise-ai-diagnostic-master-record/) | 共享档案契约——**不是 Skill**：有 `README.md`，但没有 `SKILL.md`，也没有 `manifest.json` | 契约 `v0.1` / `v0.2` | — |

关于这张表有两点必须如实说明。`maturity_tier` 是仓库自己声明的字段，不是评估结论——`enterprise-workflow-mapping` 声明为 `scaffold`，另外四个声明为 `production-candidate`；同时每个包的 `manifest.json` 都声明 `"status": "personal-experiment"` 和 `"publication": "local-only"`。各包版本相互独立，仓库没有统一的版本号。

每个包自带 `references/`、`templates/`、`evals/`、`reports/` 和 `tests/`，`SKILL.md` 是执行入口。只拷贝单个 `SKILL.md`、脱离其所在包使用，不在支持范围内。

---

## 证据门诊断

整套方法只有一个理念，并且贯穿始终：**把“观察到的”“某人说的”“文件写着的”“模型生成的”分开——并且绝不让低等级证据去回答高等级证据才能回答的问题。**

权威定义位于 [`enterprise-material-analysis/references/evidence-model.md`](enterprise-material-analysis/references/evidence-model.md)：

| 等级 | 来源 | 能支持 | 不能自动支持 |
| --- | --- | --- | --- |
| `E1` | 观察到的操作、系统记录、执行日志，或具代表性的真实/脱敏样本 | 所观察条目和时段内的流程事实 | 全部案例、因果解释、员工意图或 ROI |
| `E2` | 实质独立的角色或来源对同一具体主张的相互印证 | 已被印证的说法 | 实际运行执行——除非其中一个来源是 `E1` |
| `E3` | 一名员工、管理者、客户或供应商的陈述 | 该人报告的内容 | 全企业事实或可测量数值 |
| `E4` | SOP、制度、表单、规格书或应有流程 | 应有规则、设计或规定流程 | 实际合规或执行频次 |
| `E5` | 模型推断或分析假设 | 待验证的线索 | 事实、冲突结论或对外主张 |

独立性规则是定义的一部分：*同一场会议的两份拷贝文件，或者一名管理者复述员工的说法，都不构成独立印证。* 来源血缘会被记录，只有当支持角色或来源出处实质独立时，主张才升级为 `E2`。

### 它由代码强制执行，而不只是文字约定

- `enterprise-ai-diagnostic-master-record/schema/master-record-v0.2.schema.json` 把 `evidenceLevel` 限制为枚举 `["E1","E2","E3","E4","E5"]`。
- [`enterprise-ai-diagnostic-master-record/scripts/validate_master_record.py`](enterprise-ai-diagnostic-master-record/scripts/validate_master_record.py) 定义 `EVIDENCE_LEVELS = {"E1", "E2", "E3", "E4", "E5"}`；当 `E5` 记录未带标签 `AI假设，待验证` 时输出 `E5_LABEL_MISSING`。
- `tests/test_master_record.py` 断言该拒绝行为；`tests/test_routing_contract_v02.py` 抛出 `ValueError("E5 must remain visibly labelled")`。
- 离线模拟运行器给每条产出的记录打上 `"evidence_level": "E5"`，并有测试断言这一点。

路由契约直接写明运行规则：`E5` 内容必须标记为 `AI假设，待验证`，不得混入 `E1`/`E2` 事实段落，也不得在管理层视图中去掉等级；诊断可以依据 `E5` 提出验证建议，但不得只依据 `E5` 形成确定结论。

### 这个模型**不是**什么

`E1`–`E5` 模型真实存在且由代码强制，但它**并未在每一个包中统一实现**，本文不会掩饰这一点：

- 仓库内多处对该模型有措辞不完全一致的复述。上表是权威来源；树中其他位置的差异表述应视为术语漂移。
- `enterprise-interview-preparation` 中 **完全没有** `E1`–`E5` 引用。链路中有一个包并不使用该模型。
- `enterprise-ai-diagnostic-orchestrator/SKILL.md` 从未定义这些等级；该包中字符串 `E5` 只出现在模拟脚本和测试里。
- 只有 JSON 记录层受到机器强制。Markdown 产物仅受指令约束，没有校验器。

---

## 你会得到什么

下列每一项都由仓库中真实存在的模板、Schema 或代码路径定义。

| 交付物 | 定义位置 | 形态 |
| --- | --- | --- |
| **访谈计划**（`enterprise_interview_plan`） | [`enterprise-interview-preparation/templates/interview-plan.md`](enterprise-interview-preparation/templates/interview-plan.md) + JSON Schema | 模板 + Schema，由遵循 `SKILL.md` 的模型填写 |
| **员工流程卡**（员工确认版） | [`enterprise-workflow-mapping/templates/workflow-card.md`](enterprise-workflow-mapping/templates/workflow-card.md) + JSON Schema | 模板 + Schema；必须经员工明确确认才算定稿 |
| **原子证据账本** | [`enterprise-material-analysis/templates/evidence-pack.md`](enterprise-material-analysis/templates/evidence-pack.md)；行字段由证据模型定义 | 主张编号、原样主张、材料编号与定位、来源角色/系统与日期、证据等级、流程节点、状态、适用范围限制、敏感数据注记、相关或冲突主张编号 |
| **冲突登记** | `evidence-pack.schema.json` 要求 `conflicts` 字段；冲突分类在证据模型中 | 七类冲突：`factual`、`definition`、`time`、`policy-practice`、`scope`、`handoff`、`measurement`——保留而不静默消解 |
| **证据缺口与最小补证请求** | `evidence-pack.schema.json` 要求 `coverage` 与 `evidence_requests`；总档案承载 `outstanding_gaps` | 覆盖缺口、不可读材料缺口，以及按优先级排序、写明需要什么、向谁要、为什么、最小范围的请求 |
| **AI / Agent 边界方案** | [`enterprise-ai-process-diagnosis/templates/conditional-technical-plan.md`](enterprise-ai-process-diagnosis/templates/conditional-technical-plan.md) | 责任分配、被否决路线、逐组件 `可开发` / `有条件` / `阻塞` 状态，以及必须人工确认的点 |
| **影子试点方案（3–7 天设计）** | [`enterprise-ai-process-diagnosis/SKILL.md`](enterprise-ai-process-diagnosis/SKILL.md)、[诊断框架](enterprise-ai-process-diagnosis/references/diagnosis-framework.md) | 一套设计好的离线试点：基线、异常、人工接管、通过/观察/停止条件和回滚 |
| **管理层诊断交付物** | 两份对齐的输出：内部诊断与客户沟通版 | 共享事实与风险；客户版略去内部策略话术，但绝不略去实质性不确定 |

**配套记录。** 总档案 Schema 与校验器（[`enterprise-ai-diagnostic-master-record`](enterprise-ai-diagnostic-master-record/)）保存项目身份、状态、记录索引、版本、授权和上游引用——它不存放大段访谈正文或附件本体。子 Skill 输出的是 `registration proposal`（登记提案），不直接写总档案。总控输出 `scheduling_proposal`。离线运行时模拟输出 `runtime-log.jsonl`、`summary.json` 和 `final-master-record.json`。

**展示类产物。** [`deliverables/management-diagnostic-report-v0.1/index.html`](deliverables/management-diagnostic-report-v0.1/index.html) 是一份真实的交互式 HTML 报告（215 行 HTML、14.9 KB CSS、2.9 KB JS，支持键盘 Tab 导航、`IntersectionObserver` 与打印），但内容建立在固定的 `E5` 模拟数据之上——它不连接总档案、数据库、任务队列、OA 或 CRM。四个 `design/*.png` 是设计视觉稿，不是截图。[`deliverables/enterprise-ai-platform-v0.1/`](deliverables/enterprise-ai-platform-v0.1/) 是一份商业拓展提案——由 HTML 打印而成的 5 页 PDF 加 5 页 PPTX——不是诊断交付物；它自己的第 4 页写明：核心方法仅通过模拟案例和本地测试验证，尚不能宣称真实企业收益、生产可用、跨平台兼容或已有付费客户。

---

## 人 / 规则 / Agent 的边界

责任划分是明确声明的，不是默认暗示的：

```text
Workflow owns sequence and state.
Rules own deterministic checks.
AI owns understanding, classification, summarization, and drafting.
Agent owns bounded dynamic judgment and limited tool selection.
Humans own high-risk decisions and final responsibility.
```

**谁能看到什么。** 企业负责人看到流程范围、关键断点、岗位边界、证据缺口、推荐路线和待批准事项。一线员工只看到与本人工作摸排和确认有关的内容，不接收岗位调整、降本评价等受限管理信息。这里有一条明确的信息隔离：受限管理上下文可以帮助总控确定审核人，但不得出现在员工提问中，也不得写入该员工本人的流程卡。

**Agent 不能做什么。** 总控不得改写总档案、不得修改源材料、不得关闭 `H2` 门、不得自我批准诊断，也不得承诺 ROI。诊断 Skill 绝不实施、发布、写回、通知外部人员、批准、付款或作出客户承诺。Skill 默认只生成建议、记录和登记提案——它们不联系员工、不发送消息、不修改业务系统、不执行生产操作。

**门是什么。** `A0`/`A1` 可以在当前对话内解决。`H1`、`H2` 和 `S0` 需要独立的有界任务或停止行为。关闭 `H2` 必须生成独立的组织确认记录，包含确认人权限依据、采用的执行口径、适用范围、生效时间、来源证据和受影响记录。授权撤回不是一句备注——它会传播：材料 → 证据包 → 诊断 → 管理层视图，各自进入失效、待重算、撤回发布的状态。

---

## CRM 案例研究

> ## Synthetic / `E5` — 仅用于方法验证
>
> 整个案例研究都是用于验证方法与路由的合成 `E5` 模拟。它**不是**真实企业，**不是**脱敏客户，也**不是**任何已记录的结果。

[`simulations/business-operations-crm-authorization/`](simulations/business-operations-crm-authorization/) 是一条 CRM 客户归属交接流程的端到端走查，共 43 个编号文件，另含 `runtime-simulation/` 中可运行的离线控制夹具，以及 `synthetic-inputs/` 中 5 份合成上传材料。它覆盖管理层启动、销售申请人/销售负责人/业务运营负责人/CRM 管理员的岗位摸排、Excel 名单与 OA 审批与 CRM 变更之间的断点、证据门、流程诊断、离线影子试点，以及等待补证状态。

标签是明确且反复出现的：

- [`synthetic-inputs/README.md`](simulations/business-operations-crm-authorization/synthetic-inputs/README.md) —— `证据等级：E5 AI模拟，待真实企业验证。` 以及 `所有企业、员工、客户、编号和时间均为虚构，不对应任何真实主体。`
- [`40-synthetic-test-matrix.json`](simulations/business-operations-crm-authorization/40-synthetic-test-matrix.json) —— `"evidence_level": "E5"`、`"evidence_label": "AI模拟，待真实企业验证"`、`"simulation_only": true`，共 14 个场景（6 个路由用例 + 8 个业务控制用例）。
- 所有编号都带 `SIM` 或 `SYN` 标记：`ENT-SIM-RTL`、`PRJ-SIM-CRM-OWNER-TRANSFER-001`、`MASTER-SIM-RTL-001`、`SHADOW-SYN-CRM-001`。
- [`36-real-evidence-intake-checklist.md`](simulations/business-operations-crm-authorization/36-real-evidence-intake-checklist.md) 的存在，正是为了列出真实项目仍需要的脱敏证据。

### 影子试点：有设计，从未执行

3–7 天影子试点是一份**真实的设计规范**（`Design a 3-7 day shadow pilot: use desensitized samples, one normal path, one exception, human takeover, baseline, pass/observe/stop criteria, and rollback.`）。**从未运行过任何真实试点。** 唯一的执行记录是一次单场次加速模拟：

> `试点性质：E5 AI模拟，待真实企业验证。本记录使用现有合成XLSX、CSV和文字材料完成一次加速模拟。它不代表真实企业运行结果，不连接、不读取、不写入生产OA/CRM，不通知任何外部人员，也不形成生产实施授权。`

该记录自己也封住了结论口径：8 类目标场景中，6 类有行级样本，2 类只完成规则级检查，因此不能把这一轮写成“8 类全部通过”。

还有一处不一致值得直说，而不是抹平。`outputs/crm-shadow-pilot-20260816/crm-shadow-pilot-result.xlsx` 是一份含 7 个工作表的已提交 XLSX，但**仓库中不存在生成它的脚本**——它声明的结果指纹无法从当前代码树重新计算。

天数口径此前并不统一：一份受阻路径文档写 `3-5天`，但它自己的表格跑满五天；规范写的是 `3-7 day`；而具体产物都是 5 天运行。该离群值已修正为 `3-7天` 以对齐规范，5 天产物仍落在该区间内。处理过程记录在 [`CHANGELOG.md`](CHANGELOG.md)。

[`simulations/manufacturing-emergency-procurement/`](simulations/manufacturing-emergency-procurement/) 和 [`simulations/retail-complaint-refund/`](simulations/retail-complaint-refund/) 是两个规模更小的模拟，同样是合成数据。

---

## 适合谁

**适合你，如果**

- 你是转型顾问或实施方，需要为一条有边界的企业流程产出经得起追问的诊断；
- 你是企业项目负责人，需要知道哪些环节有证据、哪些是假设，以及自动化要成立还必须满足什么前提；
- 你希望一套方法能把 `先改造原业务流程`、`现阶段不建议实施` 或 `不需要AI，采用普通数字化或自动化方案` 当作正当结论输出；
- 你正在 Agent 平台上搭建能力，想要边界明确、输出有类型的 Skill 包，而不是一个永远说“可以做”的提示词。

**不适合你，如果**

- 你想要工具或供应商推荐、ROI 数字或节省估算——本方法在缺少证据时明确拒绝产出这些；
- 你希望由模型来决定是否推进，或者由模型批准、发布、执行；
- 你需要调度器、数据库、统一入口或运行时服务——这里一个都没有；
- 你想要企业级部署或生产系统集成。

---

## 这不是什么

这一节是刻意写的。诚实是本仓库最主要的资产，夸大它等于毁掉被记录的东西本身。

- **不是真实企业部署。** 代码树中不存在任何真实企业记录。所有企业编号都带 `SIM` 或 `SYN` 标记。
- **没有真实客户结果。** 没有测量过任何 ROI、效率提升、成本节约、质量改善、准确率或采用率数据，因为从未发生过真实项目。
- **没有独立或 provider 支持的验证。** 仓库自己的产物记录 `"provider_backed": false`：*"The output was reviewed in the creating Codex task, not generated by an independent provider run."* 一份运行时案例记录也直说独立运行仍是 `missing evidence`。
- **没有执行过影子试点。** 只存在一次合成的、加速的、单场次模拟。没有连接过任何生产 OA 或 CRM。
- **CI 会跑，但它只证明仓库与自身一致。** `.github/workflows/local-checks.yml` 在每次 push 和 pull request 时通过 `scripts/run_local_checks.sh` 运行八个套件与来源守卫。它能抓住漂移和过期断言；它不验证方法论，也不调用任何模型。
- **有 tag，但不是包发布。** 仓库有 `CHANGELOG.md` 和一个 `v0.1.0` 快照 tag，标记一组一致且通过全部校验的包。仍然没有可安装的包，也没有可依赖的已发布版本：各包版本相互独立，该 tag 不覆盖任何包自己声明的 `status` 或 `publication`。
- **不跨平台。** 五个 `manifest.json` 全部声明 `"target_platforms": ["codex"]`，总控对 `openai` 的适配声明是 *"local deterministic routing tests only; cross-Agent runtime pending"*。
- **不是生产可用。** 每个 manifest 都声明 `"status": "personal-experiment"` 和 `"publication": "local-only"`。
- **不是运行时系统。** 没有数据库、没有统一入口、没有任务队列、没有调度器、没有 Web 服务。唯一可执行的逻辑是一个确定性路由器、一个离线模拟运行器、四个校验器和根级来源守卫。
- **不能替代人。** 它不会自主访谈员工、不会联系任何人、不会发送消息、不会修改业务系统、不会作出承诺。

---

## 验证状态

### 实际执行了什么

8 个 `unittest` 测试套件加一个来源守卫，全部在仓库根目录用 Python 标准库执行。**131 个测试，全部通过。**

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

不使用也不要求 `pytest`；所有套件都跑在标准库 `unittest` 上。`scripts/run_local_checks.sh` 用一条命令跑完全部八个套件与守卫，并在任何失败时以非零退出；CI 调用的就是这个脚本，因此本地与 CI 不会漂移。

扩展验证，全部通过：

<details>
<summary>路由器、离线模拟器与总档案校验器</summary>

路由器会产出真实的调度提案。示例（使用已提交的合成总档案）：

```bash
python3 enterprise-ai-diagnostic-orchestrator/scripts/orchestrate_event.py \
  enterprise-ai-diagnostic-master-record/examples/retail-complaint-master-record-v0.2.json \
  enterprise-ai-diagnostic-orchestrator/examples/events/management-problem.json
```

返回 `"decision": "invoke_skill"`、`"target": "enterprise-interview-preparation"`、`"reason_codes": ["MANAGEMENT_SCOPE_DISCOVERY"]` 和 `"write_authority": "scheduling_proposal"`。

离线运行时模拟会重放一个场景，并把 `runtime-log.jsonl`、`summary.json`、`final-master-record.json` 写入一个**新建**输出目录——若目录已存在，它会以 `OUTPUT_DIRECTORY_EXISTS` 拒绝覆盖：

```bash
python3 enterprise-ai-diagnostic-orchestrator/scripts/run_offline_simulation.py \
  simulations/business-operations-crm-authorization/runtime-simulation/master-record.json \
  simulations/business-operations-crm-authorization/runtime-simulation/scenario.json \
  /tmp/shadow-sim-out          # must not already exist
```

它打印 `{"scenario_id": "SIM-RUNTIME-CRM-AUTH-001", "result": "completed"}`，并写出一份带 `"evidence_level": "E5"`、`"simulation_only": true`、`"production_write": false`、`"event_count": 7` 的摘要，最终阶段停留在 `evidence_completion`，因为场景仍在等待真实授权材料和真实员工确认。

总档案校验器在两份已提交示例、三份登记提案、有序交接链，以及全部 6 份总控输出示例上都返回 `valid`。总控输出校验器每次只接受一个文件：

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

### 测试证明了什么，没证明什么

测试确实在跑真实机制：13 个路由器测试断言跨企业输入、授权撤回、未知来源、过早诊断和非负责人恢复等情形下的决定、目标与原因码；另有一个防漂移测试会重跑路由器并与全部 6 份已保存输出逐字段比对。总档案校验器用刻意构造的变异用例驱动。离线运行器被端到端执行。已提交的 XLSX 被当作真实 ZIP 打开，并断言其 7 个工作表名称。

它们**不**验证方法本身。131 个测试中的绝大多数是对 Markdown 的字符串包含断言——句子在就通过，改写就失败。**这个仓库里没有任何测试跑过真实模型。** 触发评估是对录制提示词做关键词概念打分，既不是激活测试，也不是模型评分的评测。这里所有测试验证的都是“仓库与自身一致”，从不是“对真实企业有效”。

### 仓库自己的工具记录为失败的地方

两份已提交的本地发布检查——`enterprise-material-analysis/reports/local-release-check.json` 和 `enterprise-ai-process-diagnosis/reports/local-release-check.json`——都报告 `"ok": false`，摘要为 `{"pass": 3, "warn": 3, "block": 3}`。被阻塞的门是 `package_validation`、`git_diff_check` 和 `feature_branch`；警告是 `clean_worktree`、`clean_install` 和 `provider_or_human_output_evidence`。其中最关键的是 provider 或人工输出证据门，而原因就记录在它旁边。

在依赖这棵代码树之前还需要知道：仓库中另外两处内部交叉引用指向无法解析的路径（`docs/superpowers/specs/` 下的一份设计文档，以及一个从错误基准目录解析的 `evals/fixtures/...` 路径）。本文档没有把其中任何一个作为链接引用。

### 本文档的证据分级

| 主张 | 分级 |
| --- | --- |
| 路由器、离线模拟器和四个校验器可以执行，并产出上文所示输出 | `VERIFIED` |
| 8 个套件共 131 个测试通过 | `VERIFIED` |
| `E1`–`E5` 模型存在，并在 Schema、校验器与测试中受到强制 | `VERIFIED` |
| 治理规则是实质性的，且部分受机器强制 | `VERIFIED` |
| CRM 案例研究、两个较小的模拟、总档案示例，以及所有交付物的内容 | `SIMULATED`（`E5`） |
| 3–7 天影子试点作为已执行运行 | **不予主张**——仅有设计；唯一记录是合成加速模拟 |
| 真实企业结果、ROI、试点成效、独立 provider 验证 | `TO_VERIFY`——且仓库自己的产物表明它们尚不存在 |

---

## 状态

以下状态词表取自仓库文件本身：

| 字段 | 声明值 |
| --- | --- |
| `manifest.json` `status`（全部五个包） | `personal-experiment` |
| `manifest.json` `publication`（全部五个包） | `local-only` |
| `manifest.json` `target_platforms`（全部五个包） | `["codex"]` |
| `manifest.json` `maturity_tier` | `production-candidate`（四个包）、`scaffold`（`enterprise-workflow-mapping`） |
| `SKILL.md` `metadata.maturity` | `personal-experiment` |
| git tag / GitHub Releases / `CHANGELOG` | 均无 |

因此上方的徽章写的是 **Prototype**，而不是 Experimental、Production 或 Enterprise Ready。`production-candidate` 是仓库自己的逐包层级标签；它是候选层级，不是生产声明，也不覆盖 `status: personal-experiment` 或 `publication: local-only`。

尽管所有包都声明 `local-only` 发布，仓库实际以 MIT 许可证公开在 GitHub 上。维护者元数据在 manifest、`SKILL.md` 和 `agents/interface.yaml` 中署名 **Kang Jiaxin**；`LICENSE` 中的版权人写的是 **Kang**。本文不统一这两个名字，`LICENSE` 也未被改动。

---

## 安全与治理

本仓库的治理内容是实质性的、部分受机器强制，不是装饰。

**数据范围。** 只处理用户明确授权且纳入当前范围的企业材料。真实 API Key、Token、Cookie 或认证文件内容绝不记录在仓库、回复、文档或日志中。不提交 `.env`、密钥文件、原始个人信息或未脱敏企业数据。代码树中不存在任何 API Key、Token、Cookie、密码、私钥或凭据值，secret 扫描门记录为零发现。

**可复用产物中的隐私。** 可移植产物使用项目代号和匿名标识。不要把客户名称、员工身份、凭据、原始私密转写或敏感业务内容放入可复用 Skill 文件或公开夹具。原始材料保持不变；不可读、被截断、纯图片、受密码保护或损坏的文件予以记录，而不是猜测内容。不要静默扫描无关的聊天、文件、日志、账号或知识库。

**授权撤回。** 授权撤回后，上游材料及其全部派生记录必须进入复核状态，不得继续对外使用。这一点在代码、校验器和测试中都有强制：路由器在撤回时要求 `H2` 人工复核，`test_withdrawn_material_propagates_through_evidence_pack_to_diagnosis` 证明该传播链。输出视图必须使用 `metadata_policy: preserve_source_metadata`——视图可以过滤内容，但不得移除证据等级、`E5` 标签、冲突状态、授权状态或版本溯源。

**反夸大规则。** 缺少必要证据时，不得宣称效率、成本、质量、集成就绪度或业务改善。客户沟通不得隐藏实质性风险或证据缺口，不得把假设变成已确认事实，也不得在无证据时承诺 ROI、准确率、交付或合规。

**署名守卫。** [`scripts/validate_personal_skill_ownership.py`](scripts/validate_personal_skill_ownership.py) 遍历五个包目录中的每个文本文件，若某个包未声明 `owner: Kang Jiaxin`、出现被禁止的署名标记、出现 JSON Schema 方言 URI 之外的外部 URL，或声明了 `upstream_inspiration`，即判定失败。它是一道真实的来源守卫，也是本仓库中前署名只以守卫内部禁用词常量形式出现的原因。它的作用范围限于五个包目录：不扫描根 `README.md`、`docs/`、`simulations/`、`deliverables/`、`outputs/`、`scripts/` 或 `enterprise-ai-diagnostic-master-record/`，因此这些目录之外带 URL 的先行研究报告中招不到它。

**强制的限度。** 受机器强制的部分覆盖 JSON 记录层和路由层。Markdown 产物仅受指令约束——它们没有校验器，这里也没有任何东西测试模型是否真的遵守 `SKILL.md`。

---

## 快速开始

### 环境要求

Python 3，只需标准库——测试、路由器、模拟器和校验器都不引入标准库之外的东西。根目录没有 `package.json`、`pyproject.toml`、`setup.py` 或 `requirements.txt`，因此做验证没有任何依赖需要安装。

### 仓库结构

```text
enterprise-ai-diagnostic-skills/
├── enterprise-interview-preparation/      # 专业 Skill - 管理层发现
├── enterprise-workflow-mapping/           # 专业 Skill - 员工流程卡
├── enterprise-material-analysis/          # 专业 Skill - 证据包
├── enterprise-ai-process-diagnosis/       # 专业 Skill - 诊断 + 影子试点
├── enterprise-ai-diagnostic-orchestrator/ # 总控 Skill - 路由器 + 可运行代码
├── enterprise-ai-diagnostic-master-record/# 共享档案契约（不是 Skill）
├── simulations/                           # 合成端到端案例
├── deliverables/                          # 静态报告与提案产物
├── outputs/                               # 一份已提交 XLSX，无生成脚本
├── docs/                                  # 离线运行时设计说明与计划
└── scripts/                               # 署名/来源守卫
```

### 使用这些 Skill 包

没有已发布的包，没有 `npx` 安装命令，也没有可锁定的发布版本。受支持的方式是把整个包目录复制到你的 Agent 平台读取的 skill 目录中——每个包都声明 `"target_platforms": ["codex"]`，各包自己的 `README.md` 记录了该平台对应的路径。请复制整个目录，不要只复制单个 `SKILL.md`：`references/`、`templates/`、`evals/` 和 `tests/` 都是契约的一部分。

除声明的平台之外，这些包未在任何其他平台上验证过，也不存在跨平台激活证据。

### 运行检查

在仓库根目录，[验证状态](#验证状态)中列出的 8 个套件和守卫就是完整的本地检查。若要复现可执行行为而不只是测试，请使用上方折叠块中的路由器和离线模拟命令；模拟输出请写入一个尚不存在的目录。

---

## Kang 生态

```text
发现 DISCOVER
企业 AI 诊断 Skills
        ↓
定义 DEFINE
Kang Product Architect
Kang Enterprise Process Reviewer
        ↓
构建与协同 BUILD & COORDINATE
Kang Agent Workforce
Kang Agent Collab
Kang Frontend Standard
        ↓
验证 VERIFY
Kang B2B UX Auditor
Kang Product Acceptance Auditor
        ↓
交付 DELIVER
Kang GitHub README
Kang PPT Skill
```

> 这是一张生态地图，不是严格的运行时流水线。各阶段描述的是项目所处的工作位置，
> 而不是强制的执行顺序。

---

## 属于 Kang 开源 AI 体系

本项目是「面向企业 AI 转型、Agent 协作与 AI 原生产品交付的证据驱动体系」的一部分。

| 阶段 | 项目 | 作用 |
| --- | --- | --- |
| DISCOVER 发现 | [enterprise-ai-diagnostic-skills](https://github.com/KanG-ciyuan/enterprise-ai-diagnostic-skills) | 在自动化之前，先弄清企业真实业务如何运行 |
| DEFINE 定义 | [kang-product-architect](https://github.com/KanG-ciyuan/kang-product-architect) | 把模糊需求转化为可实施、可审查的产品契约 |
| DEFINE 定义 | [kang-enterprise-process-reviewer](https://github.com/KanG-ciyuan/kang-enterprise-process-reviewer) | 审查流程是否可执行、可追责、可恢复 |
| BUILD & COORDINATE 构建与协同 | [kang-agent-workforce](https://github.com/KanG-ciyuan/kang-agent-workforce) | 角色化的 Agent 数字员工团队与显式交接 |
| BUILD & COORDINATE 构建与协同 | [kang-agent-collab](https://github.com/KanG-ciyuan/kang-agent-collab) | Agent 协作与交接协议 |
| BUILD & COORDINATE 构建与协同 | [kang-frontend-standard](https://github.com/KanG-ciyuan/kang-frontend-standard) | AI 构建界面的前端质量标准 |
| VERIFY 验证 | [kang-b2b-ux-auditor](https://github.com/KanG-ciyuan/kang-b2b-ux-auditor) | 用户能否真正把工作做完 |
| VERIFY 验证 | [kang-product-acceptance-auditor](https://github.com/KanG-ciyuan/kang-product-acceptance-auditor) | AI 构建产品的独立验收 |
| DELIVER 交付 | [kang-github-readme](https://github.com/KanG-ciyuan/kang-github-readme) | 证据感知的 README 工程 |
| DELIVER 交付 | [kang-ppt-skill](https://github.com/KanG-ciyuan/kang-ppt-skill) | 证据感知的演示文稿设计 |

**横向基础设施：** [kang-meta-skill](https://github.com/KanG-ciyuan/kang-meta-skill) —
Skill 工程化、评估与发布治理。

**早期工作：** [ai-agent-rules](https://github.com/KanG-ciyuan/ai-agent-rules)、
[workflow-five-steps](https://github.com/KanG-ciyuan/workflow-five-steps)、
[renovation-agent](https://github.com/KanG-ciyuan/renovation-agent)。

---

## 开源许可证

本项目采用 [MIT License](LICENSE) 开源。
