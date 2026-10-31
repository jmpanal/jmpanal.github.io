import { parseHTML } from 'linkedom';

export const DGT_ROOT = 'https://petete.tributos.hacienda.gob.es/consultas/';
export interface DgtResultPage { query: string; order: string; page: number; totalPages: number; total: number; documentIds: string[]; }
export interface DgtDocument { source: 'dgt'; reference: string; date: string; title: string; text: string; source_url: string; tax: string; binding: number; provenance: Record<string, unknown>; }
function clean(value: string | null | undefined) { return (value ?? '').replace(/\s+/g, ' ').trim(); }
function field(document: any, key: string): string {
 const cell = document.querySelector(`tr.${key} td.value`);
 if (!cell) return '';
 const parts:string[]=[];
 const blocks=new Set(['P','DIV','TR','LI','UL','OL','TABLE','BLOCKQUOTE','H1','H2','H3','H4','SECTION']);
 const walk=(node:any)=>{
  if(node.nodeType===3){const value=clean(node.textContent);if(value)parts.push(value+' ');return;}
  if(['SCRIPT','STYLE','NOSCRIPT'].includes(node.nodeName))return;
  if(node.nodeName==='BR'){parts.push('\n');return;}
  if(blocks.has(node.nodeName))parts.push('\n\n');
  for(const child of Array.from(node.childNodes||[]))walk(child);
  if(blocks.has(node.nodeName))parts.push('\n\n');
 };
 walk(cell);
 return parts.join('').replace(/[ \t]+\n/g,'\n').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}
