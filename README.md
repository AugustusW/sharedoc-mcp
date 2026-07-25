# sharedoc-mcp

**Share agent-generated Markdown as links.** An MCP server that turns "here's the report" into a URL you can hand to anyone — backed by GitHub gists (zero setup) or your own machine (passwords, expiry, full control).

[English](./README.md) | [繁體中文](./README.zh-TW.md)

**Version 1.0.0** · [CHANGELOG](./CHANGELOG.md) · MIT

## Why

AI agents produce Markdown constantly — reports, research digests, meeting notes. Getting that to another human usually means copy-pasting walls of text into a chat. sharedoc-mcp gives your agent 8 tools to publish, update, search, and revoke shareable documents, so "send this to my teammate" becomes a link.

## Two backends, one interface

| | 🅰 `gist` (default) | 🅱 `selfhost` |
|---|---|---|
| Setup | none — uses your logged-in `gh` CLI | none extra — data stays on your machine |
| Doc lives on | GitHub (secret gist) | your machine (SQLite) |
| Link reachable | anywhere, immediately | localhost — add a tunnel to share externally |
| Password | ✗ (the secret URL is the protection) | ✓ server-verified (bcrypt), rate-limited |
| Expiry | lazy — expired gists are deleted on next use | enforced — expired links return 410 |
| Revoke | gist deleted immediately, irreversibly | immediate 410, content purged after a 7-day grace |
| File sharing | ✗ (gists are text-only) | ✓ (no password/expiry on files — link is the only protection) |

The 8 MCP tools are identical on both; when a backend can't honor a parameter (e.g. `password` on gist), it returns a clear error instead of silently ignoring it.

## Install

Requires Node.js ≥ 22.13.0. For the gist backend: [GitHub CLI](https://cli.github.com) logged in (`gh auth login`).

**Claude Code:**

```bash
claude mcp add sharedoc --scope user -- npx -y sharedoc-mcp
```

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.sharedoc]
command = "npx"
args = ["-y", "sharedoc-mcp"]
```

Any other MCP client: run `npx -y sharedoc-mcp` as a stdio server.

## Quickstart (gist backend)

Ask your agent to "share this as a doc" — it calls `create_shared_doc` and returns a secret gist URL. Secret gists are not listed publicly and the URL is unguessable, but **anyone who has the link can read it**. That's the whole security model of this backend — use `selfhost` when you need passwords.

A local index (`~/.config/sharedoc-mcp/index.json`) tracks what you've shared, powering `search_shared_docs` and expiry cleanup. Expiry on this backend is *lazy*: expired gists are deleted the next time any tool runs, not at the exact expiry moment.

## Selfhost backend

```bash
claude mcp add sharedoc --scope user --env SHAREDOC_BACKEND=selfhost -- npx -y sharedoc-mcp
```

Docs live in SQLite at `~/.local/share/sharedoc-mcp/`; a viewer serves them at `http://127.0.0.1:8377`. The server **only ever binds 127.0.0.1** — exposing it to the internet is deliberately left to a tunnel you control:

| Recipe | Fits you if | Setup |
|---|---|---|
| **Tailscale Funnel** (recommended) | no domain, want a stable URL | install [Tailscale](https://tailscale.com), then `tailscale funnel 8377` → stable `https://<machine>.<tailnet>.ts.net`; set `SHAREDOC_PUBLIC_URL` to it |
| **Cloudflare named tunnel** | you own a domain | add the domain to Cloudflare, `cloudflared tunnel create` + route a hostname to `http://127.0.0.1:8377`; set `SHAREDOC_PUBLIC_URL` |
| **cloudflared quick tunnel** | one-off sharing | `cloudflared tunnel --url http://127.0.0.1:8377` → random `trycloudflare.com` URL that changes every restart; set `SHAREDOC_PUBLIC_URL` per session |

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `SHAREDOC_BACKEND` | `gist` | `gist` or `selfhost` |
| `SHAREDOC_PORT` | `8377` | viewer port (selfhost) |
| `SHAREDOC_PUBLIC_URL` | `http://127.0.0.1:<port>` | the URL prefix returned in share links — set it to your tunnel hostname |
| `SHAREDOC_DATA_DIR` | `~/.local/share/sharedoc-mcp` | SQLite + files location (selfhost) |
| `SHAREDOC_INDEX_PATH` | `~/.config/sharedoc-mcp/index.json` | local index (gist) |
| `MCP_CALLER` | — | default author attribution for created docs |

### Security semantics, honestly

- Passwords are bcrypt-hashed and verified server-side before content is served; wrong-password attempts are rate-limited (5/minute per source+doc, HTTP 429). **Behind a tunnel, all external visitors share one source address**, so the practical limit is 5/minute per doc — stricter than per-visitor, and one person mistyping can briefly lock a doc for others.
- Document content is rendered through `marked` and sanitized with `sanitize-html` — scripts, event handlers, and `javascript:` URLs in shared content are stripped.
- Shared **files** have no password or expiry: the unguessable link is the only protection, indefinitely, and downloads are not rate-limited.
- Two MCP clients can point at the same data dir: SQLite runs in WAL mode with a busy timeout, and if the viewer port is already taken by another sharedoc-mcp instance the second client keeps its tools and relies on the existing viewer.

## The 8 tools

| Tool | Does |
|---|---|
| `create_shared_doc` | title + Markdown (+ optional password / `expires_in_hours` / author) → share URL. Identical unprotected retries within 5 min return the same URL; a retry that adds a password or expiry always creates a new doc. |
| `create_shared_file` | share a local file (selfhost only) |
| `append_to_shared_doc` | append Markdown to an existing doc (not idempotent — a retry appends twice) |
| `extend_shared_doc` | extend expiry by N hours |
| `reset_shared_doc_password` | set / change / remove (null) the password (selfhost only) |
| `update_shared_doc_title` | rename |
| `revoke_shared_doc` | kill the link (see backend table for semantics) |
| `search_shared_docs` | title substring + status filter |

## Develop

```bash
git clone https://github.com/AugustusW/sharedoc-mcp.git
cd sharedoc-mcp
npm install
npm test        # builds, then runs 52 offline tests — gh CLI is mocked, HTTP tests hit 127.0.0.1 only
```

Versioning: every release bumps `version` in `package.json`, adds a [CHANGELOG](./CHANGELOG.md) entry, and is published as a git tag + GitHub Release + npm. Your index, docs DB, and files all live outside the package — updating never touches them.

## License

MIT © AugustusW
