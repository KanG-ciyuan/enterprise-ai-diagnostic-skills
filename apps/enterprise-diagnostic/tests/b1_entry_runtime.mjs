// B1-only synthetic acceptance harness. Never run as a product server.
// Uses unchanged handlers, schema and Cookie attributes. No external services.
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import {D1Harness} from './d1_harness.mjs';
import {onRequestPost as requestLogin} from '../functions/api/auth/login-request.js';
import {onRequestPost as consumeLogin} from '../functions/api/auth/login-consume.js';
import {onRequestGet as getSession} from '../functions/api/auth/session.js';
import {onRequestPost as authorize} from '../functions/api/auth/authorize.js';
import {onRequestPost as demoEnter} from '../functions/api/demo/enter.js';
import {onRequestPost as createInvitation} from '../functions/api/projects/[projectId]/invitations.js';
import {onRequestPost as acceptInvitation} from '../functions/api/invitations/[invitationRef]/accept.js';
import {onRequestPost as revokeInvitation} from '../functions/api/invitations/[invitationRef]/revoke.js';
import {onRequestPost as createProject} from '../functions/api/projects.js';
import {onRequestGet as materials} from '../functions/api/projects/[projectId]/materials.js';
import {onRequestGet as employeeTask} from '../functions/api/projects/[projectId]/employee-task.js';
import {onRequestGet as verifierFacts} from '../functions/api/formal/projects/[projectId]/verifier-facts.js';
import {onRequestGet as confirmedFacts} from '../functions/api/formal/projects/[projectId]/confirmed-facts.js';
import {onRequestGet as draftPacket} from '../functions/api/formal/projects/[projectId]/decision-packet.js';
import {onRequestGet as ownerPacket} from '../functions/api/formal/projects/[projectId]/owner-packet.js';
import {onRequest as workItems} from '../functions/api/projects/[projectId]/work-items.js';
import {sha256} from '../functions/_shared.js';

