# 外部 AI 审核说明

请把本目录视为“虚构企业的端到端概念验证”，不要视为真实客户报告或已完成产品。

## 建议依次阅读

1. `README.md`：测试边界；
2. `01-difficult-employee-mapping.md`：困难员工访谈与确认卡；
3. `02-cross-role-cards.md`：四张岗位卡摘要；
4. `03-consultant-merge-and-challenge.md`：合并与质疑台账；
5. `04-internal-diagnosis.md`：改造方内部输出；
6. `05-boss-brief.md`：企业负责人沟通版；
7. `06-test-conclusion.md`：已验证和未验证边界。

同时阅读：

- `../../enterprise-workflow-mapping/SKILL.md`
- `../../enterprise-ai-process-diagnosis/SKILL.md`
- `../../docs/superpowers/specs/2026-08-12-enterprise-ai-diagnosis-skill-system-design.md`

## 审核问题

请按严重程度输出问题，并引用具体文件和段落：

1. 员工访谈是否存在诱导、责备、一次问多个问题或凭空补全？
2. 流程卡是否把 E1、E2、E3、E4 和未知项混淆？
3. 员工确认是否被错误当成企业级事实证明？
4. 多岗位合并是否覆盖了原卡、忽略冲突或跳过缺席角色？
5. 改造方质疑是否真正会改变技术路线或试点，而不是形式问题？
6. 技术路线是否清楚区分业务流程、规则、工作流、API、AI 工作流、有界 Agent 和人工？
7. 是否存在“为了用 AI 而用 AI”、过早推荐 Agent 或低估人工责任？
8. 影子试点是否有样本、基线、异常、人工接管、通过/观察/停止和回退条件？
9. 企业负责人沟通版是否隐藏风险、夸大收益或做出无证据承诺？
10. 哪些能力已经由 Skill 实现，哪些只是本轮人工编排的原型？

最后给出：`可继续内部模拟 / 可小范围真实试用 / 可公开发布` 三选一，并说明尚缺的最小证据。
