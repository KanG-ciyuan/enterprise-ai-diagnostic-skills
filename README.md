# 企业 AI 流程诊断 Skills

![Status](.github/badges/status.svg)
![Core Skills](.github/badges/core-skills.svg)
![Local Tests](.github/badges/local-tests.svg)
![Owner](.github/badges/owner.svg)
![Rights](.github/badges/rights.svg)

一套由 **Kang Jiaxin** 整理和维护的企业工作流程诊断方法体系。

它围绕一个具体业务流程，依次支持管理层访谈准备、员工工作摸排、企业材料分析、流程诊断、影子试点设计以及项目状态管理。目标不是让 AI 直接替企业作出高风险决定，而是把流程事实、证据缺口、岗位边界和下一步行动整理清楚。

当前仓库已经完成 Skill、总控路由、总档案和模拟案例的本地验证。模拟结果只说明方法链路能够运行，不代表真实企业数据、生产实施效果或商业收益已经得到验证。

## 核心能力

| 模块 | 负责什么 | 不负责什么 |
|---|---|---|
| [`enterprise-interview-preparation`](enterprise-interview-preparation/) | 为管理层启动访谈生成范围、角色、问题和最小材料清单 | 不直接访谈员工，不提前决定技术方案 |
| [`enterprise-workflow-mapping`](enterprise-workflow-mapping/) | Agent 逐题摸排一名员工的一项具体工作，生成员工确认流程卡 | 不做全企业诊断，不向员工输出改造结论 |
| [`enterprise-material-analysis`](enterprise-material-analysis/) | 分析授权材料，形成证据账本、冲突和最小补证清单 | 不把制度、口述或 AI 推断直接当成业务事实 |
| [`enterprise-ai-process-diagnosis`](enterprise-ai-process-diagnosis/) | 基于证据包形成业务诊断、条件式技术路线和 3 至 7 天影子试点 | 不直接开发、修改或接管生产系统 |
| [`enterprise-ai-diagnostic-orchestrator`](enterprise-ai-diagnostic-orchestrator/) | 根据事件、状态、授权和证据门判断下一步由谁处理 | 不替代各专业 Skill，不自行改写上游记录 |

共享档案契约位于 [`enterprise-ai-diagnostic-master-record`](enterprise-ai-diagnostic-master-record/)。它保存项目身份、状态、记录索引、版本、授权和上游引用，不存放大段访谈正文或附件本体。

## 操作路径

```text
创建诊断流程
  -> 管理层启动访谈
  -> 确定岗位、流程范围和 P0 必访角色
  -> Agent 摸排一线员工
  -> 员工确认个人流程卡
  -> 任意阶段上传的授权材料进入材料分析
  -> 检查证据覆盖、版本和冲突
  -> 达到诊断门后进入流程诊断
  -> 设计 3 至 7 天影子试点
  -> 企业负责人批准、暂停或要求补证
```

这不是必须从头到尾机械执行的固定流水线。总控根据当前事件路由：员工上传附件时可以先进入材料分析；证据不足时可以返回补证；授权撤回、来源不明或高风险冲突出现时必须暂停。

### 各角色看到什么

- **企业负责人：** 流程范围、关键断点、岗位边界、证据缺口、推荐改造路线和待批准事项。
- **一线员工：** 只看到与本人工作摸排和确认有关的内容，不接收岗位调整、降本评价等受限管理信息。
- **改造方：** 负责范围控制、证据管理、人工复核、异常升级和试点组织。
- **Agent：** 负责提问、整理、分类、解释和提出条件式建议，不替代有权人员作出责任、合规、资金或组织决定。

## 证据与决策边界

体系使用 `E1-E5` 区分不同来源：

| 等级 | 含义 |
|---|---|
| `E1` | 可追溯的系统记录或直接运行证据 |
| `E2` | 已授权、可验证的正式材料或书面确认 |
| `E3` | 员工、管理者或会议中的口述陈述 |
| `E4` | SOP、制度或规定要求，不能单独证明实际执行 |
| `E5` | AI 摘要、推断、模拟和待验证假设 |

所有 E5 内容必须保留等级标记，不能混入事实段落。业务规则由企业有权角色确认，AI 只负责解释与建议；高风险判断和最终批准始终由人完成。

## 模拟案例

[`simulations/business-operations-crm-authorization`](simulations/business-operations-crm-authorization/) 保存了 CRM 客户归属交接流程的端到端模拟，覆盖：

