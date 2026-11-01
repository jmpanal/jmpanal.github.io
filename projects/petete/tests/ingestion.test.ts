import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DgtClient, parseDgtDocument, parseSearchPage } from '../worker/dgt';
import { chunkText, contentHash, importDocuments, monthWindows } from '../worker/ingestion';
const search=readFileSync(new URL('./fixtures/dgt-search.html',import.meta.url),'utf8');
const document=readFileSync(new URL('./fixtures/dgt-document.html',import.meta.url),'utf8');

describe('DGT official source parser',()=>{
 it('reads real search IDs, count and query rather than guessing references',()=>{
  const result=parseSearchPage(search,2);
  expect(result.documentIds).toEqual(['39047']);expect(result.total).toBe(1);expect(result.query).toContain('V2685-21');expect(result.totalPages).toBe(1);
 });
 it('preserves complete official answer and ruling metadata from a real source fixture',()=>{
  const result=parseDgtDocument(document,2);
  expect(result.reference).toBe('V2685-21');expect(result.date).toBe('2021-11-05');expect(result.binding).toBe(1);expect(result.tax).toBe('IS');
  expect(result.text.length).toBeGreaterThan(7000);expect(result.text).toContain('Contestación completa');expect(result.text).toContain('Lo que comunico a Vd.');
  expect(result.source_url).toBe('https://petete.tributos.hacienda.gob.es/consultas/?num_consulta=V2685-21');
 });
 it('retains table/list text alongside answer paragraphs',()=>{
  const mixed=document.replace('Lo que comunico a Vd.','<table><tr><td>Tabla fiscal importante</td></tr></table><ul><li>Condición material</li></ul>Lo que comunico a Vd.');
  const result=parseDgtDocument(mixed,2);expect(result.text).toContain('Tabla fiscal importante');expect(result.text).toContain('Condición material');
 });
 it('rejects missing multipage pagination instead of silently collecting only page one',()=>{
  expect(()=>parseSearchPage(search.replace('updateNumResults("2", "1")','updateNumResults("2", "100")').replace(/<span id="total_pages">1<\/span>/,''),2)).toThrow(/pagination/);
 });
 it('rejects a login/error/partial page instead of marking the archive empty',()=>{
  expect(()=>parseSearchPage('<html>Unauthorized</html>',2)).toThrow(/result count/);
  expect(()=>parseSearchPage(search.replace('value=" .EN NUM-CONSULTA (V2685-21)"','value=""'),2)).toThrow(/missing query/);
  expect(()=>parseDgtDocument('<table><tr class="NUM-CONSULTA"><td class="value">V2685-21</td></tr></table>',2)).toThrow(/incomplete/);
 });
 it('accepts the observed official no-results template, while rejecting a generic page containing those words',()=>{
  const empty=readFileSync(new URL('./fixtures/dgt-empty.html',import.meta.url),'utf8');
  expect(parseSearchPage(empty,1)).toMatchObject({total:0,totalPages:0,documentIds:[]});
  expect(()=>parseSearchPage('<html>La consulta realizada no devuelve resultados.</html>',1)).toThrow();
 });
 it('only accepts a structurally verified zero count as an empty result',()=>{
  expect(parseSearchPage('<script>updateNumResults("1","0");</script>',1).total).toBe(0);
  expect(()=>parseSearchPage('<script>updateNumResults("1","0");</script>',2)).toThrow();
 });
 it('keeps the source session cookie and uses the verified POST protocol',async()=>{
  const requests:{url:string;init:RequestInit}[]=[];
  const fakeFetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{requests.push({url:String(input),init:init||{}});if(requests.length===1)return new Response('Home',{headers:{'set-cookie':'JSESSIONID=example; HttpOnly'}});if(String(input).endsWith('/do/form'))return new Response('Form');return new Response(search);}) as typeof fetch;
  const client=new DgtClient(fakeFetch,0);await client.search('2021-11-01','2021-11-30',2);
  expect(requests).toHaveLength(3);expect(new Headers(requests[2].init.headers).get('cookie')).toContain('JSESSIONID=example');
  const params=requests[2].init.body as URLSearchParams;expect(params.get('VLCMP_2')).toBe('01/11/2021..30/11/2021');expect(params.get('tab')).toBe('2');
 });
 it('stops on a source authorization error with no invented missing documents',async()=>{
  const client=new DgtClient((async()=>new Response('Denied',{status:401})) as typeof fetch,0);
  await expect(client.search('2021-11-01','2021-11-30',2)).rejects.toThrow(/HTTP 401/);
 });
});

describe('archive ingestion integrity',()=>{
 it('covers partial months and leap days without gaps',()=>expect(monthWindows('2024-01-20','2024-03-03')).toEqual([{from:'2024-01-20',to:'2024-01-31'},{from:'2024-02-01',to:'2024-02-29'},{from:'2024-03-01',to:'2024-03-03'}]));
 it('rejects invalid dates and reversed windows',()=>{expect(()=>monthWindows('2024-02-31','2024-03-01')).toThrow();expect(()=>monthWindows('1996-12-01','1997-01-01')).toThrow();expect(()=>monthWindows('2024-03-01','2024-01-01')).toThrow();});
 it('retains every source character across overlapping embedding chunks',()=>{
  const source=Array.from({length:4500},(_,i)=>`word${i}`).join(' '),parts=chunkText(source);
  let covered=0;
  for(const part of parts){const start=source.indexOf(part,Math.max(0,covered-500));expect(start).toBeLessThanOrEqual(covered);expect(start).toBeGreaterThanOrEqual(0);covered=Math.max(covered,start+part.length);}
  expect(covered).toBe(source.length);expect(parts.length).toBeGreaterThan(4);
 });
 it('hashes source changes deterministically for idempotent imports',async()=>{expect(await contentHash('source')).toBe(await contentHash('source'));expect(await contentHash('source')).not.toBe(await contentHash('changed'));});
 it('rejects unlicensed CENDOJ import before database access',async()=>{
  await expect(importDocuments({},[{source:'cendoj',reference:'ECLI:ES:TS:2024:1',date:'2024-01-01',title:'Resolución',text:'Contenido completo oficial de la resolución de prueba.',source_url:'https://www.poderjudicial.es/search/'}])).rejects.toMatchObject({status:400});
 });
});
