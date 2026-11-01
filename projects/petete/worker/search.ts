import { Database, Env, HttpError, Ruling, VectorizeMetadataFilter } from './types';

export interface SearchOptions { q: string; source: string; tax: string; from: string; to: string; sort: string; page: number; limit: number; mode: string; }
const validDate = (value: string) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
export function searchOptions(url: URL): SearchOptions { const p = url.searchParams; const q = (p.get('q') || '').trim(); const source = p.get('source') || ''; const tax = p.get('tax') || ''; const from = p.get('from') || ''; const to = p.get('to') || ''; const sort = p.get('sort') || 'relevance'; const mode = p.get('mode') || 'hybrid'; const page = Number(p.get('page') || 1); const limit = Number(p.get('limit') || 20); if (q.length > 2000 || tax.length > 80 || !['','dgt','cendoj'].includes(source) || !['relevance','date_asc','date_desc'].includes(sort) || !['hybrid','keyword'].includes(mode) || !Number.isInteger(page) || page < 1 || page > 1000 || !Number.isInteger(limit) || limit < 1 || limit > 100 || !validDate(from) || !validDate(to) || from && to && from > to) throw new HttpError(400, 'Filtros de búsqueda no válidos.'); return { q, source, tax, from, to, sort, mode, page, limit }; }
export function ftsQuery(q: string): string { return (q.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) || []).slice(0, 40).map(t => `"${t.replace(/"/g, '""')}"`).join(' OR '); }
export function semanticFilter(options: SearchOptions): VectorizeMetadataFilter | undefined {
  const filter: VectorizeMetadataFilter = {};
  if (options.source === 'dgt' || options.source === 'cendoj') filter.source = { $eq: options.source };
  if (options.tax) filter.tax = { $eq: options.tax };
  if (options.from || options.to) {
    filter.date_epoch = {};
    if (options.from) filter.date_epoch.$gte = Date.parse(`${options.from}T00:00:00Z`) / 1000;
    if (options.to) filter.date_epoch.$lte = Date.parse(`${options.to}T00:00:00Z`) / 1000;
  }
  return Object.keys(filter).length ? filter : undefined;
}
export function trustedSourceUrl(value: string, source: string): boolean { try { const u = new URL(value); if (u.protocol !== 'https:' || u.username || u.password) return false; const host = u.hostname.toLowerCase(); if (source === 'dgt') return host==='hacienda.gob.es'||host.endsWith('.hacienda.gob.es')||host==='petete.minhafp.gob.es'||host==='atriga.gal'||host.endsWith('.atriga.gal'); if (source === 'cendoj') return host==='poderjudicial.es'||host.endsWith('.poderjudicial.es'); return false; } catch { return false; } }
function whereClause(options: SearchOptions, alias = 'r') { const where: string[] = []; const values: unknown[] = []; if (options.source) { where.push(`${alias}.source=?`); values.push(options.source); } if (options.tax) { where.push(`${alias}.tax=?`); values.push(options.tax); } if (options.from) { where.push(`${alias}.date>=?`); values.push(options.from); } if (options.to) { where.push(`${alias}.date<=?`); values.push(options.to); } return { where, values }; }
export function rulingView(row: Ruling, full = false) { return { id: row.id, source: row.source, reference: row.reference, date: row.date, title: row.title, summary: row.summary, summary_status: row.summary_status, source_url: trustedSourceUrl(row.source_url, row.source) ? row.source_url : null, tax: row.tax, topics: (() => { try { return JSON.parse(row.topics || '[]'); } catch { return []; } })(), binding: !!row.binding, indexed_at: row.indexed_at, ...(full ? { text: row.text, content_hash: row.content_hash } : {}), ...(row.score !== undefined ? { score: row.score } : {}) }; }
export async function search(db: Database, env: Env, options: SearchOptions) {
  const { where, values } = whereClause(options); const fts = ftsQuery(options.q);
  let semanticAvailable = !!env.AI && !!env.VECTORIZE;
  const lexicalWhere = fts ? ['rulings_fts MATCH ?',...where] : where;
  const lexicalValues = fts ? [fts,...values] : values;
  const table = fts ? 'rulings_fts JOIN rulings r ON r.rowid=rulings_fts.rowid' : 'rulings r';
  const filter = lexicalWhere.length ? `WHERE ${lexicalWhere.join(' AND ')}` : '';
  const lexicalTotal = Number(await db.prepare(`SELECT count(*) AS total FROM ${table} ${filter}`).bind(...lexicalValues).first<number>('total')) || 0;
  const order = options.sort === 'date_asc' ? 'r.date ASC,r.id' : options.sort === 'date_desc' || !fts ? 'r.date DESC,r.id' : 'bm25(rulings_fts,4.0,1.0,6.0,2.0),r.id';
  const note = 'Ordenar por fecha no confirma un cambio de criterio. Compara los hechos, la norma aplicable y el texto original.';
  let warning: string | null = options.q && options.mode === 'hybrid' && !semanticAvailable ? 'Búsqueda por palabras. El índice semántico aún no está configurado.' : null;
  if (fts && options.mode === 'hybrid' && options.sort !== 'relevance') warning = 'El orden cronológico recorre todas las coincidencias por palabras del índice. Usa relevancia para combinar búsqueda semántica y palabras.';
  if (fts && options.mode === 'hybrid' && options.sort === 'relevance' && semanticAvailable) {
    try {
      const embedded = await env.AI!.run('@cf/baai/bge-m3', { text: [options.q] }); const vector = embedded.data?.[0]; if (!Array.isArray(vector) || vector.length !== 1024 || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Invalid embedding');
      // Filter before nearest-neighbor retrieval so unrelated sources or dates cannot consume topK.
      // Retain the SQL checks below for stale vector metadata and defense in depth.
      const vectorFilter = semanticFilter(options);
      const response = await env.VECTORIZE!.query(vector, { topK: 50, returnMetadata: 'none', ...(vectorFilter ? { filter: vectorFilter } : {}) });
      const candidates = (await db.prepare(`SELECT r.* FROM ${table} ${filter} ORDER BY ${order} LIMIT 500`).bind(...lexicalValues).all<Ruling>()).results;
      const ranked = new Map<string,Ruling>(); candidates.forEach((row,i) => ranked.set(row.id,{...row,score:1/(60+i+1)}));
      const ids = response.matches.map(m=>m.id); const seen = new Set<string>();
      if (ids.length) {
        const vectorRows = (await db.prepare(`SELECT r.*,c.id AS chunk_id FROM ruling_chunks c JOIN rulings r ON r.id=c.ruling_id WHERE c.id IN (${ids.map(()=>'?').join(',')})${where.length ? ` AND ${where.join(' AND ')}` : ''}`).bind(...ids,...values).all<Ruling & {chunk_id:string}>()).results;
        const found = new Map(vectorRows.map(r=>[r.chunk_id,r]));
        response.matches.forEach((match,i)=>{ const row=found.get(match.id); if(row && !seen.has(row.id)) { seen.add(row.id); ranked.set(row.id,{...row,score:(ranked.get(row.id)?.score || 0)+1/(60+i+1)}); } });
      }
      const merged=[...ranked.values()].sort((a,b)=>(b.score || 0)-(a.score || 0)||b.date.localeCompare(a.date));
      const total=merged.length; const rows=merged.slice((options.page-1)*options.limit,options.page*options.limit);
      return { results:rows.map(r=>rulingView(r)),total,total_is_exact:false,lexical_total:lexicalTotal,result_scope:'ranked_candidates',truncated:lexicalTotal>500||response.matches.length>=50,page:options.page,limit:options.limit,has_more:options.page*options.limit<total,mode:'hybrid',semantic_available:true,warning:'Búsqueda híbrida sobre hasta 500 coincidencias por palabras y 50 fragmentos semánticos. El número mostrado es la ventana de candidatos, no un recuento exhaustivo de relevancia.',candidate_limit:550,chronology_note:note };
    } catch { semanticAvailable=false; warning='La búsqueda semántica no está disponible ahora. Se muestran todas las coincidencias por palabras del índice.'; }
  }
  const rows=(await db.prepare(`SELECT r.* FROM ${table} ${filter} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...lexicalValues,options.limit,(options.page-1)*options.limit).all<Ruling>()).results;
  return {results:rows.map(r=>rulingView(r)),total:lexicalTotal,total_is_exact:true,lexical_total:lexicalTotal,result_scope:'lexical_index',truncated:false,page:options.page,limit:options.limit,has_more:options.page*options.limit<lexicalTotal,mode:'keyword',semantic_available:semanticAvailable,warning,candidate_limit:null,chronology_note:note};
}
export async function coverage(db?: Database) { if (!db) return { configured: false, indexed: 0, complete: false, target_from: '1997-01-01', earliest: null, latest: null, ai_summaries: 0, pending_summaries: 0, semantic_available: false, sources: [], note: 'Demostración documental. La base completa todavía no se ha importado.' }; const row = await db.prepare('SELECT count(*) AS indexed,min(date) AS earliest,max(date) AS latest,sum(CASE WHEN summary_status=\'ai\' THEN 1 ELSE 0 END) AS ai_summaries,sum(CASE WHEN summary_status=\'pending\' THEN 1 ELSE 0 END) AS pending_summaries FROM rulings').first<Record<string,unknown>>(); const sources = await db.prepare('SELECT source,count(*) AS indexed,min(date) AS earliest,max(date) AS latest FROM rulings GROUP BY source').all(); const lastUpdate = await db.prepare('SELECT value,updated_at FROM ingestion_state WHERE key=\'last_success\'').first(); return { configured:true,...row,complete:false,target_from:'1997-01-01',sources:sources.results,last_update:lastUpdate,note:'El número de documentos importados no acredita cobertura exhaustiva. Consulta los trabajos de importación y sus incidencias.' }; }
export function safeExcelCell(value: unknown): string { const text=String(value ?? ''); return /^[\s]*[=+@-]/.test(text) ? `'${text}` : text; }
