# Migration plan — hosting mattermost-mcp on Cloudflare Workers

Status: **proposal / not started.** This documents what it would take to run this
server as a remote MCP endpoint on Cloudflare Workers, with each user supplying
their own Personal Access Token (PAT) **per request** so nothing is stored
server-side. No code has been written yet.

## Goal

Turn the local stdio server into a single hosted endpoint that any teammate can
point their MCP client at, authenticating with their own Mattermost PAT — without
the server ever persisting that token.

## Core decision: token in the `Authorization` header, per request

Do **not** add a `token` parameter to each of the 21 tools (that would bloat
every schema and leak the token into tool-call logs). Instead carry it as the
standard transport header:

```
Authorization: Bearer <user-PAT>
```

The Worker reads the header on each request, uses it for that request's Mattermost
calls, and discards it. Clients configure it exactly once, locally:

```jsonc
// .mcp.json — remote instead of a local node process
{ "mcpServers": { "mattermost": {
    "type": "http",
    "url": "https://mattermost-mcp.<account>.workers.dev/mcp",
    "headers": { "Authorization": "Bearer <your-PAT>" }
}}}
```

This is the literal realization of "send the PAT every request, don't save it on
the server." `MM_URL` stays **server-side** config (one instance: `chat.script.nl`),
since every user targets the same Mattermost.

## Target architecture

- **Transport:** stateless **Streamable HTTP** (MCP). A stateless handler is the
  natural fit for a per-request token — no session, no stored credential. See
  "Transport options" for the Cloudflare-blessed alternative and why we still
  prefer stateless here.
- **Runtime:** Workers (V8 isolates, not Node). Native `fetch`/`FormData`/`Blob`
  are available; **no filesystem**; `Buffer`/`node:*` only via the
  `nodejs_compat` flag.
- **State:** none persisted. The only per-user in-memory value (`getMe`) is scoped
  to the request.

## File-by-file changes

### New: `wrangler.toml`
```toml
name = "mattermost-mcp"
main = "src/worker.ts"
compatibility_date = "2025-06-01"
compatibility_flags = ["nodejs_compat"]
# MM_URL set via: wrangler secret put MM_URL   (or [vars] for non-secret)
```

### New: `src/worker.ts` — Workers entrypoint
- Exports `default { fetch(request, env, ctx) }`.
- Routes `POST /mcp` (and `GET` for SSE if ever needed) to the MCP transport.
- Extracts the bearer token from `request.headers.get('authorization')`; returns
  `401` if missing.
- Builds a per-request **`Session`** (see below) from `{ apiBase: env.MM_URL + '/api/v4', token }`
  and hands it to `buildServer(session)` + the Streamable HTTP transport.
- Never logs the header.

### `src/config.ts` — drop the import-time token read
- Today it reads `MM_TOKEN` + `MM_URL` from `process.env` at module load. Workers
  has no import-time `process.env`.
- Becomes a small factory: `makeConfig(env, token) → { apiBase, token }`. `MM_URL`
  comes from the Worker `env` binding; `token` from the request header.
- Keep a thin `process.env` path for the **local stdio** entry so `npm run dev`
  still works (dual-mode — see `index.ts`).

### `src/client.ts` — thread the token through a `Session`
This is the biggest mechanical change. Introduce a context object:

```ts
export interface Session { apiBase: string; token: string }
export function mm<T>(s: Session, method, path, opts?): Promise<T>
```

- Every `mm()` call site gains the `s` argument. Resolvers (`resolveTeamId`,
  `resolveChannelId`, `resolveUser`, `getMe`, `flattenPosts`, `getRecentActivity`,
  `uploadFile`, `downloadFile`) take `Session` too.
- **Caches:**
  - `cachedMe` is **per-user** → must move out of module scope. Either drop it, or
    key by token (`Map<token, MMUser>`), or stash it on the `Session` object
    (simplest: `session.me`).
  - `teamCache` and channel-name→ID lookups are **instance-global facts** (same for
    every user of `chat.script.nl`), so they can stay module-level and shared
    safely. No correctness issue, and they survive across requests for free.

### `src/server.ts` — per-request server
- `buildServer()` becomes `buildServer(session: Session)` (or tools read the
  session from a request-scoped closure). Each request builds a server bound to
  that request's token; tool bodies call `mm(session, …)`.
- The `run()` error wrapper, schemas, and 19 of 21 tools are otherwise unchanged.

