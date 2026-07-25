# Changelog

All notable changes to this project are documented here. Every release bumps `version` in
`package.json` and adds an entry below.

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
