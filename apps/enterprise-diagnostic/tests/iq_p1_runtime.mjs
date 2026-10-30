import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {buildTrustedLedger,runHarness,MAX_MODEL_CALLS_PER_TASK} from '../functions/api/agent/_adapter.js';
import {deriveInterviewRecord} from '../functions/api/agent/_interview-record.js';
const cases=JSON.parse(readFileSync(new URL('./fixtures/iq_p1_original_evidence.json',import.meta.url)));
let passed=0,failed=0;function check(name,ok){console.log(`${ok?'PASS':'FAIL'} ${name}`);ok?passed++:failed++;}
for(const [name,c]of Object.entries(cases)){
 const x=c.context,answers={...x.priorAnswers,[x.currentQuestion.key]:x.currentAnswer};
 const ledger=buildTrustedLedger(answers,[],{statementHistory:x.employeeStatementHistory,burdenAsked:x.employeeStatementHistory.some(h=>h.dimension==='burden')});
 const r=await runHarness({projectId:'PRJ-IQ-'+name,role:'employee',answers,persistedAnswers:x.priorAnswers,questionKey:x.currentQuestion.key,answer:x.currentAnswer,modelCallBudget:{claimed:c.originalTurn,limit:12,remaining:12-c.originalTurn}},ledger,async()=>c.modelReply);
 if(name!=='C')check(name+' original repeated/unknown question converges to E3 draft',r.turn.turnKind==='draft'&&r.turn.facts.every(f=>f.evidenceLevel==='E3'));
 else check('C original unresolved contradiction still asks clarification',r.turn.turnKind==='question'&&r.turn.nextQuestion.key==='trigger');
}
// A remaining gap must not be filled merely because quota is almost exhausted.
for(const absent of ['steps','burden']) {
 const x=cases.A.context,answers={...x.priorAnswers,[x.currentQuestion.key]:x.currentAnswer};delete answers[absent];
 const history=x.employeeStatementHistory.filter(h=>h.dimension!==absent);
 const ledger=buildTrustedLedger(answers,[],{statementHistory:history,burdenAsked:absent!=='burden'});
 const r=await runHarness({projectId:'PRJ-GAP',answers,persistedAnswers:answers,questionKey:'exceptions',answer:answers.exceptions,modelCallBudget:{claimed:12,limit:12,remaining:0}},ledger,async()=>cases.A.modelReply);
 check('quota pressure does not waive missing '+absent,r.turn.turnKind==='question'&&r.turn.nextQuestion.key===absent);
}
{
 const x=cases.B.context,answers={...x.priorAnswers,[x.currentQuestion.key]:x.currentAnswer};
 const history=x.employeeStatementHistory.filter(h=>h.dimension!=='handoff');
 history.push({seq:99,dimension:'handoff',kind:'initial',text:answers.handoff});
 const ledger=buildTrustedLedger(answers,[],{statementHistory:history,burdenAsked:true});
 const reply=JSON.stringify({turnKind:'question',question:{key:'handoff',dimension:'handoff',label:'责任人',prompt:'出库扫码由你还是复核员执行？'},coverageHints:[],proposedInferences:[]});
 const r=await runHarness({projectId:'PRJ-CLARIFY',answers,persistedAnswers:answers,questionKey:'handoff',answer:answers.handoff,modelCallBudget:{claimed:7,limit:12,remaining:5}},ledger,async()=>reply);
 check('mixed known/unknown answer permits one useful actor clarification',r.turn.turnKind==='question'&&r.turn.nextQuestion.key==='handoff');
}
for(const text of ['WMS任务是否挂在我名下，我说不准，得系统管理员核实。','平台按钮的精确名称我拿不准。','金额收款不符的退款我没实际处理过，不编分支。','我未经历过取消回退。','这个质检步骤我没接触过。','这个费用口径我无法确认。']){
 const h=[{seq:7,dimension:'handoff',text,kind:'initial'}],r=deriveInterviewRecord({handoff:text},h);
 check('natural unknown '+text,r.unresolved.some(u=>u.quote===text&&u.statementSeq===7&&u.evidenceNeeded.includes('E3'))&&h[0].text===text);
}
for(const text of ['我没有退款权限，由财务执行。','我未修改原始记录，交给财务主管复核。','素材版权拿不准就换同款','我没实际处理过的情况不在本次范围，已由主管出示记录确认。']){
 // The last is still an employee knowledge gap, even when they report another source.
 if(text.includes('没实际处理'))continue;
 check('no fabricated unknown for known authority '+text,deriveInterviewRecord({judgments:text},[]).unresolved.length===0);
}
check('quota unchanged',MAX_MODEL_CALLS_PER_TASK===12);
const src=readFileSync(new URL('../app.js',import.meta.url),'utf8');
function fn(name){const m=src.match(new RegExp('(?:async )?function '+name+'\\([^]*?\\n\\}'));return m?.[0]||'';}
const defs=['formalPendingTurnKey','writeFormalPendingTurn','clearFormalPendingTurn','restoreFormalPendingTurn','advanceFormalEmployeeFixed','continueFormalEmployeeAgent'].map(fn).join('\n');
for(const code of ['model_call_limit_reached','model_transport_error']){
 const memory=new Map(),input={value:''},question={key:'handoff',label:'交接',prompt:'交接确认在哪里？'};
 const ctx={state:{formalProjectId:'PRJ-IQ',formalEmployeeTask:{id:'WI-IQ',assigneeAccountId:'EMP-IQ',draftLedger:{pendingQuestion:question},draftAnswers:{},draftRevision:4},formalEmployeeAnswers:Object.fromEntries(['trigger','inputs','steps','judgments','exceptions','handoff','burden'].map(k=>[k,'已有陈述'])),formalAgentQuestion:question,formalEmployeeStep:'questions',formalEmployeeEditIndex:null,formalInterviewRevision:4},formalEmployeeQuestions:['trigger','inputs','steps','judgments','exceptions','handoff','burden'].map(key=>({key})),sessionStorage:{setItem:(k,v)=>memory.set(k,v),getItem:k=>memory.get(k)||null,removeItem:k=>memory.delete(k)},document:{querySelector:()=>input},window:{diagnosticApi:{agentTurn:async()=>{const e=new Error('访谈暂不可用');e.code=code;e.status=code==='model_call_limit_reached'?429:503;throw e;}}},persistFormalEmployeeDraftNow:async()=>true,renderFormalEmployeeWorkbench:()=>{},showMessage:()=>{},resumeFormalAgentQuestion:()=>question};
 vm.createContext(ctx);vm.runInContext(defs,ctx);await vm.runInContext("continueFormalEmployeeAgent({key:'handoff',label:'交接',prompt:'交接确认在哪里？'},'这个回执系统我说不准，要主管核实。')",ctx);
 check(code+' failure does not show completed card',ctx.state.formalEmployeeStep==='questions');
 check(code+' answer retained outside accepted answers',ctx.state.formalPendingTurn?.text==='这个回执系统我说不准，要主管核实。'&&ctx.state.formalEmployeeAnswers.handoff==='已有陈述');
 if(fn('restoreFormalPendingTurn')){
   ctx.state.formalPendingTurn=null;vm.runInContext('restoreFormalPendingTurn()',ctx);check(code+' refresh restores paused unsent answer',ctx.state.formalPendingTurn?.text.includes('说不准')&&ctx.state.formalPendingTurn?.code===code);
   ctx.state.formalEmployeeTask.assigneeAccountId='OTHER';vm.runInContext('restoreFormalPendingTurn()',ctx);check(code+' unsent input is isolated by assignee/task',ctx.state.formalPendingTurn===null);
   ctx.state.formalEmployeeTask.assigneeAccountId='EMP-IQ';ctx.state.formalEmployeeTask.draftLedger.statementHistory=[{dimension:'handoff',text:'这个回执系统我说不准，要主管核实。',turnRevision:5}];vm.runInContext('restoreFormalPendingTurn()',ctx);check(code+' server-accepted answer does not reappear as unsent',ctx.state.formalPendingTurn===null&&memory.size===0);
   ctx.sessionStorage.setItem=()=>{throw new Error('storage blocked');};vm.runInContext("writeFormalPendingTurn({key:'handoff'},'未发送原话')",ctx);check(code+' unavailable storage keeps input in memory without claiming durable storage',ctx.state.formalPendingTurn?.text==='未发送原话'&&ctx.state.formalPendingTurn?.storageSaved===false);
 }
}
for (const step of ['intro','questions','card']) {
 const input={value:'',hidden:false},actions={innerHTML:'',querySelector:()=>null};
 const c={state:{formalEmployeeStep:step,formalEmployeeAnswers:{},formalPendingTurn:null,formalAgentQuestion:null,formalEmployeeEditIndex:null},document:{querySelector:s=>s.includes('actions')?actions:input},formalEmployeeQuestions:[{key:'trigger'}],formalUiContract:{employeeQuestionIndex:()=>0},needsStatusBar:()=>false,formalInferenceCapacityMarker:()=>null,escapeMarkup:String};
 vm.createContext(c);let ok=true;try{vm.runInContext(fn('renderFormalEmployeeComposer')+'\nrenderFormalEmployeeComposer()',c);}catch(_){ok=false;}
 check(step+' composer handles absent pending turn without a render failure',ok);
}
console.log(JSON.stringify({passed,failed}));process.exitCode=failed?1:0;
