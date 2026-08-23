# Security Policy

## Supported versions

sharedoc-mcp follows the npm `latest` tag. Security fixes land on the current 2.x line and
`main`; 1.x is not separately patched.

| Version      | Supported                |
|--------------|--------------------------|
| latest `2.x` | ✅                        |
| `1.x`        | ❌ (please upgrade)       |

## Reporting a vulnerability

Please report security issues **privately** — do **not** open a public issue.

- Preferred: this repository's **Security** tab → **Report a vulnerability** (a private GitHub
  security advisory).
- We aim to acknowledge within a few days. Coordinated disclosure is appreciated, and we're happy
  to credit you unless you'd prefer otherwise.

## Security model — please read before reporting

sharedoc-mcp turns agent-generated Markdown into a link. Two backends with two different exposure
stories, and some behaviour below is inherent to that job rather than a defect. See also
[Privacy](./README.md#privacy) and [Security semantics, honestly](./README.md#security-semantics-honestly)
in the README.

### Both backends

- **Not a privilege boundary.** The server runs as your user, with your agent's instructions. It
  publishes what the MCP client asks it to publish. There is deliberately no "share this file by
  path" tool — a hijacked agent cannot point it at `.env` — but content the agent already holds is
  content it can publish. Your client's prompt-injection posture is the control here.
- **Local trust boundary.** The index (`~/.config/sharedoc-mcp/` — titles, URLs, timestamps, and
  the first 200 characters of each doc) and, on selfhost, the SQLite database (full content and
  bcrypt hashes) live under your user account with default filesystem permissions. Anyone who can
  read your home directory can read them.
- **No accounts.** A document password protects one document. There are no users, sessions, or
  cookies to escalate between.

### Gist backend

- **Content is uploaded to GitHub** as a secret gist under your account, through your logged-in
  `gh` CLI. GitHub's terms and retention apply, and the server acts with your GitHub identity — it
  holds no credential of its own.
- **A secret gist is unlisted, not private: the URL is a bearer token.** Anyone who has it can read
  the document. That is the design, not a vulnerability.
- **No password support.** `create_shared_doc` with a `password` returns an error rather than
  silently dropping it.

### Selfhost backend

- **The viewer binds `127.0.0.1` only.** `SHAREDOC_BIND_HOST` is an explicit opt-in escape hatch
  (Docker needs it, because loopback inside a container is not reachable through `docker run -p`).
  Nothing widens the bind silently.
- **Reaching the internet is your tunnel's job**, and so are its TLS, authentication, and access
  control. sharedoc-mcp does not attempt to be a public web server.
- **Rate limiting degrades behind a tunnel.** Only wrong password attempts are counted (5/minute
  per source address + doc, persisted in SQLite so a restart cannot reset them). Behind a tunnel
  every external visitor shares one source address, so the practical limit becomes per-doc —
  stricter, never weaker, but one person mistyping can briefly lock a document for others.
- **The viewer's CSP allows `img-src https: data:`.** A shared document containing a remote image
  makes each viewer's browser fetch that URL, revealing their IP and User-Agent to the image host.
  That is the cost of images rendering at all; publish documents whose content you trust.

### Upstream

Defects in `gh`, GitHub, `marked`, `sanitize-html`, or Node itself belong to those projects.
Report them there — though if sharedoc-mcp's *use* of one of them is what makes it exploitable,
that is ours and we want to hear about it.

## What we DO treat as vulnerabilities

- **Password bypass** — content served for a password-protected document without a correct
  password: path, casing, or encoding variants of `/docs/:id`, method confusion, anything that
  reaches `renderDoc` early.
- **Serving content that should be gone** — a revoked or expired document rendering instead of
  410, or content surviving past the revoke purge grace.
- **XSS** — markup that survives `marked` + `sanitize-html` into executing script, event handlers,
  or a `javascript:` URL, or any bypass of the viewer's response headers / CSP.
- **Unintended exposure** — binding beyond `127.0.0.1` without an explicit `SHAREDOC_BIND_HOST`.
- **Password leakage** — a plaintext password reaching SQLite, the local index, logs, an error
  string, or an MCP tool response.
- **Rate limiter bypass** — key collision, counter reset, or a path that permits unbounded
  password guessing.
- **Command or argument injection** into the `gh` invocation from a document title, filename, or
  content.
- **Path traversal** out of the data directory via a docId or a `SHAREDOC_*` path variable.
- **Cross-document leakage** — dedup, search, or the index returning another document's URL or
  content.

Thanks for helping keep sharedoc-mcp users safe.