const APP = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const inputDir = arg('--input-dir', null);
assert(inputDir, 'Explicit approved --input-dir is required');
const input = (name, expected) => {
  const bytes = readFileSync(path.join(inputDir, name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, name);
  return JSON.parse(bytes);
};
const fixture = input('entry-fixture.json', '4b596c828ed2e03f3aeeaa7989d9f34e464baade71e044e6cf98a75a74077422');
const profiles = input('environment-profiles.json', 'd5396fc5c1b0d12d297494df33f921f6e48f8738177cbcc6dfa4946f00373102');
let externalCalls = 0;
globalThis.fetch = async () => { externalCalls++; throw new Error('External network forbidden in B1 tests'); };
const results = [];
function check(id, details, run) {
  return Promise.resolve().then(run).then(() => {
    results.push({id, status: 'PASS', details});
    console.log(JSON.stringify(results.at(-1)));
  });
}
const projectId = fixture.project.id;
const origin = 'http://localhost:4192';
const post = (url, body, cookie = '', extra = {}) => new Request(url, {
  method: 'POST', headers: {'content-type': 'application/json', ...(cookie ? {Cookie: cookie} : {}), ...extra},
  body: JSON.stringify(body),
});
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
const tokenOf = (url) => new URLSearchParams(new URL(url).hash.slice(1)).get('login');
function seed() {
  const db = new D1Harness();
  for (const a of fixture.accounts) db.prepare('INSERT INTO accounts(id,email,name,status,account_role) VALUES(?,?,?,?,?)')
    .bind(a.id, a.email, a.name, a.status, a.account_role).run();
  db.prepare('INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,created_by_account_id,authorization_stage) VALUES(?,?,?,?,?,?,?,?,?)')
    .bind(projectId, fixture.project.name, fixture.project.scope, 'mapping', 'active', 'E5', 'external_builder', 'B1-EXTERNAL_BUILDER', 'authorized').run();
  db.exec(`INSERT INTO enterprise_authorizations(id,project_id,name,authorizer_name,authorizer_email,scope,reference,status,created_by_account_id,creation_idempotency_key,confirmation_token_nonce,confirmation_token_hash,confirmation_token_expires_at)
    VALUES ('AUTH-B1','${projectId}','合成准入前提','合成审批人','authorizer@b1-entry.invalid','入口测试','synthetic://b1','authorized','B1-EXTERNAL_BUILDER','B1-AUTH','synthetic-nonce','synthetic-hash','2099-01-01T00:00:00Z')`);
  for (const a of fixture.accounts.filter(a => a.project_role)) db.prepare("INSERT INTO project_memberships(project_id,account_id,role,status) VALUES(?,?,?,'active')")
    .bind(projectId, a.id, a.project_role).run();
  db.exec(`INSERT INTO work_items(id,project_id,title,description,stage,status,assignee_role,assignee_label,assignee_account_id,evidence_completeness,blocking_reason,next_action)
    VALUES ('WI-B1','${projectId}','合成员工入口任务','只验证入口，不作诊断','mapping','needs_input','employee','合成员工','B1-EMPLOYEE',0,'尚未访谈','开始还原工作')`);
  return db;
}
function environment(db, mode = 'production') {
  const inbox = [];
  return {DB: db, FORMAL_AUTH_MODE: mode, FORMAL_APP_ORIGIN: origin, inbox,
    MEMBER_LOGIN_PROVIDER: {send: async message => { inbox.push(message); }}};
}
async function issue(env, email) {
  const response = await requestLogin({request: post(origin + '/api/auth/login-request', {email}), env});
  const body = await response.json();
  const message = env.inbox.filter(x => x.to === email || x.email === email || x.recipient === email).at(-1) || env.inbox.at(-1);
  return {response, body, token: message ? tokenOf(message.loginUrl) : tokenOf(body.loginUrl || origin)};
}
async function login(env, email) {
  const issued = await issue(env, email);
  assert.equal(issued.response.status, 202);
  assert(issued.token, 'actual provider must capture a challenge');
  const response = await consumeLogin({request: post(origin + '/api/auth/login-consume', {token: issued.token}), env});
  assert.equal(response.status, 200);
  const cookie = cookieOf(response);
  const restored = await getSession({request: new Request(origin + '/api/auth/session', {headers: {Cookie: cookie}}), env});
  assert.equal(restored.status, 200);
  return {response, cookie, restored: await restored.json(), token: issued.token};
}
function entryProbe(restored, search = '', hash = '', error = false) {
  const source = readFileSync(path.join(APP, 'app.js'), 'utf8');
  const fn = source.match(/^async function openFormalEntry\([^]*?^\}\n/m)?.[0];
  assert(fn, 'actual entry function');
  const calls = [];
  const context = {URLSearchParams, state: {},
    window: {location: {search, hash, pathname: '/', hostname: 'localhost'}, history: {replaceState: () => calls.push('strip-login')},
      diagnosticApi: {restoreSession: async () => {calls.push('restore'); if (error) throw new Error('401 synthetic'); return restored;}}},
    formalUiContract: {formalEntryMode: ({invitationToken}) => invitationToken ? 'invite' : 'restore'},
    formalBuilderLoginForm: {}, formalInvitationAcceptForm: {}, formalMemberTestConsume: {}, formalMemberLoginStatus: {},
    showFormalEntryMode: mode => calls.push('mode:' + mode), showView: id => calls.push(id),
    consumeFormalMemberToken: async () => calls.push('consume'),
    loadFormalEmployeeTask: () => calls.push('employee'), loadFormalVerifierWorkspace: () => calls.push('verifier'),
    loadFormalOwnerWorkspace: () => calls.push('owner'), loadFormalBuilderWorkspace: () => calls.push('builder')};
  vm.createContext(context);
  vm.runInContext(fn, context);
  return vm.runInContext('openFormalEntry()', context).then(() => ({calls, state: context.state}));
}
async function c1(baseline) {
  const db = seed();
  try {
    const env = environment(db);
    const real = await login(env, 'external_builder@b1-entry.invalid');
    assert.equal(real.restored.role, 'external_builder');
    const result = await entryProbe(real.restored);
    if (baseline) {
      assert(!result.calls.includes('builder'));
      assert(result.calls.includes('formal-entry-view'));
      console.log(JSON.stringify({id:'C1-BASELINE-REPRO', status:'REPRODUCED', actualServerRole:real.restored.role,
        observed:result.calls, expected:'builder', credentialSource:'actual login-request/consume/session handlers; VM only observes actual client dispatch'}));
    } else {
      assert(result.calls.includes('builder'));
      assert(!result.calls.includes('formal-entry-view'));
      console.log(JSON.stringify({id:'C1-CANDIDATE',status:'PASS',actualServerRole:real.restored.role,observed:result.calls}));
    }
  } finally {db.close();}
}

// Loopback-only bridge; all /api responses come from unchanged real handlers.
// Control endpoints affect synthetic in-memory data only, and are not product APIs.
async function serve() {
  const db = seed(); const env = environment(db, arg('--mode', 'production')); const requests = [];
  const routes = [];
  function scan(dir, segments = []) {
    for (const e of readdirSync(dir, {withFileTypes:true})) {
      if (e.isDirectory()) scan(path.join(dir,e.name), [...segments,e.name]);
      else if (e.name.endsWith('.js')) routes.push({segments:[...segments,e.name.slice(0,-3)], file:path.join(dir,e.name)});
    }
  }
  scan(path.join(APP,'functions/api'));
  routes.sort((a,b)=>a.segments.filter(s=>s.startsWith('[')).length-b.segments.filter(s=>s.startsWith('[')).length);
  let issuer;
  let scriptDelay = 0;
  async function invite(role, scenario = '') {
    assert(['employee','verifier','owner'].includes(role));
    issuer ||= await login(env,'external_builder@b1-entry.invalid');
    const email = `${role}-${crypto.randomUUID().slice(0,8)}@b1-entry.invalid`;
    const r = await createInvitation({request:post(origin+'/api/projects/'+projectId+'/invitations',{email,role},issuer.cookie),env,params:{projectId}});
    assert.equal(r.status,201);
    const {invitation} = await r.json();
    if (scenario==='expired') db.prepare("UPDATE invitations SET expires_at='2000-01-01' WHERE id=?").bind(invitation.id).run();
    if (scenario==='revoked') {
      const revoked=await revokeInvitation({request:post(origin+'/api/invitations/'+invitation.id+'/revoke',{},issuer.cookie),env,params:{invitationRef:invitation.id}});
      assert.equal(revoked.status,200);
    }
    return {email,role,token:invitation.token,id:invitation.id,url:origin+'/?invite='+invitation.token};
  }
  const server = createServer(async (req,res) => {
    try {
      const url = new URL(req.url,origin);
      if (url.pathname==='/__b1__/noscript') {
        res.setHeader('content-type','text/html; charset=utf-8');
        res.end('<!doctype html><title>B1 合成测试：禁用脚本</title><p>独立测试外壳：下方是原始页面，sandbox 禁止脚本。</p><iframe id="b1-noscript" title="禁止脚本的实际入口" sandbox="allow-same-origin" src="/" style="width:100%;height:900px;border:1px solid #ddd"></iframe>');return;
      }
      if (url.pathname==='/__b1__/tamper') {
        res.setHeader('content-type','text/html; charset=utf-8');
        res.end('<!doctype html><title>B1 合成负向夹具</title><h1>仅本地合成测试</h1><button onclick="for(const k of [\'role\',\'formalRole\',\'accountId\',\'session\',\'diagnosticSession\'])localStorage.setItem(k,\'external_builder\');location.assign(\'/?role=external_builder&amp;project=PRJ-B1-GATE01\')">写入伪造本机角色并访问实际入口</button>');return;
      }
      if (url.pathname==='/__b1__/delayed') {
        scriptDelay=6000;
        res.setHeader('content-type','text/html; charset=utf-8');
        res.end('<!doctype html><title>B1 延迟脚本测试</title><p>测试外壳：加载原始页面，JS 资产延迟 6 秒。</p><iframe id="b1-delayed" title="延迟脚本的实际入口" src="/" style="width:100%;height:900px;border:1px solid #ddd"></iframe>');return;
      }
      if (url.pathname==='/__b1__/inbox') {
        const email=url.searchParams.get('email'); assert(email?.endsWith('@b1-entry.invalid'));
        const message=env.inbox.filter(x => JSON.stringify(x).includes(email)).at(-1);
        res.setHeader('content-type','application/json');res.end(JSON.stringify({loginUrl:message?.loginUrl||null}));return;
      }
      if (url.pathname==='/__b1__/invite') {
        res.setHeader('content-type','application/json');res.end(JSON.stringify(await invite(url.searchParams.get('role'),url.searchParams.get('case'))));return;
      }
      if (url.pathname==='/__b1__/status') {
        res.setHeader('content-type','application/json');res.end(JSON.stringify({synthetic:true,mode:env.FORMAL_AUTH_MODE,
          counts:Object.fromEntries(['accounts','sessions','projects','project_memberships','work_items','decision_packets','invitations'].map(t=>[t,db.count(t)])),requests,externalCalls}));return;
      }
      if (url.pathname==='/__b1__/multi-account' && req.method==='POST') {
        // Only a negative/restore fixture. No session is seeded or granted here.
        db.exec(`INSERT OR IGNORE INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,authorization_stage) VALUES('PRJ-B1-SECOND','合成第二项目','入口测试','mapping','active','E5','external_builder','authorized');
          INSERT OR IGNORE INTO project_memberships(project_id,account_id,role,status) VALUES('${projectId}','B1-ACCOUNT','employee','active'),('PRJ-B1-SECOND','B1-ACCOUNT','employee','active')`);
        res.setHeader('content-type','application/json');res.end('{"synthetic":true,"memberships":2,"sessionsSeeded":0}');return;
      }
      if (url.pathname==='/__b1__/invalidate' && req.method==='POST') {
        const kind=url.searchParams.get('kind');
        if (kind==='expire') db.exec("UPDATE sessions SET expires_at='2000-01-01T00:00:00Z'");
        else if(kind==='revoke') db.exec('UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP');
        else throw new Error('Unsupported synthetic control');
        res.setHeader('content-type','application/json');res.end('{"synthetic":true}');return;
      }
      if (url.pathname.startsWith('/api/')) {
        const parts=url.pathname.slice(5).split('/');let found=null;
        for(const route of routes) {
          if(route.segments.length!==parts.length)continue;
          const params={};if(!route.segments.every((s,i)=>s.startsWith('[')?(params[s.slice(1,-1)]=decodeURIComponent(parts[i]),true):s===parts[i]))continue;
          found={route,params};break;
        }
        if(!found){res.writeHead(404);res.end();return;}
        const module=await import(pathToFileURL(found.route.file));
        const handler=module['onRequest'+req.method[0]+req.method.slice(1).toLowerCase()]||module.onRequest;
        if(!handler){res.writeHead(405);res.end();return;}
        const chunks=[];for await(const chunk of req)chunks.push(chunk);
        const request=new Request(url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
        const response=await handler({request,env,params:found.params,waitUntil:()=>{}});
        requests.push({method:req.method,path:url.pathname,status:response.status,cookiePresent:Boolean(req.headers.cookie),authorizationPresent:Boolean(req.headers.authorization),setCookie:Boolean(response.headers.get('set-cookie'))});
        res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
      }
      const relative=url.pathname==='/'?'index.html':url.pathname.slice(1);
      if(!/^[\w.-]+\.(html|css|js)$/.test(relative)){res.writeHead(404);res.end();return;}
      const bytes=readFileSync(path.join(APP,relative));
      if(relative.endsWith('.js') && scriptDelay) await new Promise(resolve=>setTimeout(resolve,scriptDelay));
      if(relative==='app.js') scriptDelay=0;
      res.setHeader('content-type',relative.endsWith('.html')?'text/html; charset=utf-8':relative.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');
      res.setHeader('cache-control','no-store');res.end(bytes);
    } catch(error) {res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:String(error.message)}));}
  });
  server.listen(4192,'127.0.0.1',()=>console.log('B1_SYNTHETIC_ONLY '+origin));
  const close=()=>server.close(()=>{db.close();process.exit(0)});
  process.on('SIGTERM',close);process.on('SIGINT',close);
}

