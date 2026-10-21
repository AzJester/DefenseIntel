import {cp,mkdir,realpath,rm,stat} from 'node:fs/promises';
import {basename,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/** Stage canonical repository sources; these generated copies are never committed. */
export async function prepareViewer({siteRoot=fileURLToPath(new URL('../',import.meta.url))}={}){
  const root=await realpath(siteRoot),repository=resolve(root,'../..');
  const sourcePublic=resolve(repository,'public'),sourceGateway=resolve(root,'../gateway.mjs');
  const targetPublic=resolve(root,'public'),targetGateway=resolve(root,'lib/gateway.mjs');
  if(dirname(targetPublic)!==root||basename(targetPublic)!=='public'||dirname(dirname(targetGateway))!==root)throw Error('Viewer staging targets must stay inside the adapter directory.');
  if(!(await stat(resolve(sourcePublic,'index.html'))).isFile()||!(await stat(sourceGateway)).isFile())throw Error('Run preparation from the complete repository, with root public assets and sites-viewer/gateway.mjs present.');
  // public/ is exclusively generated. Its resolved, fixed target is checked above.
  await rm(targetPublic,{recursive:true,force:true});
  await cp(sourcePublic,targetPublic,{recursive:true,force:true});
  await mkdir(dirname(targetGateway),{recursive:true});
  await cp(sourceGateway,targetGateway,{force:true});
  return {publicDirectory:targetPublic,gatewayFile:targetGateway};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await prepareViewer();console.log('Prepared viewer assets and gateway from canonical repository sources.');}
  catch(error){console.error('Viewer preparation failed:',error.message);process.exitCode=1;}
}
