import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {checkServerIdentity} from 'node:tls';
import {translateSql,isRefreshLockQuery,translateMigration,mysqlConfiguration,createMysqlDatabase,applyMysqlMigrations} from './mysql.mjs';
import {createAuth,hashPassword} from './auth.mjs';

const HERE=fileURLToPath(new URL('.',import.meta.url)),TEMP=await mkdtemp(join(HERE,'.mysql-test-'));
const LOCK="INSERT INTO metadata (key,value) VALUES ('refresh_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE metadata.value='null' OR metadata.value<? RETURNING key";
const sleep=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));

/** Protocol fixture, not a MySQL SQL parser. It checks the driver's asynchronous connection contract. */
function fakePool(){
  const log=[],tables=new Set(),ledger=new Map(),sessions=new Map();let nextId=0,lockValue,tail=Promise.resolve();
  const pool={log,tables,ledger,sessions,failTable:null,
    async getConnection(){
      const id=++nextId;let releaseTransaction;
      return {
        async beginTransaction(){const pending=tail;tail=new Promise(resolve=>releaseTransaction=resolve);await pending;log.push({id,method:'begin'});},
        async commit(){log.push({id,method:'commit'});releaseTransaction?.();releaseTransaction=null;},
        async rollback(){log.push({id,method:'rollback'});releaseTransaction?.();releaseTransaction=null;},
        release(){log.push({id,method:'release'});},
        async execute(sql,values=[]){
          await sleep(1);log.push({id,method:'execute',sql,values});
          if(sql.includes('force_failure'))throw Object.assign(Error('Fixture statement failure'),{code:'ER_FIXTURE'});
          const header=changes=>[{affectedRows:changes,insertId:0},[]];
          if(/^SELECT DATABASE\(\)/i.test(sql))return [[{name:'private_test_database'}],[]];
          if(/^SELECT GET_LOCK/i.test(sql))return [[{obtained:1}],[]];
          if(/^SELECT RELEASE_LOCK/i.test(sql))return [[{released:1}],[]];
          if(/information_schema\.tables/i.test(sql))return [[...tables].map(name=>({name})),[]];
          if(/^CREATE TABLE/i.test(sql)){
            const match=/^CREATE TABLE(?: IF NOT EXISTS)?\s+`?([a-z_][a-z0-9_]*)`?/i.exec(sql),name=match?.[1];
            if(pool.failTable===name)throw Error('Fixture DDL failure');
            if(tables.has(name)&&!/IF NOT EXISTS/i.test(sql))throw Error('Duplicate table would prove migration replay');
            tables.add(name);return header(0);
          }
          if(/^SELECT tag,checksum,state FROM __portable_migrations/i.test(sql))return [[...ledger.values()],[]];
          if(/^INSERT INTO __portable_migrations/i.test(sql)){ledger.set(values[0],{tag:values[0],checksum:values[1],state:'applying'});return header(1);}
          if(/^UPDATE __portable_migrations/i.test(sql)){ledger.get(values[1]).state='applied';return header(1);}
          if(/^INSERT IGNORE INTO metadata/i.test(sql)){const inserted=lockValue===undefined;if(inserted)lockValue='null';return header(inserted?1:0);}
          if(/^SELECT value FROM metadata WHERE `key`='refresh_lock' FOR UPDATE/i.test(sql))return [[{value:lockValue}],[]];
          if(/^UPDATE metadata SET value=\? WHERE `key`='refresh_lock'/i.test(sql)){lockValue=values[0];return header(1);}
          if(/^INSERT INTO __portable_sessions/i.test(sql)){sessions.set(values[0],{expires:String(values[1]),owner_version:values[2]});return header(1);}
          if(/^SELECT expires,owner_version FROM __portable_sessions/i.test(sql))return [sessions.has(values[0])?[sessions.get(values[0])]:[],[]];
          if(/^DELETE FROM __portable_sessions WHERE id=/i.test(sql)){return header(sessions.delete(values[0])?1:0);}
          if(/^DELETE FROM __portable_sessions WHERE expires</i.test(sql)){let count=0;for(const[key,value]of sessions)if(Number(value.expires)<values[0]||value.owner_version!==values[1]){sessions.delete(key);count++;}return header(count);}
          if(/^SELECT/i.test(sql))return [[{id:'selected',value:'retained'}],[]];
          return header(1);
        },
      };
    },
    async end(){log.push({method:'end'});},
  };
  return pool;
}

