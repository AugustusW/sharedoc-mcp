import { describe, it, expect } from 'vitest';
import { buildToolHandlers, extractDocId } from '../src/server.js';
import { BackendError, type ShareBackend } from '../src/backend/types.js';

function stubBackend(over: Partial<ShareBackend> = {}): ShareBackend {
  return {
    createDoc: async () => ({ url: 'https://gist.github.com/u/id1' }),
    appendDoc: async () => {},
    extendDoc: async () => {},
    resetPassword: async () => {},
    updateTitle: async () => {},
    revokeDoc: async () => {},
    deleteDoc: async () => {},
    searchDocs: async () => [],
    capabilities: () => ({ password: 'none', expiry: 'lazy', revoke: 'hard-delete' }),
    ...over,
  };
}

describe('extractDocId', () => {
  it('accepts raw id and URLs', () => {
    expect(extractDocId('f00dfeed')).toBe('f00dfeed');
    expect(extractDocId('https://gist.github.com/AugustusW/f00dfeed')).toBe('f00dfeed');
    expect(extractDocId('https://host/docs/3f2a8c1e-1111-2222-3333-444455556666'))
      .toBe('3f2a8c1e-1111-2222-3333-444455556666');
  });
  it('rejects empty', () => {
    expect(() => extractDocId('  ')).toThrow();
  });
});

describe('tool handlers', () => {
  it('create_shared_doc returns {url}', async () => {
    const h = buildToolHandlers(stubBackend());
    expect(await h.create_shared_doc({ title: 't', content: 'c' }))
      .toEqual({ url: 'https://gist.github.com/u/id1' });
  });

  it('BackendError becomes {error} (never throws)', async () => {
    const h = buildToolHandlers(stubBackend({
      createDoc: async () => { throw new BackendError('no passwords here'); },
    }));
    const r = await h.create_shared_doc({ title: 't', content: 'c', password: 'x' }) as { error: string };
    expect(r.error).toContain('no passwords here');
  });

  it('append passes extracted docId and returns {ok, doc_id}', async () => {
    let got = '';
    const h = buildToolHandlers(stubBackend({ appendDoc: async id => { got = id; } }));
    const r = await h.append_to_shared_doc({ doc_id_or_url: 'https://gist.github.com/u/f00dfeed', content: 'x' });
    expect(got).toBe('f00dfeed');
    expect(r).toEqual({ ok: true, doc_id: 'f00dfeed' });
  });

  it('search validates status enum', async () => {
    const h = buildToolHandlers(stubBackend());
    const r = await h.search_shared_docs({ status: 'bogus' }) as { error: string };
    expect(r.error).toMatch(/status/);
  });

  it('all 8 tools exist (delete added; create_shared_file stays removed)', () => {
    const h = buildToolHandlers(stubBackend());
    expect(Object.keys(h).sort()).toEqual([
      'append_to_shared_doc', 'create_shared_doc', 'delete_shared_doc',
      'extend_shared_doc', 'reset_shared_doc_password', 'revoke_shared_doc',
      'search_shared_docs', 'update_shared_doc_title',
    ]);
  });

  it('delete_shared_doc requires confirm: true (guards against accidental model calls)', async () => {
    let called = false;
    const h = buildToolHandlers(stubBackend({ deleteDoc: async () => { called = true; } }));
    const r = await h.delete_shared_doc({ doc_id_or_url: 'f00dfeed' }) as { error: string };
    expect(r.error).toContain('confirm');
    expect(called).toBe(false);
  });

  it('delete_shared_doc with confirm passes extracted id and returns {ok, doc_id}', async () => {
    let got = '';
    const h = buildToolHandlers(stubBackend({ deleteDoc: async id => { got = id; } }));
    const r = await h.delete_shared_doc({ doc_id_or_url: 'https://gist.github.com/u/f00dfeed', confirm: true });
    expect(got).toBe('f00dfeed');
    expect(r).toEqual({ ok: true, doc_id: 'f00dfeed' });
  });

  it('search passes content_query through', async () => {
    let seen: unknown;
    const h = buildToolHandlers(stubBackend({ searchDocs: async p => { seen = p; return []; } }));
    await h.search_shared_docs({ content_query: 'budget' });
    expect((seen as { contentQuery?: string }).contentQuery).toBe('budget');
  });
});
