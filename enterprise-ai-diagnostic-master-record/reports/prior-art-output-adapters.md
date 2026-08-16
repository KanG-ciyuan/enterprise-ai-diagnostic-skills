# 子 Skill 输出适配层同类方案调研

## 调研范围

- 日期：2026-08-14
- 查询：`agent skill output contract schema handoff`
- 查询：`enterprise workflow evidence pack agent`
- 结果：两个目录均成功，共归并出51个候选家族；未发现与“企业AI诊断总档案登记提案”完全匹配的公开Skill。
- 原始结果：`prior-art-output-adapters-verified.json`
- 失败审计：`prior-art-output-adapters.json`记录第一次受限网络运行，不作为成功证据，也不覆盖删除。

指标必须分开理解：skills.sh的installs表示生态安装量，不是评分或正确率；SkillsMP的stars是来源仓库Star，不是Skill安装量或质量分。候选源码只做只读检查，未执行其中脚本。

## 实际检查的候选

### 1. apify/agent-skills: apify-generate-output-schema

- 来源：https://skills.sh/apify/agent-skills/apify-generate-output-schema
- 采用信号：约7.1K installs（2026-08-14检索快照）。
- 检查状态：检查了Skill源码和仓库最近提交；仓库根目录未发现许可证文件，因此不能复制正文。
- 学到的机制：从真实产物反推结构；先复用既有类型和仓库模式；示例必须脱敏；Schema要与真实输出交叉核对。
- 本项目落点：以三个子Skill已有的流程卡、证据包和诊断产物为源，新增统一的`skill-handoff-v0.2.schema.json`，不改写原产物正文。

### 2. curiositech/some_claude_skills: output-contract-enforcer

- 来源：https://skills.sh/curiositech/some_claude_skills/output-contract-enforcer
- 采用信号：98 installs（2026-08-14检索快照）；仓库为MIT许可证。
- 检查状态：检查了Skill源码、许可证和最近提交。
- 学到的机制：结构契约与内容质量分开；上下游结构不兼容时使用转换层；只要求下游真正需要的字段。
- 本项目落点：子Skill只生成`registration proposal`，总控另行完成权限、版本、项目门和正式登记。

### 3. sjb/skills: agent-handoff

- 来源：https://skills.sh/sjb/skills/agent-handoff
- 采用信号：11 installs（2026-08-14检索快照）；候选位于仓库`in-progress`目录，成熟度有限。
- 检查状态：检查了Skill源码和仓库状态；未将其运行机制带入本项目。
- 学到的机制：交接应是指向状态和现有产物的“指南针”，而不是复制全部历史正文。
- 本项目落点：提案只传项目上下文、精确记录版本、上游引用、状态更新和未解决项，不复制流程卡、证据包或诊断正文。

## Keep / Adapt / Reject / Invent

- `keep`：真实产物驱动Schema、现有记录复用、脱敏示例、精确引用、最小交接信息。
- `adapt`：将通用输出契约改造成企业隔离、版本溯源、授权状态和证据边界明确的登记提案。
- `reject`：拒绝让子Skill直接写总档案；拒绝由子Skill选择下一路由；拒绝Apify专属展示Schema、tmux会话启动和整段上下文复制。
- `invent`：统一三类业务产物的只读`registration proposal`；缺管理字段时使用`needs_registration_context`；支持三份提案按顺序做虚拟引用链验证。

## 证据边界

- `validated advantage`：共享Schema、语义校验器、链路校验器和三份样例已经具备本地回归测试。
- `design advantage`：原始业务产物与登记元数据分离，子Skill没有总档案写权限。
- `hypothesis`：该转换层将降低未来统一入口接入三个子Skill的耦合成本；尚无数据库、自动总控或跨Agent运行证据。

