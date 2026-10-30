// F01 regression: real handlers and transactional SQLite; synthetic data, no network.
import assert from 'node:assert/strict';
import { onRequestPost as verify } from '../functions/api/work-items/[itemId]/verification.js';
import { onRequestPost as supplement } from '../functions/api/work-items/[itemId]/evidence-supplement.js';
import { onRequestGet as employeeTask } from '../functions/api/projects/[projectId]/employee-task.js';
import { D1Harness, bearerRequest } from './d1_harness.mjs';

globalThis.fetch = async () => { throw new Error('External network forbidden'); };
const P='PRJ-P1', WI='WI-P1', EMP='EMP-P1', V1='VER-P1', V2='VER2-P1';
function fixture() {
  const db=new D1Harness();
  db.exec(`
    INSERT INTO accounts(id,email,name,status) VALUES
      ('${EMP}','employee@p1.invalid','合成员工','active'),('OTHER-P1','other@p1.invalid','其他员工','active'),
      ('${V1}','verifier@p1.invalid','首核','active'),('${V2}','verifier2@p1.invalid','独立二核','active');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role)
      VALUES('${P}','电商订单补证','接单→库存→履约→售后','facts','active','E5','external_builder');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at)
      VALUES('AUTH-P1','${P}','合成授权','负责人','owner@p1.invalid','纯合成','synthetic://auth','authorized','${V1}','AUTH-P1','n','h','2099-01-01T00:00:00Z');
    INSERT INTO project_memberships(project_id,account_id,role,status) VALUES
      ('${P}','${EMP}','employee','active'),('${P}','OTHER-P1','employee','active'),
      ('${P}','${V1}','verifier','active'),('${P}','${V2}','verifier','active');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('T-E','${EMP}','${P}','2099-01-01T00:00:00Z','R-E'),('T-O','OTHER-P1','${P}','2099-01-01T00:00:00Z','R-O'),
      ('T-V1','${V1}','${P}','2099-01-01T00:00:00Z','R-V1'),('T-V2','${V2}','${P}','2099-01-01T00:00:00Z','R-V2');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,assignee_account_id,source_employee_account_id,assigned_verifier_id,evidence_completeness,blocking_reason,next_action,judgment_status)
      VALUES('${WI}','${P}','订单诊断补证','纯合成','facts','awaiting_verification','verifier','首核','${V1}','${EMP}','${V1}',60,'待核验','核验','open');
    INSERT INTO evidence_materials(id,project_id,material_key,version,source_type,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference)
      VALUES('MAT-P1','${P}','MKEY-P1',1,'csv','authorized','verified','project','${V1}','${WI}','合成退款规则','synthetic://policy');
    INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,required,impact_level,second_confirmation_status,material_status,status,source_refs_json,first_verified_by_account_id,evidence_level) VALUES
      ('F-HIGH','${P}','${WI}','execution_judgment','退款金额由主管与财务分别核对','judgments',1,'high','pending','same','awaiting_second_confirmation','["MAT-P1"]','${V1}','E2'),
      ('F-NEED','${P}','${WI}','exception_handoff','退货照片与签收凭证待补齐','exceptions',1,'normal','not_required','unverified','open','[]',NULL,NULL),
      ('F-NORMAL','${P}','${WI}','trigger_input','已付款订单按订单号接单','trigger',1,'normal','not_required','unverified','open','[]',NULL,NULL);
  `);
  return db;
}
async function call(db,handler,token,body,params={itemId:WI}) {
  const r=await handler({request:bearerRequest('http://127.0.0.1/test',token,body),env:{DB:db},params});
  return {status:r.status,body:await r.json()};
}
const requestEvidence=db=>call(db,verify,'T-V1',{factId:'F-NEED',decision:'insufficient_evidence',reason:'EC02缺破损照片与退货签收',requestedMaterial:'照片说明及签收凭证',responsibleAccountId:EMP});
const second=db=>call(db,verify,'T-V2',{factId:'F-HIGH',action:'second_confirmation',secondConfirmationReason:'独立核对合成规则与退款分工'});
const normal=db=>call(db,verify,'T-V1',{factId:'F-NORMAL',decision:'same',reason:'合成订单号可定位',sourceRefs:['MAT-P1'],evidenceLevel:'E1'});
const provide=(db,token='T-E',sourceType='text')=>call(db,supplement,token,{material:'合成照片说明及退货签收已补齐',reference:'synthetic://EC02/receipts',sourceType});
function snapshot(db) {
  return JSON.stringify(Object.fromEntries(['work_items','candidate_facts','evidence_supplements','evidence_materials','events','fact_judgments','fact_second_confirmations','idempotency_records'].map(t=>[t,db.all(`SELECT * FROM ${t} ORDER BY rowid`)])));
}
async function assertWaiting(db) {
  const item=db.get('SELECT * FROM work_items WHERE id=?',WI);
  assert.equal(item.status,'blocked','active supplement must remain blocked');
  assert.equal(item.judgment_status,'blocked');
  assert.equal(item.blocking_reason,'证据不足，等待补充材料');
  assert.equal(db.get('SELECT status FROM evidence_supplements WHERE id=?',item.supplement_id).status,'waiting');
  const r=await call(db,employeeTask,'T-E',undefined,{projectId:P});
  assert.equal(r.status,200);
  assert.equal(r.body.task.supplementation?.status,'waiting','employee refresh must retain the recovery entry');
  assert.equal(r.body.task.supplementation?.id,item.supplement_id);
}
async function assertProvided(db) {
  const r=await provide(db); assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal(r.body.recovery.factId,'F-NEED');
  const item=db.get('SELECT * FROM work_items WHERE id=?',WI);
  assert.equal(item.status,'awaiting_verification');assert.equal(item.evidence_version,2);
  assert.equal(db.get("SELECT status FROM candidate_facts WHERE id='F-NEED'").status,'open');
  const mat=db.get('SELECT * FROM evidence_materials WHERE id=?',r.body.recovery.materialId);
  assert.equal(mat.authorization_status,'pending');assert.equal(mat.integrity_status,'pending');
  const before=snapshot(db);const replay=await provide(db);
  assert.equal(replay.status,200);assert.deepEqual(replay.body,r.body);assert.equal(snapshot(db),before,'replay must not duplicate evidence');
  return r;
}
async function holdSecond(db) {
  const original=db.batch.bind(db);let release;
  db.batch=ss=>{
    if(!release&&ss[0].sql.startsWith("UPDATE candidate_facts SET status='confirmed'")) {
      return new Promise((resolve,reject)=>{release=()=>{db.batch=original;try{resolve(original(ss));}catch(e){reject(e);}};});
    }
    return original(ss);
  };
  const pending=second(db);
  for(let i=0;i<100&&!release;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.ok(release,'request must reach the transaction gate');return{pending,release};
}
let passed=0,failed=0;
async function test(name,fn){const db=fixture();try{await fn(db);passed++;console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+' | '+e.message);}finally{db.close();}}
await test('request → independent second confirmation → employee supplement',async db=>{
  assert.equal((await requestEvidence(db)).status,200);assert.equal((await second(db)).status,200);await assertWaiting(db);await assertProvided(db);
});
await test('independent second confirmation → request → employee supplement',async db=>{
  assert.equal((await second(db)).status,200);assert.equal((await requestEvidence(db)).status,200);await assertWaiting(db);await assertProvided(db);
});
await test('request → another normal fact confirmation → employee supplement',async db=>{
  assert.equal((await requestEvidence(db)).status,200);assert.equal((await normal(db)).status,200);await assertWaiting(db);await assertProvided(db);
});
await test('request → employee supplement → independent second confirmation',async db=>{
  assert.equal((await requestEvidence(db)).status,200);await assertProvided(db);assert.equal((await second(db)).status,200);
  assert.equal(db.get('SELECT status FROM work_items WHERE id=?',WI).status,'awaiting_verification','provided request must not keep the task blocked');
});
await test('in-flight second confirmation commits after supplement request',async db=>{
  const h=await holdSecond(db);try{assert.equal((await requestEvidence(db)).status,200);}finally{h.release();}
  assert.equal((await h.pending).status,200);await assertWaiting(db);await assertProvided(db);
});
await test('failed second-confirmation transaction leaves supplement intact; retry works',async db=>{
  assert.equal((await requestEvidence(db)).status,200);const before=snapshot(db);db.failOnEvent=true;
  assert.equal((await second(db)).status,500);assert.equal(snapshot(db),before);db.failOnEvent=false;
  assert.equal((await second(db)).status,200);await assertWaiting(db);await assertProvided(db);
});
await test('role, responsible employee and independent confirmer boundaries remain enforced',async db=>{
  assert.equal((await requestEvidence(db)).status,200);const before=snapshot(db);
  assert.equal((await provide(db,'T-V2')).status,403);assert.equal((await provide(db,'T-O')).status,403);
  assert.equal((await call(db,verify,'T-V1',{factId:'F-HIGH',action:'second_confirmation',secondConfirmationReason:'同一首核人尝试二核'})).status,403);
  assert.equal(snapshot(db),before);await assertWaiting(db);
});
await test('missing or invalid source type rejects with zero writes',async db=>{
  assert.equal((await requestEvidence(db)).status,200);const before=snapshot(db);
  for(const type of ['', 'zip']){assert.equal((await provide(db,'T-E',type)).status,422);assert.equal(snapshot(db),before);}
  await assertProvided(db);
});
await test('provided evidence remains unavailable for confirmation before authorization and review',async db=>{
  assert.equal((await requestEvidence(db)).status,200);const provided=await assertProvided(db);const before=snapshot(db);
  const r=await call(db,verify,'T-V1',{factId:'F-NEED',decision:'same',reason:'尝试跳过材料授权和完整性复核',sourceRefs:[provided.body.recovery.materialId],evidenceLevel:'E2'});
  assert.equal(r.status,422);assert.equal(snapshot(db),before);
});
console.log(`P1 SUPPLEMENT PASS=${passed} FAIL=${failed}`);
if(failed)process.exitCode=1;
