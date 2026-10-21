import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicGateway} from './gateway.mjs';

const TOKEN='fixture-private-source-bearer-not-a-real-credential',SOURCE='https://private-intel.example.chatgpt.site/',ORIGIN='https://intel.example.test';
const ENV={SOURCE_SITE_URL:SOURCE,SOURCE_SITE_TOKEN:TOKEN};
const DATA={companies:[{id:'company-one',name:'Leidos'}],records:[{id:'record-one',title:'Canonical evidence',company:'Leidos',url:'https://example.test/source',summary:'Source excerpt'}],alerts:[],schedule:{enabled:true,label:'Authoritative source schedule',timeZone:'America/Phoenix'},snapshots:[{id:'saved-one',title:'Shared report'}],access:{mode:'owner',readOnly:false},metadata:{sourceToken:TOKEN},adminEmail:'not-public@example.test',workshops:[{id:'session-one',notes:'Analyst working notes',sessionSecret:TOKEN}],run:{finished:'2026-10-21T19:00:00Z'}};
const request=(path='/api/workspace',value,headers={})=>new Request(ORIGIN+path,{method:value===undefined?'GET':'POST',headers:{...(value===undefined?{}:{Origin:ORIGIN,'Content-Type':'application/json'}),...headers},...(value===undefined?{}:{body:JSON.stringify(value)})});
function fixture(data=DATA){const calls=[];return {calls,handler:createPublicGateway(ENV,{fetch:async(url,options)=>{calls.push({url,options});return Response.json(data);}})};}

test('Source configuration accepts only a fixed HTTPS Sites origin with a server-side credential',()=>{
  for(const url of ['http://private.example.chatgpt.site/','https://chatgpt.site/','https://private.chatgpt.site.evil.test/','https://private.chatgpt.site:8443/','https://user:pass@private.chatgpt.site/','https://private.chatgpt.site/api/backup','https://private.chatgpt.site/?target=evil'])assert.throws(()=>createPublicGateway({...ENV,SOURCE_SITE_URL:url}),/source|HTTPS/i);
  assert.throws(()=>createPublicGateway({...ENV,SOURCE_SITE_TOKEN:''}),/credential/);assert.throws(()=>createPublicGateway({...ENV,SOURCE_SITE_TOKEN:'bad\ncredential'}),/credential/);
});

test('Public workspace fetch uses only the configured source, strips private metadata and retains source schedule state',async()=>{
  const {calls,handler}=fixture({...DATA,records:[{...DATA.records[0],summary:'Accidental '+TOKEN+' echo',authorization:TOKEN}]});
  const response=await handler(request('/api/workspace?source=https://evil.test/api/backup',undefined,{Authorization:'Bearer client-value'}));assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const text=await response.text(),data=JSON.parse(text);
  assert.equal(calls.length,1);assert.equal(calls[0].url,new URL('/api/workspace',SOURCE).href);assert.equal(calls[0].options.redirect,'manual');assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.headers['OAI-Sites-Authorization'],'Bearer '+TOKEN);assert.equal(calls[0].options.headers.Authorization,undefined);
  assert.deepEqual(data.access,{mode:'public',readOnly:true,editorUrl:SOURCE});assert.deepEqual(data.schedule,DATA.schedule);assert.equal(data.metadata,undefined);assert.equal(data.adminEmail,undefined);assert.equal(data.workshops[0].sessionSecret,undefined);assert.equal(data.records[0].authorization,undefined);assert(!text.includes(TOKEN));assert.match(data.records[0].summary,/\[redacted\]/);
});

test('Public auth and bootstrap disclose no credentials and never contact or mutate the private Site',async()=>{
  const {calls,handler}=fixture();const auth=await(await handler(request('/api/auth'))).json();assert.equal(auth.mode,'public');assert.equal(auth.readOnly,true);assert.equal(auth.csrf,undefined);assert.equal(auth.editorUrl,SOURCE);
  assert.deepEqual(await(await handler(request('/api/workspace',{action:'bootstrap'}))).json(),{ok:true,readOnly:true});assert.equal(calls.length,0);
});

test('Every shared write and private API is denied before any upstream request',async()=>{
  const {calls,handler}=fixture();
  for(const action of ['record','competitor','import','schedule','ack','ack_event','capture_plan','pursuit','workshop','entity','preferences','official_import','finding','unknown'])assert.equal((await handler(request('/api/workspace',{action}))).status,403,action);
  for(const path of ['/api/refresh','/api/ingest','/api/backup','/api/collector','/api/transfer/import'])for(const value of [undefined,{}])assert.equal((await handler(request(path,value))).status,403,path);
  assert.equal(calls.length,0);
});

test('Saved snapshot reads proxy only the validated read action and strip sensitive response fields',async()=>{
  const {calls,handler}=fixture({ok:true,snapshot:{snapshotId:'saved-one',title:'Saved source brief',sourceToken:TOKEN},metadata:{token:TOKEN}});
  const response=await handler(request('/api/workspace',{action:'snapshot_get',id:'saved-one',upstream:'https://evil.test',actionOverride:'import'}));assert.equal(response.status,200);assert.equal(calls.length,1);assert.deepEqual(JSON.parse(calls[0].options.body),{action:'snapshot_get',id:'saved-one'});assert.equal(calls[0].options.method,'POST');assert.equal(calls[0].options.redirect,'manual');assert.equal(calls[0].url,new URL('/api/workspace',SOURCE).href);
  const data=await response.json();assert.equal(data.snapshot.title,'Saved source brief');assert.equal(data.snapshot.sourceToken,undefined);assert.equal(data.metadata,undefined);
  for(const id of ['', '../backup','saved?id=one','x'.repeat(101),42])assert.equal((await handler(request('/api/workspace',{action:'snapshot_get',id}))).status,400);assert.equal(calls.length,1);
});

