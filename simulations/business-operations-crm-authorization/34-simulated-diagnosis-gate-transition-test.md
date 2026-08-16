# CRM客户归属交接诊断门状态测试（控制夹具）

> 测试性质：纯控制逻辑测试。新增的“补证”不是企业真实材料，不标记为E1/E2，不产生真实诊断结论。
>
> 目的：验证当必要条件全部被控制测试夹具标记为“满足”时，诊断门是否会从 blocked 转为允许离线影子验证；同时验证真实E5项目不会被误放行。

## 一、两条路径

| 路径 | 输入状态 | 诊断门结果 | 允许动作 |
|---|---|---|---|
| 真实当前项目 | E5模拟岗位卡、E5模拟材料、真实证据未知 | blocked | 继续补证，不进入诊断方案 |
| 控制测试夹具 | 所有必需条件人为设为满足 | gate_passed_for_shadow_only | 仅生成离线影子验证计划，不写生产系统 |

## 二、门控条件

| 条件 | 真实当前项目 | 控制夹具 | 放行要求 |
|---|---|---|---|
| 单一流程边界 | 已满足：PROC-CRM-OWNER-TRANSFER | 满足 | 不能混入客户访问授权 |
| P0岗位覆盖 | 未满足，岗位卡为E5 | 满足（测试标记） | 申请人、运营、CRM执行均有卡 |
| 业务责任规则 | 未确认 | 满足（测试标记） | 有权负责人确认归属裁决、版本和验收口径 |
| 稳定客户标识 | 未知 | 满足（测试标记） | 编号字段可读且可核对 |
| CRM执行结果 | 未知 | 满足（测试标记） | 每行可返回成功、失败、阻断或待确认 |
| 权限与锁定规则 | 未知 | 满足（测试标记） | 有授权说明和人工接管 |
| OA与CRM关联 | 未知 | 满足（测试标记） | 有稳定任务关联键 |
| 脱敏与授权 | 仅本地模拟 | 满足（测试标记） | 只使用测试目录，不连生产 |

## 三、控制夹具输入

以下内容只用于测试状态机，不代表真实企业证据：

    fixture_id: FIXTURE-SIM-CRM-OWNER-TRANSFER-GATE-001
    process_id: PROC-CRM-OWNER-TRANSFER
    evidence_mode: simulated_control_fixture
    not_enterprise_evidence: true
    p0_workflow_cards: all_present_in_fixture
    business_rule_confirmation: fixture_satisfied
    stable_customer_id: fixture_satisfied
    row_level_execution_receipt: fixture_satisfied
    permission_and_lock_rules: fixture_satisfied
    oa_crm_link_key: fixture_satisfied
    production_write_access: false

## 四、模拟门控结果

### 真实项目

    gate_status: blocked
    reason_codes:
      - EVIDENCE_LEVEL_INSUFFICIENT
      - SYSTEM_CONDITIONS_UNKNOWN
      - REAL_EMPLOYEE_CONFIRMATION_MISSING
    next_action: request_minimum_real_evidence

### 控制夹具

    gate_status: gate_passed_for_shadow_only
    business_conclusion: 补充调研后再判断
    confidence: 低
    technical_maturity: 可进入离线影子验证
    restrictions:
      - 不连接生产OA或CRM
      - 不写回客户归属
      - 不让AI或Agent裁决归属
      - 不计算真实ROI或自动化率
      - 任何结果都标记为测试结果

## 五、允许生成的离线影子验证

| 验证项 | 测试动作 | 通过条件 | 失败动作 |
|---|---|---|---|
| 名单预检 | 用测试Excel检查空值、重复、编号和版本 | 每行都有明确状态 | 退回人工确认 |
| 归属核对 | 对照测试CRM快照核对当前归属 | 编号匹配且归属一致 | 阻断，不自动修正 |
| 版本控制 | 同时提供原始清单和裁决清单 | 只有一个有效版本进入测试执行表 | 停止并标记版本冲突 |
| 执行回执 | 使用测试结果表模拟逐行成功/失败/阻断 | 每行都有结果和理由 | 转人工复核 |
| 审计链 | 关联测试任务号、版本、前后值和操作者 | 可追溯到测试输入 | 停止，不生成完成结论 |

## 六、不能由本次测试证明的内容

- 真实CRM是否有API、导入接口或RPA可行性；
- 真实权限、锁定、数据质量和批量上限；
- 真实业务错误率、耗时、人工工时和收益；
- 真实员工是否接受流程和结果；
- 生产环境安全、审计、稳定性和回滚能力。

## 七、测试结论

1. 门控逻辑正确：真实E5材料不足时保持 blocked。
2. 条件满足时，只允许进入离线影子验证，不允许直接生产实施。
3. “可进入离线影子验证”必须绑定明确的测试边界和人工接管条件。
4. 控制夹具不能替代真实E1/E2证据；正式项目仍需重新提交真实证据包。

## 交接块

    record_type: diagnosis_gate_transition_test
    schema_version: "0.2"
    test_id: GATE-TEST-SIM-CRM-OWNER-TRANSFER-001
    process_id: PROC-CRM-OWNER-TRANSFER
    current_real_project_gate: blocked
    fixture_gate: gate_passed_for_shadow_only
    fixture_is_not_enterprise_evidence: true
    next_real_project_requirement:
      - 真实P0岗位确认卡
      - 真实OA/Excel最小样本
      - 真实CRM字段、权限和逐行回执证据
      - 业务负责人确认版本和验收规则
    master_record_write: forbidden
    created_at: "2026-08-16"
