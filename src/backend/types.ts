export type DocStatus = 'active' | 'revoked' | 'expired';

export interface DocRecord {
  docId: string;
  title: string;
  url: string;
  status: DocStatus;
  author: string | null;
  createdAt: string;          // ISO
  updatedAt: string;          // ISO
  expiresAt: string | null;   // ISO
  /** View stats: tracked on selfhost (incremented on a successful render only — wrong
   *  passwords and 410/404 responses don't count). Always null on gist: GitHub's gist
   *  API exposes no view-count data, so there is nothing honest to report — see
   *  capabilities().stats rather than treating 0 as "never viewed". */
  viewCount: number | null;
  lastViewedAt: string | null; // ISO
}

export interface CreateDocParams {
  title: string;
  content: string;
  password?: string | null;
  expiresInHours?: number | null;
  author?: string | null;
}

export interface SearchParams {
  titleQuery?: string;
  /** Body-text search. Selfhost searches full content; gist searches the stored opening excerpt. */
  contentQuery?: string;
  status?: DocStatus;
  limit?: number;
  /** Pagination offset, applied after sort. Combine with the returned `hasMore` to fetch
   *  subsequent pages: `offset += limit` while `hasMore` is true. Must be >= 0. */
  offset?: number;
}

export interface SearchResult {
  results: DocRecord[];
  /** Whether a further page exists beyond this one (i.e. beyond offset + limit). */
  hasMore: boolean;
}

export interface BackendCapabilities {
  password: 'server' | 'none';
  expiry: 'enforced' | 'lazy';
  revoke: 'grace' | 'hard-delete';
  /** Whether view counts/lastViewedAt are meaningfully tracked for this backend. */
  stats: 'tracked' | 'unavailable';
}

/** Error whose message is safe and useful to surface to the MCP client. */
export class BackendError extends Error {}

// NOTE: no file-sharing method by design. An arbitrary-path "share this file" tool
// is a prompt-injection exfiltration vector (.env, keys) with no allowlist to hide
// behind — removed in v2.0.0.
export interface ShareBackend {
  createDoc(p: CreateDocParams): Promise<{ url: string }>;
  appendDoc(docId: string, content: string, updatedUser?: string): Promise<void>;
  /** Replace the entire content, leaving title/password/expiry untouched. Idempotent:
   *  calling it twice with the same content is a no-op the second time (≠ appendDoc). */
  updateContent(docId: string, content: string, updatedUser?: string): Promise<void>;
  extendDoc(docId: string, hours: number): Promise<void>;
  resetPassword(docId: string, newPassword: string | null, updatedUser?: string): Promise<void>;
  updateTitle(docId: string, newTitle: string, updatedUser?: string): Promise<void>;
  revokeDoc(docId: string, updatedUser?: string): Promise<void>;
  /** Hard delete: the record disappears entirely (≠ revoke, which keeps history + grace). */
  deleteDoc(docId: string): Promise<void>;
  searchDocs(p: SearchParams): Promise<SearchResult>;
  capabilities(): BackendCapabilities;
}
