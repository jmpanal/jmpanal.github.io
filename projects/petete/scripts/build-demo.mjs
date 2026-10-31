import {readFile,writeFile,mkdir} from 'node:fs/promises';
const seed = JSON.parse(await readFile(new URL('../data/seed-real.json',import.meta.url),'utf8'));
const rows = Array.isArray(seed) ? seed : seed.rulings;
if (!Array.isArray(rows) || !rows.length) throw new Error('Verified seed corpus missing');
for (const row of rows) {
  const u=new URL(row.source_url);
  if(u.protocol!=='https:' || !['petete.tributos.hacienda.gob.es','petete.minhafp.gob.es'].includes(u.hostname)) throw new Error('Non-official DGT seed URL');
  if(!row.reference || !row.date || !(row.text || row.full_text)) throw new Error('Incomplete seed record');
}
await mkdir(new URL('../public',import.meta.url),{recursive:true});
await writeFile(new URL('../public/demo.json',import.meta.url),JSON.stringify(rows));
console.log(`Prepared ${rows.length} verified demo records`);
