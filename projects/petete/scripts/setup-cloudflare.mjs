import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const cwd=new URL('..',import.meta.url);
const configPath=new URL('../wrangler.jsonc',import.meta.url);
const wrangler='node_modules/wrangler/bin/wrangler.js';
function run(args,capture=false,input) {
 const r=spawnSync(process.execPath,[wrangler,...args],{cwd,encoding:'utf8',input,stdio:capture||input!==undefined?['pipe','pipe','pipe']:'inherit'});
 if(r.status!==0) { if(capture) process.stderr.write(r.stderr||'Cloudflare command failed.\n'); throw new Error('Cloudflare setup stopped. Sign in with npx wrangler login or configure your scoped Cloudflare token locally, then rerun.'); }
 return r.stdout||'';
}
export function parseWranglerJson(output) {
 const text=String(output).replace(/\u001b\[[0-9;]*m/g,'').trim();
 for(let start=0;start<text.length;start++) {
  if(!['[','{'].includes(text[start]))continue;
  try{return JSON.parse(text.slice(start));}catch{}
 }
 throw new Error('Unexpected Cloudflare JSON response; setup stopped without assuming success.');
}
export function validateVectorIndex(index) {
 if(index?.name!=='petete-bge-m3'||Number(index.config?.dimensions)!==1024||index.config?.metric!=='cosine')throw new Error('Existing petete-bge-m3 index must use 1024 dimensions and cosine distance. No index was replaced.');
}
export function missingMetadataIndexes(indexes) {
 if(!Array.isArray(indexes))throw new Error('Unexpected Vectorize metadata index response.');
 const required=[{propertyName:'source',indexType:'string'},{propertyName:'tax',indexType:'string'},{propertyName:'date_epoch',indexType:'number'}];
 return required.filter(expected=>{
  const existing=indexes.find(x=>x.propertyName===expected.propertyName);
  if(existing&&existing.indexType!==expected.indexType)throw new Error(`Vectorize metadata ${expected.propertyName} must have type ${expected.indexType}. No metadata index was replaced.`);
  return !existing;
 });
}
export async function setupCloudflare() {
 if(process.env.CI&&(!process.env.CLOUDFLARE_API_TOKEN||!process.env.CLOUDFLARE_ACCOUNT_ID))throw new Error('CI deployment requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Configure the repository deployment secrets before running setup.');
 console.log('Checking Cloudflare account access. Existing jmpanal.com hosting will be preserved; only /petete is routed to this Worker.');
 const config=JSON.parse(await readFile(configPath,'utf8'));
 const databases=parseWranglerJson(run(['d1','list','--json'],true));
 if(!Array.isArray(databases))throw new Error('Unexpected D1 database list.');
 const existing=databases.find(x=>x.name==='petete');
 if(existing) {
  const id=existing.uuid||existing.id;
  if(typeof id!=='string'||!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id)||id.startsWith('00000000'))throw new Error('D1 returned an invalid database ID.');
  config.d1_databases[0].database_id=id;
  await writeFile(configPath,JSON.stringify(config,null,2)+'\n');
 } else run(['d1','create','petete','--jurisdiction','eu','--binding','DB','--update-config']);
 const indexes=parseWranglerJson(run(['vectorize','list','--json'],true));
 if(!Array.isArray(indexes))throw new Error('Unexpected Vectorize index list.');
 if(!indexes.some(x=>x.name==='petete-bge-m3'))run(['vectorize','create','petete-bge-m3','--dimensions','1024','--metric','cosine','--binding','VECTORIZE','--update-config']);
 validateVectorIndex(parseWranglerJson(run(['vectorize','get','petete-bge-m3','--json'],true)));
 for(const field of missingMetadataIndexes(parseWranglerJson(run(['vectorize','list-metadata-index','petete-bge-m3','--json'],true))))run(['vectorize','create-metadata-index','petete-bge-m3','--propertyName',field.propertyName,'--type',field.indexType]);
 // Metadata index creation is asynchronous. Confirm all property definitions before
 // deploying a scheduled producer that writes its first chunk vectors.
 let metadataReady=false;
 for(let attempt=0;attempt<15;attempt++) {
  if(!missingMetadataIndexes(parseWranglerJson(run(['vectorize','list-metadata-index','petete-bge-m3','--json'],true))).length){metadataReady=true;break;}
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
 if(!metadataReady)throw new Error('Vectorize metadata indexes are still propagating. Rerun setup after they finish; no Worker was deployed.');
 const deploy=spawnSync(process.execPath,['scripts/deploy.mjs'],{cwd,stdio:'inherit'});
 if(deploy.status!==0)process.exit(deploy.status||1);
 const secrets=parseWranglerJson(run(['secret','list','--format','json'],true));
 if(!Array.isArray(secrets))throw new Error('Unexpected Worker secret list.');
 if(!secrets.some(x=>x.name==='SESSION_PEPPER'))run(['secret','put','SESSION_PEPPER'],false,randomBytes(32).toString('hex')+'\n');
 console.log(process.env.CI?'Deployment finished. Continue with scripts/create-admin-ci.mjs to initialize account access and the DGT import queue.':'Deployment finished. Run node scripts/create-admin.mjs to initialize the first administrator securely.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await setupCloudflare();
