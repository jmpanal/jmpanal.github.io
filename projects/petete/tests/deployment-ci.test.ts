import {describe,expect,it,vi} from 'vitest';

const {adminCiConfiguration,createAdminCI}=await import(new URL('../scripts/create-admin-ci.mjs',import.meta.url).href);
const env={PETETE_ADMIN_EMAIL:'test-admin@example.com',PETETE_ADMIN_PASSWORD:'test-initial-password-123'};
const healthy=()=>Response.json({ok:true,service:'petete',database_configured:true,ai_configured:true,vector_index_configured:true});
const login=()=>Response.json({user:{id:'test-admin',role:'admin'}},{headers:{'Set-Cookie':`petete_session=${'a'.repeat(64)}; Path=/petete; Secure; HttpOnly; SameSite=Strict`}});
function harness(options:{bootstrapStatus?:number;loginStatus?:number;backfillStatus?:number}={}) {
 const calls:{path:string;init:RequestInit;body:any}[]=[],logs:string[]=[],tokens:string[]=[];
 const requestFetch=async(input:string,init:RequestInit)=>{
  const path=new URL(input).pathname.replace('/petete/api','');
  const body=init.body?JSON.parse(String(init.body)):undefined;
  calls.push({path,init,body});
  if(path==='/health')return healthy();
  if(path==='/admin/bootstrap')return options.bootstrapStatus===409?Response.json({error:'already initialized'},{status:409}):Response.json({id:'test-admin',role:'admin'},{status:201});
  if(path==='/auth/login')return options.loginStatus?Response.json({error:env.PETETE_ADMIN_PASSWORD},{status:options.loginStatus}):login();
  if(path==='/admin/backfill')return options.backfillStatus?Response.json({error:env.PETETE_ADMIN_PASSWORD},{status:options.backfillStatus}):Response.json({ok:true,result:{enqueued:body.from==='1997-01-01'?710:6}},{status:202});
  if(path==='/auth/logout')return Response.json({ok:true});
  throw new Error('Unexpected mock route');
 };
 const dependencies={env,requestFetch,writeBootstrapSecret:async(token:string)=>{tokens.push(token);},wait:vi.fn(async()=>{}),log:(line:string)=>logs.push(line),now:()=>new Date('2026-11-01T12:00:00Z'),attempts:2};
 return {calls,logs,tokens,dependencies};
}

describe('noninteractive first deployment and administrator initialization',()=>{
 it('creates the first administrator, queues recent and historical DGT windows, and closes its setup session',async()=>{
  const h=harness();const result=await createAdminCI(h.dependencies);
  expect(result).toEqual({admin:'created',recent_jobs:6,archive_jobs:710,from:'1997-01-01',to:'2026-11-01'});
  expect(h.tokens).toHaveLength(1);expect(h.tokens[0]).toMatch(/^[a-f0-9]{64}$/);
  const bootstrap=h.calls.find(c=>c.path==='/admin/bootstrap')!;
  expect(bootstrap.init.headers).toMatchObject({Authorization:`Bearer ${h.tokens[0]}`,Origin:'https://www.jmpanal.com'});
  expect(bootstrap.body).toMatchObject({email:env.PETETE_ADMIN_EMAIL,password:env.PETETE_ADMIN_PASSWORD});
  expect(h.calls.filter(c=>c.path==='/admin/backfill').map(c=>c.body)).toEqual([{from:'2026-09-01',to:'2026-11-01'},{from:'1997-01-01',to:'2026-11-01'}]);
  expect(h.calls.at(-1)?.path).toBe('/auth/logout');
  expect(h.calls.every(c=>c.init.redirect==='error')).toBe(true);
  const output=JSON.stringify([result,h.logs]);
  for(const secret of [env.PETETE_ADMIN_EMAIL,env.PETETE_ADMIN_PASSWORD,h.tokens[0],'a'.repeat(64)])expect(output).not.toContain(secret);
 });

 it('treats already-initialized HTTP409 as idempotent success without resetting any account',async()=>{
  const h=harness({bootstrapStatus:409});const result=await createAdminCI(h.dependencies);
  expect(result.admin).toBe('already_initialized');
  expect(h.calls.filter(c=>c.path==='/admin/bootstrap')).toHaveLength(1);
  expect(h.calls.some(c=>c.init.method==='PATCH'||c.path.startsWith('/admin/users'))).toBe(false);
  expect(h.calls.filter(c=>c.path==='/admin/backfill')).toHaveLength(2);
 });

 it('does not overwrite an existing password when deployment secrets no longer authenticate',async()=>{
  const h=harness({bootstrapStatus:409,loginStatus:401});
  let message='';try{await createAdminCI(h.dependencies);}catch(error){message=(error as Error).message;}
  expect(message).toContain('HTTP 401');expect(message).toContain('No account password was changed');
  expect(message).not.toContain(env.PETETE_ADMIN_PASSWORD);
  expect(h.calls.some(c=>c.path==='/admin/backfill'||c.path.startsWith('/admin/users'))).toBe(false);
 });

 it('waits for deployment propagation and retries a newly installed bootstrap secret without exposing responses',async()=>{
  const h=harness();const original=h.dependencies.requestFetch;
  let healthAttempts=0,bootstrapAttempts=0;
  h.dependencies.requestFetch=async(input,init)=>{
   if(input.endsWith('/health')&&++healthAttempts===1)return new Response('Not deployed',{status:503});
   if(input.endsWith('/admin/bootstrap')&&++bootstrapAttempts===1)return Response.json({error:env.PETETE_ADMIN_PASSWORD},{status:403});
   return original(input,init);
  };
  expect((await createAdminCI(h.dependencies)).admin).toBe('created');
  expect(healthAttempts).toBe(2);expect(bootstrapAttempts).toBe(2);expect(h.dependencies.wait).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(h.logs)).not.toContain(env.PETETE_ADMIN_PASSWORD);
 });

 it('stops before writing secrets when the deployed API is missing required bindings',async()=>{
  const h=harness();
  h.dependencies.requestFetch=async()=>Response.json({ok:true,service:'petete',database_configured:true,ai_configured:false,vector_index_configured:false});
  await expect(createAdminCI(h.dependencies)).rejects.toThrow(/D1, Workers AI and Vectorize/);
  expect(h.tokens).toHaveLength(0);expect(h.dependencies.wait).toHaveBeenCalledTimes(1);
 });

 it('logs out after a failed import request and never reports a successful queue',async()=>{
  const h=harness({backfillStatus:503});
  await expect(createAdminCI(h.dependencies)).rejects.toThrow(/bounded setup retry/);
  expect(h.calls.at(-1)?.path).toBe('/auth/logout');
  expect(h.logs.some(line=>line.includes('DGT import queued'))).toBe(false);
  expect(JSON.stringify(h.logs)).not.toContain(env.PETETE_ADMIN_PASSWORD);
 });

 it('validates paired secrets and a canonical HTTPS destination before using any credentials',()=>{
  expect(()=>adminCiConfiguration({PETETE_ADMIN_EMAIL:env.PETETE_ADMIN_EMAIL})).toThrow(/both/);
  expect(()=>adminCiConfiguration({...env,PETETE_ADMIN_PASSWORD:'short'})).toThrow(/12 to 256/);
  for(const origin of ['http://www.jmpanal.com','https://user:password@www.jmpanal.com','https://www.jmpanal.com/path','https://www.jmpanal.com/?token=value'])expect(()=>adminCiConfiguration({...env,PETETE_ORIGIN:origin})).toThrow(/HTTPS origin/);
 });
});
