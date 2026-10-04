# CODY-SESSION

CRYSNOVA session & database storage API — a Cloudflare Worker backed by Workers KV (`SESSION_KV`).

## Deploy

```sh
npm install
npm run kv:create   # first time only, then paste the namespace id into wrangler.toml
npm run deploy
```

## Session endpoints

Sessions are addressed by `shortId`. `POST /session/save` also returns a public
`sessionId` of the form `CODY_AI!KV:<shortId>` — the `CODY_AI!KV:` part is a
display label, *not* part of the KV key. Both forms are accepted anywhere an
`:id` is expected.

| Method | Canonical route | Alias (existing clients) |
| --- | --- | --- |
| `POST` | `/session/save` | `/save` |
| `GET` | `/session/load/:id` | `/load/:id` |
| `DELETE` | `/session/delete/:id` | `/delete/:id` |

Aliases run through the same handler as the canonical routes, so both families
always behave identically.

### Save

```sh
curl -X POST https://id.crysnova.qzz.io/session/save \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+15551234567","sessionData":"<blob>"}'
```

```json
{ "success": true, "sessionId": "CODY_AI!KV:mru3webc", "shortId": "mru3webc" }
```

`sessionData` must be a CODY auth bundle with `version: 1` and a `files`
object containing `creds.json` plus at least one
`app-state-sync-key-*.json` file. Credentials-only JSON is rejected with HTTP
422 because it cannot perform app-state operations such as clearing a chat or
updating the profile name. The exporter must upload the complete `sessions/`
directory, not only `creds.json`.

### Load

```sh
curl https://id.crysnova.qzz.io/session/load/mru3webc
```

```json
{ "success": true, "phone": "+15551234567", "sessionData": "<blob>", "createdAt": 1758100000000 }
```

Returns `404 {"error":"Session not found"}` for an unknown id and
`400 {"error":"Missing shortId"}` for an empty one.

### Delete

```sh
curl -X DELETE https://id.crysnova.qzz.io/session/delete/mru3webc
```

```json
{ "success": true, "message": "Session deleted" }
```

## Database endpoints (per-user isolation)

| Method | Route | Body |
| --- | --- | --- |
| `POST` | `/db/save` | `{ phone, key, data }` |
| `POST` | `/db/load` | `{ phone, key }` |
| `POST` | `/db/list` | `{ phone }` |
| `POST` | `/db/delete` | `{ phone, key }` |

## Admin

`GET /admin/users?key=ADMIN_KEY` lists the phone numbers that have database
files. Set `ADMIN_KEY` with `wrangler secret put ADMIN_KEY`; the value in
`wrangler.toml` is only a development placeholder.

## KV key layout

| Key | Value | Notes |
| --- | --- | --- |
| `session:<shortId>` | `{ phone, data, createdAt, shortId }` | Current layout. A shortId alone addresses the record. |
| `session:<phone>:<shortId>` | same | Legacy layout. Still readable; migrated to the current layout on first read. |
| `db:<phone>:<key>` | `{ data, updatedAt }` | Per-user database files. |

Reads use a direct `get` on an exact key. This matters because Workers KV is
eventually consistent — `list()` may not report a newly written key for up to
60 seconds — so a lookup implemented as a `list()` + scan can return 404 for a
session that was just saved. Never resolve a session by scanning with `list()`.

Sessions have no `expirationTtl`: they persist until deleted.

The legacy fallback reads up to `LEGACY_MAX_PAGES` (5) pages of key names and
matches on the key suffix, so it costs a few subrequests instead of one `get`
per stored session. Once every record has been migrated it can be removed.
