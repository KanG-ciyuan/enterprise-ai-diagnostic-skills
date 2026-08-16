# CRM客户授权交接合成输入材料

> 证据等级：E5 AI模拟，待真实企业验证。

本目录模拟企业负责人、员工或改造方在实际使用入口中可能上传的材料形态。所有企业、员工、客户、编号和时间均为虚构，不对应任何真实主体。

## 文件

- `crm-customer-handover-list.xlsx`：销售申请人上传的客户交接Excel清单；
- `oa-approval-export.csv`：OA审批记录导出；
- `crm-operation-log.csv`：CRM归属修改和异常日志导出；
- `employee-interview-transcript.md`：员工与Agent对话的文字转写；
- `management-meeting-minutes.md`：管理层启动会议纪要。

这些文件属于业务输入层。内部的`40-synthetic-test-matrix.json`和Python测试属于测试控制层，不会要求员工上传。

## 使用边界

- 只用于测试材料识别、证据分级、冲突发现、补证和总控路由；
- 不得把模拟姓名、数量、时效或处理结果写成真实企业事实；
- 不得用这些文件证明真实ROI、生产可用性或员工接受度；
- 所有派生结论继续保留E5标记。
