import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {initializeDatabase} from './runtime.mjs';
import {BACKUP_SCHEMA,validateBackup,readBackup,importBackup,importComplete,IMPORT_MARKER_KEY} from './import-backup.mjs';

const HERE=fileURLToPath(new URL('.',import.meta.url)),TEMP=await mkdtemp(join(HERE,'.import-test-'));
const MIGRATIONS=resolve(HERE,'..','drizzle'),AT='2026-10-21T17:00:00.000Z';
const clone=value=>JSON.parse(JSON.stringify(value));
const record={id:'record-1',company:'Leidos',category:'Teaming',title:'Private source-backed planning example',summary:'Original source statement',assessment:'Owner assessment',url:'https://example.test/source',published:AT,reviewed:'2026-10-21',priority:'Normal',source:'Fixture public source',verification:'Discovery',origin:'manual',created:AT,fingerprint:'original-fingerprint'};
const backup={schema:'defense-intelligence-transfer',version:1,exportedAt:AT,tables:{
  competitors:[{id:'leidos',name:'Leidos',aliases:'Leidos',website:'https://example.test/company',profile:JSON.stringify({name:'Leidos',tags:['Cyber']}),active:1}],
  intelligence:[record],
  alerts:[{id:'alert-1',record_id:'record-1',severity:'Normal',reason:'Original signal',created:AT,acknowledged:1}],
  metadata:[
    {key:'strategy_workshops',value:JSON.stringify([{id:'workshop-1',type:'Capture black hat',notes:'Private workshop notes'}])},
    {key:'contract_pursuits',value:JSON.stringify([{id:'pursuit-1',title:'Private pursuit',customer:'Agency example',evidenceIds:['record-1']}])},
    {key:'capture_plans',value:JSON.stringify([{id:'plan-1',pursuitId:'pursuit-1',winThemes:[]}])},
    {key:'naics_configuration',value:JSON.stringify({codes:['541330','541715'],filters:{excludeCommercial:false}})},
    {key:'refresh_lock',value:'null'},
  ],
  official_awards:[{id:'award-1',company:'Leidos',published:AT,fetched_at:AT,data:JSON.stringify({id:'award-1',company:'Leidos',awardId:'N00024-26-C-1001',obligations:45000000,ceiling:160000000,transactions:[{id:'transaction-1',modification:'P00001',obligation:1000000}]})}],
  event_clusters:[{id:'event-1',updated:AT,data:JSON.stringify({id:'event-1',recordIds:['record-1'],sources:[{recordId:'record-1',url:record.url}],materialFingerprint:'unchanged-event-fingerprint'})}],
  event_alerts:[{id:'event-alert-1',event_id:'event-1',severity:'High',reason:'Original material change',created:AT,acknowledged:1}],
  record_provenance:[{record_id:'record-1',first_seen:AT,fetched_at:AT,hash:'a'.repeat(64)}],
  evidence_versions:[{id:'record-1-version-1',record_id:'record-1',fetched_at:AT,data:JSON.stringify({...record,summary:'First captured version'})},{id:'record-1-version-2',record_id:'record-1',fetched_at:AT,data:JSON.stringify({...record,summary:'Second captured version'})}],
  brief_snapshots:[{id:'snapshot-1',title:'Private decision brief',created:AT,data:JSON.stringify({snapshotId:'snapshot-1',snapshotVersion:1,generatedAt:AT,title:'Private decision brief',records:[record],findings:[{change:'Source changed',implication:'Analyst assessment',action:'Owner action',evidenceIds:['record-1']}],ov1:{mission:'Analyst-authored mission context'}})}],
}};
let counter=0;
async function destination(){const directory=join(TEMP,'database-'+counter++);await mkdir(directory);return initializeDatabase({environment:{NODE_ENV:'test'},dataDirectory:directory,migrationsDirectory:MIGRATIONS});}
const rows=async(runtime,table)=>clone(await runtime.database.prepare(`SELECT * FROM \`${table}\``).all());

test('SQLite roundtrip preserves all records, planning metadata, source versions and immutable snapshots',async()=>{
  const runtime=await destination();try{const counts=await importBackup(runtime,backup);for(const table of Object.keys(BACKUP_SCHEMA)){assert.equal(counts[table],backup.tables[table].length);const actual=await rows(runtime,table);assert.deepEqual(table==='metadata'?actual.filter(row=>row.key!==IMPORT_MARKER_KEY):actual,backup.tables[table]);}assert.equal(await importComplete(runtime),true);assert.equal(JSON.parse((await rows(runtime,'metadata')).find(row=>row.key==='contract_pursuits').value)[0].title,'Private pursuit');assert.equal((await rows(runtime,'evidence_versions')).length,2);assert.equal(JSON.parse((await rows(runtime,'brief_snapshots'))[0].data).snapshotVersion,1);}finally{await runtime.close();}
});

