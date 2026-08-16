# 拆分流程诊断门测试

## 测试范围

- `PROC-CRM-VISIT-AUTH`：客户访问授权
- `PROC-CRM-OWNER-TRANSFER`：客户归属交接
- 总档案：`05-master-record-v0.2.json`
- 测试性质：纯模拟，不修改总档案

## 结果

| 流程 | 总控决定 | 下一责任人 | 原因 | 是否调用诊断Skill |
|---|---|---|---|---|
| 客户访问授权 | `request_human` | 企业项目负责人 | 总档案仍为 `workflow_mapping`，P0和系统证据未满足 | 否 |
| 客户归属交接 | `request_human` | 企业项目负责人 | 四个岗位均为E5模拟，真实覆盖未满足 | 否 |

两个调度输出均通过结构校验，原因码为：

- `DIAGNOSIS_GATE_NOT_CONFIRMED`
- `H2`

## 当前结论

范围拆分生效。总控没有把两个流程重新合并，也没有因为模拟流程完整而误调用 `enterprise-ai-process-diagnosis`。

下一步只有两条安全路径：

1. 继续补真实岗位与系统证据；
2. 明确进入“纯模拟诊断”，所有技术路线和收益仍标记为E5假设，不得冒充真实企业结论。
