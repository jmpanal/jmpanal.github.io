import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../worker/index';
import type { Database, Env, Statement } from '../worker/types';
import { importDocuments, enqueueBackfill, scheduled, enrichPending, cleanupVectors } from '../worker/ingestion';
import { DgtClient } from '../worker/dgt';
import { search, searchOptions } from '../worker/search';

// Exercise the complete Worker routes with SQLite's real FTS5, triggers and SQL.
// This adapter mirrors D1's async interface; Wrangler smoke tests additionally
// cover the Cloudflare runtime and asset bindings.
class SqliteD1 implements Database {
  sqlite = new DatabaseSync(':memory:');
  constructor() {
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(directory).filter(n => n.endsWith('.sql')).sort()) this.sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  }
  prepare(sql: string): Statement {
    let values: any[] = [];
    const statement = this.sqlite.prepare(sql);
    const result: Statement = {
      bind(...next: unknown[]) { values = next; return result; },
      async first<T>(column?: string): Promise<T | null> { const row = statement.get(...values) as any; return row ? column ? row[column] : row : null; },
      async all<T>() { return { results: statement.all(...values) as T[], success: true }; },
      async run() { const r = statement.run(...values); return { results: [], success: true, meta: { changes: Number(r.changes) } }; },
    };
    return result;
  }
  async exec(sql: string) { this.sqlite.exec(sql); }
  async batch(statements: Statement[]) {
    this.sqlite.exec('BEGIN');
    try { const results = []; for (const s of statements) results.push(await s.run()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
}
const databases: SqliteD1[] = [];
function setup() {
  const db = new SqliteD1(); databases.push(db);
  const env: Env = { DB: db, APP_ORIGIN: 'https://www.jmpanal.com', ADMIN_BOOTSTRAP_TOKEN: 'test-bootstrap-token', SESSION_PEPPER: 'test-private-pepper' };
  return { db, env };
}
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.sqlite.close(); });
function request(path: string, method = 'GET', body?: any, cookie?: string, origin = 'https://www.jmpanal.com') {
  const headers = new Headers({ Origin: origin });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (cookie) headers.set('Cookie', cookie);
  if (path === '/admin/bootstrap') headers.set('Authorization', 'Bearer test-bootstrap-token');
  return new Request(`https://www.jmpanal.com/petete/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function bootstrap(env: Env) {
  const response = await worker.fetch(request('/admin/bootstrap', 'POST', { email: 'admin@example.com', name: 'Admin', password: 'a-long-test-password' }), env);
  expect(response.status).toBe(201);
  const login = await worker.fetch(request('/auth/login', 'POST', { email: 'admin@example.com', password: 'a-long-test-password' }), env);
  expect(login.status).toBe(200);
  return login.headers.get('set-cookie')!;
}
const document = (reference = 'V0001-26') => ({ source: 'dgt' as const, reference, date: '2026-01-15', title: 'Arrendamiento de vivienda e IVA', text: 'La consulta examina la exención del IVA en el arrendamiento de una vivienda sin servicios hoteleros.', source_url: `https://petete.tributos.hacienda.gob.es/consultas/?num_consulta=${reference}`, tax: 'IVA', binding: 1 });

describe('Worker integration: authentication, access and assets', () => {
  it('bootstraps once, stores a password hash, and enforces role and origin checks', async () => {
    const { db, env } = setup();
    const cookie = await bootstrap(env);
    expect(cookie).toContain('HttpOnly; Secure; SameSite=Strict');
    expect(cookie).toContain('Path=/petete');
    const stored = db.sqlite.prepare('SELECT password_hash FROM users').get() as any;
    expect(stored.password_hash).toMatch(/^pbkdf2-sha256\$/);
    expect(stored.password_hash).not.toContain('a-long-test-password');
    const second = await worker.fetch(request('/admin/bootstrap', 'POST', { email: 'x@example.com', password: 'another-long-password' }), env);
    expect(second.status).toBe(409);
    expect((await worker.fetch(request('/admin/users'), env)).status).toBe(401);
    expect((await worker.fetch(request('/admin/users', 'POST', { email: 'user@example.com', name: 'User', password: 'another-long-password' }, cookie, 'https://evil.example'), env)).status).toBe(403);
    const users = await worker.fetch(request('/admin/users', 'GET', undefined, cookie), env);
    expect(users.status).toBe(200);
    expect(JSON.stringify(await users.json())).not.toContain('password_hash');
  });

  it('blocks users and revokes their existing sessions immediately', async () => {
    const { env } = setup();
    const adminCookie = await bootstrap(env);
    const create = await worker.fetch(request('/admin/users', 'POST', { email: 'user@example.com', name: 'User', password: 'a-user-test-password' }, adminCookie), env);
    expect(create.status).toBe(201);
    const user = await create.json() as any;
    const login = await worker.fetch(request('/auth/login', 'POST', { email: user.email, password: 'a-user-test-password' }), env);
    const cookie = login.headers.get('set-cookie')!;
    expect((await worker.fetch(request('/admin/users', 'GET', undefined, cookie), env)).status).toBe(403);
    expect((await worker.fetch(request('/search', 'GET', undefined, cookie), env)).status).toBe(200);
    expect((await worker.fetch(request(`/admin/users/${user.id}`, 'PATCH', { status: 'blocked' }, adminCookie), env)).status).toBe(200);
    expect((await worker.fetch(request('/search', 'GET', undefined, cookie), env)).status).toBe(401);
    expect((await worker.fetch(request('/auth/login', 'POST', { email: user.email, password: 'a-user-test-password' }), env)).status).toBe(401);
  });

  it('serves the mounted app and public source-backed demo without a database', async () => {
    const seen: string[] = [];
    const sample = { ...document(), id: 'dgt-V0001-26', summary: null, summary_status: 'pending', topics: '[]', indexed_at: '2026-10-31', content_hash: '', embedding_status: 'pending' };
    const env: Env = { ASSETS: { async fetch(req) { const path = new URL(req.url).pathname; seen.push(path); return path === '/demo.json' ? Response.json([sample]) : new Response('<title>Petete</title>'); } } };
    expect((await worker.fetch(new Request('https://www.jmpanal.com/petete/'), env)).status).toBe(200);
    expect(seen).toContain('/');
    const demo = await worker.fetch(request('/demo/search?q=IVA'), env);
    const body = await demo.json() as any;
    expect(body.total).toBe(1);
    expect(body.demo).toBe(true);
    expect(body.semantic_available).toBe(false);
    const detail = await worker.fetch(request(`/demo/rulings/${sample.id}`), env);
    expect(detail.status).toBe(200);
    expect((await detail.json() as any).text).toContain('exención');
    expect((await worker.fetch(request('/auth/login', 'POST', { email: 'x@example.com', password: 'anything' }), env)).status).toBe(503);
  });
});

describe('Worker integration: ingestion, exact search and semantic mapping', () => {
  it('accepts full documents above the normal form limit and exports source-backed XLSX', async () => {
    const { env } = setup();
    const cookie = await bootstrap(env);
    const text = document().text.repeat(500);
    const response = await worker.fetch(request('/admin/import', 'POST', { documents: [{ ...document(), text }] }, cookie), env);
    expect(response.status).toBe(202);
    const results = await worker.fetch(request('/search?q=IVA', 'GET', undefined, cookie), env);
    expect((await results.json() as any).results[0].reference).toBe('V0001-26');
    const excel = await worker.fetch(request('/export?q=IVA', 'GET', undefined, cookie), env);
    expect(excel.status).toBe(200);
    expect(excel.headers.get('content-type')).toContain('spreadsheetml');
    const XLSX = await import('xlsx');
    const book = XLSX.read(await excel.arrayBuffer(), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(book.Sheets.Consultas) as any[];
    expect(rows[0]['Referencia']).toBe('V0001-26');
    expect(rows[0]['Enlace oficial']).toContain('petete.tributos.hacienda.gob.es');
  });

  it('protects the final active administrator in the database itself', async () => {
    const { db, env } = setup();
    await bootstrap(env);
    expect(() => db.sqlite.exec("UPDATE users SET status='blocked' WHERE role='admin'")).toThrow('last_active_admin');
    expect(() => db.sqlite.exec("DELETE FROM users WHERE role='admin'")).toThrow('last_active_admin');
    expect((db.sqlite.prepare("SELECT count(*) n FROM users WHERE role='admin' AND status='active'").get() as any).n).toBe(1);
  });

  it('imports complete documents idempotently, updates FTS, and refuses unlicensed CENDOJ before writing', async () => {
    const { db, env } = setup();
    expect(await importDocuments(env, [document()])).toEqual({ inserted: 1, unchanged: 0 });
    expect(await importDocuments(env, [document()])).toEqual({ inserted: 0, unchanged: 1 });
    expect((await search(db, env, searchOptions(new URL('https://test?q=hotelero&mode=keyword')))).total).toBe(0);
    await importDocuments(env, [{ ...document(), text: 'Un establecimiento hotelero dispone de servicios de limpieza diaria, recepción y restauración sujetos a IVA.' }]);
    expect((await search(db, env, searchOptions(new URL('https://test?q=hotelero&mode=keyword')))).total).toBe(1);
    const cendoj = { ...document('ECLI:ES:TS:2026:1'), source: 'cendoj' as const, source_url: 'https://www.poderjudicial.es/search/AN/openDocument/example' };
    await expect(importDocuments(env, [cendoj])).rejects.toMatchObject({ status: 400 });
    expect((db.sqlite.prepare('SELECT count(*) n FROM rulings').get() as any).n).toBe(1);
  });

  it('paginates all lexical date matches beyond 500 rather than silently dropping old rulings', async () => {
    const { db, env } = setup();
    const insert = db.sqlite.prepare("INSERT INTO rulings(id,source,reference,date,title,text,source_url,tax,indexed_at) VALUES(?,'dgt',?,?,?,'IVA',?,'IVA','2026-10-31')");
    for (let i = 0; i < 505; i++) insert.run(`r${i}`, `V${String(i).padStart(4, '0')}-26`, i === 504 ? '1997-01-01' : '2026-01-01', 'Arrendamiento vivienda IVA', document().source_url);
    const options = searchOptions(new URL('https://test?q=IVA&sort=date_asc&mode=keyword&limit=10'));
    const result = await search(db, env, options);
    expect(result.total).toBe(505);
    expect(result.total_is_exact).toBe(true);
    expect(result.results[0].date).toBe('1997-01-01');
    expect((await search(db, env, { ...options, page: 51 })).results).toHaveLength(5);
  });

  it('maps semantic chunk hits back to unique ruling IDs even with no lexical match', async () => {
    const { db, env } = setup();
    await importDocuments(env, [document()]);
    const chunks = db.sqlite.prepare('SELECT id FROM ruling_chunks').all() as any[];
    env.AI = { async run() { return { data: [Array(1024).fill(0.1)] }; } };
    env.VECTORIZE = { async query() { return { matches: chunks.map(c => ({ id: c.id, score: 0.8 })) }; }, async upsert() { } };
    const result = await search(db, env, searchOptions(new URL('https://test?q=impuesto-indirecto&mode=hybrid')));
    expect(result.mode).toBe('hybrid');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].reference).toBe('V0001-26');
    expect(result.total_is_exact).toBe(false);
    expect(result.warning).toContain('no un recuento exhaustivo');
  });

  it('publishes source, tax and UTC date metadata with every chunk embedding', async () => {
    const { db, env } = setup();
    await importDocuments(env, [document()]);
    const published: any[] = [];
    env.AI = { async run(model: string) { return model.includes('bge-m3') ? {data:[Array(1024).fill(0.1)]} : {response:'La consulta examina el IVA del arrendamiento.'}; } };
    env.VECTORIZE = { async query() { return {matches:[]}; }, async upsert(vectors: any[]) { published.push(...vectors); } };
    await enrichPending(env, 2);
    expect(published).toHaveLength(1);
    expect(published[0].metadata).toMatchObject({source:'dgt',tax:document().tax,date_epoch:Date.parse(document().date+'T00:00:00Z')/1000});
  });

  it('backs off failed AI calls so a bad chunk cannot starve other documents', async () => {
    const { db, env } = setup();
    await importDocuments(env, [document('V0001-26'), document('V0002-26')]);
    let calls = 0;
    env.AI = { async run() { calls++; if (calls === 1) throw new Error('provider temporarily unavailable'); return { response: 'La consulta examina el IVA del arrendamiento de viviendas.' }; } };
    const failed = await enrichPending(env, 1);
    expect(failed.calls).toBe(1);
    const first = db.sqlite.prepare("SELECT attempts,retry_at FROM ruling_chunks WHERE ruling_id='dgt-V0001-26'").get() as any;
    expect(first.attempts).toBe(1);
    expect(Date.parse(first.retry_at)).toBeGreaterThan(Date.now());
    await enrichPending(env, 1);
    const second = db.sqlite.prepare("SELECT summary FROM ruling_chunks WHERE ruling_id='dgt-V0002-26'").get() as any;
    expect(second.summary).toContain('arrendamiento');
    expect(calls).toBe(2);
  });

  it('durably removes obsolete chunk vectors after a source document changes', async () => {
    const { db, env } = setup();
    await importDocuments(env, [document()]);
    const oldId = (db.sqlite.prepare('SELECT id FROM ruling_chunks').get() as any).id;
    await importDocuments(env, [{ ...document(), text: document().text + ' Se añade una aclaración posterior.' }]);
    expect((db.sqlite.prepare('SELECT id FROM vector_cleanup').get() as any).id).toBe(oldId);
    const removed: string[] = [];
    env.VECTORIZE = { async query() { return { matches: [] }; }, async upsert() { }, async deleteByIds(ids: string[]) { removed.push(...ids); } } as any;
    await cleanupVectors(env);
    expect(removed).toEqual([oldId]);
    expect((db.sqlite.prepare('SELECT count(*) n FROM vector_cleanup').get() as any).n).toBe(0);
  });

  it('runs the configured monthly cron and prioritizes new rulings ahead of historical backfill', async () => {
    const { db, env } = setup();
    await enqueueBackfill(env, '1997-01-01', '1997-01-31');
    db.sqlite.exec("UPDATE jobs SET created_at='2000-01-01T00:00:00Z'");
    const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
    const monthly = config.triggers.crons.find((cron: string) => /^0 \d+ 1 \* \*$/.test(cron));
    expect(monthly).toBeTruthy();
    vi.spyOn(DgtClient.prototype, 'search').mockResolvedValue({ query: '', order: '', page: 1, total: 0, totalPages: 0, documentIds: [] });
    await scheduled({ cron: monthly, scheduledTime: Date.parse('2026-10-01T06:00:00Z') }, env);
    const jobs = db.sqlite.prepare('SELECT id,status FROM jobs').all() as any[];
    const monthlyJobs = jobs.filter(j => j.id.includes('monthly-2026-10'));
    expect(monthlyJobs).toHaveLength(6);
    expect(monthlyJobs.some(j => j.status === 'completed')).toBe(true);
    expect(jobs.filter(j => j.id.includes('backfill')).every(j => j.status === 'queued')).toBe(true);
  });

  it('enqueues the historical archive in both DGT collections and remains idempotent', async () => {
    const { db, env } = setup();
    expect((await enqueueBackfill(env, '1997-01-15', '1997-02-10')).enqueued).toBe(4);
    expect((await enqueueBackfill(env, '1997-01-15', '1997-02-10')).enqueued).toBe(0);
    const jobs = db.sqlite.prepare('SELECT from_date,to_date,cursor FROM jobs ORDER BY from_date,cursor').all() as any[];
    expect(jobs[0].from_date).toBe('1997-01-15');
    expect(jobs[0].to_date).toBe('1997-01-31');
    expect(new Set(jobs.map(j => JSON.parse(j.cursor).tab))).toEqual(new Set([1, 2]));
  });
});
