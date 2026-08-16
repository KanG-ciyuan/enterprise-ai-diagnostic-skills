# 企业AI流程诊断总控

这个Skill负责继续推进一项已经建立总档案的企业流程诊断。它不替代访谈、员工摸排、材料分析或流程诊断，只判断当前发生了什么、由谁处理、依据什么、失败怎么办。

## 什么时候使用

- “继续处理这次流程诊断，告诉我下一步由谁做。”
- “员工已经确认流程卡，请根据总档案判断后续动作。”
- “摸排中上传了Excel，应该调用哪个能力并怎样返回原任务？”
- “授权撤回了，请停止相关派生并生成恢复条件。”

只需要做一项独立工作时，直接使用对应子Skill，不要触发总控。

## 当前操作方式

1. 提供一份`enterprise-ai-diagnostic-master-record`总档案；
2. 提供一个当前事件，或用自然语言说明刚刚发生的事情；
3. 总控检查范围、授权、版本和来源；
4. 总控调用一个专业Skill，或生成一个外部/人工任务；
5. 子Skill结果以新事件返回，再由总控重新判断。

当前版本只输出`scheduling_proposal`，不会自动写JSON总档案，不会联系员工，也没有数据库或统一入口。

## 四个专业出口

- 管理层问题和范围不清：`enterprise-interview-preparation`
- 员工专属摸排：`enterprise-workflow-mapping`
- 附件与证据：`enterprise-material-analysis`
- 达到诊断门：`enterprise-ai-process-diagnosis`

## 未来产品

统一入口可以把同一套决策映射到企业负责人、员工和平台运营工作台。FastAPI、PostgreSQL、对象存储和任务队列属于未来软件实现，不属于这个Skill。

## 验证

```bash
python3 -m unittest discover -s tests -v
python3 scripts/orchestrate_event.py <master-record.json> <event.json>
python3 scripts/validate_orchestrator_output.py <output.json>
```

结构通过不等于企业材料真实、诊断已批准或生产实施已授权。

