import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createD1,applyMigrations,initializeDatabase} from './runtime.mjs';
import {createAuth,hashPassword} from './auth.mjs';
import {createApplication,createCollectionLock,startScheduler,phoenixSlot,collectionSchedule} from './server.mjs';
import {buildPortable} from './build.mjs';
import {BACKUP_SCHEMA,importComplete} from './import-backup.mjs';
import {request as httpRequest} from 'node:http';
import {runInNewContext} from 'node:vm';

const HERE=fileURLToPath(new URL('.',import.meta.url)),TEMP=await mkdtemp(join(HERE,'.adapter-test-'));
const PASSWORD='Strong-owner-only-test-password-52!';
const PASSWORD_HASH=await hashPassword(PASSWORD);
const ENV={ADMIN_EMAIL:'owner@example.test',ADMIN_PASSWORD_HASH:PASSWORD_HASH,SESSION_SECRET:'test-only-random-material-must-not-be-used-in-production-42',PUBLIC_ORIGIN:'https://intel.insightfuldefense.com',ENABLE_SCHEDULER:'false'};
async function migrationDirectory(name){const directory=join(TEMP,name);await mkdir(join(directory,'meta'),{recursive:true});await writeFile(join(directory,'meta','_journal.json'),JSON.stringify({entries:[{idx:0,tag:'0000_first'},{idx:1,tag:'0001_second'}]}));await writeFile(join(directory,'0000_first.sql'),'CREATE TABLE app_records(id TEXT PRIMARY KEY,value TEXT);');await writeFile(join(directory,'0001_second.sql'),'ALTER TABLE app_records ADD COLUMN note TEXT;');return directory;}
let databaseCounter=0;
async function database(){const sql=new DatabaseSync(':memory:');applyMigrations(sql,await migrationDirectory('migrations-'+databaseCounter++));return sql;}
const request=(cookie,origin=ENV.PUBLIC_ORIGIN)=>({headers:{cookie,origin,'sec-fetch-site':'same-origin'},socket:{remoteAddress:'127.0.0.1'}});
const cookiePair=value=>value.split(';',1)[0];
async function authenticate(auth){const challenge=auth.loginPageToken();const result=await auth.login(request(cookiePair(challenge.cookie)),{csrf:challenge.value,email:ENV.ADMIN_EMAIL,password:PASSWORD});assert.equal(result.status,303);return cookiePair(result.cookies[0]);}

test('D1 bindings and batch transactions preserve writes and rollback failures',async()=>{
  const sql=await database(),DB=createD1(sql);
  const result=await DB.prepare('INSERT INTO app_records(id,value)VALUES(?,?)').bind('one','original').run();assert.equal(result.meta.changes,1);
  assert.equal(await DB.prepare('SELECT value FROM app_records WHERE id=?').bind('one').first('value'),'original');
  assert.equal((await DB.prepare('SELECT * FROM app_records').all()).results.length,1);
  await assert.rejects(()=>DB.batch([DB.prepare('INSERT INTO app_records(id,value)VALUES(?,?)').bind('two','pending'),DB.prepare('INSERT INTO app_records(id,value)VALUES(?,?)').bind('one','duplicate')]));
  assert.equal(await DB.prepare('SELECT id FROM app_records WHERE id=?').bind('two').first(),null);
  await DB.batch([DB.prepare('UPDATE app_records SET value=? WHERE id=?').bind('updated','one'),DB.prepare('INSERT INTO app_records(id,value)VALUES(?,?)').bind('two','committed')]);
  assert.equal(await DB.prepare('SELECT value FROM app_records WHERE id=?').bind('one').first('value'),'updated');sql.close();
});

test('Migrations apply once, keep ledger/user_version, and reject drift or unsafe replay',async()=>{
  const directory=await migrationDirectory('repeat-migrations'),sql=new DatabaseSync(':memory:');applyMigrations(sql,directory);sql.prepare('INSERT INTO app_records(id,value)VALUES(?,?)').run('kept','unchanged');applyMigrations(sql,directory);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM __portable_migrations').get().n,2);assert.equal(sql.prepare('PRAGMA user_version').get().user_version,2);assert.equal(sql.prepare('SELECT value FROM app_records WHERE id=?').get('kept').value,'unchanged');
  await writeFile(join(directory,'0000_first.sql'),'CREATE TABLE changed(id TEXT);');assert.throws(()=>applyMigrations(sql,directory),/changed/);sql.close();
  const untracked=new DatabaseSync(':memory:');untracked.exec('CREATE TABLE existing_private_data(id TEXT)');assert.throws(()=>applyMigrations(untracked,directory),/no portable migration ledger/);untracked.close();
});

