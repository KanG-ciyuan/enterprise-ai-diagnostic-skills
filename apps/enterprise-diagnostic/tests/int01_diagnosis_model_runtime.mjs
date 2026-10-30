import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {callStructuredModel} from '../functions/api/agent/_model.js';

// Exact upstream failure envelope from the acceptance run; no paid/network calls.
const recorded=JSON.parse(readFileSync(new URL('./fixtures/int01_deepseek_empty_final.json',import.meta.url))).response;
let passed=0,failed=0;
async function check(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+' '+e.message);}}
const env={DEEPSEEK_API_KEY:'synthetic-local-test',DEEPSEEK_MODEL:'deepseek-flash'};
let calls,request;
function response(payload,status=200){calls=0;globalThis.fetch=async(_url,init)=>{calls++;request=JSON.parse(init.body);return new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json'}});};}
const answer=(content,finish_reason='stop',reasoning_content='')=>({choices:[{finish_reason,message:{role:'assistant',content,reasoning_content}}]});
const run=()=>callStructuredModel({env,system:'Return JSON only',user:'Synthetic verified facts'});
await check('recorded real failure remains empty-final rejection, never uses reasoning',async()=>{response(recorded);await assert.rejects(run(),e=>e.code==='model_output_empty'&&e.status===502);assert.equal(calls,1);});
await check('diagnosis explicitly disables thinking without increasing 1200 output budget',async()=>{response(answer('{"suggestions":[]}'));await run();assert.deepEqual(request.thinking,{type:'disabled'});assert.equal(request.max_tokens,1200);assert.deepEqual(request.response_format,{type:'json_object'});});
await check('valid final JSON is read from content only',async()=>{response(answer('{"suggestions":[]}', 'stop','{"suggestions":[{"invented":true}]}'));assert.deepEqual(await run(),{suggestions:[]});assert.equal(calls,1);});
await check('truncated final output is rejected even if a partial object parses',async()=>{response(answer('{"suggestions":[]}','length'));await assert.rejects(run(),e=>e.code==='model_output_truncated'&&e.status===502);assert.equal(calls,1);});
await check('invalid JSON never falls back to reasoning JSON',async()=>{response(answer('not JSON','stop','{"suggestions":[]}'));await assert.rejects(run(),e=>e.code==='model_output_invalid');assert.equal(calls,1);});
await check('whitespace-only final remains rejected',async()=>{response(answer('   '));await assert.rejects(run(),e=>e.code==='model_output_empty');});
await check('bounded fenced JSON compatibility stays intact',async()=>{response(answer('```json\n{"suggestions":[]}\n```'));assert.deepEqual(await run(),{suggestions:[]});});
await check('upstream failure does not trigger retries',async()=>{response({error:{message:'synthetic failure'}},503);await assert.rejects(run(),e=>e.code==='model_upstream_error');assert.equal(calls,1);});
await check('transport failure does not trigger retries',async()=>{calls=0;globalThis.fetch=async()=>{calls++;throw new Error('synthetic offline');};await assert.rejects(run(),e=>e.code==='model_transport_error');assert.equal(calls,1);});
await check('timeout does not trigger retries',async()=>{calls=0;globalThis.fetch=async()=>{calls++;throw new DOMException('synthetic timeout','AbortError');};await assert.rejects(run(),e=>e.code==='model_timeout');assert.equal(calls,1);});
console.log(JSON.stringify({passed,failed,realModelCalls:0}));process.exitCode=failed?1:0;
