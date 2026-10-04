// CRYSNOVA Session & Database Storage API
// Deploy to Cloudflare Workers with KV namespace "SESSION_KV"

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const SESSION_PREFIX = 'session:';
// Public label for a stored session. This is presentation sugar around the
// shortId and is NOT part of the KV key.
const SESSION_ID_PREFIX = 'CODY_AI!KV:';
// Page cap for the legacy-key fallback. Only key *names* are read, so this
// stays cheap regardless of how many sessions are stored.
const LEGACY_MAX_PAGES = 5;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

function generateShortId() {
  return Math.random().toString(36).substring(2, 10);
}

// A session is addressed by its shortId alone: `session:<shortId>`.
function sessionKey(shortId) {
  return `${SESSION_PREFIX}${shortId}`;
}

// Accepts a bare shortId, a full public sessionId ("CODY_AI!KV:<shortId>"), or a
// percent-encoded variant of either.
function normalizeShortId(raw) {
  if (raw === null || raw === undefined) return '';
  let id = String(raw).trim();
  try {
    id = decodeURIComponent(id);
  } catch {
    // Not valid percent-encoding - keep the raw value.
  }
  if (id.includes(':')) {
    id = id.slice(id.lastIndexOf(':') + 1);
  }
  return id.trim();
}

// Reads a JSON body without letting malformed input throw out of `fetch`.
async function readJsonBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

// CODY's multi-file auth state must travel as a bundle. A creds-only payload
// can authenticate the account but cannot sign app-state mutations such as
// chatModify() or updateProfileName(). Reject it here instead of storing a
// session that will fail later with "App state key not present".
export function validateSessionData(sessionData) {
  let payload = sessionData;
  if (typeof payload === 'string') {
    const encoded = payload.trim();
    try {
      if (encoded.startsWith('CODY_AI!') && !encoded.startsWith('CODY_AI!KV:')) {
        const base64 = encoded.slice('CODY_AI!'.length);
        const binary = atob(base64);
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } else {
        payload = JSON.parse(encoded);
      }
    } catch {
      throw new Error('sessionData must be valid raw JSON or a CODY_AI base64 auth bundle');
    }
  }

  if (!payload || typeof payload !== 'object') {
    throw new Error('sessionData must be a JSON object or JSON string');
  }

  if (payload.version === 1 && payload.files && typeof payload.files === 'object') {
    const files = Object.keys(payload.files);
    const hasCreds = files.includes('creds.json');
    const appStateKeys = files.filter(file => file.startsWith('app-state-sync-key-') && file.endsWith('.json'));
    if (!hasCreds) throw new Error('session bundle must include creds.json');
    if (appStateKeys.length === 0) {
      throw new Error('session bundle must include at least one app-state-sync-key-*.json file');
    }
    return JSON.stringify(payload);
  }

  // The Worker cannot reconstruct encrypted app-state keys omitted by an old
  // exporter, so reject the old credentials-only format at upload time.
  if (payload.noiseKey && payload.me) {
    throw new Error('credentials-only sessions are not supported; export the complete sessions folder including app-state-sync-key-*.json files');
  }

  throw new Error('unsupported session format; expected auth bundle version 1');
}

// Matches `/session/load/:id` plus its legacy alias `/load/:id`, returning the raw
// id segment, or null when neither prefix matched.
function matchIdRoute(path, prefixes) {
  for (const prefix of prefixes) {
    if (path.startsWith(prefix)) {
      return path.slice(prefix.length).split('/')[0];
    }
  }
  return null;
}

// ==================== SESSION HANDLERS ====================

// Save session
async function handleSaveSession(env, phone, sessionData) {
  if (!phone || !sessionData) {
    return jsonResponse({ error: 'Missing phone or sessionData' }, 400);
  }

  try {
    const validatedSessionData = validateSessionData(sessionData);
    const shortId = generateShortId();

    // Deterministic key: the shortId on its own locates the record, so loading is
    // a single `get` instead of a namespace-wide `list` (which is eventually
    // consistent and could miss the new key for up to 60 seconds).
    await env.SESSION_KV.put(sessionKey(shortId), JSON.stringify({
      phone: phone,
      data: validatedSessionData,
      createdAt: Date.now(),
      shortId: shortId
    }));

    return jsonResponse({
      success: true,
      sessionId: `${SESSION_ID_PREFIX}${shortId}`,
      shortId: shortId
    });
  } catch (err) {
    const status = /session|app-state|credentials-only/i.test(err.message) ? 422 : 500;
    return jsonResponse({ error: err.message }, status);
  }
}

