/** Public read-only gateway. Its private source remains the authoritative writer. */
const WORKSPACE_FIELDS=['companies','records','alerts','run','schedule','awards','events','preferences','entities','findings','workshops','pursuits','capturePlans','snapshots','eventAlerts','officialRun'];
const SENSITIVE_KEY=/(?:token|secret|password|credential|authorization|cookie|api.?key|user.?id|session.?id)/i;
const REQUEST_LIMIT=2_000_000,SOURCE_LIMIT=20*1024*1024;
class InputError extends Error{constructor(message,status=400){super(message);this.status=status;}}
class SourceError extends Error{}
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

function sourceConfiguration(environment){
  let url;try{url=new URL(environment.SOURCE_SITE_URL);}catch{throw Error('A fixed private Sites source URL is required.');}
  if(url.protocol!=='https:'||url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!url.hostname.endsWith('.chatgpt.site')||url.hostname.length>253||!url.hostname.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))throw Error('The source must be one HTTPS chatgpt.site origin.');
  const token=environment.SOURCE_SITE_TOKEN;if(typeof token!=='string'||!token||token.length>8192||/[\s\u0000-\u001f\u007f]/.test(token))throw Error('The private Sites source credential is required.');
  return {origin:url.origin,editorUrl:url.origin+'/',token};
}
function sanitize(value,token,depth=0){
  if(depth>30)return null;
  if(typeof value==='string')return value.split(token).join('[redacted]');
  if(Array.isArray(value))return value.map(item=>sanitize(item,token,depth+1));
  if(object(value)){const result=Object.create(null);for(const [key,item]of Object.entries(value))if(!SENSITIVE_KEY.test(key)&&!['__proto__','prototype','constructor','metadata','_meta'].includes(key))result[key.split(token).join('[redacted]')]=sanitize(item,token,depth+1);return result;}
  return value;
}
async function readJson(message,maximum,upstream=false){
  const fail=()=>{throw upstream?new SourceError():new InputError('Use a valid JSON request.');};
  if(Number(message.headers.get('content-length')||0)>maximum)throw upstream?new SourceError():new InputError('Request must be under 2 MB.',413);
  const reader=message.body?.getReader();if(!reader)return fail();const chunks=[];let size=0;
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>maximum){await reader.cancel();throw upstream?new SourceError():new InputError('Request must be under 2 MB.',413);}chunks.push(part.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return fail();}
}
function json(value,status=200){return Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});}

export function createPublicGateway(environment,{fetch:fetchSource=globalThis.fetch}={}){
  const source=sourceConfiguration(environment),access=Object.freeze({mode:'public',readOnly:true,editorUrl:source.editorUrl});
  async function upstream(action){
    const target=new URL('/api/workspace',source.origin);
    try{
      // Workers supports manual redirect handling. Never follow a redirect with
      // the private bearer, including redirects to the same source origin.
      const response=await fetchSource(target.href,{method:action?'POST':'GET',headers:{Accept:'application/json','OAI-Sites-Authorization':'Bearer '+source.token,...(action?{'Content-Type':'application/json'}:{})},...(action?{body:JSON.stringify(action)}:{}),redirect:'manual',signal:AbortSignal.timeout(30_000)});
      if(response.status>=300&&response.status<400||!response.ok||response.redirected||response.url&&new URL(response.url).origin!==source.origin||!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')){await response.body?.cancel();throw new SourceError();}
      return await readJson(response,SOURCE_LIMIT,true);
    }catch{throw new SourceError();}
  }
  async function workspace(){
    const data=await upstream();if(!object(data)||!Array.isArray(data.records)||!Array.isArray(data.companies))throw new SourceError();
    const result={};for(const key of WORKSPACE_FIELDS)if(Object.hasOwn(data,key))result[key]=sanitize(data[key],source.token);
    return {...result,access};
  }
  async function brief(value){
    const supplied=value.options;
    if(!object(supplied)||!Array.isArray(supplied.records)||supplied.records.length>1000)throw new InputError('Select up to 1,000 evidence records.');
    const ids=supplied.records.map(record=>record?.id),selected=new Set(ids);
    if(selected.size!==ids.length)throw new InputError('Evidence record IDs must be unique.');
    if(!ids.length&&!supplied.ov1)throw new InputError('Choose evidence or an operational concept.');
    const current=await workspace(),available=new Map(current.records.map(record=>[record.id,record]));
    if(ids.some(id=>typeof id!=='string'||!available.has(id)))throw new InputError('A cited evidence record is unavailable.');
    const findings=Array.isArray(supplied.findings)?supplied.findings.slice(0,200):[];
    if(findings.some(finding=>!object(finding)||!Array.isArray(finding.evidenceIds)||!finding.evidenceIds.length||finding.evidenceIds.some(id=>!selected.has(id))))throw new InputError('Every finding must cite evidence in the selected report.');
    const snapshot=sanitize({...supplied,records:ids.map(id=>available.get(id)),title:String(supplied.title||'Decision brief').trim().slice(0,140)||'Decision brief',findings,generatedAt:new Date().toISOString(),snapshotId:crypto.randomUUID(),snapshotVersion:1,ephemeral:true},source.token);
    if(JSON.stringify(snapshot).length>1_500_000)throw new InputError('Brief snapshot is too large. Narrow the report selection.');
    return {ok:true,options:snapshot};
  }
  return async function gateway(request){
    try{
      const url=new URL(request.url),path=url.pathname,method=request.method;
      if(path==='/api/auth'&&method==='GET')return json({...access,access});
      if(path!=='/api/workspace')return json({error:path.startsWith('/api/')?'Public view does not permit this operation.':'Not found.'},path.startsWith('/api/')?403:404);
      if(method==='GET')return json(await workspace());
      if(method!=='POST')return json({error:'Method not allowed.'},405);
      if(request.headers.get('origin')!==url.origin||request.headers.has('sec-fetch-site')&&!['same-origin','none'].includes(request.headers.get('sec-fetch-site')))return json({error:'The request origin could not be verified.'},403);
      if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))return json({error:'JSON is required.'},415);
      const value=await readJson(request,REQUEST_LIMIT);if(!object(value))throw new InputError('A JSON object is required.');
      if(value.action==='bootstrap')return json({ok:true,readOnly:true});
      if(value.action==='brief_snapshot')return json(await brief(value));
      if(value.action==='snapshot_get'){
        if(typeof value.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value.id))throw new InputError('Choose a valid saved snapshot.');
        const result=await upstream({action:'snapshot_get',id:value.id});if(!object(result)||!object(result.snapshot)||result.ok!==true)throw new SourceError();
        return json({ok:true,snapshot:sanitize(result.snapshot,source.token)});
      }
      return json({error:'Public view cannot change shared data.'},403);
    }catch(error){return error instanceof InputError?json({error:error.message},error.status):json({error:'Shared intelligence is temporarily unavailable. Try again later.'},502);}
  };
}