test('MySQL translation preserves placeholders, multi-row upserts and reserved key identifiers',()=>{
  const translated=translateSql('INSERT INTO metadata (key,value) VALUES (?,?),(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  assert.equal(translated,'INSERT INTO metadata (`key`,value) VALUES (?,?),(?,?) ON DUPLICATE KEY UPDATE value=VALUES(`value`)');
  assert.equal(translateSql('INSERT INTO evidence_versions (id,data) VALUES (?,?),(?,?) ON CONFLICT(id) DO NOTHING'),'INSERT IGNORE INTO evidence_versions (id,data) VALUES (?,?),(?,?)');
  assert.equal(translateSql('INSERT OR IGNORE INTO intelligence(id,title) VALUES (?,?)'),'INSERT IGNORE INTO intelligence(id,title) VALUES (?,?)');
  assert.equal(translateSql("SELECT value FROM metadata WHERE key='key'"),"SELECT value FROM metadata WHERE `key`='key'");
  const historical='WITH recent AS (SELECT * FROM intelligence ORDER BY published DESC,created DESC LIMIT 1000) SELECT * FROM recent UNION SELECT * FROM intelligence WHERE id IN (SELECT record_id FROM alerts ORDER BY created DESC LIMIT 300) ORDER BY published DESC,created DESC';
  assert.match(translateSql(historical),/FROM \(SELECT record_id FROM alerts ORDER BY created DESC LIMIT 300\) AS alert_refs/);
  assert(isRefreshLockQuery(LOCK));assert.throws(()=>translateSql(LOCK),/atomic/);assert.throws(()=>translateSql('INSERT INTO x(id,data)VALUES(?,?)ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE x.data IS NULL'),/Conditional/);
});

test('A MySQL D1 batch uses exactly one transaction connection and rolls back before release',async()=>{
  const pool=fakePool(),{DB}=createMysqlDatabase(pool);
  const result=await DB.batch([DB.prepare('INSERT OR IGNORE INTO evidence_versions(id,data)VALUES(?,?)').bind('one','value'),DB.prepare('UPDATE evidence_versions SET data=? WHERE id=?').bind('new','one')]);assert.equal(result.length,2);assert.equal(result[0].meta.changes,1);
  assert.equal(new Set(pool.log.filter(row=>row.method==='execute').map(row=>row.id)).size,1);assert.deepEqual(pool.log.map(row=>row.method),['begin','execute','execute','commit','release']);
  pool.log.length=0;await assert.rejects(()=>DB.batch([DB.prepare('INSERT INTO x(id)VALUES(?)').bind('first'),DB.prepare('INSERT INTO force_failure(id)VALUES(?)').bind('second')]));assert.deepEqual(pool.log.map(row=>row.method),['begin','execute','execute','rollback','release']);
  assert.equal(await DB.prepare('SELECT value FROM x WHERE id=?').bind('one').first('value'),'retained');
});

test('Competing refresh locks acquire one row lock and only one winner, not row-count inference',async()=>{
  const pool=fakePool(),{DB}=createMysqlDatabase(pool),stamp=JSON.stringify('2026-10-21T17:00:00Z'),stale=JSON.stringify('2026-10-21T16:57:00Z');
  const values=await Promise.all([DB.prepare(LOCK).bind(stamp,stale).first(),DB.prepare(LOCK).bind(stamp,stale).first()]);assert.equal(values.filter(Boolean).length,1);assert.equal(values.find(Boolean).key,'refresh_lock');
  const calls=pool.log.filter(row=>row.method==='execute');assert.equal(calls.filter(row=>/FOR UPDATE/.test(row.sql)).length,2);assert.equal(calls.filter(row=>/^UPDATE metadata/.test(row.sql)).length,1);
  for(const id of new Set(calls.map(row=>row.id))){const connection=pool.log.filter(row=>row.id===id);assert.equal(connection[0].method,'begin');assert.equal(connection.at(-1).method,'release');assert.equal(connection.at(-2).method,'commit');}
  const later=await DB.prepare(LOCK).bind(JSON.stringify('2026-10-21T17:05:00Z'),JSON.stringify('2026-10-21T17:02:00Z')).first();assert(later,'expired lock can be replaced');
});
test('Offline raw transaction binds empty checks and every insert to one connection',async()=>{
  const pool=fakePool(),runtime=createMysqlDatabase(pool);
  await runtime.transaction(async transaction=>{assert.equal(transaction.dialect,'mysql');await transaction.prepare('SELECT id FROM competitors LIMIT 1 FOR UPDATE').get();await transaction.prepare('INSERT INTO competitors(id,name)VALUES(?,?)').run('one','Leidos');await transaction.prepare('INSERT INTO metadata(key,value)VALUES(?,?)').run('setting','{}');});
  assert.deepEqual(pool.log.map(row=>row.method),['begin','execute','execute','execute','commit','release']);assert.equal(new Set(pool.log.map(row=>row.id)).size,1);
  pool.log.length=0;await assert.rejects(()=>runtime.transaction(async transaction=>{await transaction.prepare('INSERT INTO force_failure(id)VALUES(?)').run('one');}));assert.deepEqual(pool.log.map(row=>row.method),['begin','execute','rollback','release']);
});

test('Remote MySQL requires verified TLS and safe connection configuration',()=>{
  const config=mysqlConfiguration({DATABASE_URL:'mysql://owner:secret%40value@db.example.test:3306/private_db'});assert.equal(config.password,'secret@value');assert.equal(config.ssl.rejectUnauthorized,true);assert.equal(config.ssl.verifyIdentity,true);assert.equal(config.multipleStatements,false);assert.equal(config.flags,'-FOUND_ROWS');
  assert.throws(()=>mysqlConfiguration({DATABASE_URL:'mysql://owner:secret@db.example.test/private_db',DB_SSL_MODE:'disable'}),/verified TLS/);
  assert.throws(()=>mysqlConfiguration({DATABASE_URL:'mysql://owner:secret@db.example.test/private_db?multipleStatements=true'}),/unsupported options/);
  assert(!mysqlConfiguration({DB_HOST:'127.0.0.1',DB_USER:'local',DB_PASSWORD:'secret',DB_NAME:'test',DB_SSL_MODE:'disable'}).ssl);
  assert.throws(()=>mysqlConfiguration({DATABASE_URL:'unparseable-private-secret'}),error=>error.message==='DATABASE_URL is invalid');
});

test('An explicit provider TLS identity keeps each pooled TCP connection on its original loopback proxy',async()=>{
  const sockets=new Set(),server=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const streams=[];
  try{
    const environment={DB_HOST:'127.0.0.1',DB_PORT:String(server.address().port),DB_USER:'owner',DB_PASSWORD:'test-only',DB_NAME:'private_test',DB_TLS_SERVERNAME:'databaseservices.int.gdcorp.tools'};
    const config=mysqlConfiguration(environment);
    assert.equal(config.host,environment.DB_TLS_SERVERNAME);assert.equal(config.port,server.address().port);
    assert.equal(config.ssl.rejectUnauthorized,true);assert.equal(config.ssl.verifyIdentity,true);assert.equal(config.ssl.servername,undefined);
    for(let index=0;index<2;index++){
      const stream=config.stream();streams.push(stream);await once(stream,'connect');assert.equal(stream.remoteAddress,'127.0.0.1');assert.equal(stream.remotePort,server.address().port);
    }
    assert.notEqual(streams[0],streams[1]);
    const certificate={subject:{CN:'unused.example.test'},subjectaltname:'DNS:*.databaseservices.int.gdcorp.tools, DNS:databaseservices.int.gdcorp.tools'};
    assert.equal(checkServerIdentity(config.host,certificate),undefined);
    assert.equal(checkServerIdentity(environment.DB_HOST,certificate).code,'ERR_TLS_CERT_ALTNAME_INVALID');
    assert.equal(checkServerIdentity('different.example.test',certificate).code,'ERR_TLS_CERT_ALTNAME_INVALID');
    assert.throws(()=>mysqlConfiguration({...environment,DB_HOST:'remote.example.test'}),/loopback database proxy/);
    assert.throws(()=>mysqlConfiguration({...environment,DB_SSL_MODE:'disable'}),/verified TLS connection/);
    for(const identity of ['localhost','127.0.0.1','::1','*.example.test','https://db.example.test','db.example.test\n','-bad.example.test','db..example.test'])assert.throws(()=>mysqlConfiguration({...environment,DB_TLS_SERVERNAME:identity}),/provider DNS identity/);
  }finally{for(const stream of streams)stream.destroy();for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));}
});

