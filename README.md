# mattermost-mcp

An [MCP](https://modelcontextprotocol.io) server that drives a Mattermost server
**as the authenticated user**, via a Personal Access Token. Read channels, search
and post messages, reply in threads, react, and upload/download files — all
acting as whoever owns the token.

Built to the same stack as `town-crier`: TypeScript, Node ≥24, the official
`@modelcontextprotocol/sdk`, `zod`, oxlint/oxfmt. Talks plain Mattermost REST
API v4 — no plugins, no Apps framework, no OAuth app to register.

## Auth — Personal Access Token

The server authenticates with a Mattermost **Personal Access Token (PAT)**, sent
as `Authorization: Bearer <token>` on every call. To create one:

> Profile picture → **Security** → **Personal Access Tokens** → **Create Token**

(That section only appears if an admin has enabled *Enable Personal Access
Tokens* in the System Console.) The token acts as your full account — including
admin reach if your account has it — so treat it like a password.

**Multi-user.** Because this runs as a local stdio process inside each person's
own MCP client, "usable by others" needs no server-side setup: each teammate
creates their **own** PAT and runs their own copy. Their token = their identity
and permissions. (A single shared, hosted instance would instead want the OAuth
authorization-code flow — out of scope here.)

## Setup

```bash
npm install
cp .env.example .env   # then put your MM_URL + MM_TOKEN in .env
npm run build
npm run smoke          # read-only check: prints your identity, teams, channels
```

## Wiring into Claude Code (`.mcp.json`)

```json
{
  "mcpServers": {
    "mattermost": {
      "command": "node",
      "args": ["/absolute/path/to/mattermost-mcp/dist/index.js"],
      "env": {
        "MM_URL": "https://chat.script.nl",
        "MM_TOKEN": "your-personal-access-token"
      }
    }
  }
}
```

Restart the session after editing `.mcp.json` for the server to be picked up.

## Tools

| Tool | What it does |
|------|--------------|
| `whoami` | The user this token acts as |
| `list_teams` | Teams you belong to |
| `list_channels` | Channels you belong to in a team |
| `search_channels` | Find channels by term (returns slugs) |
| `get_user` | Look up a user by @username or ID |
| `search_users` | Find people by partial name, nickname, or email |
| `get_channel_posts` | Read recent posts in a channel |
| `get_thread` | Read a full thread from any post in it |
| `search_posts` | Full-text search within a team |
| `post_message` | Post to a channel (optionally threaded) |
| `reply_to_thread` | Reply under a post (channel auto-resolved) |
| `update_post` | Edit a post |
| `delete_post` | Delete a post |
| `send_direct_message` | DM a user |
| `add_reaction` / `remove_reaction` | React to a post |
| `post_file` | Upload a local file and post it |
| `download_file` | Download an attachment to disk |
| `create_channel` | Create a channel |
| `join_channel` | Join a channel |

### Naming

Channel-scoped tools accept **either** a `channel_id` (26-char) **or** a `team` +
`channel` pair, where `channel` is the channel's **URL slug** (its `name`, e.g.
`town-square`), not the display name. Use `search_channels` to find a slug from a
display name. Teams and users likewise accept a slug/username or an ID.

## Scripts

- `npm run dev` — watch-run the server (stdio) with `.env`
- `npm run build` — compile to `dist/`
- `npm run smoke` — read-only live check of the client layer
- `npm run typecheck` / `lint` / `format` — gates
