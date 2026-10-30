/** Project identity and selection invariants. Synthetic handler + in-memory D1. */
import assert from 'node:assert/strict';
import {D1Harness,bearerRequest} from './d1_harness.mjs';
import {onRequestGet as session} from '../functions/api/auth/session.js';
import {onRequestPost as select} from '../functions/api/auth/select-project.js';
import {onRequest as detail} from '../functions/api/projects/[projectId].js';
function fixture(){const db=new D1Harness();db.exec(`
INSERT INTO enterprises(id,name,authorization_status) VALUES('ORG-A','合成机构甲','authorized'),('ORG-B','合成机构乙','authorized');
INSERT INTO accounts(id,email,name,enterprise_id,account_role,status) VALUES('BLD','b@identity.invalid','合成改造方','ORG-A','external_builder','active'),('MEM','m@identity.invalid','合成成员','ORG-B','member','active');
INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id) VALUES('PRJ-A','合成客户甲·订单项目','合成范围A','scope','active','unknown','external_builder','BLD'),('PRJ-B','合成客户乙·交接项目','合成范围B','scope','active','unknown','external_builder','BLD'),('PRJ-D','新建草稿','待具名授权','scope','draft','unknown','external_builder','BLD'),('PRJ-X','已归档项目','旧范围','scope','archived','unknown','external_builder','BLD');
INSERT INTO project_memberships(project_id,account_id,role,status) VALUES('PRJ-A','BLD','external_builder','active'),('PRJ-B','BLD','external_builder','active'),('PRJ-D','BLD','external_builder','active'),('PRJ-X','BLD','external_builder','active'),('PRJ-A','MEM','employee','active'),('PRJ-B','MEM','owner','active'),('PRJ-D','MEM','employee','active');
INSERT INTO sessions(token,account_id,project_id,expires_at,refresh_token) VALUES('TB','BLD','PRJ-A','2099-01-01T00:00:00Z','RB'),('TM','MEM','PRJ-A','2099-01-01T00:00:00Z','RM');
`);return db;}
async function call(db,fn,token,body,params={}){const r=await fn({request:bearerRequest('http://127.0.0.1/test',token,body),env:{DB:db},params});return{status:r.status,body:await r.json()};}
let count=0;async function test(name,fn){const db=fixture();try{await fn(db);count++;console.log('PASS '+name);}finally{db.close();}}
await test('session projects only own account affiliation',async db=>{const r=await call(db,session,'TM');assert.equal(r.status,200);assert.deepEqual(r.body.enterprise,{id:'ORG-B',name:'合成机构乙'});assert.equal(r.body.projectId,'PRJ-A');assert.equal(r.body.role,'employee');assert.equal(JSON.stringify(r.body).includes('合成机构甲'),false);});
await test('builder can select own draft and refresh persists it',async db=>{const r=await call(db,select,'TB',{projectId:'PRJ-D'});assert.equal(r.status,200);const restored=await call(db,session,'TB');assert.equal(restored.body.projectId,'PRJ-D');const project=await call(db,detail,'TB',undefined,{projectId:'PRJ-D'});assert.equal(project.status,200);assert.equal(project.body.project.name,'新建草稿');});
await test('employee cannot use draft privilege',async db=>{assert.equal((await call(db,select,'TM',{projectId:'PRJ-D'})).status,403);assert.equal((await call(db,session,'TM')).body.projectId,'PRJ-A');});
await test('membership selection restores actual per-project role',async db=>{assert.equal((await call(db,select,'TM',{projectId:'PRJ-B'})).status,200);assert.equal((await call(db,session,'TM')).body.role,'owner');const p=await call(db,detail,'TM',undefined,{projectId:'PRJ-B'});assert.equal(p.body.project.name,'合成客户乙·交接项目');});
await test('cross-project read requires explicit valid selection',async db=>{const r=await call(db,detail,'TM',undefined,{projectId:'PRJ-B'});assert.equal(r.status,403);assert.equal(JSON.stringify(r.body).includes('合成客户乙'),false);assert.equal((await call(db,select,'TM',{projectId:'PRJ-NOT-MEMBER'})).status,403);});
await test('archived and revoked memberships remain closed',async db=>{assert.equal((await call(db,select,'TB',{projectId:'PRJ-X'})).status,403);db.exec("UPDATE project_memberships SET status='revoked' WHERE account_id='MEM' AND project_id='PRJ-B'");assert.equal((await call(db,select,'TM',{projectId:'PRJ-B'})).status,403);});
await test('unbound member restores only active permitted role choices',async db=>{db.exec("UPDATE sessions SET project_id=NULL WHERE token='TM'");const r=await call(db,session,'TM');assert.equal(r.status,200);assert.equal(r.body.accountRole,'member');assert.deepEqual(r.body.memberships.map(m=>[m.projectId,m.role]),[['PRJ-A','employee'],['PRJ-B','owner']]);assert.equal(r.body.enterprise.name,'合成机构乙');});
console.log(`PROJECT_IDENTITY PASS=${count} FAIL=0`);