test('MySQL migration translation retains identifiers and makes content LONGTEXT',()=>{
  const sql=translateMigration('CREATE TABLE `metadata` (\n`key` text PRIMARY KEY NOT NULL,\n`value` text NOT NULL\n);');assert.match(sql,/`key` VARCHAR\(250\) NOT NULL PRIMARY KEY/);assert.match(sql,/`value` LONGTEXT NOT NULL/);assert.match(sql,/ENGINE=InnoDB.*utf8mb4_bin/);assert.throws(()=>translateMigration('DROP TABLE private_data;'),/Only/);
});

test('Actual migration journal applies once; interrupted MySQL DDL never replays automatically',async()=>{
  const source=resolve(HERE,'..','drizzle'),directory=join(TEMP,'drizzle');await cp(source,directory,{recursive:true});
  const pool=fakePool();await applyMysqlMigrations(pool,directory);assert.equal(pool.ledger.size,2);assert([...pool.ledger.values()].every(row=>row.state==='applied'));assert(pool.tables.has('intelligence'));assert(pool.tables.has('__portable_sessions'));
  const appCreates=()=>pool.log.filter(row=>row.method==='execute'&&/^CREATE TABLE `/.test(row.sql)).length,before=appCreates();await applyMysqlMigrations(pool,directory);assert.equal(appCreates(),before);
  const journal=JSON.parse(await readFile(join(directory,'meta','_journal.json'),'utf8')),first=join(directory,journal.entries[0].tag+'.sql');await writeFile(first,(await readFile(first,'utf8'))+'\n-- deliberate schema checksum drift');await assert.rejects(()=>applyMysqlMigrations(pool,directory),/changed/);
  const interrupted=fakePool();interrupted.failTable='official_awards';await assert.rejects(()=>applyMysqlMigrations(interrupted,source),/Fixture DDL/);interrupted.failTable=null;const failedCalls=interrupted.log.length;await assert.rejects(()=>applyMysqlMigrations(interrupted,source),/interrupted/);assert(!interrupted.log.slice(failedCalls).some(row=>row.method==='execute'&&/^CREATE TABLE `/.test(row.sql)));
  const untracked=fakePool();untracked.tables.add('unrelated_private_data');await assert.rejects(()=>applyMysqlMigrations(untracked,source),/no portable migration ledger/);
});

