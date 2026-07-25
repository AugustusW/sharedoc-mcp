# sharedoc-mcp

> **Agent-generated Markdown → a link you can hand to anyone. GitHub gists today, your own server tomorrow.**

English | [繁體中文](./README.zh-TW.md)

[![npm](https://img.shields.io/npm/v/sharedoc-mcp?color=brightgreen)](https://www.npmjs.com/package/sharedoc-mcp)
[![Release](https://img.shields.io/github/v/release/AugustusW/sharedoc-mcp?color=brightgreen)](https://github.com/AugustusW/sharedoc-mcp/releases)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-blue.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio%20server-orange.svg)](https://modelcontextprotocol.io/)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-compatible-orange.svg)](https://claude.com/claude-code)
[![Codex](https://img.shields.io/badge/Codex-compatible-black.svg)](https://developers.openai.com/codex/)

An [MCP](https://modelcontextprotocol.io/) stdio server — works in [Claude Code](https://claude.com/claude-code), Codex CLI, and any MCP client — that gives your agent **8 tools to publish, update, search, and revoke shareable documents**. Two pluggable backends behind one interface: **gist** (zero setup, rides your logged-in `gh` CLI) and **selfhost** (SQLite on your machine, passwords, enforced expiry).

> When a backend can't honor a parameter (e.g. `password` on gist), it returns a clear error instead of silently ignoring it.

## Why?

AI agents produce Markdown constantly — reports, research digests, meeting notes. Getting that to another human usually means copy-pasting walls of text into a chat window.

```text
Without sharedoc-mcp                  With sharedoc-mcp
────────────────────                  ─────────────────
copy a wall of text into chat         "share this as a doc"
paste again for each person           one link for everyone
content lives in chat scroll          revoke / extend / append later
"can you password it?"  …no           selfhost backend: bcrypt + expiry
```

## Features

- ✓ 8 MCP tools: create / append / extend / reset password / rename / revoke / delete / search
- ✓ `sharedoc-mcp serve` daemon mode — selfhost links keep working after your MCP client closes
- ✓ Content search: find old share links by what's in them, not just the title
- ✓ Two backends, one interface — switch with a single env var, tool schemas stay identical
- ✓ **Gist backend** (default): secret gists via your logged-in `gh` CLI — no tokens to manage, nothing new to host
- ✓ **Selfhost backend**: docs stay on your machine (SQLite via built-in `node:sqlite` — zero native modules)
- ✓ Server-verified passwords (bcrypt) with rate-limited attempts — 5/minute, HTTP 429, counters persisted in SQLite so a restart can't reset them (selfhost)
- ✓ Enforced expiry (410) and revoke with a 7-day content-purge grace (selfhost); lazy expiry cleanup (gist)
- ✓ Markdown rendered through `marked` + `sanitize-html` — scripts, event handlers, and `javascript:` URLs in shared content are stripped
- ✓ Viewer binds **127.0.0.1 only**, answers with a strict security-header set (CSP `default-src 'none'`, nosniff, DENY framing, no-referrer, no-store) — exposure is a tunnel you control (recipes below)
- ✓ Local index for `search_shared_docs` + create dedup (identical unprotected retries within 5 min return the same URL; a retry that adds a password/expiry always creates a new doc)
- ✓ Two MCP clients can share one data dir: SQLite WAL + busy timeout, graceful port sharing
- ✓ 60 offline tests; `npm test` passes on a clean checkout

## Install

Requires Node.js ≥ 22.13.0. Gist backend additionally needs [GitHub CLI](https://cli.github.com) logged in (`gh auth login`).

**Option A — Claude Code (one line):**

```bash
claude mcp add sharedoc --scope user -- npx -y sharedoc-mcp
```

**Option B — Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.sharedoc]
command = "npx"
args = ["-y", "sharedoc-mcp"]
```

**Option C — any other MCP client:** run `npx -y sharedoc-mcp` as a stdio server.

## Pick your backend

| | 🅰 `gist` (default) | 🅱 `selfhost` |
|---|---|---|
| Setup | none — uses your logged-in `gh` CLI | none extra — data stays on your machine |
| Doc lives on | GitHub (secret gist) | your machine (SQLite) |
| Link reachable | anywhere, immediately | localhost — add a tunnel to share externally |
| Password | ✗ (the secret URL is the protection) | ✓ server-verified (bcrypt), rate-limited |
| Expiry | lazy — expired gists deleted on next use | enforced — expired links return 410 |
| Revoke | gist deleted immediately, irreversibly | immediate 410, content purged after 7-day grace |

### Gist quickstart

Ask your agent to "share this as a doc" — it calls `create_shared_doc` and returns a secret gist URL. Secret gists are not listed publicly and the URL is unguessable, but **anyone who has the link can read it** — that's the whole security model of this backend. Need passwords? Use `selfhost`.

A local index (`~/.config/sharedoc-mcp/index.json`) tracks what you've shared, powering search and expiry cleanup. Expiry here is *lazy*: expired gists are deleted the next time any tool runs, not at the exact expiry moment.

### Selfhost quickstart

```bash
claude mcp add sharedoc --scope user --env SHAREDOC_BACKEND=selfhost -- npx -y sharedoc-mcp
```

Docs live in SQLite at `~/.local/share/sharedoc-mcp/`; a viewer serves them at `http://127.0.0.1:8377`. To share beyond your machine, put a tunnel in front and set `SHAREDOC_PUBLIC_URL`:

> **Links that outlive your editor:** in MCP mode the viewer dies with the MCP client — close Claude Code and selfhost links stop answering until the next session (data is safe in SQLite). Run the standalone daemon to keep links alive around the clock:
>
> ```bash
> npx -y sharedoc-mcp serve   # viewer only, same DB — keep it running via launchd/systemd/tmux
> ```
>
> MCP clients detect the daemon already owns the port and simply use it.

| Recipe | Fits you if | Setup |
|---|---|---|
| **Tailscale private** (recommended) | recipients are your own devices / people you can invite to your tailnet | `tailscale serve --bg 8377` → `https://<machine>.<tailnet>.ts.net`, reachable **only inside your tailnet** — nothing is exposed to the public internet |
| **Tailscale Funnel** | share with anyone, no domain | `tailscale funnel 8377` → same stable URL, but public |
| **Cloudflare named tunnel** | you own a domain | domain on Cloudflare, `cloudflared tunnel create` + route a hostname to `http://127.0.0.1:8377` |
| **cloudflared quick tunnel** | one-off sharing | `cloudflared tunnel --url http://127.0.0.1:8377` → random URL, changes every restart |

#### Own a domain? Cloudflare named tunnel, step by step

A branded, stable share URL like `https://docs.example.com/docs/<uuid>` — TLS handled by Cloudflare, works from behind NAT:

```bash
# one-time setup (domain already added to Cloudflare — the free plan is enough)
cloudflared tunnel login
cloudflared tunnel create sharedoc
cloudflared tunnel route dns sharedoc docs.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: sharedoc
credentials-file: ~/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: docs.example.com
    service: http://127.0.0.1:8377
  - service: http_status:404
```

Run `cloudflared tunnel run sharedoc` (or install it as a service for always-on), and register the MCP server with the public URL:

```bash
claude mcp add sharedoc --scope user \
  --env SHAREDOC_BACKEND=selfhost \
  --env SHAREDOC_PUBLIC_URL=https://docs.example.com \
  -- npx -y sharedoc-mcp
```

Extras this unlocks: Cloudflare's DDoS protection comes free; you can layer WAF rules, or put [Cloudflare Access](https://www.cloudflare.com/zero-trust/products/access/) (SSO) in front of everything except the share paths — an "SSO inside, password-protected shares outside" split.

**Alternative — always-on without a home machine:** run sharedoc-mcp on a VPS (where your agent also runs) and point nginx/caddy at `127.0.0.1:8377` with your domain and auto-TLS; no tunnel needed.

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `SHAREDOC_BACKEND` | `gist` | `gist` or `selfhost` |
| `SHAREDOC_PORT` | `8377` | viewer port (selfhost) |
| `SHAREDOC_PUBLIC_URL` | `http://127.0.0.1:<port>` | URL prefix in share links — set to your tunnel hostname |
| `SHAREDOC_DATA_DIR` | `~/.local/share/sharedoc-mcp` | SQLite location (selfhost) |
| `SHAREDOC_INDEX_PATH` | `~/.config/sharedoc-mcp/index.json` | local index (gist) |
| `MCP_CALLER` | — | default author attribution for created docs |

## The 8 tools

| Tool | Does |
|---|---|
| `create_shared_doc` | title + Markdown (+ optional password / `expires_in_hours` / author) → share URL |
| `append_to_shared_doc` | append Markdown (not idempotent — a retry appends twice) |
| `extend_shared_doc` | extend expiry by N hours |
| `reset_shared_doc_password` | set / change / remove (null) the password (selfhost only) |
| `update_shared_doc_title` | rename |
| `revoke_shared_doc` | kill the link, keep the record (see backend table for semantics) |
| `delete_shared_doc` | kill the link AND erase the record — irreversible |
| `search_shared_docs` | no args = list newest links; title substring, body-text search (selfhost: full content; gist: opening excerpt), status filter |

## Privacy

Data flow, by backend:

- **Gist backend**: your document content is uploaded to GitHub as a secret gist under your account — GitHub's terms and retention apply. The local index (titles, URLs, timestamps — not content) stays in `~/.config/sharedoc-mcp/`. Nothing is sent anywhere except GitHub via your own `gh` CLI.
- **Selfhost backend**: content never leaves your machine unless you attach a tunnel — then it's served to whoever you gave the link (and the tunnel provider relays the traffic). Passwords are stored only as bcrypt hashes.
- sharedoc-mcp itself has no telemetry and calls no third-party service of its own.

## Security semantics, honestly

- **Gist links are bearer tokens**: anyone with the URL reads the doc. Revoke deletes the gist immediately and irreversibly.
- Selfhost passwords are verified server-side before content is served; wrong attempts are rate-limited (5/minute per source+doc), with counters persisted in SQLite — restarting the server does not reset them. **Behind a tunnel, all external visitors share one source address**, so the practical limit is 5/minute per doc — stricter than per-visitor; one person mistyping can briefly lock a doc for others.
- There is deliberately **no file-sharing tool**: an arbitrary-path "share this file" tool is a prompt-injection exfiltration vector (`.env`, keys) — a hijacked agent could publish secrets. Removed rather than allowlisted.
- The viewer never binds beyond 127.0.0.1. Whether and how it reaches the internet is entirely your tunnel's configuration.

## Develop

```bash
git clone https://github.com/AugustusW/sharedoc-mcp.git
cd sharedoc-mcp
npm install
npm test        # builds, then runs 60 offline tests — gh CLI is mocked, HTTP tests hit 127.0.0.1 only
```

Versioning: every release bumps `version` in `package.json`, adds a [CHANGELOG](./CHANGELOG.md) entry, and is published as a git tag + [GitHub Release](https://github.com/AugustusW/sharedoc-mcp/releases) + [npm](https://www.npmjs.com/package/sharedoc-mcp).
**To get update notifications**: Watch this repo (Custom → Releases). `npx -y` fetches the latest published version on each cold run; your index and docs DB live outside the package — updating never touches them.

## Status

v1.0.0 ([CHANGELOG](./CHANGELOG.md)) — core logic is covered by 60 offline unit/integration tests (the `gh` CLI is mocked; HTTP tests run against 127.0.0.1 only; no network needed). The full flows have been manually verified (2026-07-25: real secret-gist create/index/delete via the built server over stdio JSON-RPC, and the selfhost password flow end-to-end — form → wrong password 401 → correct password 200 → rate-limit 429 → revoke 410 — plus `lsof` confirmation of the 127.0.0.1-only bind) on:

- macOS (Apple Silicon), Node v25 — gist + selfhost backends

Tunnel recipes are documented from the tools' standard behavior; Windows/Linux and real-tunnel end-to-end runs have **not yet been verified** — reports welcome.

## License

MIT © AugustusW
