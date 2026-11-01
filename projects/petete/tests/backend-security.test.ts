import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Database, Env, Statement, VectorizeQueryOptions } from '../worker/types';
import { assertSameOrigin, hashPassword, sessionCookie, verifyPassword } from '../worker/auth';
import { ftsQuery, safeExcelCell, search, searchOptions, semanticFilter, trustedSourceUrl } from '../worker/search';
import app from '../worker/index';

function adapter(sqlite:DatabaseSync):Database { return { prepare(sql:string) { let values:any[]=[]; const statement:Statement={bind(...args:unknown[]){values=args;return statement;},async first<T>(column?:string){const row=sqlite.prepare(sql).get(...values);return row?(column?row[column]:row) as T:null;},async all<T>(){return {results:sqlite.prepare(sql).all(...values) as T[]};},async run(){const info=sqlite.prepare(sql).run(...values);return {results:[],meta:{changes:Number(info.changes)}};}};return statement;}, async batch(statements){sqlite.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sqlite.exec('COMMIT');return out;}catch(e){sqlite.exec('ROLLBACK');throw e;}}, async exec(sql){sqlite.exec(sql);} }; }
let sqlite:DatabaseSync,env:Env;
const url='https://www.jmpanal.com/petete/api';
function req(path:string,method='GET',body?:unknown,cookie?:string,origin='https://www.jmpanal.com',authorization?:string){return new Request(`${url}${path}`,{method,headers:{'Content-Type':'application/json',Origin:origin,...(cookie?{Cookie:cookie}:{}),...(authorization?{Authorization:authorization}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});}
async function bootstrap(){const res=await app.fetch(req('/admin/bootstrap','POST',{email:'admin@example.com',password:'long-test-password',name:'Admin'},undefined,undefined,'Bearer bootstrap-test'),env);expect(res.status).toBe(201);const login=await app.fetch(req('/auth/login','POST',{email:'admin@example.com',password:'long-test-password'}),env);expect(login.status).toBe(200);return login.headers.get('set-cookie')!.split(';')[0];}
beforeEach(()=>{sqlite=new DatabaseSync(':memory:');sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));sqlite.exec(readFileSync(new URL('../migrations/0002_ingestion.sql',import.meta.url),'utf8'));sqlite.exec(readFileSync(new URL('../migrations/0003_admin_guard.sql',import.meta.url),'utf8'));env={DB:adapter(sqlite),ADMIN_BOOTSTRAP_TOKEN:'bootstrap-test',SESSION_PEPPER:'test-pepper'};});
afterEach(()=>sqlite.close());

describe('authentication boundary',()=>{
 it('uses salted password hashes and rejects wrong passwords',async()=>{const a=await hashPassword('twelve-plus-password');const b=await hashPassword('twelve-plus-password');expect(a).not.toBe(b);expect(await verifyPassword('twelve-plus-password',a)).toBe(true);expect(await verifyPassword('wrong',a)).toBe(false);expect(await verifyPassword('wrong','malformed')).toBe(false);});
 it('rejects cross-origin mutation and sets a secure scoped cookie',()=>{expect(()=>assertSameOrigin(req('/auth/login','POST',{},undefined,'https://evil.example'),env)).toThrow();const cookie=sessionCookie('abc');expect(cookie).toContain('HttpOnly');expect(cookie).toContain('Secure');expect(cookie).toContain('SameSite=Strict');expect(cookie).toContain('Path=/petete');});
 it('requires bootstrap secret and permits initialization only once',async()=>{expect((await app.fetch(req('/admin/bootstrap','POST',{}),env)).status).toBe(403);await bootstrap();expect((await app.fetch(req('/admin/bootstrap','POST',{email:'second@example.com',password:'long-test-password'},undefined,undefined,'Bearer bootstrap-test'),env)).status).toBe(409);});
 it('blocks ordinary users from admin and revokes sessions when blocked',async()=>{const admin=await bootstrap();const created=await app.fetch(req('/admin/users','POST',{email:'user@example.com',name:'Test User',password:'user-long-password'},admin),env);expect(created.status).toBe(201);const {id}=await created.json() as any;const login=await app.fetch(req('/auth/login','POST',{email:'user@example.com',password:'user-long-password'}),env);expect(login.status).toBe(200);const cookie=login.headers.get('set-cookie')!.split(';')[0];expect((await app.fetch(req('/admin/users','GET',undefined,cookie),env)).status).toBe(403);expect((await app.fetch(req(`/admin/users/${id}`,'PATCH',{status:'blocked'},admin),env)).status).toBe(200);expect((await app.fetch(req('/search','GET',undefined,cookie),env)).status).toBe(401);});
 it('retains one active administrator and limits concurrent sessions',async()=>{const cookie=await bootstrap();const user=sqlite.prepare('SELECT id FROM users').get()!;expect((await app.fetch(req(`/admin/users/${user.id}`,'PATCH',{status:'blocked'},cookie),env)).status).toBe(409);for(let i=0;i<4;i++)expect((await app.fetch(req('/auth/login','POST',{email:'admin@example.com',password:'long-test-password'}),env)).status).toBe(200);expect((sqlite.prepare('SELECT count(*) AS count FROM sessions WHERE revoked_at IS NULL').get()!).count).toBe(3);});
 it('rejects oversized import bodies before parsing',async()=>{const cookie=await bootstrap();const response=await app.fetch(req('/admin/import','POST',{documents:[],padding:'x'.repeat(2_000_001)},cookie),env);expect(response.status).toBe(413);});
});

