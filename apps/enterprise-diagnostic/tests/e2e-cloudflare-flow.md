# Cloudflare 端到端流程记录

验证时间：2026-08-21

验证地址：`https://enterprise-ai-diagnostic.pages.dev/`

## 已验证

1. `/api/health` 返回 `200`，存储标识为 `cloudflare-d1`。
2. 员工身份只能读取自己的 `WI-001`，初始状态为 `mapping / needs_input`。
3. 员工提交流程描述后，任务变为 `facts / awaiting_verification`，处理人转为核验人员。
4. 核验人员确认事实后，任务变为 `decision / awaiting_decision`，处理人转为企业负责人。
5. 企业负责人选择继续影子试点后，任务变为 `decision / complete`。
6. 事件记录包含 `employee_submitted`、两条 `handoff`、`fact_confirmed` 和 `owner_decision`。
7. 验证结束后已将专用演示项目恢复为干净初始状态，下一次进入仍从员工待补充流程开始。

## 当前边界

- D1 是真实线上持久化数据库，刷新后会保留处理结果。
- 当前身份仍通过演示请求头识别，不是真实账号登录。
- 项目仍使用 E5 合成材料，不连接企业 OA、CRM、ERP 或真实文件。
- 线上数据库只有这个专用演示项目，不应写入企业真实资料。