test('No default credentials; password/owner changes invalidate sessions; sign-out revokes',async()=>{
  const sql=await database();await assert.rejects(()=>createAuth({...ENV,SESSION_SECRET:''},sql),/SESSION_SECRET/);await assert.rejects(()=>createAuth({...ENV,ADMIN_EMAIL:''},sql),/ADMIN_EMAIL/);await assert.rejects(()=>createAuth({...ENV,ADMIN_PASSWORD_HASH:''},sql),/Password/);
  const auth=await createAuth(ENV,sql),cookie=await authenticate(auth),session=await auth.session(request(cookie));assert(session);assert.equal(session.purpose,'session');assert(auth.csrf({headers:{'x-csrf-token':session.csrf}},session));assert(!auth.csrf({headers:{'x-csrf-token':'bad'}},session));
  assert(!await auth.session(request(cookie.slice(0,-1)+'x')),'altered signature must fail');
  const rotated=await createAuth({...ENV,ADMIN_EMAIL:'new-owner@example.test'},sql);assert.equal(await rotated.session(request(cookie)),null);
  await auth.logout(session);assert.equal(await auth.session(request(cookie)),null);sql.close();
});

test('Password login enforces challenge, exact origin, rate limits and Secure cookies',async()=>{
  const sql=await database(),auth=await createAuth(ENV,sql),challenge=auth.loginPageToken();
  assert.match(challenge.cookie,/HttpOnly/);assert.match(challenge.cookie,/SameSite=Strict/);assert.match(challenge.cookie,/; Secure/);assert.match(challenge.cookie,/^__Host-/);
  assert.equal((await auth.login(request(cookiePair(challenge.cookie),'https://attacker.example'),{csrf:challenge.value,email:ENV.ADMIN_EMAIL,password:PASSWORD})).status,403);
  assert.equal((await auth.login(request(cookiePair(challenge.cookie)),{csrf:'invalid',email:ENV.ADMIN_EMAIL,password:PASSWORD})).status,403);
  for(let i=0;i<5;i++)assert.equal((await auth.login(request(cookiePair(challenge.cookie)),{csrf:challenge.value,email:ENV.ADMIN_EMAIL,password:'incorrect'})).status,401);
  assert.equal((await auth.login(request(cookiePair(challenge.cookie)),{csrf:challenge.value,email:ENV.ADMIN_EMAIL,password:PASSWORD})).status,429);sql.close();
});

test('Passwordless access modes validate their trust boundary and do not require owner credentials',async()=>{
  const preview='https://owner-editor.preview.c38.airoapp.ai',environment={ACCESS_MODE:'godaddy-private-preview',PUBLIC_ORIGIN:preview};
  const auth=await createAuth(environment),session=await auth.session({headers:{}});
  assert.equal(auth.mode,'godaddy-private-preview');assert.equal(auth.access.readOnly,false);assert.equal(auth.secure,true);assert(session.csrf);assert.equal(auth.login,undefined);
  assert(auth.trustedHost({headers:{host:new URL(preview).host}}));assert(!auth.trustedHost({headers:{host:'intel.insightfuldefense.com','x-forwarded-host':new URL(preview).host}}));
  assert(auth.sameOrigin({headers:{origin:preview}}));assert(!auth.sameOrigin({headers:{origin:'https://evil.example.test'}}));assert(auth.csrf({headers:{'x-csrf-token':session.csrf}},session));
  const restarted=await createAuth(environment);assert(!restarted.csrf({headers:{'x-csrf-token':session.csrf}},session),'process restart rotates managed CSRF');
  for(const origin of ['https://preview.c38.airoapp.ai','https://a.b.preview.c38.airoapp.ai','https://owner-editor.preview.c38.airoapp.ai.evil.test','http://owner-editor.preview.c38.airoapp.ai','https://owner-editor.preview.c38.airoapp.ai:8443','https://owner-editor.preview.c38.airoapp.ai/path'])await assert.rejects(()=>createAuth({...environment,PUBLIC_ORIGIN:origin}),/HTTPS origin/);
  const publicAuth=await createAuth({ACCESS_MODE:'public',PUBLIC_ORIGIN:'https://intel.insightfuldefense.com',PRIVATE_PREVIEW_URL:preview});assert.deepEqual(publicAuth.access,{mode:'public',readOnly:true,editorUrl:preview});assert.equal((await publicAuth.session({headers:{}})).csrf,null);assert.equal(publicAuth.login,undefined);
  await assert.rejects(()=>createAuth({ACCESS_MODE:'public',PUBLIC_ORIGIN:'http://127.0.0.1:3000',ALLOW_INSECURE_LOCALHOST:'true'}),/HTTPS origin/);
  await assert.rejects(()=>createAuth({ACCESS_MODE:'public',PUBLIC_ORIGIN:'https://intel.example.test',PRIVATE_PREVIEW_URL:'https://evil.example.test'}),/private preview/);
  await assert.rejects(()=>createAuth({ACCESS_MODE:'typo'}),/ACCESS_MODE/);
});

