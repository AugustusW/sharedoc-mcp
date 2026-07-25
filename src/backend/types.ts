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
  status?: DocStatus;
  limit?: number;
}

export interface BackendCapabilities {
  password: 'server' | 'none';
  expiry: 'enforced' | 'lazy';
  revoke: 'grace' | 'hard-delete';
}

/** Error whose message is safe and useful to surface to the MCP client. */
export class BackendError extends Error {}

// NOTE: no file-sharing method by design. An arbitrary-path "share this file" tool
// is a prompt-injection exfiltration vector (.env, keys) with no allowlist to hide
// behind — removed in v2.0.0.
export interface ShareBackend {
  createDoc(p: CreateDocParams): Promise<{ url: string }>;
  appendDoc(docId: string, content: string, updatedUser?: string): Promise<void>;
  extendDoc(docId: string, hours: number): Promise<void>;
  resetPassword(docId: string, newPassword: string | null, updatedUser?: string): Promise<void>;
  updateTitle(docId: string, newTitle: string, updatedUser?: string): Promise<void>;
  revokeDoc(docId: string, updatedUser?: string): Promise<void>;
  searchDocs(p: SearchParams): Promise<DocRecord[]>;
  capabilities(): BackendCapabilities;
}
