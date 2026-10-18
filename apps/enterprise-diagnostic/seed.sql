INSERT OR REPLACE INTO projects (id,name,scope,stage,status,evidence_level,created_by_role) VALUES ('DIA-CRM-001','客户交接流程诊断','从销售提交交接名单到 CRM 归属变更回执','mapping','active','E5','external_builder');
DELETE FROM events WHERE project_id = 'DIA-CRM-001';
DELETE FROM work_items WHERE project_id = 'DIA-CRM-001';
INSERT INTO work_items (id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,employee_description) VALUES
('WI-001','DIA-CRM-001','销售提交客户交接名单','销售整理交接清单并提交 OA 审批。','mapping','needs_input','employee','销售运营专员',40,'缺少异常客户的处理说明','补充流程描述',''),
('WI-002','DIA-CRM-001','审批结束后的执行通知','核对 OA 审批结束后 CRM 管理员如何得知任务。','facts','awaiting_verification','verifier','流程核验人员',78,'访谈与系统截图的通知口径不同','核对通知方式','CRM 管理员每天定时搜索已完成审批。'),
('WI-003','DIA-CRM-001','相似客户记录的唯一性判断','两条客户名称接近、联系人相同，但原归属团队不同。','facts','blocked','verifier','流程核验人员',62,'缺少唯一客户 ID','要求补充材料','找不到唯一编号时，我会把候选记录发回确认。'),
('WI-004','DIA-CRM-001','客户归属变更回执','确认执行结果是否逐条返回申请人。','risk','analysis_ready','external_builder','外部诊断负责人',92,'无','查看风险建议','目前只在群里回复已处理。'),
('WI-005','DIA-CRM-001','两周影子试点建议','用少量脱敏样本验证唯一编号、回执和人工复核口径。','decision','awaiting_decision','owner','企业负责人',100,'等待负责人决定是否试点','审阅试点建议','本事项基于已确认事实生成。'),
('WI-006','DIA-CRM-001','历史交接样本核对','核对十二条脱敏历史样本与访谈描述是否一致。','facts','complete','verifier','流程核验人员',100,'无','查看核验记录','样本已经完成核验。');
