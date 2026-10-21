import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';

const HERE=fileURLToPath(new URL('.',import.meta.url));
const FILES=['workspace.ts','intelligence-workspace.ts','intelligence-feeds.ts','official-awards.ts','event-intelligence.ts'];
function argument(name,fallback){const index=process.argv.indexOf(name);return index<0?fallback:process.argv[index+1];}

/** Copies and transpiles only the app business layer; source checkout files are read-only. */
export async function buildPortable({sourceDirectory,outputDirectory=resolve(HERE,'..'),typescript}={}){
  if(!sourceDirectory)throw Error('Pass --source with the original app checkout directory');
  const source=resolve(sourceDirectory),output=resolve(outputDirectory);
  const sameRoot=output===source;
  for(const protectedDirectory of ['public','drizzle','server']){const difference=relative(join(source,protectedDirectory),output);if(difference===''||!difference.startsWith('..')&&!isAbsolute(difference))throw Error('Build output cannot be inside a copied asset, migration or generated directory');}
  const load=createRequire(join(source,'package.json'));
  const ts=typescript||load('typescript');
  const server=join(output,'server');await mkdir(server,{recursive:true});
  const manifest={createdAt:new Date().toISOString(),node:'>=22.13.0',modules:{},migrationJournal:null};
  for(const file of FILES){
    let input=await readFile(join(source,'lib',file),'utf8');
    input=input.replace(/from\s+(['"])cloudflare:workers\1/g,"from '../hosting/runtime.mjs'");
    input=input.replace(/from\s+(['"])(\.\.?\/[^'"\r\n]+)\1/g,(match,quote,specifier)=>{
      if(specifier.endsWith('.json'))return `from '${specifier}' with {type:'json'}`;
      if(/\.(?:mjs|js)$/.test(specifier))return match;
      return `from '${specifier.replace(/\.ts$/,'')}.js'`;
    });
    const result=ts.transpileModule(input,{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,isolatedModules:true,sourceMap:false,removeComments:false},reportDiagnostics:true});
    const errors=(result.diagnostics||[]).filter(row=>row.category===ts.DiagnosticCategory.Error);
    if(errors.length)throw Error(`Cannot transpile ${file}: ${errors.map(row=>ts.flattenDiagnosticMessageText(row.messageText,' ')).join('; ')}`);
    if(/cloudflare:workers|from\s+['"]\.[^'"]*(?:\.ts)['"]/.test(result.outputText))throw Error(`Portable import rewrite failed in ${file}`);
    await writeFile(join(server,file.replace(/\.ts$/,'.js')),result.outputText);
    manifest.modules[file]=createHash('sha256').update(result.outputText).digest('hex');
  }
  await writeFile(join(server,'package.json'),JSON.stringify({private:true,type:'module'},null,2)+'\n');
  await cp(join(source,'lib','seed-data.json'),join(server,'seed-data.json'));
  if(!sameRoot){
    await cp(join(source,'public'),join(output,'public'),{recursive:true,force:true,filter:input=>!['remote-collector.mjs','collector-runtime.mjs'].includes(basename(input))});
    await cp(join(source,'drizzle'),join(output,'drizzle'),{recursive:true,force:true});
  }
  manifest.migrationJournal=createHash('sha256').update(await readFile(join(output,'drizzle','meta','_journal.json'))).digest('hex');
  await writeFile(join(output,'portable-build.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const manifest=await buildPortable({sourceDirectory:argument('--source'),outputDirectory:argument('--output',resolve(HERE,'..'))});console.log(JSON.stringify({status:'built',modules:Object.keys(manifest.modules),node:manifest.node}));}
  catch(error){console.error('Portable build failed:',error.message);process.exitCode=1;}
}
