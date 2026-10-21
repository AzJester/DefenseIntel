import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,stat,realpath,rm} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareViewer} from './site/scripts/prepare-viewer.mjs';

test('Sites adapter has an identity-free manifest and a consistent locked package graph',async()=>{
  const root=new URL('./site/',import.meta.url),manifest=JSON.parse(await readFile(new URL('.openai/hosting.json',root),'utf8'));
  assert.deepEqual(manifest,{d1:null,r2:null});
  const pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8')),lock=JSON.parse(await readFile(new URL('package-lock.json',root),'utf8'));
  assert.equal(pkg.name,lock.name);assert.equal(pkg.version,lock.version);assert.deepEqual(pkg.dependencies,lock.packages[''].dependencies);assert.deepEqual(pkg.devDependencies,lock.packages[''].devDependencies);
  assert.match(pkg.scripts.build,/prepare-viewer\.mjs.*run-framework\.mjs build/);assert.match(pkg.scripts.dev,/prepare-viewer\.mjs.*run-framework\.mjs dev/);
  const ignores=await readFile(new URL('.gitignore',root),'utf8');assert.match(ignores,/^\/public\/$/m);assert.match(ignores,/^\/lib\/gateway\.mjs$/m);assert.match(ignores,/\.dev\.vars/);
  for(const file of ['app/route.ts','app/api/[...path]/route.ts','app/layout.tsx','worker/index.ts','vite.config.ts','cloudflare-env.d.ts','scripts/run-framework.mjs'])assert((await stat(new URL(file,root))).isFile());
});

test('Preparation copies canonical assets and gateway, clears stale copies, and leaves authored sources unchanged',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'defense-viewer-kit-')),repository=join(temporary,'repo'),siteRoot=join(repository,'sites-viewer','site'),publicRoot=join(repository,'public'),gateway=join(repository,'sites-viewer','gateway.mjs');
  try{
    await mkdir(siteRoot,{recursive:true});await mkdir(publicRoot,{recursive:true});await writeFile(join(publicRoot,'index.html'),'<html>Shared fixture</html>');await writeFile(join(publicRoot,'app.js'),'export const fixture=true;');await writeFile(gateway,'export const gatewayFixture=true;');
    const result=await prepareViewer({siteRoot});assert.equal(await readFile(join(result.publicDirectory,'index.html'),'utf8'),'<html>Shared fixture</html>');assert.equal(await readFile(result.gatewayFile,'utf8'),'export const gatewayFixture=true;');
    await writeFile(join(result.publicDirectory,'stale.js'),'old generated output');await writeFile(join(publicRoot,'app.js'),'export const fixture="updated";');await prepareViewer({siteRoot});
    await assert.rejects(stat(join(result.publicDirectory,'stale.js')),error=>error.code==='ENOENT');assert.equal(await readFile(join(result.publicDirectory,'app.js'),'utf8'),'export const fixture="updated";');assert.equal(await readFile(gateway,'utf8'),'export const gatewayFixture=true;');
    await assert.rejects(prepareViewer({siteRoot:join(temporary,'missing')}),error=>error.code==='ENOENT');
  }finally{const actual=await realpath(temporary),difference=relative(tmpdir(),actual);assert(!isAbsolute(difference)&&!difference.startsWith('..')&&difference.startsWith('defense-viewer-kit-'));await rm(actual,{recursive:true,force:true});}
});
