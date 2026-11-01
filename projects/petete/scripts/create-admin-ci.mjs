import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function adminCiConfiguration(env=process.env) {
 const email=env.PETETE_ADMIN_EMAIL?.trim(),password=env.PETETE_ADMIN_PASSWORD;
 if(!email||!password)throw new Error('Set both PETETE_ADMIN_EMAIL and PETETE_ADMIN_PASSWORD repository secrets before running deployment.');
 if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('PETETE_ADMIN_EMAIL is not a valid email address.');
 if(password.length<12||password.length>256)throw new Error('PETETE_ADMIN_PASSWORD must contain 12 to 256 characters.');
 let url;try{url=new URL(env.PETETE_ORIGIN||'https://www.jmpanal.com');}catch{throw new Error('PETETE_ORIGIN must be an HTTPS origin.');}
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('PETETE_ORIGIN must be an HTTPS origin without a path or credentials.');
 return {email,password,name:(env.PETETE_ADMIN_NAME||'Administrador').trim().slice(0,120),origin:url.origin};
}

function installBootstrapSecret(token) {
 const result=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','secret','put','ADMIN_BOOTSTRAP_TOKEN'],{cwd:new URL('..',import.meta.url),input:token+'\n',encoding:'utf8',stdio:['pipe','pipe','pipe']});
 // The command's output is deliberately not forwarded: it may contain service diagnostics.
 if(result.status!==0)throw new Error('Could not configure the temporary Cloudflare bootstrap secret. Check the deployment token permissions.');
}

export async function createAdminCI({env=process.env,requestFetch=fetch,writeBootstrapSecret=installBootstrapSecret,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),log=console.log,now=()=>new Date(),attempts=8}={}) {
 const config=adminCiConfiguration(env),token=randomBytes(32).toString('hex');
 const maxAttempts=Math.max(1,Math.min(8,Number(attempts)||8));
 const endpoint=path=>config.origin+'/petete/api'+path;
 async function request(path,{method='GET',body,headers={},accepted=[200],retry=[502,503,504]}={}) {
  for(let attempt=0;attempt<maxAttempts;attempt++) {
   let response;
   try {response=await requestFetch(endpoint(path),{method,headers:{Accept:'application/json',...(body!==undefined?{'Content-Type':'application/json',Origin:config.origin}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(5000)});}catch{}
   if(response&&accepted.includes(response.status))return response;
   if(response&&!retry.includes(response.status))throw new Error(`Petete setup request failed (HTTP ${response.status}). No account password was changed.`);
   if(attempt<maxAttempts-1)await wait(1500);
  }
  throw new Error('Petete did not become ready within the bounded setup retry window. Rerun deployment after checking Cloudflare routing and bindings.');
 }
 async function json(response) {try{return await response.json();}catch{throw new Error('Petete returned an unexpected setup response. No response body was logged.');}}
 let healthy=false;
 for(let attempt=0;attempt<maxAttempts;attempt++) {
  try {
   const response=await requestFetch(endpoint('/health'),{headers:{Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(5000)});
   const status=response.ok?await response.json():null;
   healthy=!!(status?.ok&&status.service==='petete'&&status.database_configured&&status.ai_configured&&status.vector_index_configured);
  }catch{}
  if(healthy)break;
  if(attempt<maxAttempts-1)await wait(1500);
 }
 if(!healthy)throw new Error('The deployed Petete API is not ready with D1, Workers AI and Vectorize bindings. Check Cloudflare routing and rerun deployment.');
 await writeBootstrapSecret(token);
 const bootstrap=await request('/admin/bootstrap',{method:'POST',body:{email:config.email,password:config.password,name:config.name},headers:{Authorization:'Bearer '+token},accepted:[201,409],retry:[403,502,503,504]});
 const admin=bootstrap.status===201?'created':'already_initialized';
 // HTTP409 is an idempotent success. Existing accounts are never overwritten, even if
 // the workflow secrets have changed since first deployment.
 if(admin==='created') {
  const created=await json(bootstrap);
  if(created.role!=='admin'||typeof created.id!=='string')throw new Error('Petete did not confirm administrator initialization.');
 }
 const login=await request('/auth/login',{method:'POST',body:{email:config.email,password:config.password}});
 const account=await json(login);
 if(account.user?.role!=='admin')throw new Error('The configured account does not have administrator access. No permissions or passwords were changed.');
 const cookies=typeof login.headers.getSetCookie==='function'?login.headers.getSetCookie():[login.headers.get('set-cookie')||''];
 const cookie=cookies.map(value=>value.split(';')[0]).find(value=>/^petete_session=[a-f0-9]{64}$/.test(value));
 if(!cookie)throw new Error('Petete did not issue a valid administrator session.');
 const current=now(),to=current.toISOString().slice(0,10);
 const recentFrom=new Date(Date.UTC(current.getUTCFullYear(),current.getUTCMonth()-2,1)).toISOString().slice(0,10);
 let recent,archive;
 try {
  // Queue current publications first so the long historical import does not delay them.
  for(const from of [recentFrom,'1997-01-01']) {
   const response=await request('/admin/backfill',{method:'POST',body:{from,to},headers:{Cookie:cookie},accepted:[202]});
   const body=await json(response);
   if(!body.ok||!Number.isInteger(body.result?.enqueued)||body.result.enqueued<0)throw new Error('Petete did not confirm the DGT import queue.');
   if(from===recentFrom)recent=body.result;else archive=body.result;
  }
 } finally {
  try {await request('/auth/logout',{method:'POST',body:{},headers:{Cookie:cookie}});}catch {log('Setup session logout could not be confirmed. It will expire automatically.');}
 }
 const result={admin,recent_jobs:recent.enqueued,archive_jobs:archive.enqueued,from:'1997-01-01',to};
 log(`Administrator ${admin==='created'?'initialized':'already initialized'}. DGT import queued: ${recent.enqueued} recent jobs and ${archive.enqueued} historical jobs. Collection and AI indexing continue in the deployed scheduler; the full archive is not yet collected.`);
 return result;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {await createAdminCI();}catch(error) {console.error(error instanceof Error?error.message:'Petete CI initialization failed.');process.exitCode=1;}
}
