# memo

A small remote MCP server: notes, file uploads, audio transcription.

- Endpoint: `https://memo.ataga.ovh/mcp` — Streamable HTTP, MCP `2025-11-25` (older revisions still accepted)
- Server plan page (advertised as `resource_documentation`): `/plan`
- Auth: the server is its own OAuth 2.1 authorization server (dynamic client registration, PKCE, approval with a pass phrase)
- Tools: `memo_write`, `memo_search`, `upload`, `transcribe`, each with a declared output schema

## Run locally

```sh
npm install
BASE_URL=http://localhost:8787 APPROVE_PHRASE=devphrase DATA_DIR=./data node src/server.js
MEMO_BASE=http://localhost:8787 MEMO_PHRASE=devphrase node scripts/client.mjs
MEMO_BASE=http://localhost:8787 MEMO_PHRASE=devphrase node scripts/client.mjs memo_write '{"text":"hello"}'
```

## Environment

| Name | Meaning |
| --- | --- |
| `BASE_URL` | public https address of the server, no trailing slash |
| `PORT` | listen port, default 8787 |
| `DATA_DIR` | where `db.json` and `uploads/` live |
| `APPROVE_PHRASE` | pass phrase on the approval page; generated once if unset |
| `OPENROUTER_API_KEY` | used only by `transcribe` |
| `TRANSCRIBE_MODEL` | default `google/gemini-2.5-flash` |

## Layout

- `src/server.js` — express app, auth router, `/mcp` transport, public file links
- `src/oauth.js` — OAuth provider, approval page, token issue
- `src/tools.js` — the four MCP tools and their output schemas
- `src/transcribe.js` — audio fetch plus model call
- `src/store.js` — `db.json` and `uploads/` on disk
- `public/plan.html` — the plan page
- `scripts/client.mjs` — a client that runs the whole OAuth flow, for checks
