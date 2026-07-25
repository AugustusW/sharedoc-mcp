import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { BackendError, type ShareBackend } from './backend/types.js';

const CALLER_DEFAULT = 'sharedoc-mcp';

function caller(explicit?: string | null): string {
  return explicit || process.env.MCP_CALLER || CALLER_DEFAULT;
}

export function extractDocId(docIdOrUrl: string): string {
  const uuid = docIdOrUrl.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid) return uuid[0].toLowerCase();
  const tail = docIdOrUrl.trim().split('/').pop() ?? '';
  if (!tail) throw new BackendError(`cannot extract a doc id from: ${docIdOrUrl.slice(0, 100)}`);
  return tail;
}

type Handler = (args: Record<string, unknown>) => Promise<object>;

/** Thin tool layer: schema/attribution/error wrapping only; never throws. */
export function buildToolHandlers(backend: ShareBackend): Record<string, Handler> {
  const wrap = (fn: (args: Record<string, unknown>) => Promise<object>): Handler =>
    async args => {
      try {
        return await fn(args);
      } catch (e) {
        return { error: e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e) };
      }
    };

  return {
    create_shared_doc: wrap(async a => backend.createDoc({
      title: String(a.title), content: String(a.content),
      password: (a.password as string | undefined) ?? null,
      expiresInHours: (a.expires_in_hours as number | undefined) ?? null,
      author: (a.author as string | undefined) || process.env.MCP_CALLER || 'Claude Code Main',
    })),
    append_to_shared_doc: wrap(async a => {
      const id = extractDocId(String(a.doc_id_or_url));
      await backend.appendDoc(id, String(a.content), caller(a.updated_user as string));
      return { ok: true, doc_id: id };
    }),
    extend_shared_doc: wrap(async a => {
      const id = extractDocId(String(a.doc_id_or_url));
      await backend.extendDoc(id, Number(a.hours));
      return { ok: true, doc_id: id };
    }),
    reset_shared_doc_password: wrap(async a => {
      const id = extractDocId(String(a.doc_id_or_url));
      await backend.resetPassword(id, (a.new_password as string | null) ?? null, caller(a.updated_user as string));
      return { ok: true, doc_id: id };
    }),
    update_shared_doc_title: wrap(async a => {
      const id = extractDocId(String(a.doc_id_or_url));
      await backend.updateTitle(id, String(a.new_title), caller(a.updated_user as string));
      return { ok: true, doc_id: id };
    }),
    revoke_shared_doc: wrap(async a => {
      const id = extractDocId(String(a.doc_id_or_url));
      await backend.revokeDoc(id, caller(a.updated_user as string));
      return { ok: true, doc_id: id };
    }),
    delete_shared_doc: wrap(async a => {
      if (a.confirm !== true) {
        throw new BackendError('delete_shared_doc is irreversible — call again with confirm: true only after the user has explicitly approved permanent deletion. For a reversible takedown, use revoke_shared_doc.');
      }
      const id = extractDocId(String(a.doc_id_or_url));
      await backend.deleteDoc(id);
      return { ok: true, doc_id: id };
    }),
    search_shared_docs: wrap(async a => {
      const status = a.status as string | undefined;
      if (status !== undefined && !['active', 'revoked', 'expired'].includes(status)) {
        throw new BackendError(`status must be active/revoked/expired, got: ${status}`);
      }
      const results = await backend.searchDocs({
        titleQuery: (a.title_query as string) ?? '',
        contentQuery: (a.content_query as string) ?? '',
        status: status as never, limit: (a.limit as number) ?? 20,
      });
      return { results };
    }),
  };
}

const optStr = z.string().optional();

// Raw zod shapes (NOT z.object instances) — the form the SDK v1 docs use for
// registerTool inputSchema (types accept ZodRawShapeCompat | AnySchema; raw shape chosen).
const TOOL_SCHEMAS: Record<string, { description: string; inputSchema: Record<string, z.ZodType> }> = {
  create_shared_doc: {
    description: 'Create a shared Markdown doc, returns a public URL. Backend semantics differ: gist backend has no password support (secret URL is the protection) and lazy expiry; selfhost backend enforces both.',
    inputSchema: {
      title: z.string(), content: z.string(), password: optStr,
      expires_in_hours: z.number().optional(), author: optStr,
    },
  },
  // create_shared_file was removed in v2.0.0: an arbitrary-path file-sharing tool is
  // a prompt-injection exfiltration vector (.env, keys) — no allowlist, no tool.
  append_to_shared_doc: {
    description: 'Append content to an existing shared doc. NOT idempotent: a retry appends twice — check with search_shared_docs before retrying. Accepts a doc id or URL.',
    inputSchema: { doc_id_or_url: z.string(), content: z.string(), updated_user: optStr },
  },
  extend_shared_doc: {
    description: 'Extend a doc expiry by N hours (for "N days" multiply by 24 first). On the gist backend expiry is enforced lazily (cleanup on next use).',
    inputSchema: { doc_id_or_url: z.string(), hours: z.number() },
  },
  reset_shared_doc_password: {
    description: 'Reset a doc password (null removes protection). Selfhost backend only.',
    inputSchema: { doc_id_or_url: z.string(), new_password: z.string().nullable(), updated_user: optStr },
  },
  update_shared_doc_title: {
    description: 'Update a shared doc title (must be non-empty).',
    inputSchema: { doc_id_or_url: z.string(), new_title: z.string(), updated_user: optStr },
  },
  revoke_shared_doc: {
    description: 'Revoke a shared doc: the link stops working but the record stays searchable. Gist backend: the gist is deleted immediately and irreversibly. Selfhost backend: revoked with a 7-day grace before content is purged. To erase the record entirely, use delete_shared_doc.',
    inputSchema: { doc_id_or_url: z.string(), updated_user: optStr },
  },
  delete_shared_doc: {
    description: 'Permanently delete a shared doc: the link dies AND the record disappears from search — unlike revoke_shared_doc, no history is kept. Irreversible on both backends. Requires confirm: true, which you must only pass after the user explicitly approved the permanent deletion; prefer revoke_shared_doc for routine takedowns.',
    inputSchema: { doc_id_or_url: z.string(), confirm: z.boolean() },
  },
  search_shared_docs: {
    description: 'Find previously shared docs and their links. Call with NO arguments to list the newest docs (each result includes its share URL). title_query filters by title substring; content_query searches body text (selfhost: full content; gist: the opening excerpt only); status filters active/revoked/expired; limit max 100.',
    inputSchema: {
      title_query: optStr,
      content_query: optStr,
      status: z.enum(['active', 'revoked', 'expired']).optional(),
      limit: z.number().optional(),
    },
  },
};

export function buildServer(backend: ShareBackend): McpServer {
  const server = new McpServer({ name: 'sharedoc', version: '2.1.0' });
  const handlers = buildToolHandlers(backend);
  for (const [name, meta] of Object.entries(TOOL_SCHEMAS)) {
    server.registerTool(name, meta, async (args: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(await handlers[name](args)) }],
    }));
  }
  return server;
}