describe('retrieval integrity',()=>{
 const add=(id:string,date:string,text='arrendamiento inmueble IVA')=>sqlite.prepare('INSERT INTO rulings (id,source,reference,date,title,text,source_url,indexed_at) VALUES (?,\'dgt\',?,?,\'IVA alquiler\',?,\'https://petete.tributos.hacienda.gob.es/consultas/?num_consulta=V0001-25\',?)').run(id,id,date,text,new Date().toISOString());
 it('paginates the complete lexical chronology beyond 500 documents',async()=>{for(let i=0;i<510;i++)add(`V${i.toString().padStart(4,'0')}-25`,i===509?'1997-01-01':'2025-01-01');const options=searchOptions(new URL(`${url}/search?q=IVA&sort=date_asc&limit=10&mode=keyword`));const result=await search(env.DB!,env,options);expect(result.total).toBe(510);expect(result.total_is_exact).toBe(true);expect(result.results[0].date).toBe('1997-01-01');expect(result.has_more).toBe(true);});
 it('maps semantic chunks to rulings and deduplicates chunk matches',async()=>{add('V0001-25','2025-01-01');sqlite.prepare('INSERT INTO ruling_chunks(id,ruling_id,ordinal,text) VALUES (\'chunk1\',\'V0001-25\',0,\'a\'),(\'chunk2\',\'V0001-25\',1,\'b\')').run();const semanticEnv={...env,AI:{async run(){return {data:[Array(1024).fill(0.1)]};}},VECTORIZE:{async query(){return {matches:[{id:'chunk1',score:0.9},{id:'chunk2',score:0.8}]};},async upsert(){}}};const result=await search(env.DB!,semanticEnv,searchOptions(new URL(`${url}/search?q=concepto`)));expect(result.mode).toBe('hybrid');expect(result.results).toHaveLength(1);expect(result.results[0].reference).toBe('V0001-25');expect(result.total_is_exact).toBe(false);});
 it('filters vectors before topK and excludes stale cross-source metadata from results',async()=>{
  add('target','2025-01-31','residencia fiscal');
  add('wrong-source','2025-01-15','residencia fiscal');
  sqlite.prepare('UPDATE rulings SET tax=\'IVA\'').run();
  sqlite.prepare('UPDATE rulings SET source=\'cendoj\' WHERE id=\'wrong-source\'').run();
  sqlite.prepare('INSERT INTO ruling_chunks(id,ruling_id,ordinal,text) VALUES (\'target-chunk\',\'target\',0,\'target\'),(\'stale-chunk\',\'wrong-source\',0,\'stale\')').run();
  let calledOptions:VectorizeQueryOptions | undefined;
  const semanticEnv:Env={...env,AI:{async run(){return {data:[Array(1024).fill(0.1)]};}},VECTORIZE:{async query(_vector,options){calledOptions=options;return {matches:[{id:'stale-chunk',score:0.99},{id:'target-chunk',score:0.95}]};},async upsert(){}}};
  const result=await search(env.DB!,semanticEnv,searchOptions(new URL(`${url}/search?q=concepto&source=dgt&tax=IVA&from=2025-01-01&to=2025-01-31`)));
  expect(calledOptions).toEqual({topK:50,returnMetadata:'none',filter:{source:{$eq:'dgt'},tax:{$eq:'IVA'},date_epoch:{$gte:1735689600,$lte:1738281600}}});
  expect(result.results.map(r=>r.id)).toEqual(['target']);
  expect(result.total_is_exact).toBe(false);
  expect(result.result_scope).toBe('ranked_candidates');
 });
 it('omits empty Vectorize filters and supports either inclusive date bound',()=>{
  expect(semanticFilter(searchOptions(new URL(`${url}/search?q=x`)))).toBeUndefined();
  expect(semanticFilter(searchOptions(new URL(`${url}/search?q=x&source=cendoj&from=2025-01-01`)))).toEqual({source:{$eq:'cendoj'},date_epoch:{$gte:1735689600}});
  expect(semanticFilter(searchOptions(new URL(`${url}/search?q=x&to=2025-01-31`)))).toEqual({date_epoch:{$lte:1738281600}});
 });
 it('falls back explicitly to lexical search for invalid embedding dimensions',async()=>{
  add('fallback','2025-01-01');
  let vectorQueries=0;
  const semanticEnv:Env={...env,AI:{async run(){return {data:[[1,2,3]]};}},VECTORIZE:{async query(){vectorQueries++;return {matches:[]};},async upsert(){}}};
  const result=await search(env.DB!,semanticEnv,searchOptions(new URL(`${url}/search?q=IVA`)));
  expect(vectorQueries).toBe(0);expect(result.mode).toBe('keyword');expect(result.semantic_available).toBe(false);expect(result.result_scope).toBe('lexical_index');expect(result.warning).toContain('no está disponible');
 });
 it('does not permit untrusted citation URLs or formula execution in export cells',()=>{expect(trustedSourceUrl('https://petete.tributos.hacienda.gob.es/consultas/?num_consulta=V0001-25','dgt')).toBe(true);expect(trustedSourceUrl('https://petete.tributos.hacienda.gob.es.evil.test/','dgt')).toBe(false);expect(trustedSourceUrl('javascript:alert(1)','dgt')).toBe(false);expect(safeExcelCell(' =HYPERLINK("evil")')).toBe('\' =HYPERLINK("evil")');expect(safeExcelCell('V0001-25')).toBe('V0001-25');});
 it('sanitizes FTS syntax and rejects invalid filters',()=>{expect(ftsQuery('" OR * NEAR(foo)')).not.toContain('*');expect(()=>searchOptions(new URL(`${url}/search?sort=DROP%20TABLE`))).toThrow();expect(()=>searchOptions(new URL(`${url}/search?from=2026-02-31`))).toThrow();expect(()=>searchOptions(new URL(`${url}/search?from=2025-02-01&to=2024-01-01`))).toThrow();});
});