- 管理层启动访谈；
- 销售申请人、销售负责人、业务运营负责人和 CRM 管理员的岗位摸排；
- Excel 名单、OA 审批与 CRM 变更之间的断点；
- 证据门、流程诊断、离线影子试点和等待补证状态；
- 版本错误、归属争议、批量操作遗漏及人工确认边界。

该案例全部属于 **E5 模拟证据**，用于验证方法和路由，不代表任何真实企业的实际流程或经营结果。

当前案例还包含一份合成数据测试矩阵：`40-synthetic-test-matrix.json` 共 14 个场景，覆盖总控路由、客户编号缺失、重复客户、归属冲突、权限不足、批量上限、裁决版本和争议冻结等情况。

`synthetic-inputs/`提供更接近实际上传入口的合成材料，包括Excel客户交接清单、OA审批导出、CRM操作日志、员工访谈文字和管理层会议纪要；这些材料同样属于E5模拟输入。

管理层视角的演示报告位于 [`deliverables/management-diagnostic-report-v0.1/index.html`](deliverables/management-diagnostic-report-v0.1/index.html)。它是模拟成果展示，不是已获企业批准的正式诊断报告。

## 仓库结构

```text
enterprise-ai-diagnostic-skills/
├── enterprise-interview-preparation/
├── enterprise-workflow-mapping/
├── enterprise-material-analysis/
├── enterprise-ai-process-diagnosis/
├── enterprise-ai-diagnostic-orchestrator/
├── enterprise-ai-diagnostic-master-record/
├── simulations/
├── deliverables/
└── scripts/
```

每个 Skill 目录中的 `SKILL.md` 是执行入口，`references/`、`templates/`、`examples/`、`evals/` 和 `tests/` 是随包使用的配套内容。不要只复制单个 `SKILL.md`。

## 本地验证

在仓库根目录运行：

```bash
python3 -m unittest discover -s enterprise-interview-preparation/tests -v
python3 -m unittest discover -s enterprise-workflow-mapping/tests -v
python3 -m unittest discover -s enterprise-material-analysis/tests -v
python3 -m unittest discover -s enterprise-ai-process-diagnosis/tests -v
python3 -m unittest discover -s enterprise-ai-diagnostic-orchestrator/tests -v
python3 -m unittest discover -s enterprise-ai-diagnostic-master-record/tests -v
python3 -m unittest discover -s simulations/business-operations-crm-authorization/tests -v
python3 scripts/validate_personal_skill_ownership.py
```

验证通过只代表包结构、输出契约、路由规则和保存的模拟夹具符合当前约束，不代表真实企业材料正确、模型在所有平台表现一致或生产实施已经获得授权。

## 当前状态

**已经具备：**

- 五个核心 Skill 及配套规则、模板和测试；
- 事件驱动的诊断总控路由；
- 项目总档案、版本引用和证据失效规则；
- CRM 客户归属交接端到端模拟；
- 管理层报告和离线影子试点示例。

**仍需真实项目验证：**

- 脱敏 OA 审批记录、Excel 清单和 CRM 操作日志；
- 真实员工本人确认的流程卡；
- 企业有权角色对岗位边界、证据冲突和试点条件的确认；
- 真实环境下的用户接受度、系统接口、权限、安全和实施效果。

因此，真实项目在缺少上述证据时应停留在 `evidence_completion` 或 `blocked`，不得被描述为已经完成诊断或进入生产实施。

## 安全与权限

- 只处理用户明确授权且纳入当前范围的企业材料。
- 不在仓库、回复、文档或日志中记录真实 API Key、Token、Cookie 或认证文件内容。
- 不提交 `.env`、密钥文件、原始个人信息或未脱敏企业数据。
- 授权撤回后，相关上游材料及其派生记录必须进入复核状态，不得继续对外使用。
- Skill 默认只生成建议、记录或登记提案，不自动联系员工、发送消息、修改业务系统或执行生产操作。

## 参与共建

本仓库由 **Kang Jiaxin** 整理和维护。欢迎通过 Issue 讨论方法、证据边界和适用场景，也欢迎通过 Pull Request 参与改进。提交案例或夹具前，请确认其为合成或充分脱敏数据，并且具备公开授权。

## 许可证

本项目采用 [MIT License](./LICENSE) 开源。
