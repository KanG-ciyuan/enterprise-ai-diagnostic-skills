/** Regression for browser acceptance authority blocker. Synthetic in-memory D1; not browser evidence. */
import assert from 'node:assert/strict';
import { onRequestPost as verify } from '../functions/api/work-items/[itemId]/verification.js';
import { D1Harness, bearerRequest } from './d1_harness.mjs';
const P = "PRJ-S", OTHER = "PRJ-O";
const BLD = "BLD-S", VER = "VER-S", VER2 = "VER2-S", OWN = "OWN-S", EMP = "EMP-S";
const TOK_B = "TOK-B", TOK_V = "TOK-V", TOK_V2 = "TOK-V2", TOK_O = "TOK-O", TOK_E = "TOK-E";
function fixture() {
  const db = new D1Harness();
  db.exec(`
    INSERT INTO accounts(id,email,name,status) VALUES
      ('${BLD}','b@v02.invalid','改造方','active'),('${VER}','v@v02.invalid','核验人','active'),
      ('${VER2}','v2@v02.invalid','其他核验人','active'),
      ('${OWN}','o@v02.invalid','负责人','active'),('${EMP}','e@v02.invalid','员工','active');
    INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id) VALUES
      ('${P}','V02','选品到发布','decision','active','L2','external_builder','${BLD}'),
      ('${OTHER}','其他项目','范围','decision','active','L2','external_builder','${BLD}');
    INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at) VALUES
      ('AUTH-S','${P}','授权','王总','owner@v02.invalid','诊断','DOC','authorized','${BLD}','K1','n','h','2099-01-01T00:00:00Z'),
      ('AUTH-O','${OTHER}','授权','李总','owner2@v02.invalid','诊断','DOC','authorized','${BLD}','K2','n','h','2099-01-01T00:00:00Z');
    INSERT INTO project_memberships(project_id,account_id,role,status) VALUES
      ('${P}','${BLD}','external_builder','active'),('${P}','${VER}','verifier','active'),
      ('${P}','${VER2}','verifier','active'),
      ('${P}','${OWN}','owner','active'),('${P}','${EMP}','employee','active'),
      ('${OTHER}','${BLD}','external_builder','active');
    INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES
      ('${TOK_B}','${BLD}','${P}','2099-01-01T00:00:00Z','R1'),('${TOK_V}','${VER}','${P}','2099-01-01T00:00:00Z','R2'),
      ('${TOK_V2}','${VER2}','${P}','2099-01-01T00:00:00Z','R-V2'),
      ('${TOK_O}','${OWN}','${P}','2099-01-01T00:00:00Z','R3'),('${TOK_E}','${EMP}','${P}','2099-01-01T00:00:00Z','R4');
    INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,evidence_completeness,blocking_reason,next_action,judgment_status,assigned_verifier_id) VALUES
      ('WI-S','${P}','任务','任务','facts','awaiting_verification','employee','员工',100,'','','confirmed','${VER}'),
      ('WI-O','${OTHER}','其他任务','任务','facts','awaiting_verification','employee','员工',100,'','','confirmed',NULL);
    INSERT INTO evidence_materials(id,project_id,material_key,version,source_type,authorization_status,integrity_status,visibility,created_by_account_id,work_item_id,label,reference) VALUES
      ('MAT-S','${P}','MAT-S',1,'pdf','authorized','verified','project','${BLD}','WI-S','证据','REF');
    INSERT INTO candidate_facts(id,project_id,work_item_id,fact_type,claim,source_field,required,impact_level,second_confirmation_status,material_status,status,source_refs_json,evidence_level) VALUES
      ('F-GOOD','${P}','WI-S','workflow','每天重复确认库存','stock',1,'normal','not_required','same','confirmed','["MAT-S"]','E2'),
      ('F-SECOND','${P}','WI-S','workflow','高影响但未二次确认','risk',0,'high','pending','same','confirmed','["MAT-S"]','E2'),
      ('F-E5','${P}','WI-S','workflow','模型推断的假设','ai',0,'normal','not_required','same','confirmed','["MAT-S"]','E5'),
      ('F-OPEN','${P}','WI-S','workflow','尚未核验的候选事实','open',0,'normal','not_required','unverified','open','[]',NULL),
      ('F-OTHER','${OTHER}','WI-O','workflow','其他项目事实','other',1,'normal','not_required','same','confirmed','[]','E2');
  `);
  return db;
}

async function gateBatch(db, predicate, operation) {
  const original = db.batch.bind(db); let release = null; let claimed = false;
  db.batch = (statements) => {
    if (!claimed && predicate(statements)) {
      claimed = true;
      return new Promise((resolve, reject) => { release = () => { try { resolve(original(statements)); } catch (error) { reject(error); } }; });
    }
    return original(statements);
  };
  const pending = operation();
  for (let i = 0; i < 400 && !release; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(release, "controlled request must reach the targeted batch");
  return { pending, release: () => { db.batch = original; release(); } };
}

async function call(db, token, action='correct_evidence_level') {
 const response=await verify({request:bearerRequest('http://127.0.0.1/x',token,{action,factId:'F-GOOD',evidenceLevel:'E1',impactLevel:'high',reason:'合成核验变更'}),env:{DB:db},params:{itemId:'WI-S'}});
 return {status:response.status,body:await response.json()};
}
function snapshot(db){return JSON.stringify(Object.fromEntries(['candidate_facts','events','fact_judgments'].map(t=>[t,db.all(`SELECT * FROM ${t} ORDER BY rowid`)])));}
let passed=0;
for(const action of ['correct_evidence_level','upgrade_impact']) {
 const db=fixture(),before=snapshot(db),r=await call(db,TOK_V2,action);assert.equal(r.status,403);assert.equal(snapshot(db),before);passed++;
 console.log('PASS unassigned verifier rejected without writes: '+action);
}
{
 const db=fixture();assert.equal((await call(db,TOK_V)).status,200);assert.equal(db.all("SELECT evidence_level FROM candidate_facts WHERE id='F-GOOD'")[0].evidence_level,'E1');passed++;console.log('PASS assigned correction');
}
for(const action of ['correct_evidence_level','upgrade_impact']) for(const change of ['reassign','revoke']) {
 const db=fixture();const hold=await gateBatch(db,ss=>ss[0].sql.startsWith('UPDATE candidate_facts SET'),()=>call(db,TOK_V,action));
 if(change==='reassign')db.exec(`UPDATE work_items SET assigned_verifier_id='${VER2}',assignment_version=assignment_version+1 WHERE id='WI-S'`);
 else db.exec(`UPDATE project_memberships SET status='revoked' WHERE project_id='${P}' AND account_id='${VER}'`);
 const before=snapshot(db);hold.release();const r=await hold.pending;assert.equal(r.status,409);assert.equal(snapshot(db),before);assert.deepEqual(Object.keys(r.body).sort(),['code','detail']);passed++;console.log('PASS final write guard and safe conflict: '+action+' '+change);
}
console.log(`BROWSER BLOCKER REGRESSION PASS=${passed} FAIL=0`);
