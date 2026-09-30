# 企业 AI 流程诊断系统

[English](README.md) | 简体中文

[![本地检查](https://github.com/KanG-ciyuan/enterprise-ai-diagnostic-skills/actions/workflows/local-checks.yml/badge.svg)](https://github.com/KanG-ciyuan/enterprise-ai-diagnostic-skills/actions/workflows/local-checks.yml)
[![版本](https://img.shields.io/github/v/tag/KanG-ciyuan/enterprise-ai-diagnostic-skills?label=version&sort=semver)](CHANGELOG.md)
[![测试](https://img.shields.io/badge/tests-131%20passing-brightgreen)](#验证状态)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**在动手做 AI 之前，先搞清楚业务到底怎么跑。**

这是一套**可运行的系统**，专门做大多数 AI 项目会跳过的那一步：把一条业务流程的实际运行方式查清楚，判定证据支持什么，然后判断哪里该用 AI、哪里不该用、哪里根本不需要 AI。交付形态是五个 Agent Skill 包加一份共享记录契约，另含可运行的路由与校验代码。

![系统架构](assets/architecture.png)

---

## 目录

- [这是什么](#这是什么)
- [为什么需要它](#为什么需要它)
- [快速开始](#快速开始)
- [工作方式](#工作方式)
- [你会得到什么](#你会得到什么)
- [证据分级](#证据分级)
- [人 / 规则 / Agent 的边界](#人--规则--agent-的边界)
- [案例](#案例)
- [状态与限制](#状态与限制)
- [验证状态](#验证状态)
- [安全与治理](#安全与治理)
- [仓库结构](#仓库结构)
- [参与贡献](#参与贡献)
- [开源许可证](#开源许可证)

---

## 这是什么

一套面向企业 AI 落地的诊断系统，以 Agent 指令的形式打包。

它把**一条**企业流程完整跑一遍：

**管理层访谈 → 员工流程摸排 → 授权材料分析 → 证据门诊断 → 影子试点设计 → 人类决策门。**

五个 Skill 包承担这五步，第六个模块承载共享记录契约，总控在它们之间路由。证据分级（`E1`–`E5`）贯穿全程，**任何结论都不能只靠一句断言推进**。

它面向改造方从业者与企业项目负责人 —— 那些必须判断**AI 在哪儿用得上、在哪儿用不上、以及哪儿的流程本身得先改**的人。

> ### AI 生成的流畅，不等于证据。
>
> 一份流畅、结构漂亮的诊断，是最容易生产、也最难核实的产物。这套系统拒绝把它当成结论。每一条实质性主张都必须引用材料编号与位置、标注证据等级，并与模型推断保持可分离 —— 模型推断标记为 `E5`，加注 `AI假设，待验证`，**缺少这个标签会被校验器直接拒绝**。
>
> 同一条规矩也适用于本文档。仓库里没有证据的地方，本文档会明说。

---

## 为什么需要它

在模型上场之前，有两件事已经出问题了。

**数据没准备好。** 企业数据通常笼统、重复、口径对不上。模型再好，喂进去的是浑的，出来的也是浑的。真要落地，往往得先花大力气把脏数据洗成干净数据。

**流程没搞清楚。** 没人说得清一个岗位实际怎么干活。制度写的和手上做的经常是两回事 —— 而项目往往就死在这一点上。

这两个问题都不是换个更好的模型能解决的。它们合在一起，就是 AI 接进去了却没人用的原因。

这套系统针对的失败模式：

| 失败模式 | 为什么会毁掉项目 | 这套系统怎么做 |
| --- | --- | --- |
| 范围取自组织架构，而不是取自工作 | 分析单位是部门，于是没有触发、没有终态、没有决策点 | 按触发、起点、终点和决策切出有界流程；范围必须先选定才能规划 |
| 把制度当成实际做法 | SOP 描述的是预期规则，不是任何人实际怎么干 | SOP 归为 `E4`，只支持"规定如此"，绝不支持"实际照做了"或执行频率 |
| 一个人的说法变成企业事实 | 管理层的总结被反复转述，最后读起来像正式文件 | 单人陈述是 `E3`：只支持**该人所述**，不支持企业级事实或可测数量 |
| 冲突被抹平 | 两份对不上的材料，按职级或"哪份更像正式文件"来裁决 | 冲突被保留并分类；只有新证据才能解决，不是更官方的那份文件 |
| 结论跑在证据前面 | 需求、数据、责任方和访问权限都还没确认，路线已经定了 | 业务价值与技术成熟度分开判断；需求再真实，组件也可以是 `阻塞` |
| 流程没修就先上 AI | 等于把坏掉的交接环节用机器速度放大 | 责任分配优先考虑流程改造与确定性规则；`先改造原业务流程` 和 `不需要AI，采用普通数字化或自动化方案` 是一类正式结论 |
| 让模型承担风险 | 生成的建议被当成决定 | 由**具名的人**决策；Agent 必须在门前停下 |

关于这套方法赖以建立的对照 —— 它针对的做法 vs 证据门诊断，共九个维度 —— 见下方[传统诊断 vs 证据门诊断](#传统诊断-vs-证据门诊断)。

---

## 快速开始

### 环境要求

只要 Python 3 标准库，**无需安装任何依赖**：

```bash
git clone https://github.com/KanG-ciyuan/enterprise-ai-diagnostic-skills.git
cd enterprise-ai-diagnostic-skills
./scripts/run_local_checks.sh
```

预期输出：

```
All local checks passed. Suites: 8, tests: 131.
```

这条脚本会跑八个 `unittest` 套件加来源守卫。CI 调用的是**同一个脚本**，所以本地与 CI 不会漂移。

### 运行单个 Skill

每个包都是自包含的。`SKILL.md` 是执行入口；`references/`、`templates/`、`evals/`、`tests/` 都是契约的一部分。

```
enterprise-interview-preparation/SKILL.md
enterprise-workflow-mapping/SKILL.md
enterprise-material-analysis/SKILL.md
enterprise-ai-process-diagnosis/SKILL.md
enterprise-ai-diagnostic-orchestrator/SKILL.md
```

把**整个包目录**复制到你的 Agent 平台读取 skill 的目录下。**只复制一个 `SKILL.md` 不是受支持的用法。**

### 运行离线模拟

```bash
python3 enterprise-ai-diagnostic-orchestrator/scripts/run_offline_simulation.py \
  simulations/business-operations-crm-authorization/runtime-simulation/scenario.json \
  /tmp/diagnostic-run
```

把一段固定的、仅含 `E5` 的场景重放进路由器。它只写入调用方指定的目录，**绝不写总档案**，也不连接任何系统。

### 校验记录

```bash
cd enterprise-ai-diagnostic-master-record
python3 scripts/validate_master_record.py examples/retail-complaint-master-record.json
python3 scripts/validate_skill_handoff.py examples/skill-handoffs/workflow-mapping.json
python3 scripts/validate_handoff_chain.py \
  examples/retail-complaint-master-record-v0.2.json \
  examples/skill-handoffs/workflow-mapping.json \
  examples/skill-handoffs/material-analysis.json \
  examples/skill-handoffs/diagnosis.json
```

---

## 工作方式

四步，顺序不能换。**顺序本身就是方法** —— 管理层访谈确定范围并授权，员工摸排还原实际，材料分析核对主张，诊断放在最后且只提条件式选项。

| 步骤 | 包 | 做什么 | 不做什么 |
| --- | --- | --- | --- |
| 1. 管理层访谈 | `enterprise-interview-preparation` | 锁定一条有界流程及其要支撑的决策；规划角色覆盖与补证请求 | 不给技术建议 |
| 2. 员工流程摸排 | `enterprise-workflow-mapping` | 一次只问一个问题，直到一项工作画得出来、并由员工本人确认 | 不诊断、不审计部门、不联系任何人 |
| 3. 授权材料分析 | `enterprise-material-analysis` | 产出证据台账、主张—来源映射、冲突登记与最小补证请求 | 不选技术路线、不估 ROI |
| 4. 证据门诊断 | `enterprise-ai-process-diagnosis` | 判断需求、流程缺陷与组件可行性；设计 3–7 天离线影子试点 | 不实施、不写生产、不替人决策 |

**总控只负责路由，不负责决策。** 每个事件产生一个路由决定，最多调用一个步骤。证据不足就把工作退回去补证；授权被撤回就暂停。它不能批准、发布、通知、付款或作出承诺。

**总档案是契约，不是 Skill。** `enterprise-ai-diagnostic-master-record/` 承载共享 schema（`v0.1`、`v0.2`）与四个校验器，让每一步读写同一套结构、同一套证据语义。

### 传统诊断 vs 证据门诊断

左列描述的是本仓库针对的做法 —— 它是方法赖以建立的对照，**不是对任何人项目的实测调研**。

| | 传统 AI 诊断 | 这里的证据门诊断 |
| --- | --- | --- |
| 起点 | 组织架构、干系人访谈、一个看好的方案 | 一条有界流程，以及它要支撑的决策 |
| 什么算事实 | 职级最高或说得最流畅的那个人说的 | 带来源位置和证据等级（`E1`–`E5`）的主张 |
| 官方文件 | 被当作"工作实际如何"的证明 | `E4` —— 只支持预期规则，不支持执行 |
| 模型输出 | 直接当作分析结论 | `E5` —— 待核实的线索，加标注、机器校验 |
| 冲突 | 按偏好、职级或排版解决 | 保留并分类；只有新证据能解决 |
| 不可读/缺失材料 | 悄悄跳过 | 记录在案，并给出标了责任人的优先级补证请求 |
| 技术路线 | 项目一开始就定 | 逐组件判定 `可开发` / `有条件` / `阻塞` |
| 试点 | 承诺铺开 | 离线影子试点设计，含通过/观察/停止标准与回退 |
| 交付权限 | 交付物建议，工作继续推进 | Agent 提建议；**由人决策** |

---

## 你会得到什么

下面每一项都由仓库里真实存在的模板、schema 或代码路径定义。

| 产出物 | 定义位置 | 性质 |
| --- | --- | --- |
| **访谈计划**（`enterprise_interview_plan`） | [`enterprise-interview-preparation/templates/interview-plan.md`](enterprise-interview-preparation/templates/interview-plan.md) + JSON Schema | 模板 + schema，由模型按 `SKILL.md` 填写 |
| **员工确认流程卡** | [`enterprise-workflow-mapping/templates/workflow-card.md`](enterprise-workflow-mapping/templates/workflow-card.md) + JSON Schema | 模板 + schema；**必须经员工明确确认** |
| **证据包** | [`enterprise-material-analysis/templates/`](enterprise-material-analysis/templates/) | 证据台账、主张—来源映射、矛盾登记、覆盖缺口、最小补证请求 |
| **内部诊断** | [`enterprise-ai-process-diagnosis/templates/conditional-technical-plan.md`](enterprise-ai-process-diagnosis/templates/conditional-technical-plan.md) | 需求判断、流程缺陷、逐组件可行性、条件式选项 |
| **系统接口发现卡** | [`enterprise-ai-process-diagnosis/templates/system-interface-discovery-card.md`](enterprise-ai-process-diagnosis/templates/system-interface-discovery-card.md) | 关于 API、权限、沙箱与稳定标识，已知什么、还不知道什么 |
| **3–7 天影子试点设计** | [`enterprise-ai-process-diagnosis/references/diagnosis-framework.md`](enterprise-ai-process-diagnosis/references/diagnosis-framework.md) | 离线试点，含基线、一条异常、人工接管、通过/观察/停止标准与回退 |
| **管理层简报** | [`deliverables/management-diagnostic-report-v0.1/`](deliverables/management-diagnostic-report-v0.1/) | 客户版视图，**保留**证据等级、`E5` 标注与冲突状态 |
| **总档案** | [`enterprise-ai-diagnostic-master-record/schema/`](enterprise-ai-diagnostic-master-record/schema/) | 共享 JSON 记录 + 校验器，`v0.1` / `v0.2` |

---

## 证据分级

每条主张都带等级。权威定义在 [`enterprise-material-analysis/references/evidence-model.md`](enterprise-material-analysis/references/evidence-model.md)。

| 等级 | 来源 | 能证明 | 不能自动证明 |
| --- | --- | --- | --- |
| `E1` | 观察到的操作、系统记录、执行日志，或具代表性的真实/脱敏样本 | 所观察条目与时段内的流程事实 | 所有情况、因果解释、员工意图或 ROI |
| `E2` | 实质独立的多角色或多来源，印证同一具体主张 | 该说法经过印证 | 除非其中一条是 `E1`，否则不证明实际运行时行为 |
| `E3` | 单个员工、管理者、客户或供应商的陈述 | **该人是怎么说的** | 企业级事实或可测数量 |
| `E4` | SOP、制度、表单、规范或预期流程 | 预期规则、设计或要求流程 | 实际合规性、执行频率 |
| `E5` | 模型推断或分析者假设 | 一条待核实的线索 | 事实、冲突裁决或对外主张 |

**规矩只有一条：低等级的证据，不许去回答高等级证据才能回答的问题。**

两条容易搞错的地方：

- **等级来自来源，不来自说得多肯定。** 有人声称「制度规定是这样」却拿不出文件，那是 `E3` 不是 `E4`。没有文件，就无法区分「制度真是这样」与「本人记忆中的制度是这样」。
- **隐性规定停留在 `E3`。** 无文件、但属于该角色被期望遵循的做法，仍基于单人陈述。它是模型里最脆弱的一类：**人走了，记录上看不出丢了什么。**

### 这条规矩由代码强制，不只是写在文档里

- `master-record-v0.2.schema.json` 把 `evidenceLevel` 限定为 `["E1","E2","E3","E4","E5"]`。
- [`validate_master_record.py`](enterprise-ai-diagnostic-master-record/scripts/validate_master_record.py) 在 `E5` 记录缺少 `AI假设，待验证` 标签时报 `E5_LABEL_MISSING`。
- `tests/test_master_record.py` 断言这一拒绝；`tests/test_routing_contract_v02.py` 抛 `ValueError("E5 must remain visibly labelled")`。
- 离线模拟运行器给每条产出记录打上 `"evidence_level": "E5"`，并有测试守住。

路由契约直接写明了运行规则：`E5` 内容必须标注 `AI假设，待验证`，不得混入 `E1`/`E2` 事实段落，不得在管理层视图中被剥掉等级；诊断可以用 `E5` 提出核实方向，但**不得仅凭 `E5` 形成定论**。

### 已知缺口：文件无法自证权威性

模型**没有机制确认一份上传文件确实是企业制度文件**。任何人都可以上传一份自称 SOP 的文件。这是「流畅输出不等于证据」在文件侧的同一形态：**看起来像制度，不等于制度。**

可复用的原语已经存在：`enterprise_authorizations` 里的具名授权人 + 一次性 capability + 带理由和时间的确认留痕。把它延伸到文件，即可要求**由企业具名确认人确认该文件的权威性与生效范围**。**状态：未解决。**

---

## 人 / 规则 / Agent 的边界

责任分成五层，而这个边界正是整套系统的要害：

| 层 | 负责 |
| --- | --- |
| 业务流程 | 角色、输入、责任、交接、例外 |
| 确定性规则 | 阈值、必填、权限、时限 |
| 工作流 | 顺序、状态、等待、重试、升级、恢复 |
| AI | 理解、分类、抽取、摘要、草拟 |
| Agent | 在显式授权范围内的有限动态选择 |
| **人** | **高风险批准、资金、客户承诺、最终责任** |

业务规则负责识别，AI 负责解释和建议。目标、规则和取舍由企业拥有。

责任还要再分四层：能力边界、企业组织决策、改造方实施开发、上线后维护。条件式技术方案中的组件默认由改造方技术团队或企业指定供应商开发/配置；企业员工负责提供授权材料并参与验收，**不承担软件开发责任**。**`可开发` 只表示能做出离线原型，不表示人员、预算、合同和生产接入已经落实。**

### 人类决策门

`A0`/`A1` 可以在当前对话内解决。`H1`、`H2`、`S0` 需要独立的有界任务或停止行为。关闭 `H2` 必须生成独立的组织确认记录，含确认人权限依据、采用的执行口径、适用范围、生效时间、来源证据和受影响记录。授权撤回不是一句备注 —— 它会传播：材料 → 证据包 → 诊断 → 管理层视图，各自进入失效 / 待重算 / 撤回发布状态。

---

## 案例

### 真实工作复盘（`E3`）

[`case-studies/real-process-retrospective.md`](case-studies/real-process-retrospective.md) —— 把方法用在维护者亲手做过的工作上，已脱敏。另有[自包含网页版](case-studies/real-process-retrospective.html)。

它带来了什么：

- **一个由方法自己抓到的范围错误。** 估算工作量时发现工作单元选错了 —— 同一组操作在另一个频率高得多的触发源下运行。
- **两条流畅、合理、但错误的推断。** 它们被拦下，只因为被标注为推断并逐条核对。这就是「AI 生成的流畅不等于证据」的具体形态。
- **三条规则升入证据模型**，包括口头规则声明那条，以及上面的文件溯源缺口。
- **一条被故意扣下的洞察**，因为它只基于单个案例 —— 记入 [`CHANGELOG.md`](CHANGELOG.md)，注明已识别但未采纳。
- **一个原设计遗漏的限制。** 已离岗者的事后复盘，所有补证路径会同时失效，证据永久停留在 `E3`。

### 合成案例（`E5`）

三个完整的端到端模拟，每个都从员工摸排一路走到诊断结论：

- [`simulations/manufacturing-emergency-procurement/`](simulations/manufacturing-emergency-procurement/) —— 制造业紧急采购审批
- [`simulations/retail-complaint-refund/`](simulations/retail-complaint-refund/) —— 门店客诉退款与补偿
- [`simulations/business-operations-crm-authorization/`](simulations/business-operations-crm-authorization/) —— CRM 客户归属交接，43 个编号文件外加可运行的离线控制夹具

这些案例里的每一个企业标识都带 `SIM` 或 `SYN` 标记。它们验证的是机制，**不是任何真实企业的证据**。

### 影子试点：设计过，从未执行

3–7 天试点是一份真实的设计规范。**没有跑过任何真实试点。** 唯一的执行记录是一次合成的、加速的单场次模拟。

---

## 状态与限制

来自文件本身的声明状态：

| 字段 | 声明值 |
| --- | --- |
| `manifest.json` `status`（五个包） | `personal-experiment` |
| `manifest.json` `publication`（五个包） | `local-only` |
| `manifest.json` `target_platforms`（五个包） | `["codex"]` |
| `manifest.json` `maturity_tier` | `production-candidate`（四个包）、`scaffold`（`enterprise-workflow-mapping`） |
| `SKILL.md` `metadata.maturity` | `personal-experiment` |
| git tag | `v0.1.0`、`v0.1.1` —— 仓库快照，不是包发布 |
| `CHANGELOG.md` | 存在 |
| GitHub Releases | 无 |

因此上方的徽章写的是 **Prototype**，而不是 Experimental、Production 或 Enterprise Ready。`production-candidate` 是仓库自己的逐包层级标签；它是候选层级，不是生产声明，也不覆盖 `status: personal-experiment` 或 `publication: local-only`。

尽管所有包都声明 `local-only` 发布，仓库实际以 MIT 许可证公开在 GitHub 上。维护者元数据在 manifest、`SKILL.md` 和 `agents/interface.yaml` 中署名 **Kang Jiaxin**；`LICENSE` 中的版权人写的是 **Kang**。本文不统一这两个名字，`LICENSE` 也未被改动。

**以下这些，确实还不存在，直说：**

- **没有真实企业部署。** 代码树中不存在任何真实企业记录。
- **没有真实客户结果。** 没有测量过任何 ROI、效率提升、成本节约、质量改善、准确率或采用率数据，因为从未发生过真实项目。
- **没有独立或 provider 支持的验证。** 仓库自己的产物记录 `"provider_backed": false`。一份运行时案例记录直说独立运行仍是 `missing evidence`。
- **没有执行过影子试点。** 只存在一次合成的、加速的单场次模拟。没有连接过任何生产 OA 或 CRM。
- **不跨平台。** 五个 manifest 全部声明 `"target_platforms": ["codex"]`。
- **不是运行时系统。** 没有数据库、没有统一入口、没有任务队列、没有调度器、没有 Web 服务。可执行逻辑只有确定性路由器、离线模拟运行器、四个校验器和根级来源守卫。
- **不能替代人。** 它不会自主访谈员工、不会联系任何人、不会发送消息、不会修改业务系统、不会作出承诺。

---

## 验证状态

### 实际跑过什么

八个 `unittest` 套件加一个来源守卫，全部在仓库根目录用 Python 标准库执行。**131 项测试，全部通过。**

```bash
python3 -m unittest discover -s enterprise-interview-preparation/tests          # 9 通过
python3 -m unittest discover -s enterprise-workflow-mapping/tests               # 7 通过
python3 -m unittest discover -s enterprise-material-analysis/tests              # 7 通过
python3 -m unittest discover -s enterprise-ai-process-diagnosis/tests           # 7 通过
python3 -m unittest discover -s enterprise-ai-diagnostic-orchestrator/tests     # 23 通过
python3 -m unittest discover -s enterprise-ai-diagnostic-master-record/tests    # 56 通过
python3 -m unittest discover -s simulations/business-operations-crm-authorization/tests  # 17 通过
python3 -m unittest discover -s deliverables/management-diagnostic-report-v0.1/tests     # 5 通过
python3 scripts/validate_personal_skill_ownership.py                            # personal_skill_ownership_valid
```

[`scripts/run_local_checks.sh`](scripts/run_local_checks.sh) 用一条命令跑完全部八个套件与守卫，任何失败都以非零退出。[`.github/workflows/local-checks.yml`](.github/workflows/local-checks.yml) 在每次 push 和 pull request 时调用同一个脚本，所以本地与 CI 不会漂移。

### 测试证明了什么，没证明什么

它们确实在跑真实机制。13 个路由器测试断言跨企业输入、授权撤回、未知来源、过早诊断和非负责人恢复等情形下的决定、目标与原因码；另有一个防漂移测试重跑路由器并与全部 6 份已保存输出逐字段比对。总档案校验器用刻意构造的变异用例驱动。离线运行器被端到端执行。已提交的 XLSX 被当作真实 ZIP 打开，并断言其 7 个工作表名称。

它们**不验证方法论**。131 项里绝大多数是对 Markdown 的字符串包含断言 —— 句子在就过，改个说法就失败。**仓库里没有任何一项测试真正调用模型。** 触发评估是对录制提示词的关键词—概念打分，不是激活测试，也不是模型评分评估。这里的每一项测试，验证的都是仓库与自身一致，**从不是对真实企业的有效性**。

曾有两处内部交叉引用失效；`v0.1.1` 里已修复悬空的设计文档引用，并更正了天数口径不一致。`outputs/crm-shadow-pilot-20260816/crm-shadow-pilot-result.xlsx` 是一份含 7 个工作表的已提交 XLSX，但**仓库中不存在生成它的脚本** —— 它声明的结果指纹无法从代码树重新计算。

### 仓库自己的工具记录为失败的部分

两份已提交的本地发布检查 —— `enterprise-material-analysis/reports/local-release-check.json` 和 `enterprise-ai-process-diagnosis/reports/local-release-check.json` —— 都报告 `"ok": false`，摘要为 `{"pass": 3, "warn": 3, "block": 3}`。被阻塞的门是 `package_validation`、`git_diff_check` 和 `feature_branch`；警告是 `clean_worktree`、`clean_install` 和 `provider_or_human_output_evidence`。其中最关键的是 provider 或人工输出证据门，原因就记录在它旁边。

### 本文档的证据分级

| 主张 | 分类 |
| --- | --- |
| 路由器、离线模拟器与四个校验器确实可执行并产出所示结果 | `VERIFIED` |
| 八个套件 131 项测试通过，且在 CI 的裸解释器环境下通过 | `VERIFIED` |
| `E1`–`E5` 模型存在，并在 schema、校验器与测试中强制 | `VERIFIED` |
| 治理规则有实质内容且部分由机器强制 | `VERIFIED` |
| CRM 案例、两个较小的模拟、总档案示例以及所有交付物的内容 | `SIMULATED`（`E5`） |
| 真实工作复盘 | `E3` —— 单人回忆，已脱敏 |
| 3–7 天影子试点作为一次已执行的运行 | **不声称** —— 仅设计 |
| 真实企业结果、ROI、试点成效、独立 provider 验证 | `TO_VERIFY` —— 且仓库自己的产物说明这些尚不存在 |

---

## 安全与治理

**数据范围。** 只处理用户明确授权且纳入当前范围的企业材料。真实 API Key、Token、Cookie 或认证文件内容绝不记录在仓库、回复、文档或日志中。不提交 `.env`、密钥文件、原始个人信息或未脱敏企业数据。代码树中不存在任何 API Key、Token、Cookie、密码、私钥或凭据值。

**可复用产物中的隐私。** 在可移植产物中使用项目代号和匿名标识符。不要把客户名称、员工身份、凭据、原始私人逐字稿或敏感业务内容放进可复用 Skill 文件或公开夹具。原始材料保持不变；不可读、被截断、纯图片、受密码保护或损坏的文件记录在案，而不是靠猜。不要静默扫描无关的聊天、文件、日志、账号或知识库。

**授权撤回。** 授权被撤回时，上游材料及由其派生的一切必须进入复核状态，不得继续对外使用。这在代码、校验器和测试中都被强制：路由器在撤回时要求 `H2` 人工复核，`test_withdrawn_material_propagates_through_evidence_pack_to_diagnosis` 证明该传播。输出视图必须使用 `metadata_policy: preserve_source_metadata` —— 视图可以过滤内容，但不得剥掉证据等级、`E5` 标注、冲突状态、授权状态或版本血缘。

**反过度声称规则。** 没有相应证据，不得声称效率、成本、质量、集成就绪度或业务改善。客户沟通不得隐藏实质性风险或证据缺口，不得把假设变成已确认事实，不得在没有证据时承诺 ROI、准确率、交付或合规。

**来源守卫。** [`scripts/validate_personal_skill_ownership.py`](scripts/validate_personal_skill_ownership.py) 遍历五个包目录下的每个文本文件，在以下情况失败：包未声明 `owner: Kang Jiaxin`、出现被禁止的署名标记、出现 JSON Schema 方言 URI 以外的外部 URL、或包声明了 `upstream_inspiration`。它是一道真实的来源守卫，也是本仓库中曾经的署名只以守卫内部禁用常量的形式存在的原因。它的作用范围仅限五个包目录：不扫描根 `README.md`、`docs/`、`simulations/`、`deliverables/`、`outputs/`、`scripts/` 和 `enterprise-ai-diagnostic-master-record/`，所以这些目录之外带 URL 的先例研究报告不在它的覆盖范围内。

**强制的边界。** 由机器强制覆盖的是 JSON 记录层和路由层。Markdown 产物**只受指令约束** —— 没有针对它们的校验器，也没有任何东西测试模型是否真的遵守 `SKILL.md`。

---

## 仓库结构

```text
.
├── assets/                                 # 架构图及其 HTML 源文件
├── enterprise-interview-preparation/       # Skill 1 - 管理层访谈
├── enterprise-workflow-mapping/            # Skill 2 - 员工流程卡
├── enterprise-material-analysis/           # Skill 3 - 证据包
├── enterprise-ai-process-diagnosis/        # Skill 4 - 诊断与影子试点
├── enterprise-ai-diagnostic-orchestrator/  # Skill 5 - 总控路由（可运行代码）
├── enterprise-ai-diagnostic-master-record/ # 共享记录契约（不是 Skill）
├── simulations/                            # 合成端到端案例（E5）
├── case-studies/                           # 方法用于真实工作的记录
├── portfolio/                              # 面向读者的项目介绍页
├── deliverables/                           # 静态报告与提案产物
├── outputs/                                # 一份已提交 XLSX，无生成脚本
├── docs/                                   # 离线运行时设计说明与计划
├── scripts/                                # 本地检查运行器 + 来源守卫
├── CHANGELOG.md
├── README.md / README.zh-CN.md
└── LICENSE
```

每个包各自带 `references/`、`templates/`、`evals/`、`reports/` 和 `tests/`。

---

## 参与贡献

欢迎 issue 和 pull request，只有一条要求：**贡献里的主张，必须遵守仓库对自己使用的同一套证据标准。** 说清楚跑了什么、跑在什么上、以及哪些无法验证。

提交 pull request 之前：

```bash
./scripts/run_local_checks.sh
```

必须零退出。如果你改了 `SKILL.md`、模板或 schema，请在同一个改动里更新对应测试 —— 套件会断言这些文件包含的文本。

---

## 开源许可证

以 [MIT 许可证](LICENSE) 发布。

Copyright (c) Kang.