// Locates a record written by the old `session:<phone>:<shortId>` layout. The
// phone is unknown at load time, but the shortId is the last segment of the key,
// so matching on key names avoids the old `get`-per-key scan that hung requests.
async function findLegacySession(env, shortId) {
  const suffix = `:${shortId}`;
  let cursor;

  for (let page = 0; page < LEGACY_MAX_PAGES; page++) {
    const listed = await env.SESSION_KV.list({ prefix: SESSION_PREFIX, cursor });

    for (const item of listed.keys) {
      if (!item.name.endsWith(suffix)) continue;
      const raw = await env.SESSION_KV.get(item.name);
      if (!raw) continue;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (parsed && parsed.shortId === shortId) {
        return { key: item.name, parsed };
      }
    }

    if (listed.list_complete || !listed.cursor) return null;
    cursor = listed.cursor;
  }

  return null;
}

// Load session
async function handleLoadSession(env, rawShortId) {
  const shortId = normalizeShortId(rawShortId);
  if (!shortId) {
    return jsonResponse({ error: 'Missing shortId' }, 400);
  }

  try {
    const raw = await env.SESSION_KV.get(sessionKey(shortId));
    let parsed = raw ? JSON.parse(raw) : null;

    if (!parsed) {
      const legacy = await findLegacySession(env, shortId);
      if (legacy) {
        // Move it onto the deterministic key so later loads are a single `get`.
        await env.SESSION_KV.put(sessionKey(shortId), JSON.stringify(legacy.parsed));
        await env.SESSION_KV.delete(legacy.key);
        parsed = legacy.parsed;
      }
    }

    if (!parsed) {
      return jsonResponse({ error: 'Session not found' }, 404);
    }

    return jsonResponse({
      success: true,
      sessionData: parsed.data,
      phone: parsed.phone,
      createdAt: parsed.createdAt
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// Delete session
async function handleDeleteSession(env, rawShortId) {
  const shortId = normalizeShortId(rawShortId);
  if (!shortId) {
    return jsonResponse({ error: 'Missing shortId' }, 400);
  }

  try {
    const key = sessionKey(shortId);

    if (await env.SESSION_KV.get(key)) {
      await env.SESSION_KV.delete(key);
      return jsonResponse({ success: true, message: 'Session deleted' });
    }

    const legacy = await findLegacySession(env, shortId);
    if (legacy) {
      await env.SESSION_KV.delete(legacy.key);
      return jsonResponse({ success: true, message: 'Session deleted' });
    }

    return jsonResponse({ error: 'Session not found' }, 404);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ==================== DATABASE HANDLERS (Per-User Isolated) ====================

// Save database file for a specific user
async function handleSaveDB(env, phone, key, data) {
  try {
    const dbKey = `db:${phone}:${key}`;
    await env.SESSION_KV.put(dbKey, JSON.stringify({
      data: data,
      updatedAt: Date.now()
    }));
    return jsonResponse({ success: true, key: key, phone: phone });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// Load database file for a specific user
async function handleLoadDB(env, phone, key) {
  try {
    const dbKey = `db:${phone}:${key}`;
    const data = await env.SESSION_KV.get(dbKey);
    if (!data) {
      return jsonResponse({ success: false, data: null });
    }
    const parsed = JSON.parse(data);
    return jsonResponse({ success: true, data: parsed.data });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// List all database files for a specific user
async function handleListDB(env, phone) {
  try {
    const list = await env.SESSION_KV.list({ prefix: `db:${phone}:` });
    const keys = list.keys.map(k => k.name.replace(`db:${phone}:`, ''));
    return jsonResponse({ success: true, keys: keys });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// Delete database file for a specific user
async function handleDeleteDB(env, phone, key) {
  try {
    const dbKey = `db:${phone}:${key}`;
    await env.SESSION_KV.delete(dbKey);
    return jsonResponse({ success: true, message: 'Database file deleted' });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// List all users (Admin only)
async function handleListUsers(env, adminKey) {
  const ADMIN_KEY = env.ADMIN_KEY || 'crysnova_admin_2026';

  if (adminKey !== ADMIN_KEY) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  try {
    const list = await env.SESSION_KV.list({ prefix: 'db:' });
    const users = new Set();

    for (const key of list.keys) {
      const match = key.name.match(/^db:([^:]+):/);
      if (match) {
        users.add(match[1]);
      }
    }

    return jsonResponse({ success: true, users: Array.from(users) });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ==================== MAIN HANDLER ====================

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ===== SESSION ROUTES =====
    // `/session/*` is the canonical contract; the unprefixed paths are supported
    // aliases used by existing clients. Both go through the same handler, so the
    // two families cannot drift apart.

    // GET /session/load/:shortId  (alias: GET /load/:shortId)
    if (method === 'GET') {
      const shortId = matchIdRoute(path, ['/session/load/', '/load/']);
      if (shortId !== null) return handleLoadSession(env, shortId);
    }

    // POST /session/save  (alias: POST /save)
    if (method === 'POST' && (path === '/session/save' || path === '/save')) {
      const body = await readJsonBody(request);
      if (!body) return jsonResponse({ error: 'Invalid JSON body' }, 400);
      return handleSaveSession(env, body.phone, body.sessionData);
    }

    // DELETE /session/delete/:shortId  (alias: DELETE /delete/:shortId)
    if (method === 'DELETE') {
      const shortId = matchIdRoute(path, ['/session/delete/', '/delete/']);
      if (shortId !== null) return handleDeleteSession(env, shortId);
    }

    // ===== DATABASE ROUTES (require phone number) =====

    // POST /db/save
    if (path === '/db/save' && method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || !body.phone || !body.key) {
        return jsonResponse({ error: 'Missing phone or key' }, 400);
      }
      return handleSaveDB(env, body.phone, body.key, body.data);
    }

    // POST /db/load
    if (path === '/db/load' && method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || !body.phone || !body.key) {
        return jsonResponse({ error: 'Missing phone or key' }, 400);
      }
      return handleLoadDB(env, body.phone, body.key);
    }

    // POST /db/list
    if (path === '/db/list' && method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || !body.phone) {
        return jsonResponse({ error: 'Missing phone' }, 400);
      }
      return handleListDB(env, body.phone);
    }

    // POST /db/delete
    if (path === '/db/delete' && method === 'POST') {
      const body = await readJsonBody(request);
      if (!body || !body.phone || !body.key) {
        return jsonResponse({ error: 'Missing phone or key' }, 400);
      }
      return handleDeleteDB(env, body.phone, body.key);
    }

    // ===== ADMIN ROUTES =====

    // GET /admin/users?key=xxx
    if (path === '/admin/users' && method === 'GET') {
      const adminKey = url.searchParams.get('key');
      return handleListUsers(env, adminKey);
    }

    // ===== ROOT =====
    if (path === '/' && method === 'GET') {
      return new Response(`CRYSNOVA Storage API (Per-User Isolated)

Session Endpoints:
  POST   /session/save       - Save session (body: { phone, sessionData })
  GET    /session/load/:id   - Load session by shortId or full sessionId
  DELETE /session/delete/:id - Delete session by shortId or full sessionId

  Aliases (identical handlers, kept for existing clients):
  POST   /save  |  GET /load/:id  |  DELETE /delete/:id

Database Endpoints (Per-User):
  POST   /db/save    - Save file (body: { phone, key, data })
  POST   /db/load    - Load file (body: { phone, key })
  POST   /db/list    - List files (body: { phone })
  POST   /db/delete  - Delete file (body: { phone, key })

Admin Endpoints:
  GET    /admin/users?key=ADMIN_KEY - List all users

Each user's data is completely isolated. No data sharing between bot instances.

Cloudflare KV Storage • CRYSNOVA AI`, {
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  }
};
