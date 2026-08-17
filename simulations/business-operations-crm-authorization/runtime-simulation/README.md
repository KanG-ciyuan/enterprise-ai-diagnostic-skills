# CRM客户授权离线运行模拟

本目录是 E5 控制夹具，不包含真实客户、员工、OA、CRM或企业材料。

运行：

```bash
python3 enterprise-ai-diagnostic-orchestrator/scripts/run_offline_simulation.py \
  simulations/business-operations-crm-authorization/runtime-simulation/master-record.json \
  simulations/business-operations-crm-authorization/runtime-simulation/scenario.json \
  /tmp/crm-runtime-simulation-result
```

输出目录必须不存在。运行成功后会生成：

- `runtime-log.jsonl`：每个路由决定和明确人工动作；
- `summary.json`：场景标记、事件数量和最终阶段；
- `final-master-record.json`：仅用于审阅的模拟总档案快照。

本夹具验证材料路由、H1人工确认、授权撤回暂停和负责人手动恢复。它不验证真实模型、接口、权限、业务收益或生产写入能力。
