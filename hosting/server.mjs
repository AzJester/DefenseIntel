import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {readFile,realpath,stat} from 'node:fs/promises';
import {resolve,relative,isAbsolute,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {initializeDatabase} from './runtime.mjs';
import {createAuth} from './auth.mjs';
import {importBackup,importComplete,BackupImportError} from './import-backup.mjs';

const HERE=fileURLToPath(new URL('.',import.meta.url));
const APP_ROOT=resolve(HERE,'..');
const TRANSFER_TABLES=['competitors','intelligence','alerts','metadata','official_awards','event_clusters','event_alerts','record_provenance','evidence_versions','brief_snapshots'];
// Exact business/input errors only. Driver errors such as "Unknown column" stay private 500s.
const INPUT_ERRORS=new Set([
  'A capture plan is required.','Choose an existing pursuit.','A capture plan cites unavailable evidence.','Use a valid solicitation source link.','Give the capture plan a title.','Maximum 30 capture plans.',
  'Invalid official collection.','Invalid official award.','Official award source must be USAspending.gov.','Invalid award amounts.','Invalid official source date.','Invalid contract action.',
  'A pursuit is required.','Use 1–12 named criteria with unique IDs and positive total weight.','Assessment scores must be 0–5 or unknown.','An assessment cites unavailable evidence.','Use one assessment for each company and criterion.','A pursuit needs a title and a valid nonnegative value when supplied.','Maximum 30 saved pursuits.',
  'A workshop session is required.','A workshop evidence record is unavailable.','A session needs a title and objective.','Maximum 50 saved sessions.',
  'Choose a competitor and legal recipient name.','A UEI must contain 12 letters or numbers.','A CAGE code must contain 5 letters or numbers.','Unknown competitor.','Maximum 250 recipient mappings.',
  'A finding needs a change, implication, next action and evidence.','A cited evidence record is unavailable.','Maximum 200 findings.','Snapshot not found.','Select up to 1,000 evidence records.','Evidence record IDs must be unique.','Choose evidence or an operational concept.','Every finding must cite evidence in the selected report.','Brief snapshot is too large. Narrow the report selection.',
  'A valid source or company URL is required.','Only http and https URLs are supported.','Competitor name is required.','Import 1–500 rows at a time.','Every competitor needs a name.','Every record requires title, company, summary and url.','Publication dates must be valid and not in the future.','Unsupported action.',
  'Invalid collection shape','Invalid source record','Invalid company coverage','Invalid source health','Invalid URL',
]);
function safeError(error,environment=process.env){let message=String(error?.message||'Unknown error');for(const key of ['DATABASE_URL','DB_PASSWORD','ADMIN_PASSWORD','ADMIN_PASSWORD_HASH','SESSION_SECRET'])if(environment[key])message=message.split(environment[key]).join('[redacted]');return message.replace(/mysql(?:2)?:\/\/[^\s@]+@/gi,'mysql://[redacted]@');}
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const MIME={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.pdf':'application/pdf'};
function loginHtml(token,error=''){
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in | Defense Intelligence</title><style>body{margin:0;background:#081c32;color:#edf4fb;font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}main{width:min(380px,calc(100vw - 56px));padding:32px;background:#102c47;border:1px solid #35516b;border-radius:12px}h1{font-size:27px;margin:8px 0}p{color:#c8d6e3;line-height:1.5}label{display:block;margin-top:18px}input,button{box-sizing:border-box;width:100%;padding:12px;border-radius:5px;border:1px solid #667c91;font:inherit}input{margin-top:6px;background:#fff;color:#102132}button{margin-top:24px;background:#d6b36a;color:#102132;font-weight:700;cursor:pointer}.error{color:#ffd5c9}.small{font-size:13px}</style></head><body><main><p class="small">DEFENSE / COMPETITIVE INTELLIGENCE</p><h1>Private workspace</h1><p>Sign in with your owner account.</p>${error?`<p class="error" role="alert">${escape(error)}</p>`:''}<form action="/auth/login" method="post"><input type="hidden" name="csrf" value="${escape(token)}"><label>Email<input name="email" type="email" required autocomplete="username" maxlength="254"></label><label>Password<input name="password" type="password" required autocomplete="current-password" maxlength="1024"></label><button type="submit">Sign in</button></form></main></body></html>`;
}
function transferHtml(ownerPassword=true){return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Private data transfer | Defense Intelligence</title><style>body{font:16px system-ui,sans-serif;background:#081c32;color:#f4f7fa;margin:0;padding:40px}main{max-width:700px;margin:auto;background:#102c47;padding:28px;border-radius:12px}p{line-height:1.6;color:#d0dce7}input,button{font:inherit;margin:12px 0;padding:10px}button{display:block;background:#d6b36a;color:#102132;border:0;border-radius:4px;font-weight:700}pre{white-space:pre-wrap}</style></head><body><main><h1>Transfer your private workspace</h1><p>The app is waiting for its owner backup. The workspace, collection and scheduler remain disabled until the transfer completes and the server restarts.</p><p>Choose the source app's JSON backup (maximum 20 MB). Import is allowed only into an empty application database. Existing rows will never be overwritten.</p><form id="transfer"><label>Private backup file <input id="backup" type="file" accept="application/json,.json" required></label><button id="submit" type="submit">Import private backup</button></form><pre id="status" role="status"></pre>${ownerPassword?'<button id="signout" type="button">Sign out</button>':''}<script>let csrf;const status=document.getElementById('status');async function token(){if(!csrf){const r=await fetch('/auth/session',{cache:'no-store'});if(!r.ok){location.assign('/auth/login');throw Error('Sign in to continue.');}csrf=(await r.json()).csrf;}return csrf;}document.getElementById('transfer').addEventListener('submit',async event=>{event.preventDefault();const file=document.getElementById('backup').files[0],button=document.getElementById('submit');if(!file)return;if(file.size>20*1024*1024){status.textContent='Choose a backup smaller than 20 MB.';return;}button.disabled=true;status.textContent='Validating and importing the private workspace…';try{const response=await fetch('/api/transfer/import',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':await token()},body:await file.text()});const data=await response.json();if(!response.ok)throw Error(data.error||'Import did not complete.');status.textContent='Import complete. Restart or redeploy this server before opening the workspace. Imported table counts: '+JSON.stringify(data.imported);}catch(error){status.textContent=error.message;button.disabled=false;}});document.getElementById('signout')?.addEventListener('click',async()=>{await fetch('/auth/logout',{method:'POST',headers:{'X-CSRF-Token':await token()}});location.assign('/auth/login');});</script></main></body></html>`;}
const securityHeaders=secure=>({
  'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; worker-src 'self' blob:",
  ...(secure?{'Strict-Transport-Security':'max-age=31536000'}:{}),
});
function send(response,status,body,headers={},head=false){
  const value=Buffer.isBuffer(body)?body:Buffer.from(typeof body==='string'?body:JSON.stringify(body));
  response.writeHead(status,{'Content-Type':typeof body==='string'?'text/html; charset=utf-8':'application/json; charset=utf-8','Content-Length':value.length,...headers});response.end(head?undefined:value);
}
function redirect(response,path,cookies=[]){response.writeHead(303,{Location:path,'Set-Cookie':cookies,'Cache-Control':'no-store, private'});response.end();}
async function body(request,maximum=2000000){
  if(Number(request.headers['content-length']||0)>maximum){const error=Error('Request body is too large');error.status=413;throw error;}
  const chunks=[];let size=0;
  for await(const chunk of request){size+=chunk.length;if(size>maximum){const error=Error('Request body is too large');error.status=413;throw error;}chunks.push(chunk);}
  return Buffer.concat(chunks).toString('utf8');
}
function collectionShape(value){
  if(!value||!Array.isArray(value.items)||value.items.length>500||!Array.isArray(value.companies)||value.companies.length>30||!Array.isArray(value.health)||value.health.length>150)throw Error('Invalid collection shape');
  for(const row of value.items){if(!row||!['id','company','category','title','summary','url','published','source','verification','priority'].every(key=>typeof row[key]==='string')||row.id.length>250||row.company.length>150||row.summary.length>4000||row.title.length>500||row.url.length>2500)throw Error('Invalid source record');}
  for(const row of value.companies){if(!row||!['ok','empty','error'].includes(row.status)||!Array.isArray(row.sources)||!Array.isArray(row.errors)||typeof row.id!=='string'||typeof row.name!=='string'||row.sources.length>50||row.errors.length>50)throw Error('Invalid company coverage');}
  for(const row of value.health){if(!row||typeof row.source!=='string'||typeof row.status!=='string'||typeof row.detail!=='string')throw Error('Invalid source health');}
  return value;
}
async function ephemeralSnapshot(value,business){
  const supplied=value?.options;
  if(!supplied||typeof supplied!=='object'||!Array.isArray(supplied.records)||supplied.records.length>1000)throw Error('Select up to 1,000 evidence records.');
  const ids=supplied.records.map(record=>record?.id),selected=new Set(ids);
  if(selected.size!==ids.length)throw Error('Evidence record IDs must be unique.');
  if(!ids.length&&!supplied.ov1)throw Error('Choose evidence or an operational concept.');
  const current=await business.workspace(),available=new Map((current.records||[]).map(record=>[record.id,record]));
  if(ids.some(id=>typeof id!=='string'||!available.has(id)))throw Error('A cited evidence record is unavailable.');
  const findings=Array.isArray(supplied.findings)?supplied.findings.slice(0,200):[];
  if(findings.some(finding=>!finding||!Array.isArray(finding.evidenceIds)||!finding.evidenceIds.length||finding.evidenceIds.some(id=>!selected.has(id))))throw Error('Every finding must cite evidence in the selected report.');
  const snapshot={...supplied,records:ids.map(id=>available.get(id)),title:String(supplied.title||'Decision brief').trim().slice(0,140)||'Decision brief',findings,generatedAt:new Date().toISOString(),snapshotId:randomUUID(),snapshotVersion:1,ephemeral:true};
  if(JSON.stringify(snapshot).length>1500000)throw Error('Brief snapshot is too large. Narrow the report selection.');
  return {ok:true,options:snapshot};
}
export function phoenixSlot(now=new Date()){
  const fields=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Phoenix',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(part=>[part.type,part.value]));
  return fields.minute==='00'&&['07','13'].includes(fields.hour)?`${fields.year}-${fields.month}-${fields.day}T${fields.hour}:00[America/Phoenix]`:null;
}
export function createCollectionLock(){
  let running=null;
  return {
    get busy(){return !!running;},get pending(){return running;},
    async run(operation){if(running)return {status:'busy',message:'Another collection is in progress.'};const promise=Promise.resolve().then(operation);running=promise;try{return await promise;}finally{if(running===promise)running=null;}},
  };
}
export function startScheduler({database,lock,refresh,enabled=true,now=()=>new Date(),intervalMilliseconds=30000,onError=console.error}){
  let stopped=false;
  const tick=async()=>{
    if(stopped||!enabled||lock.busy)return;
    let slot;
    try{
      slot=phoenixSlot(now());if(!slot)return;
      const claimed=await database.prepare("INSERT OR IGNORE INTO __portable_jobs(id,started,status)VALUES(?,?,'running')").run(slot,new Date().toISOString());
      if(!Number(claimed.changes))return;
      const result=await lock.run(refresh);if(result?.status==='busy'){await database.prepare('DELETE FROM __portable_jobs WHERE id=?').run(slot);return;}await database.prepare('UPDATE __portable_jobs SET finished=?,status=? WHERE id=?').run(new Date().toISOString(),result?.status||'completed',slot);
    }catch{
      if(slot)try{await database.prepare("UPDATE __portable_jobs SET finished=?,status='failed' WHERE id=?").run(new Date().toISOString(),slot);}catch{}
      onError('Scheduled intelligence collection failed. Review the application logs and source status.');
    }
  };
  const timer=enabled?setInterval(()=>void tick(),intervalMilliseconds):null;timer?.unref();
  if(enabled)void tick();
  return {enabled,tick,stop(){stopped=true;if(timer)clearInterval(timer);}};
}

export async function createApplication(options={}){
  const environment=options.environment||process.env;
  const runtime=options.runtime||await initializeDatabase({environment});
  const auth=await createAuth(environment,runtime.database);
  const business=options.business||Object.assign({},...await Promise.all([import('../server/workspace.js'),import('../server/intelligence-workspace.js')]));
  if(!['workspace','mutate','refresh','persistCollection','bootstrap'].every(key=>typeof business[key]==='function'))throw Error('Portable business modules are incomplete. Run the portable build.');
  const transferPending=environment.IMPORT_REQUIRED==='true'&&!await importComplete(runtime);
  if(!transferPending)await business.bootstrap();
  const publicDirectory=await realpath(options.publicDirectory||resolve(APP_ROOT,'public'));
  const lock=createCollectionLock();
  const scheduler=startScheduler({database:runtime.database,lock,refresh:()=>business.refresh(),enabled:!transferPending&&environment.ENABLE_SCHEDULER!=='false',onError:message=>console.error(message)});
  const server=http.createServer(async(request,response)=>{
    for(const[key,value]of Object.entries(securityHeaders(auth.secure)))response.setHeader(key,value);
    const method=request.method||'GET';
    try{
      const path=new URL(request.url||'/',auth.origin).pathname;
      if(path==='/healthz'&&['GET','HEAD'].includes(method))return send(response,200,{status:'ok'},{},method==='HEAD');
      if(!auth.trustedHost(request))return send(response,421,{error:'This editor is available only through its configured GoDaddy private preview.'});
      if(path==='/auth/login'&&method==='GET'){
        if(auth.mode!=='owner-password')return send(response,404,{error:'Not found'});
        if(await auth.session(request))return redirect(response,'/');
        const challenge=auth.loginPageToken();return send(response,200,loginHtml(challenge.value),{'Set-Cookie':challenge.cookie});
      }
      if(path==='/auth/login'&&method==='POST'){
        if(auth.mode!=='owner-password')return send(response,404,{error:'Not found'});
        if(!String(request.headers['content-type']||'').startsWith('application/x-www-form-urlencoded'))return send(response,415,{error:'Use the sign-in form.'});
        const form=Object.fromEntries(new URLSearchParams(await body(request,8192))),result=await auth.login(request,form);
        if(result.status===303)return redirect(response,'/',result.cookies);
        const challenge=auth.loginPageToken();return send(response,result.status,loginHtml(challenge.value,result.error),{'Set-Cookie':challenge.cookie,...(result.status===429?{'Retry-After':'900'}:{})});
      }
      const session=await auth.session(request);
      if(!session){if(path.startsWith('/api/')||path==='/auth/session'||method!=='GET'&&method!=='HEAD')return send(response,401,{error:'Sign in to continue.'});return redirect(response,'/auth/login');}
      if(!['GET','HEAD','POST'].includes(method))return send(response,405,{error:'Method not allowed'},{Allow:'GET, HEAD, POST'});
      if(method==='POST'&&(!auth.sameOrigin(request)||!auth.access.readOnly&&!auth.csrf(request,session)))return send(response,403,{error:'The request could not be verified. Reload the workspace and try again.'});
      if(path==='/auth/session'&&method==='GET')return send(response,200,{...auth.access,access:auth.access,...(session.csrf?{csrf:session.csrf}:{}),...(auth.mode==='owner-password'?{email:auth.email,expires:session.exp}:{})});
      if(path==='/auth/logout'&&method==='POST'&&auth.mode==='owner-password')return send(response,200,{ok:true},{'Set-Cookie':await auth.logout(session)});
      if(path==='/auth/client.js'&&['GET','HEAD'].includes(method))return send(response,200,await readFile(resolve(HERE,'client.js')),{'Content-Type':MIME['.js']},method==='HEAD');
      if(auth.access.readOnly&&(path==='/api/backup'||path==='/api/transfer/import'||path==='/api/refresh'||path==='/api/ingest'))return send(response,403,{error:'This shared workspace is read-only. Open the owner editor to make changes.'});
      if(path==='/api/transfer/import'&&method==='POST'){
        if(!transferPending)return send(response,409,{error:'Private data import is closed for this workspace.'});
        if(!String(request.headers['content-type']||'').startsWith('application/json'))return send(response,415,{error:'JSON backup is required'});
        try{const payload=JSON.parse(await body(request,20*1024*1024)),result=await lock.run(()=>importBackup(runtime,payload));if(result.status==='busy')return send(response,409,{error:result.message});return send(response,200,{ok:true,imported:result,restartRequired:true});}
        catch(error){if(error instanceof BackupImportError)return send(response,/already contains/.test(error.message)?409:400,{error:error.message});if(error.status===413)return send(response,413,{error:'Backup must be smaller than 20 MB.'});if(error instanceof SyntaxError)return send(response,400,{error:'Backup must contain valid JSON.'});console.error('Private data transfer failed.');return send(response,500,{error:'Private data transfer did not complete; no application data was imported.'});}
      }
      if(transferPending){if(!auth.access.readOnly&&path==='/'&&['GET','HEAD'].includes(method))return send(response,200,transferHtml(auth.mode==='owner-password'),{},method==='HEAD');return send(response,503,{error:'Private data transfer is required. Import the owner backup and restart the server before opening the workspace.'});}
      if(path==='/api/workspace'&&method==='GET')return send(response,200,{...await business.workspace(),access:auth.access});
      if(path==='/api/backup'&&method==='GET'){
        const tables={};for(const table of TRANSFER_TABLES)tables[table]=(await runtime.DB.prepare(`SELECT * FROM ${table}`).all()).results;
        return send(response,200,{schema:'defense-intelligence-transfer',version:1,exportedAt:new Date().toISOString(),tables},{'Content-Disposition':'attachment; filename="defense-intelligence-backup.json"'});
      }
      if(path==='/api/workspace'&&method==='POST'){
        if(!String(request.headers['content-type']||'').startsWith('application/json'))return send(response,415,{error:'JSON is required'});
        const value=JSON.parse(await body(request));
        if(auth.access.readOnly){
          if(value?.action==='bootstrap')return send(response,200,{ok:true,readOnly:true});
          if(value?.action==='brief_snapshot')return send(response,200,await ephemeralSnapshot(value,business));
          if(value?.action!=='snapshot_get')return send(response,403,{error:'This shared workspace is read-only. Open the owner editor to make changes.'});
        }
        return send(response,200,await business.mutate(value));
      }
      if(path==='/api/refresh'&&method==='POST'){
        if(request.headers['content-length']&&Number(request.headers['content-length'])>8192)return send(response,413,{error:'Request body is too large'});
        await body(request,8192);return send(response,200,await lock.run(()=>business.refresh()));
      }
      if(path==='/api/ingest'&&method==='POST'){
        if(!String(request.headers['content-type']||'').startsWith('application/json'))return send(response,415,{error:'JSON is required'});
        const collection=collectionShape(JSON.parse(await body(request)));return send(response,200,await lock.run(()=>business.persistCollection(collection,undefined,'private hosting runner')));
      }
      if(path.startsWith('/api/')||path.startsWith('/auth/'))return send(response,404,{error:'Not found'});
      if(!['GET','HEAD'].includes(method))return send(response,405,{error:'Method not allowed'},{Allow:'GET, HEAD'});
      let pathname;try{pathname=decodeURIComponent(path);}catch{return send(response,400,{error:'Invalid path'});}
      if(pathname.includes('\0')||pathname.includes('\\')||pathname.split('/').some(part=>part.startsWith('.')))return send(response,404,{error:'Not found'});
      const requested=resolve(publicDirectory,'.'+(pathname==='/'?'/index.html':pathname));
      const difference=relative(publicDirectory,requested);if(difference.startsWith('..')||isAbsolute(difference))return send(response,404,{error:'Not found'});
      let actual;try{actual=await realpath(requested);}catch{return send(response,404,{error:'Not found'});}
      const actualDifference=relative(publicDirectory,actual);if(actualDifference.startsWith('..')||isAbsolute(actualDifference))return send(response,404,{error:'Not found'});
      const extension=extname(actual).toLowerCase(),type=MIME[extension];if(!type)return send(response,404,{error:'Not found'});
      const metadata=await stat(actual);if(!metadata.isFile()||metadata.size>25000000)return send(response,404,{error:'Not found'});
      let contents=await readFile(actual);if(extension==='.html')contents=Buffer.from(contents.toString('utf8').replace('</head>','<script src="/auth/client.js"></script></head>'));
      return send(response,200,contents,{'Content-Type':type},method==='HEAD');
    }catch(error){
      const validation=error instanceof SyntaxError||INPUT_ERRORS.has(error?.message);
      const status=error?.status||((request.url||'').startsWith('/api/')&&method==='POST'&&validation?400:500);
      if(status>=500)console.error('Application request failed:',safeError(error,environment));
      if(!response.headersSent)send(response,status,{error:status>=500?'The request could not be completed. Review the server logs.':error?.message||'Invalid request'});else response.end();
    }
  });
  server.requestTimeout=300000;server.headersTimeout=15000;server.keepAliveTimeout=5000;server.maxHeadersCount=100;
  return {
    server,auth,lock,scheduler,
    async listen(port=Number(environment.PORT||3000),host=environment.HOST||(auth.local?'127.0.0.1':'0.0.0.0')){
      if(!Number.isInteger(port)||port<0||port>65535)throw Error('PORT must be a valid port number');
      if(auth.local&&!['127.0.0.1','::1','localhost'].includes(host))throw Error('Local development authentication may only bind to a loopback address');
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve();});});return server.address();
    },
    async close(){scheduler.stop();await new Promise(resolve=>server.close(resolve));if(lock.pending)await lock.pending.catch(()=>{});},
  };
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const app=await createApplication();const address=await app.listen();console.log(`Private intelligence server listening on port ${address.port}.`);
    let closing=false;const shutdown=async()=>{if(closing)return;closing=true;const timeout=setTimeout(()=>process.exit(1),25000);timeout.unref();await app.close();await(await initializeDatabase()).close();clearTimeout(timeout);process.exit(0);};
    process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  }catch(error){console.error('Private intelligence server could not start:',safeError(error));process.exitCode=1;}
}