test('Browser bridge adds writable-mode CSRF and presents sign-out only for app-password mode',async()=>{
  const source=await readFile(join(HERE,'client.js'),'utf8'),origin='https://intel.example.test';
  for(const mode of ['public','godaddy-private-preview','owner-password']){
    const calls=[],buttons=[],redirects=[],events=new Map(),session={mode,...(mode==='public'?{}:{csrf:'process-test-csrf'})};
    class BrowserRequest extends Request{constructor(input,options){super(typeof input==='string'?new URL(input,origin):input,options);}}
    const window={location:{origin,assign:path=>redirects.push(path)},fetch:async(input,options)=>{const request=new BrowserRequest(input,options);calls.push(request);return new Response(JSON.stringify(request.url.endsWith('/auth/session')?session:{ok:true}),{status:200,headers:{'Content-Type':'application/json'}});}};
    const document={addEventListener:(name,callback)=>events.set(name,callback),querySelector:()=>({append:button=>buttons.push(button)}),createElement:()=>({addEventListener(){}})};
    runInNewContext(source,{window,document,Request:BrowserRequest,Headers,URL});await events.get('DOMContentLoaded')();
    assert.equal(buttons.length,mode==='owner-password'?1:0,mode);assert.equal(redirects.length,0);
    await window.fetch('/api/workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(calls.at(-1).headers.get('X-CSRF-Token'),mode==='public'?null:session.csrf,mode);
  }
});

test('Public HTTP mode permits public reads and validated ephemeral exports while preventing shared writes and backups',async()=>{
  const sql=await database(),publicDirectory=join(TEMP,'public-mode');await mkdir(publicDirectory);await writeFile(join(publicDirectory,'index.html'),'<html><head></head><body>Public workspace</body></html>');await writeFile(join(publicDirectory,'app.js'),'console.log("public app");');
  let bootstraps=0,mutations=0,refreshes=0;const record={id:'evidence-one',company:'Leidos',title:'Canonical source title',url:'https://example.test/source'};
  const business={async bootstrap(){bootstraps++;},async workspace(){return {records:[record],schedule:{enabled:true,label:'Copied schedule claims daily collection'}};},async mutate(value){assert.equal(value.action,'snapshot_get');mutations++;return {ok:true,snapshot:{id:value.id,title:'Public saved report'}};},async refresh(){refreshes++;return {status:'ok'};},async persistCollection(){throw Error('Public ingest must not run');}};
  const environment={ACCESS_MODE:'public',PUBLIC_ORIGIN:'https://intel.insightfuldefense.com',PRIVATE_PREVIEW_URL:'https://owner-editor.preview.c38.airoapp.ai',ENABLE_SCHEDULER:'false'};
  const app=await createApplication({environment,runtime:{database:sql},publicDirectory,business}),address=await app.listen(0,'127.0.0.1'),base='http://127.0.0.1:'+address.port;
  const post=value=>fetch(base+'/api/workspace',{method:'POST',headers:{Origin:environment.PUBLIC_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify(value)});
  try{
    const session=await(await fetch(base+'/auth/session')).json();assert.equal(session.mode,'public');assert.equal(session.readOnly,true);assert.equal(session.csrf,undefined);assert.equal(session.email,undefined);
    assert.equal((await fetch(base+'/auth/login',{redirect:'manual'})).status,404);assert.equal((await fetch(base+'/app.js')).status,200);assert.match(await(await fetch(base+'/')).text(),/auth\/client\.js/);
    const workspace=await(await fetch(base+'/api/workspace')).json();assert.equal(workspace.access.readOnly,true);assert.equal(workspace.access.editorUrl,environment.PRIVATE_PREVIEW_URL);assert.equal(workspace.records[0].id,record.id);assert.equal(workspace.schedule.enabled,false);assert.equal(workspace.schedule.label,'Automatic collection is paused here.');assert(!workspace.schedule.label.includes('Copied schedule'));
    assert.equal((await post({action:'bootstrap'})).status,200);assert.equal(bootstraps,1,'public bootstrap request must not execute business bootstrap');
    for(const action of ['capture_plan','finding','workshop','pursuit','preferences','entity','import','add_company','unknown'])assert.equal((await post({action})).status,403,action);
    for(const [path,method] of [['/api/backup','GET'],['/api/refresh','POST'],['/api/ingest','POST'],['/api/transfer/import','POST']])assert.equal((await fetch(base+path,{method,headers:{Origin:environment.PUBLIC_ORIGIN,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})})).status,403,path);
    const generated=await post({action:'brief_snapshot',options:{title:'Public download',records:[{id:record.id,title:'Untrusted replacement'}],findings:[{evidenceIds:[record.id],change:'Analyst finding'}]}});assert.equal(generated.status,200);const result=await generated.json();assert.equal(result.options.ephemeral,true);assert.equal(result.options.records[0].title,record.title);assert(result.options.snapshotId);assert.equal(mutations,0,'ephemeral snapshots never call the persisting business mutation');
    assert.equal((await post({action:'brief_snapshot',options:{records:[{id:'missing'}]}})).status,400);assert.equal((await post({action:'brief_snapshot',options:{records:[record],findings:[{evidenceIds:['missing']}]}})).status,400);
    assert.equal((await post({action:'snapshot_get',id:'saved-report'})).status,200);assert.equal(mutations,1);assert.equal(refreshes,0);
    assert.equal((await fetch(base+'/api/workspace',{method:'POST',headers:{Origin:'https://evil.example.test','Content-Type':'application/json'},body:'{"action":"bootstrap"}'})).status,403);
  }finally{await app.close();sql.close();}
});

test('GoDaddy managed preview permits owner CRUD without app login but rejects wrong Host, Origin and missing CSRF',async()=>{
  // Native HTTP preserves the explicit Host. Node fetch deliberately replaces it.
  const fetch=(url,options={})=>new Promise((resolve,reject)=>{const request=httpRequest(url,{method:options.method||'GET',headers:options.headers},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));response.on('error',reject);});request.on('error',reject);request.end(options.body);});
  const sql=await database(),publicDirectory=join(TEMP,'managed-mode');await mkdir(publicDirectory);await writeFile(join(publicDirectory,'index.html'),'<html><head></head><body>Owner editor</body></html>');
  let mutations=0,refreshes=0;const business={async bootstrap(){},async workspace(){return {records:[]};},async mutate(value){mutations++;return {ok:true,action:value.action};},async refresh(){refreshes++;return {status:'ok'};},async persistCollection(){return {status:'ok'};}};
  const environment={ACCESS_MODE:'godaddy-private-preview',PUBLIC_ORIGIN:'https://owner-editor.preview.c38.airoapp.ai',ENABLE_SCHEDULER:'false'},host=new URL(environment.PUBLIC_ORIGIN).host;
  const app=await createApplication({environment,runtime:{database:sql},publicDirectory,business}),address=await app.listen(0,'127.0.0.1'),base='http://127.0.0.1:'+address.port;
  try{
    assert.equal((await fetch(base+'/api/workspace')).status,421);assert.equal((await fetch(base+'/api/workspace',{headers:{Host:'intel.insightfuldefense.com','X-Forwarded-Host':host}})).status,421);
    const response=await fetch(base+'/auth/session',{headers:{Host:host}}),session=await response.json();assert.equal(response.headers.getSetCookie().length,0);assert.equal(session.mode,'godaddy-private-preview');assert.equal(session.readOnly,false);assert(session.csrf);assert.equal(session.email,undefined);
    assert.equal((await fetch(base+'/auth/login',{headers:{Host:host},redirect:'manual'})).status,404);
    const headers={Host:host,Origin:environment.PUBLIC_ORIGIN,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'};
    assert.equal((await fetch(base+'/api/workspace',{headers:{Host:host}})).status,200);
    assert.equal((await fetch(base+'/api/workspace',{method:'POST',headers:{Host:host,Origin:environment.PUBLIC_ORIGIN,'Content-Type':'application/json'},body:'{"action":"capture_plan"}'})).status,403);
    assert.equal((await fetch(base+'/api/workspace',{method:'POST',headers:{...headers,Origin:'https://evil.example.test'},body:'{"action":"capture_plan"}'})).status,403);
    assert.equal((await fetch(base+'/api/workspace',{method:'POST',headers,body:'{"action":"capture_plan"}'})).status,200);assert.equal(mutations,1);
    assert.equal((await fetch(base+'/api/refresh',{method:'POST',headers})).status,200);assert.equal(refreshes,1);
  }finally{await app.close();sql.close();}
});