test('Nonempty destination refuses transfer without overwriting or appending data',async()=>{
  const runtime=await destination();try{await runtime.database.prepare('INSERT INTO metadata(key,value)VALUES(?,?)').run('owner-existing-setting','{"retained":true}');await assert.rejects(()=>importBackup(runtime,backup),/already contains/);assert.deepEqual(await rows(runtime,'metadata'),[{key:'owner-existing-setting',value:'{"retained":true}'}]);assert.equal((await rows(runtime,'intelligence')).length,0);}finally{await runtime.close();}
});

test('A mid-import failure rolls back every application table but keeps migration history',async()=>{
  const runtime=await destination();try{
    const failing={transaction:operation=>runtime.transaction(transaction=>operation({...transaction,prepare(sql){const statement=transaction.prepare(sql);return {get:(...values)=>statement.get(...values),async run(...values){if(sql.startsWith('INSERT INTO `official_awards`'))throw Error('Simulated destination failure');return statement.run(...values);}};}}))};
    await assert.rejects(()=>importBackup(failing,backup),/Simulated destination/);for(const table of Object.keys(BACKUP_SCHEMA))assert.equal((await rows(runtime,table)).length,0);assert.equal(runtime.database.prepare('SELECT COUNT(*) n FROM __portable_migrations').get().n,2);
  }finally{await runtime.close();}
});

test('Validator rejects extra/missing columns, secret tables, bad types, oversize values and duplicate IDs',()=>{
  const cases=[value=>value.tables.competitors[0].secret='must never print',value=>delete value.tables.intelligence[0].title,value=>value.tables.__portable_sessions=[],value=>value.tables.competitors[0].active='1',value=>value.tables.intelligence[0].published='not-a-date',value=>value.tables.intelligence[0].title='x'.repeat(701),value=>value.tables.metadata[0].value='{invalid JSON',value=>value.tables.evidence_versions.push(clone(value.tables.evidence_versions[0]))];
  for(const change of cases){const value=clone(backup);change(value);assert.throws(()=>validateBackup(value),error=>!error.message.includes('must never print'));}
  const value=clone(backup);value.version=2;assert.throws(()=>validateBackup(value),/not supported/);
});

test('Offline CLI prints only counts, closes the database and safely rejects a second import',async()=>{
  const directory=join(TEMP,'cli-database'),packageRoot=join(TEMP,'cli-package');await mkdir(directory);await mkdir(join(packageRoot,'hosting'),{recursive:true});
  const path=join(TEMP,'private-backup.json');await writeFile(path,JSON.stringify(backup));
  // CLI module keeps its real migrations contract. Supply a copied journal through a local wrapper.
  const wrapper=join(TEMP,'cli.mjs');await writeFile(wrapper,`import {initializeDatabase} from ${JSON.stringify(new URL('./runtime.mjs',import.meta.url).href)};\nawait initializeDatabase({migrationsDirectory:${JSON.stringify(MIGRATIONS)}});\nprocess.argv[1]=${JSON.stringify(fileURLToPath(new URL('./import-backup.mjs',import.meta.url)))};\nawait import(${JSON.stringify(new URL('./import-backup.mjs',import.meta.url).href)});\n`);
  const environment={...process.env,NODE_ENV:'test',DATA_DIR:directory};for(const key of ['DATABASE_URL','DB_HOST','DB_PORT','DB_USER','DB_PASSWORD','DB_NAME','DB_SSL_MODE','DB_SSL_CA'])delete environment[key];
  const result=spawnSync(process.execPath,[wrapper,'--input',path],{env:environment,encoding:'utf8'});assert.equal(result.status,0,result.stderr);const output=JSON.parse(result.stdout);assert.equal(output.imported.metadata,5);assert(!result.stdout.includes('Private'));assert(!result.stdout.includes('Original source'));assert(!result.stdout.includes('example.test'));
  const repeat=spawnSync(process.execPath,[wrapper,'--input',path],{env:environment,encoding:'utf8'});assert.equal(repeat.status,1);assert.match(repeat.stderr,/already contains/);assert(!repeat.stderr.includes('Private pursuit'));assert.equal(repeat.stdout,'');
});

test('Backup reader rejects malformed UTF-8 and production cannot silently use SQLite',async()=>{
  const path=join(TEMP,'invalid.json');await writeFile(path,Buffer.from([0xff,0xfe]));await assert.rejects(()=>readBackup(path),/UTF-8 JSON/);await assert.rejects(()=>initializeDatabase({environment:{NODE_ENV:'production'},dataDirectory:join(TEMP,'not-production-storage'),migrationsDirectory:MIGRATIONS}),/requires managed MySQL/);
});

test.after(async()=>{const actual=await realpath(TEMP),difference=relative(HERE,actual);assert(!isAbsolute(difference)&&!difference.startsWith('..')&&difference.startsWith('.import-test-'));await rm(actual,{recursive:true,force:true});});
