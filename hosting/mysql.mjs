import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {connect,isIP} from 'node:net';

const SQL=Symbol('mysql-statement'),OWNER=Symbol('mysql-owner');
const LOCK_SQL="INSERT INTO metadata (key,value) VALUES ('refresh_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE metadata.value='null' OR metadata.value<? RETURNING key";
const compact=value=>value.replace(/\s+/g,'').toLowerCase();
const normalizeValues=values=>values.map(value=>{if(value===undefined||value!==null&&!['string','number','bigint','boolean'].includes(typeof value)&&!(value instanceof Uint8Array))throw Error('Unsupported database parameter');return typeof value==='boolean'?Number(value):value instanceof Uint8Array?Buffer.from(value):value;});
export const isRefreshLockQuery=sql=>compact(sql)===compact(LOCK_SQL);

/** Only the SQLite dialect constructs used by the checked-in business layer are translated. */
export function translateSql(sql){
  if(typeof sql!=='string'||!sql.trim())throw Error('A SQL statement is required');
  if(isRefreshLockQuery(sql))throw Error('Refresh lock requires its atomic transaction path');
  let result=sql.trim().replace(/^INSERT\s+OR\s+IGNORE\s+/i,'INSERT IGNORE ');
  if(/\s*\bON\s+CONFLICT\s*\([^)]*\)\s+DO\s+NOTHING\s*$/i.test(result))result=result.replace(/\s*\bON\s+CONFLICT\s*\([^)]*\)\s+DO\s+NOTHING\s*$/i,'').replace(/^INSERT\s+(?!IGNORE\b)/i,'INSERT IGNORE ');
  const conflict=/\s*\bON\s+CONFLICT\s*\([^)]*\)\s+DO\s+UPDATE\s+SET\s+([\s\S]+)$/i.exec(result);
  if(conflict){
    if(/\bWHERE\b/i.test(conflict[1]))throw Error('Conditional upsert is not supported outside the refresh lock');
    const assignments=conflict[1].replace(/\bexcluded\.([a-z_][a-z0-9_]*)\b/gi,(_match,name)=>`VALUES(\`${name}\`)`);
    result=result.slice(0,conflict.index)+' ON DUPLICATE KEY UPDATE '+assignments;
  }
  // Avoid MySQL's unsupported LIMIT inside an IN subquery; preserve old alert evidence.
  result=result.replace(/^WITH recent AS \((SELECT \* FROM intelligence ORDER BY published DESC,created DESC LIMIT 1000)\) SELECT \* FROM recent UNION SELECT \* FROM intelligence WHERE id IN \((SELECT record_id FROM alerts ORDER BY created DESC LIMIT 300)\) ORDER BY published DESC,created DESC$/i,
    (_match,recent,alerts)=>`SELECT * FROM (${recent}) AS recent UNION SELECT * FROM intelligence WHERE id IN (SELECT record_id FROM (${alerts}) AS alert_refs) ORDER BY published DESC,created DESC`);
  if(/\b(?:RETURNING|ON\s+CONFLICT|INSERT\s+OR\s+IGNORE)\b/i.test(result))throw Error('Unsupported portable SQL dialect construct');
  // KEY is reserved in MySQL. Keep literals and already quoted identifiers untouched.
  result=result.replace(/'(?:(?:'')|[^'])*'|"(?:(?:"")|[^"])*"|`[^`]*`|\bkey\b/gi,(token,offset)=>/^key$/i.test(token)&&!/\b(?:DUPLICATE|PRIMARY)\s*$/i.test(result.slice(0,offset))?'`key`':token);
  return result;
}

/** A caller already inside a batch passes its connection and owns the transaction. */
async function refreshLock(connection,values,ownTransaction){
  if(values.length!==2||values.some(value=>typeof value!=='string'))throw Error('Invalid refresh lock parameters');
  if(ownTransaction)await connection.beginTransaction();
  try{
    await connection.execute("INSERT IGNORE INTO metadata (`key`,value) VALUES ('refresh_lock','null')");
    const [rows]=await connection.execute("SELECT value FROM metadata WHERE `key`='refresh_lock' FOR UPDATE");
    const available=rows[0]&&(rows[0].value==='null'||rows[0].value<values[1]);
    if(available)await connection.execute("UPDATE metadata SET value=? WHERE `key`='refresh_lock'",[values[0]]);
    if(ownTransaction)await connection.commit();return {rows:available?[{key:'refresh_lock'}]:[],changes:available?1:0,lastInsertRowid:0};
  }catch(error){if(ownTransaction)await connection.rollback();throw error;}
}
async function execute(connection,sql,values,insideTransaction=false){
  if(isRefreshLockQuery(sql))return refreshLock(connection,values,!insideTransaction);
  const [result]=await connection.execute(translateSql(sql),normalizeValues(values));
  return Array.isArray(result)?{rows:result,changes:0,lastInsertRowid:0}:{rows:[],changes:Number(result.affectedRows||0),lastInsertRowid:Number(result.insertId||0)};
}
async function withConnection(pool,operation){const connection=await pool.getConnection();try{return await operation(connection);}finally{connection.release();}}

