import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { buildInferenceRecords, buildInferences, resolveInferenceJudgment } from '../functions/api/agent/_adapter.js';
import { applyAnswerEvidence, validateSubmissionEvidence } from '../functions/api/agent/_evidence.js';

let passed=0,failed=0;
const check=(name,ok)=>{console.log(`${ok?'PASS':'FAIL'} ${name}`);ok?passed++:failed++;};
const answers={trigger:'已付款订单进入待处理队列，由客服接单。',inputs:'看订单号、SKU、数量、地址和ERP可售库存。',steps:'先核对库存再导出CSV，仓管接单后由仓库履约。',judgments:'库存冲突先暂停并找仓库主管明确确认。',exceptions:'缺破损照片时先请客户补齐再交运营主管。',handoff:'审批后客服建立ERP退款申请并通知财务，平台退款成功才关单。',burden:'单笔核对大约几分钟，等待时间另外记录。'};
const stamp=(entry)=>({verdict:'agree',correction:'',contentVersion:entry.contentVersion,templateVersion:entry.templateVersion??null,evidenceHash:entry.evidenceHash,evidenceVersion:entry.evidenceVersion});
async function draftFor(values=answers,count=15){
  const records=buildInferenceRecords([], [...buildInferences({statements:values},{}),...Array.from({length:count-4},(_,i)=>({source:'model',text:`合成待判定读法${i+1}：客服在订单环节${i+1}保留人工交接，需要本人确认。`,basis:'steps'}))]).records;
  const result=await applyAnswerEvidence({existing:{answers:{},ledger:{},revision:0},answers:values,authoritativeInferences:records});
  return{schemaVersion:2,revision:1,answers:result.answers,ledger:{statementHistory:result.history,evidence:result.evidence,authoritativeInferences:result.authoritativeInferences},inferenceVerdicts:Object.fromEntries(result.authoritativeInferences.map(e=>[e.id,stamp(e)])),submissionText:''};
}
const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const names=['formalIsCapacityMarker','formalInferenceJudgmentState','formalVisibleInferences','formalInferenceSummary','formalVerdictsPayload'];
const pure=names.map(name=>{const i=source.indexOf('function '+name+'(');if(i<0)throw Error(name);return source.slice(i,source.indexOf('\n}',i)+2);}).join('\n');
const context=vm.createContext({state:{formalAgentInferences:[],formalInferencePending:{},formalInferencePriorVerdicts:{}}});
vm.runInContext(pure,context);
for(const count of [13,15,40]){
  const draft=await draftFor(answers,count);context.state.formalAgentInferences=draft.ledger.authoritativeInferences;
  context.state.formalAgentInferences.push({id:'INF-CAPACITY-BLOCK',source:'capacity_block',isCapacityMarker:true});
  check(`all ${count} stored inferences reachable in UI`,vm.runInContext('formalVisibleInferences().length',context)===count);
  context.verdicts=draft.inferenceVerdicts;
  const summary=vm.runInContext('formalInferenceSummary(formalVisibleInferences(),verdicts)',context);
  check(`summary covers all ${count}, excludes capacity marker`,summary.total===count&&summary.valid===count);
  const last=draft.ledger.authoritativeInferences.filter(e=>!e.isCapacityMarker).at(-1);
  delete context.verdicts[last.id];
  check(`last overflow row must still be judged (${count})`,vm.runInContext('formalInferenceSummary(formalVisibleInferences(),verdicts).unjudged',context)===1);
  context.state.formalInferencePending={[last.id]:{verdict:'correct',correction:'仅为本人操作，不代表已核验企业事实。'}};
  const payload=vm.runInContext('formalVerdictsPayload()',context);
  check(`overflow row sends current version echo (${count})`,payload[last.id]?.evidenceVersion===last.evidenceVersion&&payload[last.id]?.contentVersion===last.contentVersion);
}
for(const length of [299,300,301,442,500,1000,4000]){
  const text='接单后先看已付款订单和对应的订单号。'.repeat(Math.ceil(length/20)).padEnd(length,'单').slice(0,length);
  const draft=await draftFor({...answers,trigger:text},4);
  const gate=await validateSubmissionEvidence({draft,answers:draft.answers,materialStatus:'none_available'});
  check(`normal ${length}-character answer does not look stale`,gate.ok===true);
}
{
  const prefix='先核对订单与库存，再交仓管。'.repeat(30).slice(0,350);
  const first=await draftFor({...answers,trigger:prefix+'首版尾部：平台已付款才接单。'},4);
  const prior=first.ledger.authoritativeInferences.find(e=>e.basis==='trigger');
  const next=await applyAnswerEvidence({existing:first,answers:{...first.answers,trigger:prefix+'新版尾部：以待处理队列为接单起点。'}});
  const entry=next.authoritativeInferences.find(e=>e.id===prior.id);
  check('tail-only change keeps preview but advances evidence version',entry.quote===prior.quote&&entry.evidenceVersion>prior.evidenceVersion);
  check('tail-only change invalidates old human judgment',resolveInferenceJudgment(entry,first.inferenceVerdicts)==='stale');
  const updated={...first,revision:2,answers:next.answers,ledger:{...first.ledger,statementHistory:next.history,evidence:next.evidence,authoritativeInferences:next.authoritativeInferences}};
  check('new full evidence remains internally consistent',(await validateSubmissionEvidence({draft:updated,answers:updated.answers})).ok===true);
  const restored=await applyAnswerEvidence({existing:updated,answers:first.answers});
  const restoredEntry=restored.authoritativeInferences.find(e=>e.id===prior.id);
  check('restoring old text does not revive old judgment',restoredEntry.evidenceVersion>entry.evidenceVersion&&resolveInferenceJudgment(restoredEntry,first.inferenceVerdicts)==='stale');
  const bad=structuredClone(first);bad.ledger.authoritativeInferences.find(e=>e.basis==='trigger').quote='来源不符的伪造引用';
  const legacy=structuredClone(first);const legacyEntry=legacy.ledger.authoritativeInferences.find(e=>e.basis==='trigger');legacyEntry.id='INF-LEGACY-TRIGGER';
  check('legacy stored ID with valid canonical preview remains compatible',(await validateSubmissionEvidence({draft:legacy,answers:legacy.answers})).ok===true);
  check('wrong preview is still rejected',(await validateSubmissionEvidence({draft:bad,answers:bad.answers})).ok===false);
  const noQuote=structuredClone(first);noQuote.ledger.authoritativeInferences.find(e=>e.basis==='trigger').quote=null;
  check('missing template preview is still rejected',(await validateSubmissionEvidence({draft:noQuote,answers:noQuote.answers})).ok===false);
  const tampered=structuredClone(first);tampered.answers.trigger=prefix+'绕过证据入口改写尾部';
  check('tail tampering without new history/digest is rejected',(await validateSubmissionEvidence({draft:tampered,answers:tampered.answers})).ok===false);
  const wrongRefs=structuredClone(updated);wrongRefs.ledger.authoritativeInferences.find(e=>e.id===prior.id).evidenceRefs=prior.evidenceRefs;
  check('old full-text digest cannot pass via matching preview',(await validateSubmissionEvidence({draft:wrongRefs,answers:wrongRefs.answers})).ok===false);
}
console.log(JSON.stringify({passed,failed}));process.exitCode=failed?1:0;
