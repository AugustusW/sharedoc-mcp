# Changelog

All notable changes to this project are documented here. Every release bumps `version` in
`package.json` and adds an entry below.

## [Unreleased] — 2.0.0 (in progress)

### Added
- **`sharedoc-mcp serve` daemon mode** — a standalone viewer process sharing the same
  SQLite DB, so selfhost links keep working after the MCP client closes; MCP-mode
  processes detect the daemon on the port and yield to it
- **`delete_shared_doc`** — hard delete: link dies and the record disappears from
  search (unlike `revoke_shared_doc`, which keeps history with a 7-day grace)
- **Content search** — `search_shared_docs` gains `content_query` (selfhost: full
  content; gist: the stored opening excerpt), and its description now advertises the
  no-arguments list-newest-links usage
- Startup warning when docs.db exceeds 100 MB

### Security (breaking)
- **Removed `create_shared_file`** (7 tools now): an arbitrary-path file-sharing tool is a
  prompt-injection exfiltration vector (`.env`, keys) — removed rather than allowlisted.
  The selfhost `files` table and `/files/` routes are gone (migration 2 drops the table).
- **Rate-limit counters persisted in SQLite** — restarting the server no longer resets
  brute-force attempt counts.
- **Full security-header set on every viewer response**: CSP `default-src 'none'` (inline
  styles + https/data images + self-only form posts), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
- README: Tailscale **private** (`tailscale serve`, tailnet-only) is now the recommended
  exposure default; Funnel/public tunnels are the share-with-anyone option.

## [1.0.0] - 2026-07-25

Initial public release.

### Added
- **8 MCP tools** — `create_shared_doc`, `create_shared_file`, `append_to_shared_doc`,
  `extend_shared_doc`, `reset_shared_doc_password`, `update_shared_doc_title`,
  `revoke_shared_doc`, `search_shared_docs` — one interface over two pluggable backends
- **Gist backend** (default) — secret gists via your logged-in `gh` CLI, local JSON index
  for search/dedup, lazy expiry cleanup; unsupported params (password, files) fail with
  clear errors instead of being ignored
- **Selfhost backend** — SQLite (`node:sqlite`, WAL) storage, localhost-only HTTP viewer,
  bcrypt-verified passwords with rate-limited attempts (5/min, HTTP 429), enforced expiry
  (410), revoke with 7-day content-purge grace, file sharing, `sanitize-html`-hardened
  markdown rendering
- Tunnel-first exposure model: the server never binds beyond 127.0.0.1; README documents
  Tailscale Funnel / Cloudflare named tunnel / quick tunnel recipes
- 52 offline tests (gh mocked, HTTP against 127.0.0.1 only); `npm test` builds first and
  passes on a clean checkout
