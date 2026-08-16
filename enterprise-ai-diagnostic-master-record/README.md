# 企业 AI 诊断总档案 v0.1 / v0.2

这是企业 AI 应用诊断体系的共享档案契约，不是 Skill，也不提供统一入口或数据库。

## 用法

1. 一个诊断项目创建一份总档案；
2. 用 `enterprise_id` 隔离企业，用 `project_id` 区分同企业的不同项目；
3. 员工流程卡、材料、证据包、诊断和报告独立保存；
4. 总档案只登记记录ID、版本、状态、授权、上游引用和文件位置；
5. 每次进入下一阶段前运行校验器。

v0.1保留原有索引和兼容校验。v0.2新增员工任务子状态、P0规划到任务的覆盖门、E5标签、冲突关闭引用、诊断遗留缺口、组织决定、S0停止恢复、视图元数据保护和文件哈希；不改变各子Skill的正文格式。

```bash
python3 scripts/validate_master_record.py examples/retail-complaint-master-record.json
python3 scripts/validate_master_record.py examples/retail-complaint-master-record-v0.2.json
```

输出 `valid` 才表示当前档案通过结构和跨记录语义检查。它不证明材料真实、结论正确或企业已经授权生产实施。

## 子 Skill 登记提案

三个子Skill不直接写总档案。它们保留原有流程卡、证据包和诊断正文，只在总控运行或用户明确要求项目交接时，额外输出一份`registration proposal`。总控负责校验提案、补齐有权限的管理字段、检查项目门并正式登记；子Skill不得自行决定下一路由。

单份提案校验：

```bash
python3 scripts/validate_skill_handoff.py examples/skill-handoffs/workflow-mapping.json
python3 scripts/validate_skill_handoff.py examples/skill-handoffs/material-analysis.json
python3 scripts/validate_skill_handoff.py examples/skill-handoffs/diagnosis.json
```

三份提案按“工作摸排 -> 材料分析 -> 流程诊断”顺序做虚拟引用链校验：

```bash
python3 scripts/validate_handoff_chain.py \
  examples/retail-complaint-master-record-v0.2.json \
  examples/skill-handoffs/workflow-mapping.json \
  examples/skill-handoffs/material-analysis.json \
  examples/skill-handoffs/diagnosis.json
```

这只是只读提案和虚拟链路验证，不会把记录自动写回JSON文件，也不是数据库事务或自动总控。

## 与现有 Skill 兼容

总档案作为包装层，不修改现有三个 Skill：

- 流程卡的 `employee_id` 映射为 `participant_id`；
- 保留现有 `project_id`、`version` 和 `upstream_records`；
- 总档案补充 `enterprise_id`、`process_id`、授权状态、生命周期状态和文件位置；
- 证据包继续保留自己的结论、冲突和 `prohibited_conclusions`，主档案只索引它；
- 任何跨角色合并生成新的派生记录，不覆盖员工卡。

## 当前人工收件

项目联系人创建企业和项目编号，员工分别导出流程卡，联系人受控收件并登记版本，再交给材料分析和诊断 Skill。总档案解决收到后的归档、覆盖、版本和失效判断，不解决不同电脑之间的自动传输。

## 未来迁移

未来统一入口可将九个区块映射为数据库实体，由专用 Agent 自动登记提交、版本和状态。企业隔离、上游引用、授权撤回、发布门和角色视图规则保持不变。

## 目录

- `templates/master-record.md`：人类可读模板；
- `schema/master-record.schema.json`：JSON Schema；
- `schema/master-record-v0.2.schema.json`：v0.2 JSON Schema；
- `schema/skill-handoff-v0.2.schema.json`：三个子Skill共用的登记提案Schema；
- `scripts/validate_master_record.py`：标准库语义校验器；
- `scripts/validate_skill_handoff.py`：单份登记提案结构和职责边界校验器；
- `scripts/validate_handoff_chain.py`：按输入顺序验证提案的企业范围、上游引用和员工任务；
- `examples/retail-complaint-master-record.json`：虚构零售实例；
- `examples/retail-complaint-master-record-v0.2.json`：包含P0覆盖、E5、H2和S0恢复的v0.2实例；
- `examples/skill-handoffs/`：工作摸排、材料分析和流程诊断的三份登记提案样例；
- `tests/test_master_record.py`：总档案边界回归测试；
- `tests/test_routing_contract_v02.py`：总控路由v0.2六路径参考状态机测试；
- `tests/test_skill_handoff.py`：登记提案与顺序链路回归测试；
- `reports/prior-art-output-adapters.md`：登记提案转换层的内部方案取舍；
- `contracts/orchestration-routing-contract.md`：总控路由协作契约；
- `simulations/routing-v0.2/retail-complaint-routing-simulation.md`：v0.2六路径仿真记录。