test('Brief exports use canonical source evidence and return ephemeral options without any upstream POST',async()=>{
  const {calls,handler}=fixture();
  const response=await handler(request('/api/workspace',{action:'brief_snapshot',options:{title:'Public evidence brief',records:[{id:'record-one',title:'Forged title'}],findings:[{change:'Analyst interpretation',evidenceIds:['record-one']}]}}));assert.equal(response.status,200);const result=await response.json();assert.equal(result.options.ephemeral,true);assert.equal(result.options.records[0].title,'Canonical evidence');assert(result.options.snapshotId);assert(Number.isFinite(Date.parse(result.options.generatedAt)));assert.equal(calls.length,1);assert.equal(calls[0].options.method,'GET');assert.equal(calls[0].options.body,undefined);
  for(const options of [{records:[]},{records:[{id:'record-one'},{id:'record-one'}]},{records:[{id:'missing'}]},{records:[{id:'record-one'}],findings:[{evidenceIds:['missing']}]},{records:Array.from({length:1001},(_,i)=>({id:String(i)}))}])assert.equal((await handler(request('/api/workspace',{action:'brief_snapshot',options}))).status,400);
  assert(calls.every(call=>call.options.method==='GET'));
  const concept=await handler(request('/api/workspace',{action:'brief_snapshot',options:{records:[],ov1:{mission:'Analyst concept'}}}));assert.equal(concept.status,200);assert.equal((await concept.json()).options.ephemeral,true);
});

test('POST origin, content type, JSON and body limits reject unsafe input without contacting the source',async()=>{
  const {calls,handler}=fixture();
  assert.equal((await handler(request('/api/workspace',{action:'bootstrap'},{Origin:'https://evil.test'}))).status,403);const missing=request('/api/workspace',{action:'bootstrap'});missing.headers.delete('Origin');assert.equal((await handler(missing)).status,403);
  assert.equal((await handler(request('/api/workspace',{action:'bootstrap'},{'Sec-Fetch-Site':'cross-site'}))).status,403);assert.equal((await handler(request('/api/workspace',{action:'bootstrap'},{'Content-Type':'text/plain'}))).status,415);
  assert.equal((await handler(new Request(ORIGIN+'/api/workspace',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:'{bad json'}))).status,400);
  assert.equal((await handler(request('/api/workspace',{action:'bootstrap',large:'x'.repeat(2_000_001)}))).status,413);assert.equal(calls.length,0);
});

test('Redirects, login HTML, bad source JSON and source failures expose only a generic error',async()=>{
  const cases=[()=>Response.redirect('https://evil.test/collect',302),()=>new Response('private login '+TOKEN,{status:200,headers:{'Content-Type':'text/html'}}),()=>new Response('{bad '+TOKEN,{status:200,headers:{'Content-Type':'application/json'}}),()=>Response.json({error:'private '+TOKEN},{status:500}),()=>Response.json({records:[]}),()=>Response.json(DATA,{headers:{'Content-Length':String(21*1024*1024)}}),()=>{throw Error('Credential '+TOKEN+' upstream failure');},()=>{const response=Response.json(DATA);Object.defineProperty(response,'url',{value:'https://evil.test/api/workspace'});return response;}];
  for(const response of cases){const calls=[],handler=createPublicGateway(ENV,{fetch:async(url,options)=>{calls.push({url,options});return response();}}),result=await handler(request());assert.equal(result.status,502);const text=await result.text();assert(!text.includes(TOKEN));assert(!text.includes('evil.test'));assert.equal(JSON.parse(text).error,'Shared intelligence is temporarily unavailable. Try again later.');assert.equal(calls.length,1);assert.equal(calls[0].options.redirect,'manual');assert.equal(calls[0].url,new URL('/api/workspace',SOURCE).href);}
});

test('Source credential redaction also covers unexpected object keys and saved-snapshot failures',async()=>{
  const token='OpaqueFixtureValue123456789',handler=createPublicGateway({...ENV,SOURCE_SITE_TOKEN:token},{fetch:async()=>Response.json({...DATA,records:[{...DATA.records[0],[token]:'Unexpected key',summary:token}]})});
  const response=await handler(request()),text=await response.text();assert.equal(response.status,200);assert(!text.includes(token));assert.match(text,/\[redacted\]/);
  const failing=createPublicGateway(ENV,{fetch:async()=>Response.json({error:'Snapshot not found '+TOKEN},{status:400})}),failure=await failing(request('/api/workspace',{action:'snapshot_get',id:'missing-snapshot'}));assert.equal(failure.status,502);assert(!(await failure.text()).includes(TOKEN));
});

test('Worker-compatible manual mode rejects every class of redirect without requesting any Location',async()=>{
  for(const status of [300,301,302,303,304,305,307,308,399]){
    const calls=[],handler=createPublicGateway(ENV,{fetch:async(url,options)=>{calls.push({url,options});return new Response(null,{status,headers:{Location:status%2?'https://evil.test/collect':new URL('/alternate',SOURCE).href,'Content-Type':'application/json'}});}});
    const response=await handler(request());assert.equal(response.status,502);assert.equal(calls.length,1);assert.equal(calls[0].url,new URL('/api/workspace',SOURCE).href);assert.equal(calls[0].options.redirect,'manual');
    assert(!(await response.text()).includes(TOKEN));
  }
});
