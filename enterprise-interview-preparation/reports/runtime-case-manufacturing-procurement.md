# 模拟输出：制造业紧急采购访谈准备

## 结论先行

- 范围：紧急采购申请到收货、付款与补录闭环；
- 要支持的决定：真实流程是否稳定、ERP覆盖到哪一步、规则和接口条件是否存在；
- 当前假设：“ERP里都有”和“应该直接上Agent”均未验证；
- 本方案不进行技术选型。

## 资源约束与最小访谈组合

- 总时间、最多人数和单场时长未提供，当前矩阵是建议覆盖，不是已确认排期；
- 若只能安排3个角色，最低组合为采购执行人员、审批/财务和ERP管理员；
- 申请部门与仓库无法覆盖时，流程触发和收货闭环保持部分缺口，不得宣称完成端到端验证。

## 角色覆盖矩阵

| 优先级 | 角色 | 为什么访谈 | 改变的决定 |
|---|---|---|---|
| P0 | 采购执行人员 | 还原实际步骤、线下补充和异常 | 是否需要后续一对一工作摸排 |
| P0 | 申请部门 | 说明触发、紧急定义和输入质量 | 紧急分类是否稳定 |
| P0 | 仓库/收货 | 验证交接、数量差异和补货结果 | 流程何时才算完成 |
| P0 | 审批/财务 | 确认权限、付款和补录规则 | 哪些节点必须人工批准 |
| P0 | ERP管理员 | 验证字段、日志、导出、权限和接口 | 是否具备系统证据和集成条件 |
| P1 | 供应商管理 | 说明临时供应商和交期异常 | 例外范围是否需要单独流程 |

## 待验证的跨角色分歧

| 分歧主题 | 角色与主张 | 镜像问题 | 最小证据 |
|---|---|---|---|
| ERP是否覆盖完整流程 | 管理层/系统方：“ERP里都有”；执行人员可能存在电话、聊天和表格 | 请双方用同一笔最近案例指出每一步的系统编号、时间和线下补充 | 一笔端到端脱敏记录及关联材料 |
| 紧急采购何时允许先做后补 | 申请/采购可能按紧急程度判断；审批/财务按权限要求判断 | 双方分别说明最近一笔先采购后补审批的条件和批准证据 | 最近5笔紧急采购审批链 |

## 分角色问题摘录

| 角色 | 主问题 | 追问触发 | 为什么问 | 最小证据 |
|---|---|---|---|---|
| 采购执行人员 | 请回忆最近一次紧急采购，从收到申请到完成补录逐步说明。 | “ERP里都有”时追问系统外聊天、表格、电话和失败路径 | 判断实际流程与制度是否一致 | 一笔脱敏采购记录及相关交接材料 |
| 审批/财务 | 什么条件允许先采购后补审批，谁有权决定？ | “领导同意”时追问角色、阈值、时间和批准记录 | 判断权限能否形成确定性规则 | 最近5笔紧急采购审批链 |
| ERP管理员 | 哪些步骤在ERP留下稳定编号和状态？ | “有接口”时追问文档、权限、沙箱、读写范围 | 判断数据与集成成熟度 | 字段字典、导出样本或接口证明 |
| 仓库 | 收货差异、质量异常或无订单号时如何接管？ | “再沟通”时追问谁负责、多久升级、何时关闭 | 找到异常恢复路径 | 3笔异常收货记录 |

## 最小材料清单

| 材料 | 提供者 | 最小范围 | 无法获得时 |
|---|---|---|---|
| 紧急采购SOP与权限表 | 采购负责人/财务 | 当前有效版本 | 标记制度未知，不生成规则结论 |
| ERP采购、审批、收货导出 | ERP管理员 | 可关联的近20笔脱敏样本 | 进行5天人工观察，不宣称系统覆盖 |
| 异常与补录记录 | 采购/仓库 | 最近5笔 | 只记录口述并请求后续补证 |

## 现场边界

- 不能承诺ERP存在API或可以生产写回；
- 不能承诺采用Agent、RPA或任何指定技术；
- 不能承诺自动化率、节省人数或ROI；
- 录音、转写和材料收集前取得授权。

## 总档案交接块

```yaml
record_type: enterprise_interview_plan
schema_version: "0.2"
record_id: INTERVIEW-PLAN-SIM-MFG-001
version: 1
enterprise_id: ENT-SIM-MFG
project_id: PRJ-SIM-MFG-001
process_id: PROC-URGENT-PROCUREMENT
scope: 紧急采购申请到收货、付款与补录闭环
discovery_decisions: [实际流程是否稳定, ERP覆盖范围, 规则与接口条件]
planning_constraints:
  total_time_minutes: null
  max_participants: null
  session_duration_minutes: null
  access_constraints: []
  status: unknown
participant_roles:
  - role: 采购执行人员
    priority: P0
    reason: 还原实际步骤与异常
    decision_impact: 是否需要后续一对一摸排
  - role: 申请部门
    priority: P0
    reason: 说明触发与输入
    decision_impact: 紧急分类是否稳定
  - role: 仓库
    priority: P0
    reason: 验证收货交接
    decision_impact: 流程何时完成
  - role: 审批财务
    priority: P0
    reason: 确认权限与补录规则
    decision_impact: 哪些节点必须人工批准
  - role: ERP管理员
    priority: P0
    reason: 验证字段与记录边界
    decision_impact: 是否具备系统证据
conflict_hypotheses:
  - topic: ERP是否覆盖完整流程
    roles: [采购执行人员, ERP管理员]
    claims: [ERP里都有, 可能存在系统外处理]
    mirrored_questions: [用同一笔案例指出系统记录和线下补充]
    verification_evidence: [一笔端到端脱敏记录]
    status: hypothesis
evidence_requests:
  - evidence: 紧急采购权限与系统记录
    owner_role: 采购负责人和ERP管理员
    minimum_scope: 近20笔可关联脱敏记录
    decision_impact: 验证权限和系统覆盖
    fallback: 进行5天人工观察
coverage_gaps: [供应商视角待安排]
prohibited_promises: [ERP存在API, 必须采用Agent, ROI]
upstream_records: []
created_at: "2026-08-13T23:00:00+08:00"
```
