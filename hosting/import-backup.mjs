import {readFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {initializeDatabase} from './runtime.mjs';

const MAX_FILE_BYTES=100*1024*1024,MAX_ROWS=250000;
const string=(maximum,options={})=>({type:'string',maximum,...options});
const flag={type:'flag'};
const id=string(250,{required:true}),timestamp=string(40,{date:true});
const data=string(1500000,{json:true,object:true});
/** SQL identifiers come only from this fixed schema, never from backup content. */
export const BACKUP_SCHEMA={
  competitors:{id,name:string(150,{required:true}),aliases:string(2000),website:string(2500),profile:string(100000,{json:true,object:true}),active:flag},
  intelligence:{id,company:string(150,{required:true}),category:string(100),title:string(700,{required:true}),summary:string(20000),assessment:string(20000),url:string(2500),published:timestamp,reviewed:timestamp,priority:string(100),source:string(500),verification:string(1000),origin:string(100),created:timestamp,fingerprint:string(100000)},
  alerts:{id,record_id:id,severity:string(100),reason:string(4000),created:timestamp,acknowledged:flag},
  metadata:{key:id,value:string(50000000,{json:true})},
  official_awards:{id,company:string(150,{required:true}),published:timestamp,fetched_at:timestamp,data},
  event_clusters:{id,updated:timestamp,data},
  event_alerts:{id,event_id:id,severity:string(100),reason:string(10000),created:timestamp,acknowledged:flag},
  record_provenance:{record_id:id,first_seen:timestamp,fetched_at:timestamp,hash:string(128,{required:true})},
  evidence_versions:{id,record_id:id,fetched_at:timestamp,data},
  brief_snapshots:{id,title:string(700,{required:true}),created:timestamp,data},
};
const TABLES=Object.keys(BACKUP_SCHEMA);
export const IMPORT_MARKER_KEY='portable_transfer_completed';
export class BackupImportError extends Error{}
const reject=message=>{throw new BackupImportError(message);};
function plain(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;}
function validString(value,specification){
  if(typeof value!=='string'||value.length>specification.maximum||specification.required&&!value.trim())return false;
  if(specification.date&&value&&(!/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)||!Number.isFinite(Date.parse(value))))return false;
  if(specification.json){let parsed;try{parsed=JSON.parse(value);}catch{return false;}if(specification.object&&!plain(parsed))return false;}
  return true;
}
export function validateBackup(value){
  if(!plain(value)||Object.keys(value).some(key=>!['schema','version','exportedAt','tables'].includes(key))||value.schema!=='defense-intelligence-transfer'||value.version!==1||!plain(value.tables))reject('Backup format or version is not supported.');
  if(value.exportedAt!==undefined&&!validString(value.exportedAt,timestamp))reject('Backup export date is invalid.');
  if(Object.keys(value.tables).length!==TABLES.length||Object.keys(value.tables).some(table=>!Object.hasOwn(BACKUP_SCHEMA,table)))reject('Backup must contain exactly the ten supported application tables.');
  const counts={};let total=0;
  for(const table of TABLES){
    const rows=value.tables[table],definition=BACKUP_SCHEMA[table],columns=Object.keys(definition),primary=table==='metadata'?'key':table==='record_provenance'?'record_id':'id',seen=new Set();
    if(!Array.isArray(rows)||rows.length>MAX_ROWS)reject('Backup table row limit exceeded.');
    total+=rows.length;if(total>MAX_ROWS)reject('Backup total row limit exceeded.');
    for(const row of rows){
      if(!plain(row)||Object.keys(row).length!==columns.length||Object.keys(row).some(column=>!Object.hasOwn(definition,column)))reject('Backup contains missing or unsupported columns.');
      for(const column of columns){const specification=definition[column],valid=specification.type==='flag'?(row[column]===0||row[column]===1):validString(row[column],specification);if(!valid)reject('Backup contains invalid field types, lengths, dates or JSON.');}
      if(seen.has(row[primary]))reject('Backup contains duplicate primary identifiers.');seen.add(row[primary]);
    }
    counts[table]=rows.length;
  }
  return {tables:value.tables,counts};
}

export async function readBackup(path){
  let buffer;
  try{const file=await stat(path);if(!file.isFile()||file.size>MAX_FILE_BYTES)reject('Backup must be a regular file smaller than 100 MB.');buffer=await readFile(path);if(buffer.length>MAX_FILE_BYTES)reject('Backup is too large.');}
  catch(error){if(error instanceof BackupImportError)throw error;reject('Backup file could not be read.');}
  let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer));}catch{reject('Backup file must contain valid UTF-8 JSON.');}
  return validateBackup(value);
}

/** Migrations precede import; all emptiness checks and application inserts share one transaction. */
export async function importBackup(runtime,input){
  const validated=input?.counts&&input?.tables?validateBackup({schema:'defense-intelligence-transfer',version:1,tables:input.tables}):validateBackup(input);
  if(typeof runtime?.transaction!=='function')reject('The destination runtime does not support atomic imports.');
  await runtime.transaction(async transaction=>{
    for(const table of TABLES){
      const primary=table==='metadata'?'key':table==='record_provenance'?'record_id':'id';
      const row=await transaction.prepare(`SELECT \`${primary}\` FROM \`${table}\` LIMIT 1${transaction.dialect==='mysql'?' FOR UPDATE':''}`).get();
      if(row)reject('Destination already contains application data. Use a new database; existing rows were not overwritten.');
    }
    for(const table of TABLES){
      const columns=Object.keys(BACKUP_SCHEMA[table]),sql=`INSERT INTO \`${table}\` (${columns.map(column=>'`'+column+'`').join(',')}) VALUES (${columns.map(()=>'?').join(',')})`;
      for(const row of validated.tables[table])await transaction.prepare(sql).run(...columns.map(column=>row[column]));
    }
    const marker=JSON.stringify({schema:'defense-intelligence-transfer',version:1,completed:true,importedAt:new Date().toISOString(),counts:validated.counts});
    await transaction.prepare('INSERT INTO metadata (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(IMPORT_MARKER_KEY,marker);
  });
  return {...validated.counts};
}
export async function importComplete(runtime){
  const row=await runtime.database.prepare('SELECT value FROM metadata WHERE key=?').get(IMPORT_MARKER_KEY);
  if(!row)return false;
  try{const marker=JSON.parse(row.value);return marker.schema==='defense-intelligence-transfer'&&marker.version===1&&marker.completed===true&&Number.isFinite(Date.parse(marker.importedAt))&&TABLES.every(table=>Number.isInteger(marker.counts?.[table])&&marker.counts[table]>=0);}catch{return false;}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let runtime;
  try{
    const index=process.argv.indexOf('--input'),path=index>=0?process.argv[index+1]:null;
    if(!path||process.argv.length!==4||index!==2)reject('Usage: node hosting/import-backup.mjs --input <private-backup-file>');
    const backup=await readBackup(resolve(path));runtime=await initializeDatabase();const counts=await importBackup(runtime,backup);console.log(JSON.stringify({imported:counts}));
  }catch(error){console.error(error instanceof BackupImportError?error.message:'Backup import did not complete. No application rows were imported; check database connectivity and migration state.');process.exitCode=1;}
  finally{if(runtime)try{await runtime.close();}catch{console.error('Database connection did not close cleanly.');process.exitCode=1;}}
}
