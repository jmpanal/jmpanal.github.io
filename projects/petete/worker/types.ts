export interface D1Result<T = Record<string, unknown>> { results: T[]; success?: boolean; meta?: { changes?: number; last_row_id?: number }; }
export interface Statement { bind(...values: unknown[]): Statement; first<T = Record<string, unknown>>(column?: string): Promise<T | null>; all<T = Record<string, unknown>>(): Promise<D1Result<T>>; run(): Promise<D1Result>; }
export interface Database { prepare(query: string): Statement; batch(statements: Statement[]): Promise<D1Result[]>; exec(query: string): Promise<unknown>; }
export interface VectorizeMetadataFilter {
  source?: { $eq: 'dgt' | 'cendoj' };
  tax?: { $eq: string };
  date_epoch?: { $gte?: number; $lte?: number };
}
export interface VectorizeQueryOptions { topK: number; returnMetadata?: 'none' | 'indexed' | 'all'; filter?: VectorizeMetadataFilter; }
export interface Env {
  DB?: Database;
  ASSETS?: { fetch(request: Request): Promise<Response> };
  AI?: { run(model: string, input: Record<string, unknown>): Promise<any> };
  VECTORIZE?: { query(vector: number[], options: VectorizeQueryOptions): Promise<{ matches: { id: string; score: number }[] }>; upsert(vectors: any[]): Promise<unknown> };
  ADMIN_BOOTSTRAP_TOKEN?: string;
  SESSION_PEPPER?: string;
  APP_ORIGIN?: string;
  MAX_SESSIONS?: string;
}
export interface User { id: string; email: string; name: string; role: 'admin' | 'user'; status: 'active' | 'blocked' | 'canceled'; password_hash?: string; created_at: string; }
export interface Ruling { id: string; source: 'dgt' | 'cendoj'; reference: string; date: string; title: string; text: string; summary: string | null; summary_status: string; source_url: string; tax: string; topics: string; binding: number; content_hash: string; indexed_at: string; embedding_status: string; score?: number; }
export type AuthContext = { user: User; sessionId: string };
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function json(data: unknown, status = 200, headers: Record<string, string> = {}) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } }); }
export function requireDb(env: Env): Database { if (!env.DB) throw new HttpError(503, 'La base de datos todavía no está configurada.'); return env.DB; }
export async function bodyJson<T = any>(request: Request, maxBytes = 32_768): Promise<T> { if (!request.headers.get('content-type')?.includes('application/json')) throw new HttpError(415, 'Se requiere application/json.'); if (Number(request.headers.get('content-length') || 0)>maxBytes) throw new HttpError(413,'Solicitud demasiado grande.'); if (!request.body) throw new HttpError(400,'JSON no válido.'); const reader=request.body.getReader(); const chunks:Uint8Array[]=[]; let length=0; for (;;) { const part=await reader.read(); if(part.done) break; length+=part.value.byteLength; if(length>maxBytes) { await reader.cancel(); throw new HttpError(413,'Solicitud demasiado grande.'); } chunks.push(part.value); } const bytes=new Uint8Array(length); let offset=0; for(const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; } try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400, 'JSON no válido.'); } }
