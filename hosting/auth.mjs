import {randomBytes,scrypt as callbackScrypt,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(callbackScrypt);
const SESSION_SECONDS=8*60*60,LOGIN_SECONDS=15*60;
const b64=value=>Buffer.from(value).toString('base64url');
const digest=value=>createHash('sha256').update(value).digest('hex');
const safeEqual=(a,b)=>{const first=Buffer.from(a),second=Buffer.from(b);return first.length===second.length&&timingSafeEqual(first,second);};

export async function hashPassword(password){
  if(typeof password!=='string'||Buffer.byteLength(password)<16||Buffer.byteLength(password)>1024)throw Error('Password must be between 16 and 1024 bytes');
  const salt=randomBytes(24),N=65536,r=8,p=1,key=await scrypt(password,salt,64,{N,r,p,maxmem:256*1024*1024});
  return `scrypt$${N}$${r}$${p}$${b64(salt)}$${b64(key)}`;
}
function parseHash(value){
  const parts=String(value||'').split('$');
  if(parts.length!==6||parts[0]!=='scrypt')throw Error('ADMIN_PASSWORD_HASH must use scrypt$N$r$p$saltBase64url$keyBase64url');
  const N=Number(parts[1]),r=Number(parts[2]),p=Number(parts[3]),salt=Buffer.from(parts[4],'base64url'),key=Buffer.from(parts[5],'base64url');
  if(!Number.isInteger(N)||N<32768||N>131072||(N&(N-1))||r!==8||!Number.isInteger(p)||p<1||p>2||salt.length<16||salt.length>64||![32,64].includes(key.length)||b64(salt)!==parts[4]||b64(key)!==parts[5])throw Error('ADMIN_PASSWORD_HASH has unsupported or weak scrypt parameters');
  return {N,r,p,salt,key};
}
export async function createAuth(environment,database){
  const email=String(environment.ADMIN_EMAIL||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw Error('ADMIN_EMAIL is required');
  const secret=environment.SESSION_SECRET;
  if(typeof secret!=='string'||Buffer.byteLength(secret)<32)throw Error('SESSION_SECRET must contain at least 32 bytes of random secret material');
  if(environment.ADMIN_PASSWORD_HASH&&environment.ADMIN_PASSWORD)throw Error('Set ADMIN_PASSWORD_HASH or ADMIN_PASSWORD, not both');
  const passwordHash=environment.ADMIN_PASSWORD_HASH||await hashPassword(environment.ADMIN_PASSWORD);
  const password=parseHash(passwordHash),ownerVersion=digest(email+'\n'+passwordHash);
  const publicUrl=new URL(environment.PUBLIC_ORIGIN||'');
  const local=environment.ALLOW_INSECURE_LOCALHOST==='true'&&['localhost','127.0.0.1','[::1]'].includes(publicUrl.hostname);
  if(publicUrl.username||publicUrl.password||publicUrl.pathname!=='/'||publicUrl.search||publicUrl.hash||publicUrl.protocol!=='https:'&&!(local&&publicUrl.protocol==='http:'))throw Error('PUBLIC_ORIGIN must be one HTTPS origin; HTTP is allowed only for explicitly enabled localhost development');
  const secure=publicUrl.protocol==='https:',origin=publicUrl.origin;
  const sessionName=secure?'__Host-DefenseIntel':'DefenseIntelLocal',loginName=secure?'__Host-DefenseIntelLogin':'DefenseIntelLocalLogin';
  const cookie=(name,value,age)=>`${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure?'; Secure':''}`;
  const cookies=request=>Object.fromEntries(String(request.headers.cookie||'').split(';').map(part=>{const index=part.indexOf('=');return index<0?['','']:[part.slice(0,index).trim(),part.slice(index+1).trim()];}).filter(([key])=>key));
  const sign=payload=>{const encoded=b64(JSON.stringify(payload));return encoded+'.'+createHmac('sha256',secret).update(encoded).digest('base64url');};
  function decode(token,purpose){
    if(typeof token!=='string'||token.length>4096)return null;
    const parts=token.split('.');if(parts.length!==2||!/^[A-Za-z0-9_-]+$/.test(parts[0])||!/^[A-Za-z0-9_-]{43}$/.test(parts[1]))return null;
    const signature=createHmac('sha256',secret).update(parts[0]).digest('base64url');
    if(!safeEqual(parts[1],signature))return null;
    try{const value=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8')),now=Math.floor(Date.now()/1000);return value.v===1&&value.purpose===purpose&&Number.isInteger(value.iat)&&Number.isInteger(value.exp)&&value.iat<=now+30&&value.exp>now&&value.exp-value.iat<=(purpose==='session'?SESSION_SECONDS:LOGIN_SECONDS)&&value.exp>value.iat?value:null;}catch{return null;}
  }
  const attempts=new Map();let activeVerifications=0,globalWindow=Date.now(),globalAttempts=0;
  function consumeAttempt(ip){
    const now=Date.now();if(now-globalWindow>=15*60*1000){globalWindow=now;globalAttempts=0;}
    for(const [key,value]of attempts)if(now-value.started>=15*60*1000)attempts.delete(key);
    const old=attempts.get(ip)||{started:now,count:0};
    if(old.count>=5||globalAttempts>=30||activeVerifications>=2||attempts.size>=10000&&!attempts.has(ip))return false;
    old.count++;globalAttempts++;attempts.set(ip,old);return true;
  }
  async function session(request){
    const value=decode(cookies(request)[sessionName],'session');
    if(!value||value.owner!==ownerVersion||typeof value.id!=='string'||typeof value.csrf!=='string')return null;
    const stored=await database.prepare('SELECT expires,owner_version FROM __portable_sessions WHERE id=?').get(digest(value.id));
    return stored&&Number(stored.expires)===value.exp&&stored.owner_version===ownerVersion?value:null;
  }
  return {
    origin,local,email,secure,session,cookieName:sessionName,
    sameOrigin(request){return request.headers.origin===origin&&(!request.headers['sec-fetch-site']||['same-origin','none'].includes(request.headers['sec-fetch-site']));},
    csrf(request,value){return typeof request.headers['x-csrf-token']==='string'&&safeEqual(request.headers['x-csrf-token'],value.csrf);},
    loginPageToken(){const now=Math.floor(Date.now()/1000),value=sign({v:1,purpose:'login',iat:now,exp:now+LOGIN_SECONDS,nonce:b64(randomBytes(24))});return {value,cookie:cookie(loginName,value,LOGIN_SECONDS)};},
    async login(request,form){
      const ip=request.socket.remoteAddress||'unknown';
      const challenge=cookies(request)[loginName];
      if(!this.sameOrigin(request)||!decode(challenge,'login')||typeof form.csrf!=='string'||!safeEqual(challenge,form.csrf))return {status:403,error:'Sign-in page expired. Reload it and try again.'};
      if(!consumeAttempt(ip))return {status:429,error:'Too many sign-in attempts. Try again in 15 minutes.'};
      const suppliedEmail=String(form.email||'').trim().toLowerCase(),suppliedPassword=String(form.password||'');
      if(Buffer.byteLength(suppliedPassword)>1024)return {status:400,error:'Invalid sign-in details.'};
      activeVerifications++;
      try{
        const key=await scrypt(suppliedPassword,password.salt,password.key.length,{N:password.N,r:password.r,p:password.p,maxmem:256*1024*1024});
        if(!safeEqual(digest(suppliedEmail),digest(email))||!safeEqual(key,password.key))return {status:401,error:'Email or password is incorrect.'};
        const now=Math.floor(Date.now()/1000),value={v:1,purpose:'session',owner:ownerVersion,id:b64(randomBytes(32)),csrf:b64(randomBytes(32)),iat:now,exp:now+SESSION_SECONDS};
        await database.prepare('DELETE FROM __portable_sessions WHERE expires<? OR owner_version<>?').run(now,ownerVersion);
        await database.prepare('INSERT INTO __portable_sessions(id,expires,owner_version)VALUES(?,?,?)').run(digest(value.id),value.exp,ownerVersion);
        attempts.delete(ip);
        return {status:303,cookies:[cookie(sessionName,sign(value),SESSION_SECONDS),cookie(loginName,'',0)]};
      }finally{activeVerifications--;}
    },
    async logout(value){await database.prepare('DELETE FROM __portable_sessions WHERE id=?').run(digest(value.id));return cookie(sessionName,'',0);},
  };
}
