# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A stdio MCP server that drives a Mattermost server **as the authenticated user** via a
Personal Access Token (PAT). It speaks plain Mattermost REST API v4 — no plugins, no Apps
framework, no OAuth app. Each user runs their own local copy with their own PAT, so the
token *is* the identity and permission set; there is no per-request auth or session state.

## Commands

```bash
npm run build       # tsc → dist/ (compiles src/** only)
npm run dev         # tsx watch, runs src/index.ts over stdio with .env loaded
npm run typecheck   # tsc -p tsconfig.check.json — type-checks src AND test, no emit
npm run lint        # oxlint
npm run format      # oxfmt --write .   (format:check to verify only)
npm run smoke       # read-only live check of the client layer (needs .env, posts nothing)
npm run handshake   # spawns built dist/index.js as an MCP client; needs `npm run build` first
```

There is no unit-test framework. `test/smoke.ts` and `test/handshake.ts` are live
integration scripts run via `tsx --env-file=.env` against a real server, not a test runner.

## Architecture

Three source files, a clean layering — read them in this order:

- **`src/config.ts`** — reads `MM_URL` + `MM_TOKEN` from env once at import; both required.
  Exports `config.apiBase` (`${MM_URL}/api/v4`) and `config.token`.
- **`src/client.ts`** — the only place that touches the network. `mm<T>(method, path, opts)`
  is the core REST wrapper: attaches the Bearer PAT, throws a descriptive `Error` on any
  non-2xx (preferring the Mattermost error body's `message`), returns `undefined` on 204.
  Also holds the name→ID **resolvers** (`resolveTeamId`, `resolveChannelId`, `resolveUser`,
  `getMe`) with per-process `Map` caches, and `flattenPosts` / `uploadFile` / `downloadFile`.
- **`src/server.ts`** — `buildServer()` registers every MCP tool. Tools are thin: resolve
  names → call `mm()` → return. No business logic lives here beyond shaping responses.
- **`src/index.ts`** — entry point; wires `buildServer()` to `StdioServerTransport`.

## Conventions that bite if missed

- **ESM with `.js` import specifiers.** Source is `.ts` but imports use `.js`
  (`./client.js`), required by `NodeNext` + `verbatimModuleSyntax`. Keep this.
- **The build scopes to `src/**` only** (`tsconfig.json` has `rootDir: src`). It never
  type-checks `test/**`. `tsconfig.check.json` exists solely to widen strict checking to
  `test/**` with `noEmit` — that's why `typecheck` uses a different config than `build`.
- **Tool error handling is centralized.** Every tool body runs inside the `run()` helper in
  `server.ts`, which turns a thrown error into an `{isError: true}` text result rather than a
  transport-level crash. New tools should follow this pattern, not throw to the SDK.
- **Channel targeting is dual.** Channel-scoped tools accept either a 26-char `channel_id`
  **or** a `team` + `channel` pair, where `channel` is the **URL slug** (`name`), not the
  display name. `resolveChannelId` enforces this. IDs are detected by `/^[a-z0-9]{26}$/` and
  passed through without a lookup. Use `search_channels` to turn a display name into a slug.
- **Post ordering is flipped on read.** Mattermost returns posts newest→oldest in an
  `{order, posts}` envelope; `flattenPosts` reverses to oldest→newest (natural reading order)
  and resolves author IDs to usernames in one batched `/users/ids` call.
- **stdout is the MCP transport.** All diagnostics go to `console.error` (stderr). Never
  `console.log` from server/client code — it corrupts the protocol stream.
- **Node ≥24**, relying on native `fetch`, `FormData`, and `Blob` — no HTTP client dep. The
  only runtime deps are `@modelcontextprotocol/sdk` and `zod`.

## Adding a tool

Register it in `buildServer()` with a `zod` `inputSchema`, do name resolution via the
`client.ts` resolvers, call `mm()`, and wrap the body in `run(...)`. Spread `channelTarget`
into the schema for anything channel-scoped. Mirror the README's tool table when you add one.
