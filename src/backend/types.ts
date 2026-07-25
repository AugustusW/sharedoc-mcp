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
  files: boolean;
  revoke: 'grace' | 'hard-delete';
}

/** Error whose message is safe and useful to surface to the MCP client. */
export class BackendError extends Error {}

export interface ShareBackend {
  createDoc(p: CreateDocParams): Promise<{ url: string }>;
  createFile(p: { filePath: string; filename?: string; contentType?: string }): Promise<{ url: string }>;
  appendDoc(docId: string, content: string, updatedUser?: string): Promise<void>;
  extendDoc(docId: string, hours: number): Promise<void>;
  resetPassword(docId: string, newPassword: string | null, updatedUser?: string): Promise<void>;
  updateTitle(docId: string, newTitle: string, updatedUser?: string): Promise<void>;
  revokeDoc(docId: string, updatedUser?: string): Promise<void>;
  searchDocs(p: SearchParams): Promise<DocRecord[]>;
  capabilities(): BackendCapabilities;
}
