import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
const cwd=new URL('..',import.meta.url);
const configPath=new URL('../wrangler.jsonc',import.meta.url);
const wrangler='node_modules/wrangler/bin/wrangler.js';
function run(args,capture=false,input) {
 const r=spawnSync(process.execPath,[wrangler,...args],{cwd,encoding:'utf8',input,stdio:capture||input!==undefined?['pipe','pipe','pipe']:'inherit'});
 if(r.status!==0) { if(capture) process.stderr.write(r.stderr||'Cloudflare command failed.\n'); throw new Error('Cloudflare setup stopped. Sign in with npx wrangler login or configure your scoped Cloudflare token locally, then rerun.'); }
 return r.stdout||'';
}
function jsonOutput(output) { const start=output.indexOf('['); if(start<0) throw new Error('Unexpected Cloudflare resource-list response'); return JSON.parse(output.slice(start)); }
console.log('Checking Cloudflare account access. Existing jmpanal.com hosting will be preserved; only /petete is routed to this Worker.');
let config=JSON.parse(await readFile(configPath,'utf8'));
const databases=jsonOutput(run(['d1','list','--json'],true));
const existing=databases.find(x=>x.name==='petete');
if(existing) { config.d1_databases[0].database_id=existing.uuid||existing.id; await writeFile(configPath,JSON.stringify(config,null,2)+'\n'); }
else run(['d1','create','petete','--jurisdiction','eu','--binding','DB','--update-config']);
const indexes=jsonOutput(run(['vectorize','list','--json'],true));
if(!indexes.some(x=>x.name==='petete-bge-m3')) run(['vectorize','create','petete-bge-m3','--dimensions','1024','--metric','cosine','--binding','VECTORIZE','--update-config']);
const deploy=spawnSync(process.execPath,['scripts/deploy.mjs'],{cwd,stdio:'inherit'});
if(deploy.status!==0) process.exit(deploy.status||1);
const secrets=jsonOutput(run(['secret','list'],true));
if(!secrets.some(x=>x.name==='SESSION_PEPPER')) run(['secret','put','SESSION_PEPPER'],false,randomBytes(32).toString('hex')+'\n');
console.log('Deployment finished. Run node scripts/create-admin.mjs to initialize the first administrator securely.');
