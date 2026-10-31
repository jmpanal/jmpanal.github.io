import {readFile,writeFile,mkdir} from 'node:fs/promises';
const data=JSON.parse(await readFile(new URL('../data/seed-real.json',import.meta.url),'utf8'));
const quote=v=>"'"+String(v??'').replaceAll("'","''")+"'";
const stamp=new Date().toISOString();
const sql=data.map(r=>`INSERT INTO rulings(id,source,reference,date,title,text,summary,summary_status,source_url,tax,topics,binding,content_hash,indexed_at,embedding_status) VALUES(${[r.id,'dgt',r.reference,r.date,r.title,r.text||r.full_text,r.summary,'editorial',r.source_url,r.tax,JSON.stringify(r.topics||[]),r.binding?1:0,r.content_hash,stamp,'pending'].map(quote).join(',')}) ON CONFLICT(source,reference) DO NOTHING;`).join('\n');
await mkdir(new URL('../.tmp',import.meta.url),{recursive:true});
await writeFile(new URL('../.tmp/demo-seed.sql',import.meta.url),sql);
console.log(`Prepared ${data.length} source-verified demo rows for local development.`);