export function parseSearchPage(html: string, tab: 1 | 2): DgtResultPage {
 const { document } = parseHTML(html);
 const totalMatch = html.match(/updateNumResults\(\s*["']([12])["']\s*,\s*["']([\d.,]+)["']\s*\)/);
 const query = document.querySelector('input#query')?.getAttribute('value') ?? '';
 const ids = Array.from(document.querySelectorAll('td[id^="doc_"]')).map(x => x.id.replace('doc_', '')).filter(x => /^\d+$/.test(x));
 if (!totalMatch || Number(totalMatch[1]) !== tab) throw new Error('DGT search markup changed or incomplete: missing result count.');
 const total = Number(totalMatch[2].replace(/[.,]/g, ''));
 if (!Number.isSafeInteger(total) || total < 0) throw new Error('DGT invalid result count.');
 if (total === 0 && ids.length) throw new Error('DGT inconsistent empty response.');
 if (total > 0 && (!query || !ids.length)) throw new Error('DGT nonempty search missing query or document IDs.');
 const paginationText=clean(document.querySelector('#total_pages')?.textContent);
 if(total>ids.length&&!paginationText)throw new Error('DGT nonempty multipage search missing pagination.');
 const totalPages = Number(paginationText || (total === 0 ? '0' : '1'));
 const page = Number(document.querySelector('#current_page')?.getAttribute('value') || '1');
 if (!Number.isInteger(totalPages) || totalPages < 0 || !Number.isInteger(page) || page < 1) throw new Error('DGT invalid pagination.');
 return { query, order: document.querySelector('#order')?.getAttribute('value') || 'FECHA-SALIDA|0', page, totalPages, total, documentIds: [...new Set(ids)] };
}
export function parseDgtDocument(html: string, tab: 1 | 2): DgtDocument {
 const { document } = parseHTML(html);
 const reference = field(document, 'NUM-CONSULTA');
 const rawDate = field(document, 'FECHA-SALIDA');
 const match = rawDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
 const facts = field(document, 'DESCRIPCION-HECHOS');
 const question = field(document, 'CUESTION-PLANTEADA');
 const answer = field(document, 'CONTESTACION-COMPL');
 if (!/^(?:V)?\d{4,6}-\d{2}$/.test(reference) || !match || !answer) throw new Error('DGT document markup changed or incomplete: missing reference, date or answer.');
 const date = `${match[3]}-${match[2]}-${match[1]}`;
 if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('DGT invalid document date.');
 const organ = field(document, 'ORGANO');
 const legislation = field(document, 'NORMATIVA');
 const text = [['Órgano',organ],['Normativa',legislation],['Descripción de hechos',facts],['Cuestión planteada',question],['Contestación completa',answer]].filter(([,v]) => v).map(([k,v]) => `${k}\n${v}`).join('\n\n');
 let tax = /\bIVA\b|valor a[nñ]adido/i.test(`${organ} ${legislation}`) ? 'IVA' : /\bIRPF\b|renta.*personas f[ií]sicas/i.test(`${organ} ${legislation}`) ? 'IRPF' : /\bLIS\b|\bTRLIS\b|sociedades|personas jur[ií]dicas/i.test(`${organ} ${legislation}`) ? 'IS' : /sucesiones|donaciones|\bISD\b/i.test(`${organ} ${legislation}`) ? 'ISD' : /transmisiones patrimoniales|\bITP\b/i.test(`${organ} ${legislation}`) ? 'ITP-AJD' : 'Otros';
 return { source: 'dgt', reference, date, title: clean(question || facts).slice(0, 220), text, source_url: `${DGT_ROOT}?num_consulta=${encodeURIComponent(reference)}`, tax, binding: tab === 2 ? 1 : 0, provenance: { publisher: 'Dirección General de Tributos', retrievedAt: new Date().toISOString(), endpoint: 'consultas/do/document', fullText: true, legislation, organ } };
}
function spanishDate(iso: string) { return `${iso.slice(8,10)}/${iso.slice(5,7)}/${iso.slice(0,4)}`; }
export class DgtClient {
 private cookies = new Map<string, string>();
 private lastRequest = 0;
 private initialized = false;
 constructor(private requestFetch: typeof fetch = fetch, private intervalMs = 1200) {}
 private async request(path: string, body?: URLSearchParams): Promise<string> {
  const pause = this.intervalMs - (Date.now() - this.lastRequest);
  if (pause > 0) await new Promise(r => setTimeout(r, pause));
  const headers = new Headers({ 'Accept': 'text/html', 'User-Agent': 'PeteteResearch/1.0 (tax research; serial low-rate retrieval)', 'Referer': DGT_ROOT, 'X-Requested-With': 'XMLHttpRequest' });
  if (this.cookies.size) headers.set('Cookie', [...this.cookies].map(([k,v]) => `${k}=${v}`).join('; '));
  if (body) headers.set('Content-Type','application/x-www-form-urlencoded; charset=UTF-8');
  this.lastRequest = Date.now();
  const response = await this.requestFetch(new URL(path, DGT_ROOT), { method: body ? 'POST' : 'GET', headers, body, signal: AbortSignal.timeout(30000), redirect: 'error' });
  const rawCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') || ''];
  for (const cookie of rawCookies) { const pair = cookie.split(';',1)[0]; const equal = pair.indexOf('='); if (equal > 0) this.cookies.set(pair.slice(0,equal).trim(),pair.slice(equal+1)); }
  if (!response.ok) throw new Error(`DGT HTTP ${response.status} at ${path}; stopped, no documents assumed missing.`);
  const html = await response.text();
  if (html.length > 5_000_000) throw new Error('DGT response exceeds safety limit.');
  return html;
 }
 async init() { if (!this.initialized) { await this.request(''); await this.request('do/form'); this.initialized = true; } }
 async search(from: string, to: string, tab: 1 | 2, page = 1, query?: string, order?: string): Promise<DgtResultPage> {
  await this.init();
  const body = query ? new URLSearchParams({ query, order: order || 'FECHA-SALIDA|0' }) : new URLSearchParams({ type1:'on', type2:'on', NMCMP_1:'NUM-CONSULTA', VLCMP_1:'', OPCMP_1:'.Y', NMCMP_2:'FECHA-SALIDA', VLCMP_2:`${spanishDate(from)}..${spanishDate(to)}`, OPCMP_2:'.Y', cmpOrder:'FECHA-SALIDA',dirOrder:'0' });
  body.set('tab',String(tab)); body.set('page',String(page));
  return parseSearchPage(await this.request('do/search',body),tab);
 }
 async document(id: string, tab: 1 | 2, query: string): Promise<DgtDocument> {
  if (!/^\d+$/.test(id)) throw new Error('DGT document ID must come from search results.');
  await this.init();
  return parseDgtDocument(await this.request('do/document',new URLSearchParams({query, doc:id, tab:String(tab)})),tab);
 }
}