test('Async MySQL-backed sessions are checked and revoked before responses can succeed',async()=>{
  const pool=fakePool(),{database}=createMysqlDatabase(pool),password='Test-only-high-entropy-owner-password-111!';
  const environment={ADMIN_EMAIL:'owner@example.test',ADMIN_PASSWORD_HASH:await hashPassword(password),SESSION_SECRET:'test-only-random-material-required-111111111',PUBLIC_ORIGIN:'https://intel.insightfuldefense.com'};
  const auth=await createAuth(environment,database),challenge=auth.loginPageToken(),request={headers:{origin:environment.PUBLIC_ORIGIN,cookie:challenge.cookie.split(';')[0]},socket:{remoteAddress:'127.0.0.1'}};
  const result=await auth.login(request,{csrf:challenge.value,email:environment.ADMIN_EMAIL,password});assert.equal(result.status,303);const cookie=result.cookies[0].split(';')[0],session=await auth.session({headers:{cookie}});assert(session);assert.equal(pool.sessions.size,1);
  await auth.logout(session);assert.equal(pool.sessions.size,0);assert.equal(await auth.session({headers:{cookie}}),null);
});

test.after(async()=>{const actual=await realpath(TEMP),difference=relative(HERE,actual);assert(!isAbsolute(difference)&&!difference.startsWith('..')&&difference.startsWith('.mysql-test-'));await rm(actual,{recursive:true,force:true});});