export function createMysqlDatabase(pool){
  const boundPrepare=(connection,sql)=>({
    async get(...values){return (await execute(connection,sql,values,true)).rows[0]||null;},
    async all(...values){return (await execute(connection,sql,values,true)).rows;},
    async run(...values){const value=await execute(connection,sql,values,true);return {changes:value.changes,lastInsertRowid:value.lastInsertRowid};},
  });
  const raw={
    dialect:'mysql',
    prepare(sql){return {
      async get(...values){return withConnection(pool,async connection=>(await execute(connection,sql,values)).rows[0]||null);},
      async all(...values){return withConnection(pool,async connection=>(await execute(connection,sql,values)).rows);},
      async run(...values){return withConnection(pool,async connection=>{const value=await execute(connection,sql,values);return {changes:value.changes,lastInsertRowid:value.lastInsertRowid};});},
    };},
    async close(){await pool.end();},
  };
  const DB={
    prepare(sql){
      function statement(values=[]){return {
        [OWNER]:DB,[SQL]:{sql,values},
        bind(...next){return statement(normalizeValues(next));},
        async run(){const value=await raw.prepare(sql).run(...values);return {success:true,results:[],meta:{changes:value.changes,last_row_id:value.lastInsertRowid}};},
        async all(){return {success:true,results:await raw.prepare(sql).all(...values),meta:{changes:0}};},
        async first(column){const row=await raw.prepare(sql).get(...values);return column===undefined?row:row?.[column]??null;},
      };}return statement();
    },
    async batch(statements){
      if(!Array.isArray(statements)||statements.some(statement=>statement?.[OWNER]!==DB))throw Error('Batch statements must belong to this database');
      return withConnection(pool,async connection=>{
        await connection.beginTransaction();
        try{const results=[];for(const statement of statements){const {sql,values}=statement[SQL],value=await execute(connection,sql,values,true);results.push({success:true,results:value.rows,meta:{changes:value.changes,last_row_id:value.lastInsertRowid}});}await connection.commit();return results;}
        catch(error){await connection.rollback();throw error;}
      });
    },
  };
  return {database:raw,DB,pool,async transaction(operation){return withConnection(pool,async connection=>{await connection.beginTransaction();try{const result=await operation({dialect:'mysql',prepare:sql=>boundPrepare(connection,sql)});await connection.commit();return result;}catch(error){await connection.rollback();throw error;}});}};
}

export function mysqlConfiguration(environment){
  let input={};
  if(environment.DATABASE_URL){
    let url;try{url=new URL(environment.DATABASE_URL);}catch{throw Error('DATABASE_URL is invalid');}
    if(!['mysql:','mysql2:'].includes(url.protocol)||url.hash)throw Error('DATABASE_URL must identify one MySQL database');
    const modes=[...url.searchParams.keys()];if(modes.some(name=>!['ssl-mode'].includes(name)))throw Error('DATABASE_URL contains unsupported options');
    const mode=url.searchParams.get('ssl-mode');if(mode&&!['REQUIRED','VERIFY_CA','VERIFY_IDENTITY'].includes(mode.toUpperCase()))throw Error('DATABASE_URL must use verified TLS');
    try{input={host:url.hostname.replace(/^\[|\]$/g,''),port:url.port||3306,user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),database:decodeURIComponent(url.pathname.slice(1))};}catch{throw Error('DATABASE_URL credentials are malformed');}
  }else input={host:environment.DB_HOST,port:environment.DB_PORT||3306,user:environment.DB_USER,password:environment.DB_PASSWORD,database:environment.DB_NAME};
  if(!input.host||!input.user||!input.password||!input.database||/[\u0000-\u001f]/.test(input.host)||input.database.length>64||!/^[-a-zA-Z0-9_$]+$/.test(input.database))throw Error('MySQL requires DB_HOST, DB_USER, DB_PASSWORD and DB_NAME, or a complete DATABASE_URL');
  const port=Number(input.port);if(!Number.isInteger(port)||port<1||port>65535)throw Error('DB_PORT is invalid');
  const local=['localhost','127.0.0.1','::1'].includes(input.host);
  if(environment.DB_SSL_MODE&&environment.DB_SSL_MODE!=='verify'&&!(local&&environment.DB_SSL_MODE==='disable'))throw Error('Remote MySQL requires verified TLS; DB_SSL_MODE=disable is allowed only for loopback tests');
  let transport={};
  if(environment.DB_TLS_SERVERNAME){
    const identity=environment.DB_TLS_SERVERNAME;
    if(!local||environment.DB_SSL_MODE==='disable')throw Error('DB_TLS_SERVERNAME requires a verified TLS connection through a loopback database proxy');
    if(typeof identity!=='string'||identity.length>253||/[^a-zA-Z0-9.-]/.test(identity)||isIP(identity)||!identity.includes('.')||!identity.split('.').every(label=>/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label)))throw Error('DB_TLS_SERVERNAME must be an explicit provider DNS identity');
    const proxyHost=input.host;
    // mysql2 3.24.6 uses config.host for both SNI and certificate identity. Its
    // supported stream factory keeps TCP routing at the original local proxy.
    input.host=identity.toLowerCase();
    transport={stream:()=>connect({host:proxyHost,port}).setNoDelay(true).setKeepAlive(true)};
  }
  return {...input,port,waitForConnections:true,connectionLimit:5,queueLimit:50,connectTimeout:15000,enableKeepAlive:true,
    charset:'utf8mb4',dateStrings:true,decimalNumbers:true,supportBigNumbers:true,bigNumberStrings:false,flags:'-FOUND_ROWS',multipleStatements:false,
    ...transport,
    ...(local&&environment.DB_SSL_MODE==='disable'?{}:{ssl:{rejectUnauthorized:true,verifyIdentity:true,...(environment.DB_SSL_CA?{ca:environment.DB_SSL_CA}:{})}})};
}

