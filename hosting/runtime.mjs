import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync} from 'node:fs';
import {resolve,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mysqlConfiguration,createMysqlDatabase,applyMysqlMigrations} from './mysql.mjs';

const EXECUTE=Symbol('portable-statement'),OWNER=Symbol('portable-owner');
let singleton,initializing;

/** Synchronous SQLite work stays inside an uninterrupted transaction; callers retain the D1 async API. */
export function createD1(database){
  const adapter={
    prepare(sql){
      if(typeof sql!=='string'||!sql.trim())throw Error('A SQL statement is required');
      function statement(values=[]){
        const execute=mode=>{
          const prepared=database.prepare(sql),started=performance.now();
          if(mode==='all')return {success:true,results:prepared.all(...values),meta:{duration:performance.now()-started,changes:0}};
          if(mode==='first')return prepared.get(...values)||null;
          const result=prepared.run(...values);
          return {success:true,results:[],meta:{duration:performance.now()-started,changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};
        };
        return {
          [OWNER]:adapter,[EXECUTE]:execute,
          bind(...next){
            if(next.some(value=>value===undefined||value!==null&&!['string','number','bigint','boolean'].includes(typeof value)&&!(value instanceof Uint8Array)))throw Error('Unsupported database parameter');
            return statement(next.map(value=>typeof value==='boolean'?Number(value):value));
          },
          async run(){return execute('run');},
          async all(){return execute('all');},
          async first(column){const row=execute('first');return column===undefined?row:row?.[column]??null;},
        };
      }
      return statement();
    },
    async batch(statements){
      if(!Array.isArray(statements)||statements.some(statement=>statement?.[OWNER]!==adapter))throw Error('Batch statements must belong to this database');
      database.exec('BEGIN IMMEDIATE');
      try{const results=statements.map(statement=>statement[EXECUTE]('run'));database.exec('COMMIT');return results;}
      catch(error){database.exec('ROLLBACK');throw error;}
    },
  };
  return adapter;
}

export function applyMigrations(database,migrationsDirectory){
  const journalPath=join(migrationsDirectory,'meta','_journal.json');
  const journal=JSON.parse(readFileSync(journalPath,'utf8'));
  if(!Array.isArray(journal.entries)||journal.entries.some(entry=>!Number.isInteger(entry.idx)||!/^\d{4}_[a-zA-Z0-9_-]+$/.test(entry.tag)))throw Error('Invalid migration journal');
  const entries=[...journal.entries].sort((a,b)=>a.idx-b.idx);
  if(entries.some((entry,index)=>entry.idx!==index)||new Set(entries.map(entry=>entry.tag)).size!==entries.length)throw Error('Migration journal must have unique consecutive entries');
  const existing=database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row=>row.name);
  if(existing.length&&!existing.includes('__portable_migrations'))throw Error('Existing database has no portable migration ledger. Import into a freshly migrated database; do not replay migrations over an existing schema.');
  database.exec('CREATE TABLE IF NOT EXISTS __portable_migrations (tag TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
  const applied=database.prepare('SELECT tag,checksum FROM __portable_migrations ORDER BY tag').all();
  if(applied.some(row=>!entries.some(entry=>entry.tag===row.tag)))throw Error('Database migration is newer than this release');
  for(const entry of entries){
    const sql=readFileSync(join(migrationsDirectory,entry.tag+'.sql'),'utf8'),checksum=createHash('sha256').update(sql.replace(/\r\n/g,'\n')).digest('hex');
    const old=applied.find(row=>row.tag===entry.tag);
    if(old){if(old.checksum!==checksum)throw Error(`Applied migration ${entry.tag} was changed`);continue;}
    database.exec('BEGIN IMMEDIATE');
    try{database.exec(sql);database.prepare('INSERT INTO __portable_migrations(tag,checksum,applied_at) VALUES(?,?,?)').run(entry.tag,checksum,new Date().toISOString());database.exec(`PRAGMA user_version=${entry.idx+1}`);database.exec('COMMIT');}
    catch(error){database.exec('ROLLBACK');throw error;}
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS __portable_sessions (id TEXT PRIMARY KEY,expires INTEGER NOT NULL,owner_version TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS __portable_jobs (id TEXT PRIMARY KEY,started TEXT NOT NULL,finished TEXT,status TEXT NOT NULL);
  `);
}

export async function initializeDatabase(options={}){
  if(singleton)return singleton;if(initializing)return initializing;
  initializing=(async()=>{
    const environment=options.environment||process.env,migrationsDirectory=options.migrationsDirectory||fileURLToPath(new URL('../drizzle/',import.meta.url));
    if(['DATABASE_URL','DB_HOST','DB_USER','DB_PASSWORD','DB_NAME'].some(key=>environment[key])||options.mysqlPool){
      let pool=options.mysqlPool;
      if(!pool){const mysql=await import('mysql2/promise');pool=(mysql.default||mysql).createPool(mysqlConfiguration(environment));}
      try{await applyMysqlMigrations(pool,migrationsDirectory);const adapter=createMysqlDatabase(pool);singleton={kind:'mysql',...adapter,async close(){await pool.end();singleton=undefined;}};return singleton;}
      catch(error){await pool.end();throw error;}
    }
    if(environment.NODE_ENV==='production')throw Error('Production mode requires managed MySQL credentials; private SQLite is supported only for local development');
    const dataDirectory=options.dataDirectory||environment.DATA_DIR;
    if(!dataDirectory||!isAbsolute(dataDirectory))throw Error('DATA_DIR must name an absolute persistent directory in local SQLite mode; production managed hosting requires MySQL credentials');
    mkdirSync(dataDirectory,{recursive:true,mode:0o700});
    const databasePath=resolve(dataDirectory,'defense-intel.sqlite'),database=new DatabaseSync(databasePath);
    try{
      database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
      applyMigrations(database,migrationsDirectory);
      singleton={kind:'sqlite',database,DB:createD1(database),databasePath,async transaction(operation){database.exec('BEGIN IMMEDIATE');try{const result=await operation({dialect:'sqlite',prepare:sql=>database.prepare(sql)});database.exec('COMMIT');return result;}catch(error){database.exec('ROLLBACK');throw error;}},async close(){database.close();singleton=undefined;}};return singleton;
    }catch(error){database.close();throw error;}
  })();
  try{return await initializing;}finally{initializing=undefined;}
}
export const env={get DB(){if(!singleton)throw Error('Initialize the portable database before using the business modules');return singleton.DB;}};