async function suite() {
  await c1(false);
  await check('M01-M02-M10-M18-static', 'public entry, preserved forms and non-authorizing role articles', () => {
    const html=readFileSync(path.join(APP,'index.html'),'utf8');
    const section=html.slice(html.indexOf('<section id="formal-entry-view"'),html.indexOf('<section id="formal-builder-view"'));
    for(const id of ['formal-builder-login-form','formal-member-login-form','formal-invitation-accept-form','formal-member-login-status','formal-member-test-consume']) assert(section.includes('id="'+id+'"'));
    for(const name of ['enterpriseName','email','name','bootstrapToken','testToken']) assert(section.includes('name="'+name+'"'));
    assert(section.includes('name="bootstrapToken" type="password"'));
    assert.equal((section.match(/<article class="b1-entry-role">/g)||[]).length,4);
    for(const article of section.match(/<article class="b1-entry-role">[^]*?<\/article>/g)) {
      assert(!article.includes('data-action')); assert(!article.includes('data-role'));
    }
    assert(section.includes('data-action="enter-demo"')); assert(section.includes('合成演示仅在隔离开发环境可用'));
    assert(!section.includes('localStorage')); assert(!section.includes('value="123456"'));
    assert(html.includes('styles.css?v=workbench-v5&amp;b1='));assert(html.includes('app.js?v=workbench-v6&amp;b1='));
    for(const pattern of [/<header class="app-header" hidden>/, /id="workspace-sidebar"[^>]* hidden>/, /<aside class="global-boundary" hidden>/, /id="project-list-view"[^>]* hidden>/]) assert(pattern.test(html));
    assert(section.includes('<noscript>'));
  });
  for(const role of ['employee','verifier','owner','account','external_builder']) {
    await check('M04-M08-role-'+role,'actual login Cookie/session plus actual entry dispatch',async()=>{
      const db=seed();try {
        const a=fixture.accounts.find(a=>(a.project_role||'account')===role);
        const real=await login(environment(db),a.email);assert.equal(real.restored.role,role);
        const p=await entryProbe(real.restored);assert(p.calls.includes(['account','external_builder'].includes(role)?'builder':role));
        assert(!p.calls.includes('formal-entry-view'));
        assert(/Secure/.test(real.response.headers.get('set-cookie')) && /HttpOnly/.test(real.response.headers.get('set-cookie')) && /SameSite=Lax/.test(real.response.headers.get('set-cookie')));
      }finally{db.close();}
    });
  }
  await check('M03-priority','login hash, then invite, then restore',async()=>{
    const a=await entryProbe({},'?invite=synthetic','\u0023login=synthetic');assert(a.calls.includes('consume'));assert(!a.calls.includes('restore'));
    const b=await entryProbe({},'?invite=synthetic');assert(b.calls.includes('formal-entry-view'));assert(!b.calls.includes('restore'));
    const c=await entryProbe({},'?role=external_builder&project=synthetic','',true);assert(c.calls.includes('formal-entry-view'));assert(!c.calls.includes('builder'));
    const d=await entryProbe({role:'unauthorized-role'});assert(d.calls.includes('formal-entry-view'));assert(!d.calls.includes('builder'));
  });
  for(const change of ['expired','revoked','disabled','membership']) {
    await check('M09-session-'+change,'actual session refusal after synthetic state change',async()=>{
      const db=seed();try {
        const env=environment(db);const real=await login(env,'employee@b1-entry.invalid');
        if(change==='expired')db.exec("UPDATE sessions SET expires_at='2000-01-01T00:00:00Z'");
        if(change==='revoked')db.exec('UPDATE sessions SET revoked_at=CURRENT_TIMESTAMP');
        if(change==='disabled')db.exec("UPDATE accounts SET status='disabled' WHERE id='B1-EMPLOYEE'");
        if(change==='membership')db.exec("UPDATE project_memberships SET status='revoked' WHERE account_id='B1-EMPLOYEE'");
        const r=await getSession({request:new Request(origin+'/api/auth/session',{headers:{Cookie:real.cookie}}),env});assert.equal(r.status,change==='membership'?403:401);
      }finally{db.close();}
    });
  }
  await check('M09-M10-negative','no/forged/demo identity and cross-project requests reject without business writes',async()=>{
    const db=seed();try {
      const env=environment(db);const before=[db.count('accounts'),db.count('projects'),db.count('project_memberships'),db.count('work_items'),db.count('decision_packets')];
      for(const headers of [{},{Cookie:'__Host-diagnostic_session=forged'},{'X-Demo-Role':'external_builder'},{Authorization:'Bearer forged'}]) {
        const r=await getSession({request:new Request(origin+'/api/auth/session?role=external_builder',{headers}),env});assert.equal(r.status,401);
      }
      const real=await login(env,'employee@b1-entry.invalid');
      const cross=await materials({request:new Request(origin+'/api/projects/PRJ-OTHER/materials',{headers:{Cookie:real.cookie}}),env,params:{projectId:'PRJ-OTHER'}});assert.equal(cross.status,403);
      const escalation=await createProject({request:post(origin+'/api/projects',{name:'forbidden',scope:'x',role:'external_builder'},real.cookie),env});assert.equal(escalation.status,403);
      const basic=await login(env,'account@b1-entry.invalid');
      const noStanding=await createProject({request:post(origin+'/api/projects',{name:'forbidden',scope:'x'},basic.cookie),env});assert.equal(noStanding.status,403);
      assert.deepEqual([db.count('accounts'),db.count('projects'),db.count('project_memberships'),db.count('work_items'),db.count('decision_packets')],before);
      const nonLocal=await getSession({request:new Request('https://b1.invalid/api/auth/session',{headers:{Authorization:'Bearer '+real.cookie.split('=')[1]}}),env});assert.equal(nonLocal.status,401);
      const cookie=await getSession({request:new Request('https://b1.invalid/api/auth/session',{headers:{Cookie:real.cookie}}),env});assert.equal(cookie.status,200);
    }finally{db.close();}
  });
  await check('M07-multi-project-account','multiple memberships recover account without builder standing',async()=>{
    const db=seed();try {
      db.exec("INSERT INTO projects(id,name,scope,stage,status,evidence_level,created_by_role,authorization_stage) VALUES('PRJ-SECOND','合成二','scope','mapping','active','E5','external_builder','authorized'); INSERT INTO project_memberships(project_id,account_id,role,status) VALUES('PRJ-SECOND','B1-EMPLOYEE','employee','active')");
      const env=environment(db);const real=await login(env,'employee@b1-entry.invalid');assert.equal(real.restored.role,'account');assert.equal(real.restored.projectId,null);
      assert.equal((await createProject({request:post(origin+'/api/projects',{name:'forbidden',scope:'x'},real.cookie),env})).status,403);
    }finally{db.close();}
  });
  for(const mode of profiles.modes) for(const testMode of profiles.test_mode_variants) {
    await check('M11-mode-'+String(mode)+'-test-'+String(testMode),'demo is explicit development only',async()=>{
      const db=new D1Harness();try {
        const env={DB:db,...(mode===null?{}:{FORMAL_AUTH_MODE:mode}),...(testMode?{FORMAL_AUTH_TEST_MODE:testMode}:{})};
        const r=await demoEnter({request:post(origin+'/api/demo/enter',{role:'employee'}),env});
        assert.equal(r.status,mode==='development'?200:403);assert.equal(db.count('sessions'),mode==='development'?1:0);
      }finally{db.close();}
    });
  }
  for(const mode of profiles.modes) {
    await check('M12-no-provider-'+String(mode),'no real provider; fail closed except explicit controlled development fallback',async()=>{
      const db=seed();try {
        const env={DB:db,FORMAL_AUTH_MODE:mode,FORMAL_AUTH_TEST_MODE:'1'};
        const r=await requestLogin({request:post(origin+'/api/auth/login-request',{email:'employee@b1-entry.invalid'}),env});const b=await r.json();assert.equal(r.status,202);
        assert.equal(Boolean(b.loginUrl),mode==='development');assert(!b.token);
        if(mode!=='development')assert.equal(db.get('SELECT delivery_status FROM member_login_challenges').delivery_status,'failed');
      }finally{db.close();}
    });
  }
  await check('M12-controlled-recipient','development fallback requires test switch and controlled .invalid recipient',async()=>{
    for(const variant of ['no-switch','uncontrolled']) {
      const db=seed();try {
        let email='employee@b1-entry.invalid';if(variant==='uncontrolled'){email='synthetic@example.test';db.prepare("UPDATE accounts SET email=? WHERE id='B1-EMPLOYEE'").bind(email).run();}
        const env={DB:db,FORMAL_AUTH_MODE:'development',...(variant==='uncontrolled'?{FORMAL_AUTH_TEST_MODE:'1'}:{})};
        const r=await requestLogin({request:post(origin+'/api/auth/login-request',{email}),env});assert(!(await r.json()).loginUrl);assert.equal(db.count('sessions'),0);
      }finally{db.close();}
    }
  });
  await check('M13-hash-cookie-binding-replay','real challenge hash/15min/server binding/cookie/replay',async()=>{
    const db=seed();try {
      const env=environment(db);const issued=await issue(env,'employee@b1-entry.invalid');const row=db.get('SELECT * FROM member_login_challenges');
      assert.equal(row.token_hash,await sha256(issued.token));assert(!JSON.stringify(row).includes(issued.token));assert(!issued.body.loginUrl);assert(!issued.body.token);
      const remaining=Date.parse(row.expires_at)-Date.now();assert(remaining>14*60000&&remaining<=15*60000);
      const first=await consumeLogin({request:post(origin+'/api/auth/login-consume',{token:issued.token,accountId:'B1-EXTERNAL_BUILDER',projectId:'other',role:'external_builder'}),env});assert.equal(first.status,200);
      const restored=await getSession({request:new Request(origin+'/api/auth/session',{headers:{Cookie:cookieOf(first)}}),env});assert.equal((await restored.json()).role,'employee');
      const replay=await consumeLogin({request:post(origin+'/api/auth/login-consume',{token:issued.token}),env});assert.equal(replay.status,401);assert.equal(db.count('sessions'),1);
    }finally{db.close();}
  });
  for(const kind of ['expired','disabled','undelivered','empty','invalid']) {
    await check('M13-reject-'+kind,'invalid challenge creates no session',async()=>{
      const db=seed();try {
        const env=environment(db);const {token}=await issue(env,'employee@b1-entry.invalid');
        if(kind==='expired')db.exec("UPDATE member_login_challenges SET expires_at='2000-01-01'");
        if(kind==='disabled')db.exec("UPDATE accounts SET status='disabled'");
        if(kind==='undelivered')db.exec("UPDATE member_login_challenges SET delivery_status='dispatching'");
        const r=await consumeLogin({request:post(origin+'/api/auth/login-consume',{token:kind==='empty'?'':kind==='invalid'?'synthetic-invalid':token}),env});assert.equal(r.status,401);assert.equal(db.count('sessions'),0);
      }finally{db.close();}
    });
  }
  await check('M13-concurrent','exactly one concurrent consume wins',async()=>{
    const db=seed();try {const env=environment(db);const {token}=await issue(env,'employee@b1-entry.invalid');const rr=await Promise.all([1,2].map(()=>consumeLogin({request:post(origin+'/api/auth/login-consume',{token}),env})));assert.deepEqual(rr.map(r=>r.status).sort(),[200,401]);assert.equal(db.count('sessions'),1);}finally{db.close();}
  });
  for(const marker of ['provider_delivered','dev_fallback_link',null,'no_provider_manual_link','unknown']) for(const mode of ['production','productionn']) {
    await check('M14-source-'+String(marker)+'-'+mode,'positive provider source is mandatory outside development',async()=>{
      const db=seed();try {const env=environment(db,mode);const {token}=await issue(env,'employee@b1-entry.invalid');db.prepare('UPDATE member_login_challenges SET delivery_error=?').bind(marker).run();const r=await consumeLogin({request:post(origin+'/api/auth/login-consume',{token}),env});assert.equal(r.status,marker==='provider_delivered'?200:401);assert.equal(db.count('sessions'),marker==='provider_delivered'?1:0);}finally{db.close();}
    });
  }
  for(const fault of ['provider','mark-throw','mark-zero']) {
    await check('M14-failure-'+fault,'delivery/positive-source persistence failure cannot leave a usable challenge',async()=>{
      const db=seed();try {
        const env=environment(db);let captured;
        env.MEMBER_LOGIN_PROVIDER={send:async m=>{captured=m;if(fault==='provider')throw new Error('synthetic provider failure');}};
        const original=db.runStatement.bind(db);if(fault!=='provider')db.runStatement=st=>{if(st.sql.includes('SET delivery_error=?')&&!st.sql.includes("delivery_status='failed'")){if(fault==='mark-throw')throw new Error('synthetic mark failure');return {meta:{changes:0},success:true};}return original(st);};
        const r=await requestLogin({request:post(origin+'/api/auth/login-request',{email:'employee@b1-entry.invalid'}),env});assert.equal(r.status,fault==='provider'?202:503);
        const token=tokenOf(captured.loginUrl);assert.equal((await consumeLogin({request:post(origin+'/api/auth/login-consume',{token}),env})).status,401);assert.equal(db.count('sessions'),0);
      }finally{db.close();}
    });
  }
  for(const role of ['employee','verifier','owner']) {
    await check('M03-invite-'+role,'real issuer, wrong email reject, correct accept, replay reject',async()=>{
      const db=seed();try {
        const env=environment(db);const issuer=await login(env,'external_builder@b1-entry.invalid');const email=role+'-invite@b1-entry.invalid';
        const cr=await createInvitation({request:post(origin+'/api/projects/'+projectId+'/invitations',{email,role},issuer.cookie),env,params:{projectId}});assert.equal(cr.status,201);const {invitation}=await cr.json();
        const params={invitationRef:invitation.token};const initial=[db.count('accounts'),db.count('project_memberships'),db.count('sessions')];
        const wrong=await acceptInvitation({request:post(origin+'/api/invitations/'+invitation.token+'/accept',{email:'wrong@b1-entry.invalid'}),env,params});assert.equal(wrong.status,403);assert.deepEqual([db.count('accounts'),db.count('project_memberships'),db.count('sessions')],initial);
        const accepted=await acceptInvitation({request:post(origin+'/api/invitations/'+invitation.token+'/accept',{email,name:'合成受邀者',role:'external_builder'}),env,params});assert.equal(accepted.status,200);assert.equal((await accepted.json()).role,role);
        const session=await getSession({request:new Request(origin+'/api/auth/session',{headers:{Cookie:cookieOf(accepted)}}),env});assert.equal((await session.json()).role,role);
        assert.equal((await acceptInvitation({request:post(origin+'/api/invitations/'+invitation.token+'/accept',{email}),env,params})).status,409);
      }finally{db.close();}
    });
  }
  for(const scenario of ['expired','revoked']) {
    await check('M03-invite-'+scenario,'unusable invitation cannot create members or sessions',async()=>{
      const db=seed();try {
        const env=environment(db);const issuer=await login(env,'external_builder@b1-entry.invalid');const email='negative@b1-entry.invalid';
        const cr=await createInvitation({request:post(origin+'/api/projects/'+projectId+'/invitations',{email,role:'employee'},issuer.cookie),env,params:{projectId}});const {invitation}=await cr.json();
        if(scenario==='expired')db.prepare("UPDATE invitations SET expires_at='2000-01-01' WHERE id=?").bind(invitation.id).run();
        else assert.equal((await revokeInvitation({request:post(origin+'/api/invitations/'+invitation.id+'/revoke',{},issuer.cookie),env,params:{invitationRef:invitation.id}})).status,200);
        const before=[db.count('accounts'),db.count('project_memberships'),db.count('sessions')];assert.equal((await acceptInvitation({request:post(origin+'/api/invitations/'+invitation.token+'/accept',{email}),env,params:{invitationRef:invitation.token}})).status,409);assert.deepEqual([db.count('accounts'),db.count('project_memberships'),db.count('sessions')],before);
      }finally{db.close();}
    });
  }
  await check('M02-bootstrap','controlled synthetic bootstrap success and invalid/missing configuration refusal',async()=>{
    for(const kind of ['valid','wrong','missing']) {
      const db=new D1Harness();try {
        const env={DB:db,FORMAL_AUTH_MODE:'production',...(kind==='missing'?{}:{FORMAL_BOOTSTRAP_TOKEN:'B1_PUBLIC_SYNTHETIC_ONLY'})};
        const r=await authorize({request:post(origin+'/api/auth/authorize',{enterpriseName:'合成企业',email:'new@b1-entry.invalid',name:'合成创建人',bootstrapToken:kind==='valid'?'B1_PUBLIC_SYNTHETIC_ONLY':'wrong'}),env});
        assert.equal(r.status,kind==='valid'?200:kind==='missing'?503:401);assert.equal(db.count('accounts'),kind==='valid'?1:0);
      }finally{db.close();}
    }
  });
  await check('M06-owner-boundary','owner cannot use raw material/employee/verifier/draft/task APIs; no published diagnosis seeded',async()=>{
    const db=seed();try {
      const env=environment(db);const real=await login(env,'owner@b1-entry.invalid');const ctx={request:new Request(origin+'/api/synthetic',{headers:{Cookie:real.cookie}}),env,params:{projectId}};
      for(const handler of [materials,employeeTask,verifierFacts,confirmedFacts,draftPacket,workItems])assert.equal((await handler(ctx)).status,403);
      assert.equal((await ownerPacket(ctx)).status,404);assert.equal(db.count('decision_packets'),0);
    }finally{db.close();}
  });
  assert.equal(externalCalls,0);
  console.log(JSON.stringify({summary:{passed:results.length,failed:0,externalCalls,scope:'synthetic actual handlers and entry VM; browser checked separately'}}));
}

if(args.includes('--serve')) await serve();
else if(args.includes('--c1-baseline')) await c1(true);
else await suite();
