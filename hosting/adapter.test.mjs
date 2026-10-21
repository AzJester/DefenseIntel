import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createD1,applyMigrations,initializeDatabase} from './runtime.mjs';
import {createAuth,hashPassword} from './auth.mjs';
import {createApplication,createCollectionLock,startScheduler,phoenixSlot} from './server.mjs';
import {buildPortable} from './build.mjs';
import {BACKUP_SCHEMA,importComplete} from './import-backup.mjs';

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

test.after(async()=>{
  const actual=await realpath(TEMP),difference=relative(HERE,actual);assert(!isAbsolute(difference)&&!difference.startsWith('..')&&difference.startsWith('.adapter-test-'),'Only the verified temporary test directory can be removed');await rm(actual,{recursive:true,force:true});
});
