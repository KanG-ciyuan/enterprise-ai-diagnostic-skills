# 管理层启动后的岗位流程摸排复跑记录（E5模拟）

> 本记录模拟 enterprise-workflow-mapping 在管理层启动完成后的运行结果。19-22号文件中的岗位卡作为已有模拟产物复用，不重新生成新的企业事实，也不写入正式总档案。

## 一、运行范围

本轮只处理一个流程范围：PROC-CRM-OWNER-TRANSFER，分别对三个岗位映射各自的一项具体工作：

| 角色 | 映射的具体工作 | 模拟卡 |
|---|---|---|
| 销售申请人 | 准备客户交接名单并提交OA | 19-simulated-sales-applicant-workflow-card-v2.md |
| 业务运营负责人 | 核对归属、处理争议并交接CRM执行 | 21-simulated-operations-manager-handoff-card.md |
| CRM管理员 | 执行客户归属变更并反馈结果 | 22-simulated-crm-admin-workflow-card.md |

销售负责人卡（20号）保留为审批视角补充材料，不把它当作一线执行岗位卡。

## 二、质量门检查

### 销售申请人

- 正常路径：岗位异动/客户调整 → 整理名单 → OA逐条填写或上传Excel → 审批流转。
- 已识别判断：客户数量、客户编号是否存在、名单是否属于本人。
- 已识别异常：归属不一致、重复客户、错名、审批返工、审批完成但CRM未完成。
- 已识别负担：批量名单准备和错误返工。
- 状态：E5模拟卡可用于后续材料核验；不能关闭真实销售申请人P0缺口。

### 业务运营负责人

- 正常路径：收到审批 → CRM核对归属 → 原OA留言执行或形成裁决清单 → 等待CRM管理员处理。
- 已识别判断：归属是否一致、是否存在多销售/多部门、哪一版清单有效。
- 已识别异常：争议补证、旧附件误用、管理员漏检索、没有逐客户回执。
- 已识别负担：人工核对、争议协调和事后抽查。
- 状态：E5模拟卡可用于后续材料核验；不能关闭真实运营执行P0缺口。

### CRM管理员

- 正常路径：检索待执行任务 → 有编号则批量导入 → 无编号则逐条搜索修改 → 回复完成。
- 已识别判断：客户唯一编号、名称与联系人/地址/信用代码匹配、是否有权限。
- 已识别异常：锁定客户、跨事业部权限、导入数量上限、隐性漏改、无一键回滚。
- 已识别负担：批量与手工混合处理、逐条返工和结果核对。
- 状态：E5模拟卡可用于后续材料核验；不能关闭真实CRM管理员P0缺口。

## 三、跨岗位冲突保留

1. 销售负责人认为审批主要确认交接事项，运营可能被期望承担名单后置核验；责任边界尚未有真实制度确认。
2. 运营认为裁决清单取代原附件，CRM管理员实际可能仍看到多个版本；有效版本尚未得到系统证据确认。
3. OA审批完成、CRM执行完成和业务验收完成被不同角色使用；需要同一任务的时间和日志材料核对。
4. CRM“导入完成”可能不是逐客户成功；需要结果页、错误日志或执行后导出验证。

这些冲突不在工作流摸排阶段裁决，只作为后续材料分析和管理层确认事项。

## 四、员工确认状态（模拟）

| 岗位卡 | 模拟确认 | 真实状态 |
|---|---|---|
| 销售申请人 | 模拟回答后已表示流程基本准确 | E5，待真实员工确认 |
| 业务运营负责人 | 模拟回答后已表示主线准确 | E5，待真实负责人确认 |
| CRM管理员 | 模拟回答后已表示主线准确 | E5，待真实管理员确认 |

## 五、模拟路由结果

| 路由 | 结果 |
|---|---|
| 岗位流程卡 | 可以作为后续材料分析的输入索引 |
| enterprise-material-analysis | 等待授权OA、Excel、CRM导出、日志、截图或会议纪要后调用 |
| enterprise-ai-process-diagnosis | 暂不调用；真实员工确认和必要证据尚未完成 |
| 正式总档案 | 不写入；只保留本地模拟记录 |

## 六、需要材料分析核验的最小集合

- 一份真实脱敏OA正常交接单和一份退回单；
- 当前真实Excel模板与一份脱敏批量清单；
- 同一任务对应的OA时间、CRM日志和管理员回复；
- CRM客户唯一编号、归属、锁定、权限和导入错误字段；
- 一份争议更正清单及新旧版本关系。

材料到达后，材料分析只提取和验证证据，不改写岗位卡中的原始模拟陈述。

## 总控交接提案

    event_type: workflow_mapping_simulation_revalidated
    process_id: PROC-CRM-OWNER-TRANSFER
    evidence_level: E5
    simulation_only: true
    workflow_cards:
      - record_id: WF-SIM-SALES-APPLICANT-001
        source: 19-simulated-sales-applicant-workflow-card-v2.md
        employee_confirmed: false
      - record_id: WF-SIM-OPERATIONS-001
        source: 21-simulated-operations-manager-handoff-card.md
        employee_confirmed: false
      - record_id: WF-SIM-CRM-ADMIN-001
        source: 22-simulated-crm-admin-workflow-card.md
        employee_confirmed: false
    next_route: enterprise-material-analysis_on_authorized_material_arrival
    diagnosis_gate: blocked_pending_real_confirmation_and_evidence
    master_record_write: forbidden