### File tools — the one real redesign (`post_file`, `download_file`)
- They currently use `node:fs` to read/write a **local path**, which is meaningless
  on a remote Worker (no filesystem, and the path isn't the user's machine).
- Redesign the I/O contract:
  - `post_file`: accept **base64 `content`** (+ `filename`) instead of `path`, decode
    to a `Blob`, upload via the existing multipart flow.
  - `download_file`: return **base64 `content`** in the tool result instead of
    writing to disk. (Large files: optionally stream to an **R2** bucket and return
    a short-lived URL — adds an R2 binding; defer unless needed.)
- The other 19 tools need no behavioural change.

### `src/index.ts` — keep the stdio entry
- Preserve the local stdio path for development and for anyone who still wants to
  run locally: it builds a `Session` from `process.env` (`MM_URL` + `MM_TOKEN`) and
  wires `StdioServerTransport`. Dual-mode: `index.ts` = stdio, `worker.ts` = HTTP.

### `package.json`
- Add `wrangler` (dev dep) and scripts: `dev:worker` (`wrangler dev`), `deploy`
  (`wrangler deploy`).
- Keep `build`/`typecheck`/`lint`/`format` as-is; add `@cloudflare/workers-types`
  to the typecheck config for `worker.ts`.

### CI (`.github/workflows/ci.yml`)
- No change required to gate PRs. Optionally add a `wrangler deploy --dry-run`
  build check, and a separate deploy workflow on push to `main` (needs a
  `CLOUDFLARE_API_TOKEN` secret).

## Transport options

1. **Stateless Streamable HTTP (recommended for this use case).** A thin handler;
   token read per request; no Durable Objects; nothing stored. Matches the
   "PAT every request" goal exactly. Risk: the MCP SDK's `StreamableHTTPServerTransport`
   is written against Node `http` req/res; running it cleanly on the Workers
   `fetch` model needs verification (a spike) — may need a small adapter.
2. **Cloudflare `agents` / `McpAgent` (their blessed path).** Wraps the SDK, returns
   a Workers fetch handler, but is backed by **Durable Objects** (a session object)
   and is oriented toward OAuth-provided `props`. Usable with a static header token
   (read it in `fetch`, pass down), but it's more moving parts and leans stateful.

Plan targets option 1; the spike should validate it and fall back to option 2 if
the SDK transport won't run statelessly on Workers.

## Security / trust (must be acknowledged)

- Local stdio keeps the PAT on the user's machine. **Hosted, the Worker sees every
  user's PAT on every request.** Mattermost PATs are **full-account and unscoped**,
  so the operator could in principle capture any user's god-mode token. Acceptable
  for a team-internal tool you operate; not for untrusted users.
- **Never log** the `Authorization` header or request bodies that echo it.
- The endpoint is effectively open (anyone with the URL can POST) but useless
  without a valid PAT — Mattermost returns 401. Still consider: a lightweight
  gateway secret or Cloudflare Access in front, rate limiting, and CORS lockdown.

## Deployment steps

1. `npm i -D wrangler @cloudflare/workers-types`
2. `wrangler secret put MM_URL`  → `https://chat.script.nl`
3. `wrangler deploy`
4. Share the `/mcp` URL; each user adds the `.mcp.json` http block with their PAT.

## Testing

- `wrangler dev` locally; adapt `test/handshake.ts` into an **HTTP** handshake that
  connects via the Streamable HTTP client transport with an `Authorization` header,
  lists tools, and round-trips `whoami`.
- Keep the existing stdio `smoke`/`handshake` for the local path.

## Effort & risk

- **Effort:** ~1 day. Threading `Session` through `client.ts`/`server.ts` is the
  bulk (mechanical). File-tool redesign is the only genuine rework.
- **Top risk:** whether the MCP SDK's Streamable HTTP transport runs statelessly on
  the Workers runtime — resolve with a short spike before committing to option 1.
- **Reconsider first:** for a per-user-PAT tool, local stdio keeps tokens off the
  server entirely. Host only if "no local Node process + centralized updates"
  outweighs the token-trust shift.

## Open questions

- One shared Mattermost instance (`MM_URL` server-side), or should users be able to
  target different instances (then `MM_URL` also moves to a per-request header)?
- File tools: base64-only (simple) or R2-backed URLs (handles large files)?
- Put Cloudflare Access / a gateway secret in front, or rely solely on PAT validity?
