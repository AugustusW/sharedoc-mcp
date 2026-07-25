# Changelog

All notable changes to this project are documented here. Every release bumps `version` in
`package.json` and adds an entry below.

## [2.1.1] - 2026-07-25

Viewer rendering round — table/dark-mode/element styling from a user report on mobile.

### Fixed
- **GFM strikethrough (`~~text~~`) survives sanitization** — `<del>` is not in
  sanitize-html's default allowlist and was silently dropped, losing the strikethrough
  meaning entirely
- **Table column alignment survives sanitization** — marked emits GFM `:--:`/`--:` as a
  presentational `align` attribute on `th`/`td`, which the sanitizer stripped
- Tables render with real borders (`border-collapse`, cell padding, header background)
  instead of unstyled runs of text
- Wide tables scroll horizontally (`display:block; overflow-x:auto`) instead of bursting
  the layout on phones
- Dark mode: `color-scheme: light dark` plus a `prefers-color-scheme: dark` token set —
  the page, and the password form's input/button, now follow the system theme instead of
  always rendering white
- `blockquote` (left border + muted text) and `img` (`max-width:100%; height:auto`) are
  styled; large images no longer overflow on mobile

### Changed
- Minor polish: inline `code` gets padding + radius (reset inside `pre`), `kbd` renders
  as a bordered keycap, task-list checkboxes drop the redundant list bullet
- Document `<style>`/`style` attributes remain stripped by design — styling belongs to
  the page template, content carries semantics only

## [2.1.0] - 2026-07-25

User-audit round — all findings from a post-2.0.0 security/behavior review.

### Changed
- **Rate limiter now counts only FAILED unlock attempts** (was: every POST, including
  correct passwords). At the cap requests are rejected first; a wrong password records a
  failure; a correct unlock clears the counter — a legit user can no longer lock a doc
  for others by unlocking it repeatedly
- **`delete_shared_doc` now requires `confirm: true`** — an irreversible tool exposed to
  agents deserves an explicit-consent gate; the error message tells the model to obtain
  user approval first. Prefer `revoke_shared_doc` for routine takedowns
- Gist content search filters BEFORE applying the limit — a match older than the newest
  20 docs is now found
- Gist append updates the local search excerpt only AFTER the GitHub PATCH succeeds —
  a failed append can no longer leave locally-searchable text that isn't in the gist

### Fixed
- `npm audit` is clean: `@hono/node-server` (transitive via the MCP SDK, unused by this
  package's stdio + native-http paths) pinned to ≥2.0.5 via `overrides`; all 70 tests
  pass with the override
- README privacy wording: the gist local index stores the first 200 characters of each
  doc (for content search), not "no content"
- README: install examples now pin the major (`npx -y sharedoc-mcp@^2`) so a future
  breaking release can't change behavior on a cold start; exact-pin guidance included.
  Windows daemon options
  (Task Scheduler / NSSM)

## [2.0.0] - 2026-07-25

### Added
- **`sharedoc-mcp serve` daemon mode** — a standalone viewer process sharing the same
  SQLite DB, so selfhost links keep working after the MCP client closes; MCP-mode
  processes detect the daemon on the port and yield to it
- **`delete_shared_doc`** — hard delete: link dies and the record disappears from
  search (unlike `revoke_shared_doc`, which keeps history with a 7-day grace)
- **Content search** — `search_shared_docs` gains `content_query` (selfhost: full
  content; gist: the stored opening excerpt), and its description now advertises the
  no-arguments list-newest-links usage
- **`GET /healthz`** — health + identity probe (`{ok, server, db}` with a non-reversible
  DB fingerprint): hook it into external monitoring, and MCP-mode processes use it to
  verify a busy port really is a sharedoc-mcp viewer on the same database before
  trusting it (a mismatch now logs a loud broken-links warning instead of silently
  minting dead URLs)
- Startup warning when docs.db exceeds 100 MB, and a note when the removed v1
  file-sharing feature left an orphaned `files/` directory behind

### Security (breaking)
- **Removed `create_shared_file`**: an arbitrary-path file-sharing tool is a
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
