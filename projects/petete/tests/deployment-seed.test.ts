import {afterEach,describe,expect,it} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {chunkText,contentHash} from '../worker/ingestion';

const {buildSeedSql}=await import(new URL('../scripts/seed-demo.mjs',import.meta.url).href);
const {parseWranglerJson,validateVectorIndex,missingMetadataIndexes}=await import(new URL('../scripts/setup-cloudflare.mjs',import.meta.url).href);
const seed=JSON.parse(readFileSync(new URL('../data/seed-real.json',import.meta.url),'utf8'));
const openDatabases:DatabaseSync[]=[];
function database() {
 const db=new DatabaseSync(':memory:');openDatabases.push(db);
 const directory=new URL('../migrations/',import.meta.url);
 for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')).sort())db.exec(readFileSync(new URL(name,directory),'utf8'));
 return db;
}
afterEach(()=>{for(const db of openDatabases.splice(0))db.close();});

describe('first production corpus activation',()=>{
 it('seeds the verified documents with pending AI summaries, complete compatible chunks and import-normalized source hashes',async()=>{
  const db=database();db.exec(buildSeedSql(seed,{production:true}));
  const rows=db.prepare('SELECT * FROM rulings').all() as any[];
  expect(rows).toHaveLength(seed.length);
  for(const row of rows) {
   const source=seed.find((s:any)=>s.reference===row.reference);
   expect(row.summary).toBeNull();expect(row.summary_status).toBe('pending');
   expect(row.content_hash).toBe(await contentHash([source.reference,source.date,source.title,source.text||source.full_text,source.source_url,source.tax||''].join('\n')));
   const chunks=db.prepare('SELECT id,text FROM ruling_chunks WHERE ruling_id=? ORDER BY ordinal').all(row.id) as any[];
   expect(chunks.map(c=>c.text)).toEqual(chunkText(row.text));
   expect(chunks[0].id).toBe(`${row.id}-c0-${row.content_hash.slice(0,8)}`);
   expect((db.prepare("SELECT count(*) n FROM rulings_fts WHERE rulings_fts MATCH ?").get(`\"${row.reference}\"`) as any).n).toBeGreaterThan(0);
  }
  const count=(db.prepare('SELECT count(*) n FROM ruling_chunks').get() as any).n;
  db.exec(buildSeedSql(seed,{production:true}));
  expect((db.prepare('SELECT count(*) n FROM ruling_chunks').get() as any).n).toBe(count);
 });

 it('preserves existing real documents and summaries when production deployment is repeated',()=>{
  const db=database();db.exec(buildSeedSql(seed,{production:true}));
  const first=seed[0],id=`dgt-${first.reference}`;
  db.prepare("UPDATE rulings SET text='Actual source text updated after initial collection',summary='Verified existing summary',summary_status='ai',content_hash='new-source-hash' WHERE id=?").run(id);
  db.prepare('DELETE FROM ruling_chunks WHERE ruling_id=?').run(id);
  db.exec(buildSeedSql(seed,{production:true}));
  const row=db.prepare('SELECT text,summary,summary_status,content_hash FROM rulings WHERE id=?').get(id) as any;
  expect(row).toMatchObject({text:'Actual source text updated after initial collection',summary:'Verified existing summary',summary_status:'ai',content_hash:'new-source-hash'});
  expect((db.prepare('SELECT count(*) n FROM ruling_chunks WHERE ruling_id=?').get(id) as any).n).toBe(0);
 });

 it('repairs missing chunks on legacy identical-text seeds without relabeling editorial summaries',()=>{
  const db=database();db.exec(buildSeedSql(seed));
  const id=`dgt-${seed[0].reference}`,oldHash='a'.repeat(64);
  db.prepare('DELETE FROM ruling_chunks WHERE ruling_id=?').run(id);
  db.prepare('UPDATE rulings SET content_hash=? WHERE id=?').run(oldHash,id);
  db.exec(buildSeedSql(seed,{production:true}));
  const row=db.prepare('SELECT summary_status,content_hash FROM rulings WHERE id=?').get(id) as any;
  expect(row.summary_status).toBe('editorial');expect(row.content_hash).toBe(oldHash);
  const chunk=db.prepare('SELECT id FROM ruling_chunks WHERE ruling_id=? ORDER BY ordinal LIMIT 1').get(id) as any;
  expect(chunk.id).toBe(`${id}-c0-${oldHash.slice(0,8)}`);
 });
});

describe('Cloudflare provisioning compatibility guards',()=>{
 it('accepts matching multilingual vector dimensions and rejects an incompatible existing index',()=>{
  expect(()=>validateVectorIndex({name:'petete-bge-m3',config:{dimensions:1024,metric:'cosine'}})).not.toThrow();
  expect(()=>validateVectorIndex({name:'petete-bge-m3',config:{dimensions:768,metric:'cosine'}})).toThrow(/1024/);
  expect(()=>validateVectorIndex({name:'petete-bge-m3',config:{dimensions:1024,metric:'dot-product'}})).toThrow(/cosine/);
 });
 it('creates only missing metadata properties and rejects incompatible property types',()=>{
  const indexes=[{propertyName:'source',indexType:'string'},{propertyName:'tax',indexType:'string'}];
  expect(missingMetadataIndexes(indexes)).toEqual([{propertyName:'date_epoch',indexType:'number'}]);
  expect(missingMetadataIndexes([...indexes,{propertyName:'date_epoch',indexType:'number'}])).toEqual([]);
  expect(()=>missingMetadataIndexes([{propertyName:'date_epoch',indexType:'string'}])).toThrow(/number/);
 });
 it('parses Wrangler JSON without mistaking a banner or color sequence for the response',()=>{
  expect(parseWranglerJson('\u001b[33m[WARNING]\u001b[0m\n[{"name":"petete"}]')).toEqual([{name:'petete'}]);
  expect(parseWranglerJson('{"name":"petete-bge-m3","config":{"dimensions":1024}}')).toMatchObject({config:{dimensions:1024}});
  expect(()=>parseWranglerJson('Unexpected non-JSON response')).toThrow(/stopped/);
 });
});