test('HTTP app protects assets and data; good CSRF works; logout blocks old cookie',async()=>{
  const sql=await database(),publicDirectory=join(TEMP,'public');await mkdir(publicDirectory);await writeFile(join(publicDirectory,'index.html'),'<html><head></head><body>Private intelligence</body></html>');await writeFile(join(publicDirectory,'app.js'),'console.log("private asset");');
  let mutations=0;
  const fake={async bootstrap(){},async workspace(){return {records:[{id:'private-record'}]};},async mutate(value){mutations++;return {ok:true,action:value.action};},async refresh(){return {status:'ok'};},async persistCollection(){return {status:'ok'};}};
  const app=await createApplication({environment:ENV,runtime:{database:sql},publicDirectory,business:fake});const address=await app.listen(0,'127.0.0.1'),base='http://127.0.0.1:'+address.port;
  try{
    assert.equal((await fetch(base+'/api/workspace')).status,401);assert.equal((await fetch(base+'/app.js',{redirect:'manual'})).status,303);assert.deepEqual(await(await fetch(base+'/healthz')).json(),{status:'ok'});
    const loginPage=await fetch(base+'/auth/login'),html=await loginPage.text(),challenge=/name="csrf" value="([^"]+)"/.exec(html)[1],challengeCookie=cookiePair(loginPage.headers.getSetCookie()[0]);
    const login=await fetch(base+'/auth/login',{method:'POST',redirect:'manual',headers:{Origin:ENV.PUBLIC_ORIGIN,Cookie:challengeCookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:ENV.ADMIN_EMAIL,password:PASSWORD,csrf:challenge})});assert.equal(login.status,303);
    const cookie=cookiePair(login.headers.getSetCookie()[0]);assert.match(login.headers.getSetCookie()[0],/Secure/);
    const index=await fetch(base+'/',{headers:{Cookie:cookie}});assert.match(await index.text(),/\/auth\/client\.js/);assert.match(index.headers.get('cache-control'),/no-store/);
    const session=await(await fetch(base+'/auth/session',{headers:{Cookie:cookie}})).json();
    assert.equal((await fetch(base+'/api/workspace',{method:'POST',headers:{Cookie:cookie,Origin:ENV.PUBLIC_ORIGIN,'Content-Type':'application/json'},body:'{"action":"test"}'})).status,403);
    assert.equal((await fetch(base+'/api/workspace',{method:'POST',headers:{Cookie:cookie,Origin:'https://attacker.example','X-CSRF-Token':session.csrf,'Content-Type':'application/json'},body:'{"action":"test"}'})).status,403);
    assert.equal((await fetch(base+'/api/workspace',{method:'POST',headers:{Cookie:cookie,Origin:ENV.PUBLIC_ORIGIN,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'},body:'{"action":"test"}'})).status,200);assert.equal(mutations,1);
    assert.equal((await fetch(base+'/%2e%2e/hosting/auth.mjs',{headers:{Cookie:cookie}})).status,404);
    assert.equal((await fetch(base+'/api/ingest',{method:'POST',headers:{Cookie:cookie,Origin:ENV.PUBLIC_ORIGIN,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'},body:'{}'})).status,400);
    assert.equal((await fetch(base+'/auth/logout',{method:'POST',headers:{Cookie:cookie,Origin:ENV.PUBLIC_ORIGIN,'X-CSRF-Token':session.csrf}})).status,200);
    assert.equal((await fetch(base+'/api/workspace',{headers:{Cookie:cookie}})).status,401);
  }finally{await app.close();sql.close();}
});

test('Known mutation validation errors remain useful 400s while SQL and driver details remain private',async()=>{
  const sql=await database(),publicDirectory=join(TEMP,'validation-public');await mkdir(publicDirectory);await writeFile(join(publicDirectory,'index.html'),'<html><head></head><body>Private app</body></html>');
  const messages=[
    'Use 1–12 named criteria with unique IDs and positive total weight.','Use one assessment for each company and criterion.',
    'Give the capture plan a title.','Assessment scores must be 0–5 or unknown.','An assessment cites unavailable evidence.',
    'A capture plan cites unavailable evidence.','A pursuit needs a title and a valid nonnegative value when supplied.',
    'A workshop evidence record is unavailable.','A session needs a title and objective.','A cited evidence record is unavailable.',
    'Official award source must be USAspending.gov.','Competitor name is required.',
  ];
  const internal=["Unknown column 'private_database_secret' in 'field list'",'Unsupported database parameter','Persistent database unavailable'];
  const business={async bootstrap(){},async workspace(){return {};},async mutate(value){throw Error([...messages,...internal][value.index]);},async refresh(){return {status:'ok'};},async persistCollection(){return {status:'ok'};}};
  const app=await createApplication({environment:ENV,runtime:{database:sql},publicDirectory,business}),address=await app.listen(0,'127.0.0.1'),base='http://127.0.0.1:'+address.port;
  try{
    const cookie=await authenticate(app.auth),session=await app.auth.session({headers:{cookie}}),headers={Cookie:cookie,Origin:ENV.PUBLIC_ORIGIN,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'};
    for(let index=0;index<messages.length;index++){const response=await fetch(base+'/api/workspace',{method:'POST',headers,body:JSON.stringify({index})});assert.equal(response.status,400,messages[index]);assert.deepEqual(await response.json(),{error:messages[index]});}
    for(let i=0;i<internal.length;i++){const response=await fetch(base+'/api/workspace',{method:'POST',headers,body:JSON.stringify({index:messages.length+i})});assert.equal(response.status,500);const body=await response.text();assert.equal(JSON.parse(body).error,'The request could not be completed. Review the server logs.');assert(!body.includes(internal[i]));assert(!body.includes('private_database_secret'));}
  }finally{await app.close();sql.close();}
});

test('Phoenix schedule is 07:00/13:00; persistent claims and shared lock prevent overlap',async()=>{
  assert.match(phoenixSlot(new Date('2026-10-21T14:00:15Z')),/T07:00/);assert.match(phoenixSlot(new Date('2026-10-21T20:00:30Z')),/T13:00/);assert.equal(phoenixSlot(new Date('2026-10-21T14:01:00Z')),null);
  const sql=await database(),lock=createCollectionLock();let count=0,release;const pending=new Promise(resolve=>release=resolve);
  const scheduler=startScheduler({database:sql,lock,refresh:async()=>{count++;await pending;return {status:'ok'};},now:()=>new Date('2026-10-21T14:00:10Z'),enabled:false});
  const running=lock.run(async()=>{count++;await pending;return {status:'ok'};});assert.equal((await lock.run(async()=>{throw Error('Should not run concurrently');})).status,'busy');release();await running;
  scheduler.stop();
  const enabled=startScheduler({database:sql,lock,refresh:async()=>{count++;return {status:'ok'};},now:()=>new Date('2026-10-21T14:00:10Z')});await new Promise(resolve=>setTimeout(resolve,10));await enabled.tick();assert.equal(count,2);enabled.stop();
  const restarted=startScheduler({database:sql,lock,refresh:async()=>{count++;return {status:'ok'};},now:()=>new Date('2026-10-21T14:00:10Z')});await new Promise(resolve=>setTimeout(resolve,10));assert.equal(count,2);restarted.stop();sql.close();
});

test('Portable schedule reports the running scheduler rather than copied workspace metadata',async()=>{
  assert.equal(collectionSchedule(false).label,'Automatic collection is paused here.');assert.equal(collectionSchedule(false).enabled,false);
  const active=collectionSchedule(true);assert.deepEqual(active.localTimes,['07:00','13:00']);assert.equal(active.timeZone,'America/Phoenix');assert.equal(active.requiresRunningHost,true);assert.match(active.label,/host must keep this app running/);
  const sql=await database(),publicDirectory=join(TEMP,'schedule-public');await mkdir(publicDirectory);await writeFile(join(publicDirectory,'index.html'),'<html><head></head><body>Schedule</body></html>');
  const business={async bootstrap(){},async workspace(){return {records:[],schedule:{enabled:false,label:'Copied paused schedule',staleField:'old host'}};},async mutate(){return {ok:true};},async refresh(){return {status:'ok'};},async persistCollection(){return {status:'ok'};}};
  const app=await createApplication({environment:{ACCESS_MODE:'public',PUBLIC_ORIGIN:'https://intel.example.test',ENABLE_SCHEDULER:'true'},runtime:{database:sql},publicDirectory,business}),address=await app.listen(0,'127.0.0.1'),url='http://127.0.0.1:'+address.port+'/api/workspace';
  try{const running=await(await fetch(url)).json();assert.equal(running.schedule.enabled,true);assert.deepEqual(running.schedule.localTimes,['07:00','13:00']);assert.equal(running.schedule.staleField,undefined);app.scheduler.stop();const stopped=await(await fetch(url)).json();assert.equal(stopped.schedule.enabled,false);assert.equal(stopped.schedule.label,'Automatic collection is paused here.');}
  finally{await app.close();sql.close();}
});

test('Overview and source copy honor an explicit paused schedule and hide public owner refresh instructions',async()=>{
  const source=(await readFile(resolve(HERE,'../public/workspace.js'),'utf8')).split('function dataView(){')[0];
  const rendered=cloud=>runInNewContext(source+'\ncloud='+JSON.stringify({alerts:[],run:null,...cloud})+';({overview:overview(),sources:sources()});',{names:{},overview:()=>'<div>Base overview</div>',sources:()=>'',esc:value=>String(value??'')});
  const paused=rendered({schedule:{enabled:false,label:'Daily at 07:00 and 13:00'},access:{readOnly:true}});assert.match(paused.overview,/Automatic collection is paused here\./);assert(!paused.overview.includes('Automatic collection scheduled.'));assert(!paused.overview.includes('Use Refresh intelligence'));assert(!paused.sources.includes('Refresh intelligence to populate'));assert(!paused.sources.includes('Daily at 07:00 and 13:00'));assert.match(paused.sources,/Automatic collection is paused here\./);
  const owner=rendered({schedule:{enabled:false},access:{readOnly:false}});assert.match(owner.overview,/Use Refresh intelligence/);
  const enabled=rendered({schedule:collectionSchedule(true),access:{readOnly:true}});assert.match(enabled.overview,/07:00 and 13:00 Arizona time/);assert.match(enabled.overview,/host must keep this app running/);assert(!enabled.overview.includes('Use Refresh intelligence'));
  const legacy=rendered({schedule:{label:'Legacy schedule label'}});assert.match(legacy.overview,/Automatic collection scheduled\./);assert.match(legacy.sources,/Legacy schedule label/);
  assert.match(rendered({schedule:null}).overview,/Automatic schedule is being configured\./);
});

test('Portable build rewrites imports and executes actual business modules with SQLite',async()=>{
  const original=resolve(HERE,'..');
  const output=join(TEMP,'actual-build');await mkdir(join(output,'hosting'),{recursive:true});
  await writeFile(join(output,'hosting','runtime.mjs'),`export {env,initializeDatabase} from ${JSON.stringify(new URL('./runtime.mjs',import.meta.url).href)};\n`);
  // This test is a local read-only copy of the real app source, never a deployment or source edit.
  const built=await buildPortable({sourceDirectory:original,outputDirectory:output});assert.equal(Object.keys(built.modules).length,5);
  const compiled=await readFile(join(output,'server','workspace.js'),'utf8');assert.match(compiled,/\.\.\/hosting\/runtime\.mjs/);assert.match(compiled,/\.\/intelligence-workspace\.js/);assert.match(compiled,/with\s*\{\s*type:\s*['"]json['"]/);
  const dataDirectory=join(TEMP,'actual-data');await mkdir(dataDirectory);
  process.env.DATA_DIR=dataDirectory;
  const runtimeModule=await import('./runtime.mjs');const runtime=await runtimeModule.initializeDatabase({environment:{NODE_ENV:'test'},dataDirectory,migrationsDirectory:join(output,'drizzle')});
  try{const business=await import(new URL('file:///'+join(output,'server','workspace.js').replace(/\\/g,'/')));await business.bootstrap();const current=await business.workspace();assert(current.companies.length>=20);assert(Array.isArray(current.events));assert(Array.isArray(current.records));}
  finally{await runtime.close();delete process.env.DATA_DIR;}
});
test('Initial import gate prevents seeding, data access and collection until atomic owner transfer and restart',async()=>{
  const dataDirectory=join(TEMP,'gated-data');await mkdir(dataDirectory);
  const runtime=await initializeDatabase({environment:{NODE_ENV:'test'},dataDirectory,migrationsDirectory:resolve(HERE,'..','drizzle')});
  const publicDirectory=join(TEMP,'gated-public');await mkdir(publicDirectory);await writeFile(join(publicDirectory,'index.html'),'<html><head></head><body>Ready private app</body></html>');
  let bootstraps=0,refreshes=0;
  const business={async bootstrap(){bootstraps++;},async workspace(){return {records:[]};},async mutate(){return {ok:true};},async refresh(){refreshes++;return {status:'ok'};},async persistCollection(){throw Error('Gate must prevent ingestion');}};
  const environment={...ENV,IMPORT_REQUIRED:'true',ENABLE_SCHEDULER:'true'};
  const app=await createApplication({environment,runtime,publicDirectory,business}),address=await app.listen(0,'127.0.0.1'),base='http://127.0.0.1:'+address.port;
  let cookie;
  try{
    assert.equal(bootstraps,0);assert.equal(app.scheduler.enabled,false);assert.equal((await fetch(base+'/api/transfer/import',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
    cookie=await authenticate(app.auth);const session=await(await fetch(base+'/auth/session',{headers:{Cookie:cookie}})).json();
    assert.match(await(await fetch(base+'/',{headers:{Cookie:cookie}})).text(),/Transfer your private workspace/);
    for(const path of ['/api/workspace','/api/refresh','/api/ingest']){const method=path==='/api/workspace'?'GET':'POST';assert.equal((await fetch(base+path,{method,headers:{Cookie:cookie,Origin:ENV.PUBLIC_ORIGIN,'X-CSRF-Token':session.csrf}})).status,503);}
    const payload={schema:'defense-intelligence-transfer',version:1,tables:Object.fromEntries(Object.keys(BACKUP_SCHEMA).map(table=>[table,[]]))};payload.tables.metadata=[{key:'contract_pursuits',value:JSON.stringify([{id:'restored-pursuit'}])}];
    assert.equal((await fetch(base+'/api/transfer/import',{method:'POST',headers:{Cookie:cookie,Origin:ENV.PUBLIC_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify(payload)})).status,403);
    const transferred=await fetch(base+'/api/transfer/import',{method:'POST',headers:{Cookie:cookie,Origin:ENV.PUBLIC_ORIGIN,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'},body:JSON.stringify(payload)});assert.equal(transferred.status,200);const result=await transferred.json();assert.equal(result.restartRequired,true);assert.equal(result.imported.metadata,1);assert.equal(await importComplete(runtime),true);assert.equal(bootstraps,0);assert.equal(refreshes,0);
    assert.equal((await fetch(base+'/api/workspace',{headers:{Cookie:cookie}})).status,503,'old process remains gated');
    assert.equal((await fetch(base+'/api/transfer/import',{method:'POST',headers:{Cookie:cookie,Origin:ENV.PUBLIC_ORIGIN,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'},body:JSON.stringify(payload)})).status,409,'completed data is never overwritten');
  }finally{await app.close();}
  const restarted=await createApplication({environment:{...environment,ENABLE_SCHEDULER:'false'},runtime,publicDirectory,business}),next=await restarted.listen(0,'127.0.0.1');
  try{assert.equal(bootstraps,1);assert.equal((await fetch('http://127.0.0.1:'+next.port+'/api/workspace',{headers:{Cookie:cookie}})).status,200);}finally{await restarted.close();await runtime.close();}
});

test('Public pending transfer stays closed while the passwordless GoDaddy editor can import and reopen a private backup',async()=>{
  const dataDirectory=join(TEMP,'managed-transfer-data');await mkdir(dataDirectory);
  const runtime=await initializeDatabase({environment:{NODE_ENV:'test'},dataDirectory,migrationsDirectory:resolve(HERE,'..','drizzle')});
  const publicDirectory=join(TEMP,'managed-transfer-public');await mkdir(publicDirectory);await writeFile(join(publicDirectory,'index.html'),'<html><head></head><body>Transferred app</body></html>');
  let bootstraps=0;const business={async bootstrap(){bootstraps++;},async workspace(){return {records:[]};},async mutate(){throw Error('Import must not call business mutation');},async refresh(){throw Error('Scheduler must stay disabled');},async persistCollection(){throw Error('Import must not ingest');}};
  const common={IMPORT_REQUIRED:'true',ENABLE_SCHEDULER:'false'},preview='https://owner-editor.preview.c38.airoapp.ai',host=new URL(preview).host;
  const payload={schema:'defense-intelligence-transfer',version:1,tables:Object.fromEntries(Object.keys(BACKUP_SCHEMA).map(table=>[table,[]]))};payload.tables.metadata=[{key:'capture_plans',value:JSON.stringify([{id:'restored-capture',title:'Transferred planning'}])}];
  const publicApp=await createApplication({environment:{...common,ACCESS_MODE:'public',PUBLIC_ORIGIN:'https://intel.insightfuldefense.com'},runtime,publicDirectory,business}),publicAddress=await publicApp.listen(0,'127.0.0.1'),publicBase='http://127.0.0.1:'+publicAddress.port;
  try{assert.equal(bootstraps,0);const response=await fetch(publicBase+'/');assert.equal(response.status,503);assert(!(await response.text()).includes('Transfer your private workspace'));assert.equal((await fetch(publicBase+'/api/backup')).status,403);assert.equal((await fetch(publicBase+'/api/transfer/import',{method:'POST',headers:{Origin:'https://intel.insightfuldefense.com','Content-Type':'application/json'},body:JSON.stringify(payload)})).status,403);}finally{await publicApp.close();}
  const fetchPreview=(base,path,options={})=>new Promise((resolve,reject)=>{const request=httpRequest(base+path,{method:options.method||'GET',headers:{Host:host,...options.headers}},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));response.on('error',reject);});request.on('error',reject);request.end(options.body);});
  const environment={...common,ACCESS_MODE:'godaddy-private-preview',PUBLIC_ORIGIN:preview};
  const managed=await createApplication({environment,runtime,publicDirectory,business}),managedAddress=await managed.listen(0,'127.0.0.1'),managedBase='http://127.0.0.1:'+managedAddress.port;
  try{
    const page=await(await fetchPreview(managedBase,'/')).text();assert.match(page,/Transfer your private workspace/);assert(!page.includes('<button id="signout"'));
    const session=await(await fetchPreview(managedBase,'/auth/session')).json(),headers={Origin:preview,'Content-Type':'application/json','X-CSRF-Token':session.csrf};
    const result=await fetchPreview(managedBase,'/api/transfer/import',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(result.status,200);assert.equal((await result.json()).restartRequired,true);assert(await importComplete(runtime));assert.equal(bootstraps,0);
    assert.equal((await fetchPreview(managedBase,'/api/workspace')).status,503);assert.equal((await fetchPreview(managedBase,'/api/transfer/import',{method:'POST',headers,body:JSON.stringify(payload)})).status,409);
  }finally{await managed.close();}
  const reopened=await createApplication({environment,runtime,publicDirectory,business}),reopenedAddress=await reopened.listen(0,'127.0.0.1'),reopenedBase='http://127.0.0.1:'+reopenedAddress.port;
  try{assert.equal(bootstraps,1);const backup=await fetchPreview(reopenedBase,'/api/backup');assert.equal(backup.status,200);const data=await backup.json();assert.equal(data.tables.metadata.find(row=>row.key==='capture_plans').value,payload.tables.metadata[0].value);const workspace=await(await fetchPreview(reopenedBase,'/api/workspace')).json();assert.equal(workspace.access.readOnly,false);}finally{await reopened.close();await runtime.close();}
});

test.after(async()=>{
  const actual=await realpath(TEMP),difference=relative(HERE,actual);assert(!isAbsolute(difference)&&!difference.startsWith('..')&&difference.startsWith('.adapter-test-'),'Only the verified temporary test directory can be removed');await rm(actual,{recursive:true,force:true});
});
