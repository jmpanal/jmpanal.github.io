import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const config=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
if(!config.d1_databases?.[0]?.database_id || config.d1_databases[0].database_id.startsWith('00000000')) {
  throw new Error('Cloudflare is not provisioned. Run npm run setup:cloudflare from the project folder after signing in to your Cloudflare account.');
}
function run(args) { const r=spawnSync(process.execPath,args,{stdio:'inherit',cwd:new URL('..',import.meta.url)}); if(r.status!==0) process.exit(r.status||1); }
run(['node_modules/vitest/vitest.mjs','run']);
run(['scripts/build-demo.mjs']);
run(['node_modules/typescript/bin/tsc','--noEmit']);
run(['node_modules/vite/bin/vite.js','build']);
run(['node_modules/wrangler/bin/wrangler.js','d1','migrations','apply','petete','--remote']);
run(['node_modules/wrangler/bin/wrangler.js','deploy','--keep-vars']);
