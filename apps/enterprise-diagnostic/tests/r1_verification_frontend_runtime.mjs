// Execute the actual submit function; network/DOM are unit boundaries, not E2E.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const extract=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start)));
const source=extract('async function runBackendAction(', 'async function persistEmployeeSubmission(')+extract('async function submitVerifierJudgment(', 'async function reviewFormalMaterial(');
let count=0;
for(const second of [false,true])for(const status of [200,409,500]){
 const sent=[],feedback=[];let reloads=0;
 const state={formalSessionActive:true,formalProjectId:'PRJ-R1',verifierFact:{factId:'F',workItemId:'WI',evidenceVersion:3,flowCardVersion:2,...(second?{secondConfirmationAction:'second_confirmation'}:{})},workItems:[],verifierDecision:'same',verifierReason:'当前页面的具名理由',verifierCorrection:'',verifierSubmitting:false,verifierVersionConflict:false,verifierSourceRefs:['MAT']};
 const submit=async(id,payload)=>{sent.push({id,payload});if(status!==200)throw Object.assign(new Error('test response'),{status,code:status===409?'verification_version_conflict':'server_failure'});return {};};
 const context={state,window:{diagnosticApi:{verifyFormal:submit}},document:{querySelector:selector=>selector==='#verifier-reason'?{value:state.verifierReason}:selector==='#verifier-correction'?{value:''}:selector.endsWith('#verifier-evidence-level')?{value:'E2'}:null},renderWorkspace(){},renderVerifierWorkbench(){},setFeedback:(...args)=>feedback.push(args),showMessage:message=>{throw Error(message);},loadFormalVerifierWorkspace:async()=>{reloads++;}};
 vm.createContext(context);vm.runInContext(source,context);await context.submitVerifierJudgment();
 assert.equal(sent.length,1);assert.equal(sent[0].payload.evidenceVersion,3);assert.equal(sent[0].payload.flowCardVersion,2);
 assert.equal(sent[0].payload[second?'secondConfirmationReason':'reason'],'当前页面的具名理由');assert.equal(state.verifierSubmitting,false);
 if(status===409){
  assert.equal(state.verifierVersionConflict,true);assert.equal(state.verifierDecision,'');assert.equal(state.verifierReason,'');assert.equal(state.verifierCorrection,'');assert.equal(state.verifierSourceRefs.length,0);assert.equal(reloads,0,'conflict must not auto-refresh or auto-retry');
  await context.submitVerifierJudgment();assert.equal(sent.length,1,'old judgment cannot resubmit');
 }else if(status===500){assert.equal(state.verifierVersionConflict,false);assert.equal(state.verifierReason,'当前页面的具名理由');assert.equal(reloads,0);}
 else assert.equal(reloads,1);
 count++;console.log(`PASS ${second?'second':'first'} HTTP${status} viewed payload and recovery behavior`);
}
console.log('R1 FRONTEND PASS='+count+' FAIL=0');