export function translateMigration(sql){
  if(!/^\s*CREATE TABLE\s+`[a-z_][a-z0-9_]*`\s*\(/i.test(sql)||!/\);\s*$/.test(sql))throw Error('Only checked-in CREATE TABLE migrations are supported in MySQL mode');
  return sql.replace(/`([a-z_][a-z0-9_]*)`\s+text\s+PRIMARY KEY\s+NOT NULL/gi,'`$1` VARCHAR(250) NOT NULL PRIMARY KEY')
    .replace(/\btext\b/gi,'LONGTEXT').replace(/\binteger\b/gi,'BIGINT')
    .replace(/\);\s*$/,' ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;');
}
export async function applyMysqlMigrations(pool,migrationsDirectory){
  const journal=JSON.parse(readFileSync(join(migrationsDirectory,'meta','_journal.json'),'utf8'));
  if(!Array.isArray(journal.entries)||journal.entries.some((entry,index)=>entry.idx!==index||!/^\d{4}_[a-zA-Z0-9_-]+$/.test(entry.tag))||new Set(journal.entries.map(entry=>entry.tag)).size!==journal.entries.length)throw Error('Invalid migration journal');
  return withConnection(pool,async connection=>{
    const [identity]=await connection.execute('SELECT DATABASE() AS name');const lockName='defense-intel-schema-'+createHash('sha256').update(identity[0]?.name||'').digest('hex').slice(0,40);
    const [claimed]=await connection.execute('SELECT GET_LOCK(?,30) AS obtained',[lockName]);if(Number(claimed[0]?.obtained)!==1)throw Error('Could not obtain the database migration lock');
    try{
      const [tables]=await connection.execute('SELECT TABLE_NAME AS name FROM information_schema.tables WHERE table_schema=DATABASE()');
      if(tables.length&&!tables.some(row=>row.name==='__portable_migrations'))throw Error('Existing MySQL database has no portable migration ledger. Import into a freshly migrated database.');
      await connection.execute('CREATE TABLE IF NOT EXISTS __portable_migrations (tag VARCHAR(250) PRIMARY KEY,checksum CHAR(64) NOT NULL,migration_idx INT NOT NULL,state VARCHAR(20) NOT NULL,applied_at VARCHAR(40) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin');
      const [applied]=await connection.execute('SELECT tag,checksum,state FROM __portable_migrations ORDER BY migration_idx');
      if(applied.some(row=>row.state!=='applied'))throw Error('A prior MySQL migration was interrupted. Inspect its schema and ledger before proceeding; it will not be replayed automatically.');
      if(applied.some(row=>!journal.entries.some(entry=>entry.tag===row.tag)))throw Error('Database migration is newer than this release');
      for(const entry of journal.entries){
        const sql=readFileSync(join(migrationsDirectory,entry.tag+'.sql'),'utf8'),checksum=createHash('sha256').update(sql.replace(/\r\n/g,'\n')).digest('hex'),old=applied.find(row=>row.tag===entry.tag);
        if(old){if(old.checksum!==checksum)throw Error(`Applied migration ${entry.tag} was changed`);continue;}
        const statements=sql.split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean).map(translateMigration);
        await connection.execute("INSERT INTO __portable_migrations(tag,checksum,migration_idx,state,applied_at) VALUES(?,?,?,'applying',?)",[entry.tag,checksum,entry.idx,new Date().toISOString()]);
        for(const statement of statements)await connection.execute(statement);
        await connection.execute("UPDATE __portable_migrations SET state='applied',applied_at=? WHERE tag=?",[new Date().toISOString(),entry.tag]);
      }
      await connection.execute('CREATE TABLE IF NOT EXISTS __portable_sessions (id VARCHAR(250) PRIMARY KEY,expires BIGINT NOT NULL,owner_version VARCHAR(64) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin');
      await connection.execute('CREATE TABLE IF NOT EXISTS __portable_jobs (id VARCHAR(250) PRIMARY KEY,started VARCHAR(40) NOT NULL,finished VARCHAR(40),status VARCHAR(40) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin');
    }finally{await connection.execute('SELECT RELEASE_LOCK(?)',[lockName]);}
  });
}
