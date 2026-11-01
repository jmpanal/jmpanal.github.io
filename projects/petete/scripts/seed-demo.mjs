import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const quote=value=>value===null?'NULL':"'"+String(value??'').replaceAll("'","''")+"'";
const hash=value=>createHash('sha256').update(value).digest('hex');

// Keep deployment seed boundaries compatible with ingestion.chunkText.
// Integration tests compare this output to authenticated document imports.
function chunks(text,size=5000,overlap=350) {
 const output=[];
 for(let start=0;start<text.length;) {
  let end=Math.min(start+size,text.length);
  if(end<text.length) {const boundary=text.lastIndexOf(' ',end);if(boundary>start+size*0.7)end=boundary;}
  output.push(text.slice(start,end));
  if(end===text.length)break;
  start=end-overlap;
 }
 return output;
}

export function buildSeedSql(data,{production=false,stamp=new Date().toISOString()}={}) {
 if(!Array.isArray(data)||!data.length)throw new Error('Verified seed corpus missing.');
 return data.map(row=>{
  const text=row.text||row.full_text;
  if(!/^V?\d{4,6}-\d{2}$/.test(row.reference)||typeof text!=='string'||text.length<40)throw new Error('Incomplete official seed document.');
  const url=new URL(row.source_url);
  if(url.protocol!=='https:'||url.username||url.password||!['petete.tributos.hacienda.gob.es','petete.minhafp.gob.es','www.atriga.gal','atriga.gal'].includes(url.hostname))throw new Error('Untrusted seed source.');
  const id=`dgt-${row.reference}`,tax=row.tax||'Otros';
  const contentHash=hash([row.reference,row.date,row.title,text,row.source_url,row.tax||''].join('\n'));
  const summary=production?null:(row.summary||null);
  const summaryStatus=production||!summary?'pending':'editorial';
  const provenance=JSON.stringify({...row.provenance,publisher:'Dirección General de Tributos',seeded:true,sourceUpdatedAt:row.source_updated_at||null,fullText:true});
  const values=[id,'dgt',row.reference,row.date,row.title,text,summary,summaryStatus,row.source_url,tax,JSON.stringify(row.topics||[]),row.binding?1:0,contentHash,stamp,'pending',provenance].map(quote).join(',');
  // Never overwrite a production document with a seed. Legacy seed rows with identical
  // text can receive missing chunks without changing their hash or existing summaries.
  return `INSERT INTO rulings(id,source,reference,date,title,text,summary,summary_status,source_url,tax,topics,binding,content_hash,indexed_at,embedding_status,provenance) VALUES(${values}) ON CONFLICT(source,reference) DO NOTHING;\n`+
   `INSERT OR IGNORE INTO ruling_chunks(id,ruling_id,ordinal,text) SELECT r.id||'-c'||c.key||'-'||substr(r.content_hash,1,8),r.id,CAST(c.key AS INTEGER),c.value FROM rulings r,json_each(${quote(JSON.stringify(chunks(text)))}) c WHERE r.source='dgt' AND r.reference=${quote(row.reference)} AND r.text=${quote(text)};`;
 }).join('\n');
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const {values}=parseArgs({options:{production:{type:'boolean',default:false},output:{type:'string',default:'.tmp/demo-seed.sql'}}});
 const data=JSON.parse(await readFile(new URL('../data/seed-real.json',import.meta.url),'utf8'));
 const output=resolve(values.output);
 await mkdir(dirname(output),{recursive:true});
 await writeFile(output,buildSeedSql(data,{production:values.production}));
 console.log(`Prepared ${data.length} source-verified seed documents with full-text chunks. ${values.production?'Production summaries await AI enrichment.':'Local summaries are labeled editorial.'}`);
}
