export type Page = 'search' | 'saved' | 'timeline' | 'coverage' | 'admin' | 'help';
export type Source = 'dgt' | 'cendoj';
export interface Ruling { id: string; source: Source; reference: string; date: string; title: string; text?: string; summary?: string | null; summary_status: string; source_url?: string | null; tax: string; topics: string[]; binding: boolean; indexed_at?: string; facts?: string; question?: string; answer?: string; legislation?: string; issuing_body?: string; attribution?: string; source_updated_at?: string; score?: number; }
export interface User { id: string; email: string; name: string; role: 'admin' | 'user'; status: string; }
export interface Filters { tax: string; from: string; to: string; sort: 'relevance' | 'date_asc' | 'date_desc'; }
export interface SearchResponse { results: Ruling[]; total: number; page: number; limit: number; has_more: boolean; mode: string; semantic_available?: boolean; warning?: string | null; total_is_exact?: boolean; truncated?: boolean; result_scope?: string; }
export interface Coverage { configured?: boolean; indexed?: number; earliest?: string | null; latest?: string | null; complete?: boolean; ai_summaries?: number; pending_summaries?: number; note?: string; sources?: {source: string; indexed: number; earliest: string; latest: string}[]; last_update?: {value: string; updated_at: string} | null; }
