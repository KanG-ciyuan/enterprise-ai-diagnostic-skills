import { readFileSync } from 'node:fs';
import { appendStatementHistory, buildTrustedLedger, runHarness } from '../functions/api/agent/_adapter.js';
import { deriveInterviewRecord } from '../functions/api/agent/_interview-record.js';
import { D1Harness, bearerRequest } from './d1_harness.mjs';
import { onRequestGet as verifierFacts } from '../functions/api/formal/projects/[projectId]/verifier-facts.js';
const original = JSON.parse(readFileSync(new URL('./fixtures/ai_p1_original_interviews.json', import.meta.url)));
let failed=0, passed=0;
function check(name, ok) { console.log(`${ok?'PASS':'FAIL'} ${name}`); ok?passed++:failed++; }
for (const [name, data] of Object.entries(original)) {
  // Replay a recorded response is a deterministic regression, not a real-model test.
  const ledger=buildTrustedLedger(data.answers,[],{statementHistory:data.history,burdenAsked:true});
  const {turn}=await runHarness({projectId:'PRJ-P1-'+name,answers:data.answers,persistedAnswers:data.answers,questionKey:'burden',answer:data.answers.burden,materialStatus:'none_available'},ledger,async()=>data.modelReply);
  const card=turn.flowCard;
  check(name+' recorded interview reaches draft',turn.turnKind==='draft');
  if(name==='A') {
    check('A ERP refund application retained',card?.dimensions.handoff.includes('ERP建立退款申请'));
    check('A manual finance notification retained',card?.dimensions.handoff.includes('当班财务'));
    check('A platform success closure retained',card?.dimensions.handoff.includes('退款成功'));
    check('A obsolete account stays in history, outside current card',!card?.dimensions.steps.includes('每笔都先核库存')&&deriveInterviewRecord(data.answers,data.history).dimensions.steps.includes('原口径'));
    check('A urgent-order correction visible in steps',card?.dimensions.steps.includes('急单'));
    check('A ERP sync unknown handed off',card?.unresolved.some(u=>JSON.stringify(u).includes('同步')));
    check('A urgent-order responsibility unknown handed off',card?.unresolved.some(u=>JSON.stringify(u).includes('补台账')));
    check('A waiting time not measured handed off',card?.unresolved.some(u=>/没统计|未统计|没计时/.test(JSON.stringify(u))));
  } else {
    check('B original input fields retained',card?.dimensions.inputs.includes('订单号、SKU、数量和收货地址'));
    check('B page exception retained',card?.dimensions.inputs.includes('页面报错'));
    check('B stock recovery retained',card?.dimensions.handoff.includes('可交仓'));
    check('B replacement handoff retained',card?.dimensions.handoff.includes('替换SKU'));
    check('B unknown refund threshold handed off',card?.unresolved.some(u=>JSON.stringify(u).includes('阈值')));
  }
  check(name+' E3 employee statement remains',turn.facts.every(f=>f.evidenceLevel==='E3'&&f.provenanceStatus==='employee_statement'));
  check(name+' unresolved output matches card',turn.unresolvedQuestions.length===card?.unresolved.length);
}
for(const reverse of [false,true]) {
  const inputs=['我在ERP建立退款申请，再手动发群通知当班财务。','必须等平台退款成功才关单，ERP流水不能代替。'];
  if(reverse)inputs.reverse();
  let history=[];for(const text of inputs)history=appendStatementHistory({prior:history,dimension:'handoff',text}).history;
  const before=JSON.stringify(history),record=deriveInterviewRecord({handoff:inputs.at(-1)},history);
  check('handoff order '+reverse+' preserves application and close',record.dimensions.handoff.includes('ERP建立退款申请')&&record.dimensions.handoff.includes('平台退款成功'));
  check('projection does not mutate original history '+reverse,JSON.stringify(history)===before);
}
let h=appendStatementHistory({prior:[],dimension:'inputs',text:'我先看订单号和SKU，库存同步周期不知道。'}).history;
const again=appendStatementHistory({prior:h,dimension:'inputs',text:h[0].text});
check('same-answer retry is idempotent',again.history.length===h.length);
const withdrawn=appendStatementHistory({prior:h,dimension:'inputs',withdraw:true}).history;
check('withdrawn text remains in audit history but leaves current card',withdrawn.length===2&&deriveInterviewRecord({},withdrawn).dimensions.inputs==='');
h=appendStatementHistory({prior:h,dimension:'inputs',text:'本人现在看ERP页面和仓库预留，具体同步周期仍不知道。',intent:'correction'}).history;
const corrected=deriveInterviewRecord({inputs:h.at(-1).text},h);
check('explicit correction intent labels old account',corrected.dimensions.inputs.includes('原口径')&&corrected.dimensions.inputs.includes('员工修正'));
check('unknown has traceable employee source and human receiver',corrected.unresolved.some(u=>u.quote.includes('不知道')&&u.statementSeq&&u.requestedFrom.includes('核验人员')&&u.evidenceNeeded.includes('E3')));
check('conditional handling is not manufactured as an unknown',deriveInterviewRecord({exceptions:'库存不确定就暂停核对，交仓库确认。'},[]).unresolved.length===0);
const longText='先核订单、SKU和数量。'.repeat(40)+'随后建立ERP退款申请并通知财务。';
const longHistory=appendStatementHistory({prior:[],dimension:'steps',text:longText}).history;
check('accepted long statement is not clipped to historical 300-char preview',longHistory[0].text===longText&&longHistory[0].text.endsWith('随后建立ERP退款申请并通知财务。'));
{
  const db=new D1Harness();
  db.exec(`
    INSERT INTO accounts(id,email,name,status,account_role) VALUES ('VP1','vp1@test.invalid','核验人','active','member'),('VP2','vp2@test.invalid','另一核验人','active','member');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage) VALUES ('PRJ-AIP1','合成','合成','facts','active','E3','external_builder','VP1','authorized');
    INSERT INTO project_memberships(project_id,account_id,role,status) VALUES ('PRJ-AIP1','VP1','verifier','active'),('PRJ-AIP1','VP2','verifier','active');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES ('AU-AIP1','PRJ-AIP1','合成','合成','owner@test.invalid','合成','synthetic','authorized','VP1','au','n','h','2099-01-01T00:00:00Z');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('TOK-AIP1','VP1','PRJ-AIP1','2099-01-01T00:00:00Z','REF-AIP1');
    INSERT INTO invitations(id,token,project_id,inviter_account_id,email,role,status,expires_at,accepted_account_id,idempotency_key) VALUES ('IV-AIP1','iv','PRJ-AIP1','VP2','vp1@test.invalid','verifier','accepted','2099-01-01T00:00:00Z','VP1','ivkey');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assigned_verifier_id,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action) VALUES ('WI-SELF','PRJ-AIP1','合成','合成','facts','awaiting_verification','VP1','verifier','核验人',0,'待核验','核对'),('WI-OTHER','PRJ-AIP1','另一任务','合成','facts','awaiting_verification','VP2','verifier','另一核验人',0,'待核验','核对');
  `);
  const card={unresolved:[{dimension:'inputs',quote:'ERP同步周期不知道',reason:'同步周期待核实',requestedFrom:'核验人',evidenceNeeded:'系统同步记录'},{dimension:'burden',quote:'没计时',reason:'耗时待核实'}]};
  db.prepare('UPDATE work_items SET workflow_card_json=? WHERE id=?').bind(JSON.stringify(card),'WI-SELF').run();
  db.prepare('UPDATE work_items SET workflow_card_json=? WHERE id=?').bind(JSON.stringify({unresolved:[{dimension:'inputs',reason:'不得泄漏的另一任务'}]}),'WI-OTHER').run();
  for(const [id,wi,source]of [['CF-I','WI-SELF','inputs'],['CF-B','WI-SELF','burden'],['CF-O','WI-OTHER','inputs']]) db.prepare("INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,status,required) VALUES (?,'PRJ-AIP1',?,'trigger_input','合成员工陈述',?,'open',1)").bind(id,wi,source).run();
  const response=await verifierFacts({request:bearerRequest('http://localhost/api/formal/projects/PRJ-AIP1/verifier-facts','TOK-AIP1'),env:{DB:db},params:{projectId:'PRJ-AIP1'}});
  const body=await response.json();
  check('verifier receives assigned fact gaps',response.status===200&&body.facts.find(f=>f.factId==='CF-I')?.unresolvedQuestions[0]?.quote==='ERP同步周期不知道');
  check('gap projection preserves fact-dimension boundary',body.facts.find(f=>f.factId==='CF-I')?.unresolvedQuestions.every(u=>u.dimension==='inputs'));
  check('other assignee task and its gaps remain inaccessible',!JSON.stringify(body).includes('不得泄漏')&&!body.facts.some(f=>f.factId==='CF-O'));
  check('handoff does not mark facts verified',body.facts.every(f=>f.status==='open'));
  db.close();
}
console.log(JSON.stringify({passed,failed}));
process.exitCode=failed?1:0;
