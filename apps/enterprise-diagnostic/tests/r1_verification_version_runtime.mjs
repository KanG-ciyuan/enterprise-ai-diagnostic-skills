// R1: real handlers + transactional SQLite, synthetic fixtures, no network/model.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {onRequestPost as verify} from '../functions/api/work-items/[itemId]/verification.js';
import {onRequestPost as supplement} from '../functions/api/work-items/[itemId]/evidence-supplement.js';
import {onRequestGet as getFacts} from '../functions/api/formal/projects/[projectId]/verifier-facts.js';
import {D1Harness,bearerRequest} from './d1_harness.mjs';
globalThis.fetch=async()=>{throw new Error('external network forbidden');};
const P='PRJ-R1FIX',WI='WI-R1FIX',F='FACT-R1FIX';
function fixture(high=false){
 const db=new D1Harness();
 db.exec(`
 INSERT INTO accounts(id,email,name,status) VALUES ('E','e@r1.invalid','合成员工','active'),('V','v@r1.invalid','首核','active'),('V2','v2@r1.invalid','独立二核','active');
 INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role) VALUES ('${P}','R1','合成订单库存','facts','active','E5','external_builder');
 INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES ('AUTH','${P}','合成授权','合成负责人','owner@r1.invalid','纯合成','synthetic://auth','authorized','V','auth','n','h','2099-01-01T00:00:00Z');
 INSERT INTO project_memberships(project_id,account_id,role,status) VALUES ('${P}','E','employee','active'),('${P}','V','verifier','active'),('${P}','V2','verifier','active');
 INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES ('T-E','E','${P}','2099-01-01T00:00:00Z','R-E'),('T-V','V','${P}','2099-01-01T00:00:00Z','R-V'),('T-V2','V2','${P}','2099-01-01T00:00:00Z','R-V2');
 INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,source_employee_account_id,assigned_verifier_id,evidence_completeness,blocking_reason,next_action) VALUES ('${WI}','${P}','合成库存核验','纯合成','facts','awaiting_verification','verifier','首核','E','V',60,'待核验','核对');
 INSERT INTO evidence_materials(id,project_id,material_key,version,source_type,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference) VALUES ('MAT','${P}','MKEY',1,'csv','authorized','verified','project','V','${WI}','合成库存记录','synthetic://stock');
 INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,required,impact_level,second_confirmation_status,material_status,status,source_refs_json,evidence_level) VALUES ('${F}','${P}','${WI}','execution_judgment','库存冲突交主管确认','judgments',1,'${high?'high':'normal'}','${high?'pending':'not_required'}','unverified','open','["MAT"]','E2');
 `);return db;
}
const allTables=db=>db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r=>r.name);
const snapshot=db=>JSON.stringify(Object.fromEntries(allTables(db).map(t=>[t,db.all(`SELECT * FROM "${t}" ORDER BY rowid`)])));
async function invoke(db,token,body,handler=verify){const r=await handler({request:bearerRequest('http://127.0.0.1/test',token,body),env:{DB:db},params:{itemId:WI}});return {status:r.status,body:await r.json()};}
async function view(db,token='T-V'){
 const r=await getFacts({request:bearerRequest('http://127.0.0.1/facts',token),env:{DB:db},params:{projectId:P}});assert.equal(r.status,200);
 const f=(await r.json()).facts.find(f=>f.factId===F);assert.ok(f);return {evidenceVersion:f.evidenceVersion,flowCardVersion:f.flowCardVersion};
}
const first=(basis,extra={})=>({factId:F,decision:'same',reason:'已审阅合成依据',sourceRefs:['MAT'],evidenceLevel:'E2',...basis,...extra});
const second=(basis)=>({factId:F,action:'second_confirmation',secondConfirmationReason:'独立审阅合成依据',...basis});
async function changeBasis(db){const r=await invoke(db,'T-V',{factId:F,action:'correct_evidence_level',evidenceLevel:'E1',reason:'合成来源等级更正'});assert.equal(r.status,200);}
async function rejectNoWrites(db,token,payload){const before=snapshot(db);const r=await invoke(db,token,payload);assert.equal(r.status,409,JSON.stringify(r));assert.equal(r.body.code,'verification_version_conflict');assert.match(r.body.detail,/重新.*判断/);assert.equal(snapshot(db),before,'all application tables must remain byte-for-byte unchanged');}
async function readySecond(db){const old=await view(db);assert.equal((await invoke(db,'T-V',first(old))).status,200);return view(db,'T-V2');}
function pauseBeforeBatch(db){
 const original=db.batch.bind(db);let release;
 db.batch=statements=>{db.batch=original;return new Promise((resolve,reject)=>{release=()=>{try{resolve(original(statements));}catch(e){reject(e);}};});};
 return async()=>{for(let i=0;i<100&&!release;i++)await new Promise(r=>setImmediate(r));assert.ok(release,'verification reached its final transaction');return release;};
}
let passed=0,failed=0;
async function test(name,fn,high=false){const db=fixture(high);try{await fn(db);passed++;console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+' | '+e.message);}finally{db.close();}}
await test('normal first confirmation with actual viewed versions',async db=>{const b=await view(db);assert.equal((await invoke(db,'T-V',first(b))).status,200);assert.equal(db.get('SELECT status FROM candidate_facts').status,'confirmed');});
await test('normal independent second confirmation with actual viewed versions',async db=>{const b=await readySecond(db);assert.equal((await invoke(db,'T-V2',second(b))).status,200);assert.equal(db.count('fact_second_confirmations'),1);},true);
for(const kind of ['first','second']){
 for(const [label,value] of [['missing',undefined],['null',null],['string','1'],['zero',0],['negative',-1],['fraction',1.2],['boolean',true],['array',[1]],['object',{}],['unsafe',Number.MAX_SAFE_INTEGER+1]])await test(kind+' rejects '+label+' evidence version with zero writes',async db=>{
  const b=kind==='second'?await readySecond(db):await view(db);b.evidenceVersion=value;
  await rejectNoWrites(db,kind==='second'?'T-V2':'T-V',kind==='second'?second(b):first(b));
 },kind==='second');
 await test(kind+' rejects missing card version with zero writes',async db=>{const b=kind==='second'?await readySecond(db):await view(db);delete b.flowCardVersion;await rejectNoWrites(db,kind==='second'?'T-V2':'T-V',kind==='second'?second(b):first(b));},kind==='second');
 for(const value of [null,'1',0])await test(kind+' rejects invalid card version '+JSON.stringify(value),async db=>{const b=kind==='second'?await readySecond(db):await view(db);b.flowCardVersion=value;await rejectNoWrites(db,kind==='second'?'T-V2':'T-V',kind==='second'?second(b):first(b));},kind==='second');
 await test(kind+' rejects stale evidence, then explicit fresh read succeeds',async db=>{
  const old=kind==='second'?await readySecond(db):await view(db);await changeBasis(db);
  await rejectNoWrites(db,kind==='second'?'T-V2':'T-V',kind==='second'?second(old):first(old));
  const fresh=await view(db,kind==='second'?'T-V2':'T-V');assert.equal(fresh.evidenceVersion,2);
  assert.equal((await invoke(db,kind==='second'?'T-V2':'T-V',kind==='second'?second(fresh):first(fresh,{evidenceLevel:'E1'}))).status,200);
 },kind==='second');
 await test(kind+' rejects future evidence version',async db=>{const b=kind==='second'?await readySecond(db):await view(db);b.evidenceVersion=2;await rejectNoWrites(db,kind==='second'?'T-V2':'T-V',kind==='second'?second(b):first(b));},kind==='second');
 await test(kind+' rejects stale card version',async db=>{const b=kind==='second'?await readySecond(db):await view(db);db.exec(`UPDATE candidate_facts SET flow_card_version=2 WHERE id='${F}'`);await rejectNoWrites(db,kind==='second'?'T-V2':'T-V',kind==='second'?second(b):first(b));},kind==='second');
 await test(kind+' basis changes after precheck, before transaction: atomic reject',async db=>{
  const b=kind==='second'?await readySecond(db):await view(db);const wait=pauseBeforeBatch(db);
  const pending=invoke(db,kind==='second'?'T-V2':'T-V',kind==='second'?second(b):first(b));const release=await wait();
  await changeBasis(db);const current=snapshot(db),factBeforeRelease=db.get('SELECT id,status,evidence_version,flow_card_version,second_confirmation_status FROM candidate_facts WHERE id=?',F);release();const r=await pending;
  assert.equal(r.status,409);assert.equal(r.body.code,'verification_version_conflict');assert.equal(snapshot(db),current,'rejected transaction adds nothing after legitimate concurrent change');
  const digest=value=>createHash('sha256').update(value).digest('hex');
  console.log('R1_CONCURRENCY_EVIDENCE '+JSON.stringify({kind,viewed:b,concurrentChange:'existing authorized grade correction committed EV1 -> EV2 before release',factBeforeRelease,response:r,factAfter:db.get('SELECT id,status,evidence_version,flow_card_version,second_confirmation_status FROM candidate_facts WHERE id=?',F),allApplicationTablesBeforeHash:digest(current),allApplicationTablesAfterHash:digest(snapshot(db)),zeroAdditionalBusinessWrites:true}));
 },kind==='second');
 await test(kind+' card changes after precheck, before batch: atomic card guard',async db=>{
  const b=kind==='second'?await readySecond(db):await view(db);const wait=pauseBeforeBatch(db);
  const pending=invoke(db,kind==='second'?'T-V2':'T-V',kind==='second'?second(b):first(b));const release=await wait();
  db.exec(`UPDATE candidate_facts SET flow_card_version=2 WHERE id='${F}'`);const current=snapshot(db);release();assert.equal((await pending).status,409);assert.equal(snapshot(db),current);
 },kind==='second');
 await test(kind+' event failure rolls back confirmation/history/task entirely',async db=>{
  const b=kind==='second'?await readySecond(db):await view(db);const before=snapshot(db);db.failOnEvent=true;
  assert.equal((await invoke(db,kind==='second'?'T-V2':'T-V',kind==='second'?second(b):first(b))).status,500);assert.equal(snapshot(db),before);
 },kind==='second');
 await test(kind+' competing confirmations have one writer and one set of side effects',async db=>{
  const b=kind==='second'?await readySecond(db):await view(db),token=kind==='second'?'T-V2':'T-V';const payload=kind==='second'?second(b):first(b);
  const counts={judgments:db.count('fact_judgments'),seconds:db.count('fact_second_confirmations'),events:db.count('events')};
  const results=await Promise.all([invoke(db,token,payload),invoke(db,token,payload)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(db.count('fact_judgments')-counts.judgments,kind==='second'?0:1);assert.equal(db.count('fact_second_confirmations')-counts.seconds,kind==='second'?1:0);assert.equal(db.count('events')-counts.events,2);
 },kind==='second');
}
await test('different-with-correction retains the human correction and viewed basis',async db=>{const b=await view(db);assert.equal((await invoke(db,'T-V',first(b,{decision:'different_with_correction',correction:'由仓储主管确认后再放行'}))).status,200);const row=db.get('SELECT * FROM fact_judgments');assert.equal(row.correction,'由仓储主管确认后再放行');assert.equal(row.evidence_version,b.evidenceVersion);});
await test('employee supplement v1 to v2 rejects old first, permits reviewed v2',async db=>{
 const old=await view(db);assert.equal((await invoke(db,'T-V',first(old,{decision:'insufficient_evidence',requestedMaterial:'合成库存凭证',responsibleAccountId:'E'}))).status,200);
 const supplied=await invoke(db,'T-E',{material:'合成新库存凭证',reference:'synthetic://v2',sourceType:'csv'},supplement);assert.equal(supplied.status,200);
 // Material remains pending; stale confirmation must not approve even the still-eligible old MAT.
 await rejectNoWrites(db,'T-V',first(old));const fresh=await view(db);assert.equal(fresh.evidenceVersion,2);assert.equal((await invoke(db,'T-V',first(fresh))).status,200);
});
await test('insufficient-evidence judgment also rejects a stale viewed basis',async db=>{const old=await view(db);await changeBasis(db);await rejectNoWrites(db,'T-V',first(old,{decision:'insufficient_evidence',requestedMaterial:'合成缺口',responsibleAccountId:'E'}));});
await test('insufficient-evidence CAS cannot create a supplement after concurrent basis change',async db=>{
 const old=await view(db),wait=pauseBeforeBatch(db);const pending=invoke(db,'T-V',first(old,{decision:'insufficient_evidence',requestedMaterial:'合成缺口',responsibleAccountId:'E'}));const release=await wait();await changeBasis(db);const current=snapshot(db);release();assert.equal((await pending).status,409);assert.equal(snapshot(db),current);
});
await test('independence and assignment remain enforced with valid versions',async db=>{const b=await readySecond(db);const before=snapshot(db);assert.equal((await invoke(db,'T-V',second(b))).status,403);assert.equal(snapshot(db),before);},true);
console.log(`R1 VERSION PASS=${passed} FAIL=${failed}`);process.exitCode=failed?1:0;
