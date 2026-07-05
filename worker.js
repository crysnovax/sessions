// CRYSNOVA Session & Database Storage API
// Deploy to Cloudflare Workers with KV namespace "SESSION_KV"

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

function generateShortId() {
  return Math.random().toString(36).substring(2, 10);
}

// ==================== SESSION HANDLERS ====================

// Save session
async function handleSaveSession(env, phone, sessionData) {
  try {
    const shortId = generateShortId();
    const key = `session:${phone}:${shortId}`;
    
    await env.SESSION_KV.put(key, JSON.stringify({
      phone: phone,
      data: sessionData,
      createdAt: Date.now(),
      shortId: shortId
    }));
    
    return jsonResponse({
      success: true,
      sessionId: `CODY_AI!KV:${shortId}`,
      shortId: shortId
    });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// Load session
async function handleLoadSession(env, shortId) {
  try {
    // Search for session by shortId across all users
    const list = await env.SESSION_KV.list({ prefix: 'session:' });
    
    for (const key of list.keys) {
      const data = await env.SESSION_KV.get(key.name);
      if (data) {
        const parsed = JSON.parse(data);
        if (parsed.shortId === shortId) {
          return jsonResponse({
            success: true,
            sessionData: parsed.data,
            phone: parsed.phone,
            createdAt: parsed.createdAt
          });
        }
      }
    }
    
    return jsonResponse({ error: 'Session not found' }, 404);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// Delete session
async function handleDeleteSession(env, shortId) {
  try {
    const list = await env.SESSION_KV.list({ prefix: 'session:' });
    
    for (const key of list.keys) {
      const data = await env.SESSION_KV.get(key.name);
      if (data) {
        const parsed = JSON.parse(data);
        if (parsed.shortId === shortId) {
          await env.SESSION_KV.delete(key.name);
          return jsonResponse({ success: true, message: 'Session deleted' });
        }
      }
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
    
    // GET /session/load/:shortId
    if (path.startsWith('/session/load/') && method === 'GET') {
      const shortId = path.split('/')[3];
      if (!shortId) return jsonResponse({ error: 'Missing shortId' }, 400);
      return handleLoadSession(env, shortId);
    }
    
    // POST /session/save
    if (path === '/session/save' && method === 'POST') {
      const body = await request.json();
      if (!body.phone || !body.sessionData) {
        return jsonResponse({ error: 'Missing phone or sessionData' }, 400);
      }
      return handleSaveSession(env, body.phone, body.sessionData);
    }
    
    // DELETE /session/delete/:shortId
    if (path.startsWith('/session/delete/') && method === 'DELETE') {
      const shortId = path.split('/')[3];
      if (!shortId) return jsonResponse({ error: 'Missing shortId' }, 400);
      return handleDeleteSession(env, shortId);
    }
    
    // ===== DATABASE ROUTES (require phone number) =====
    
    // POST /db/save
    if (path === '/db/save' && method === 'POST') {
      const body = await request.json();
      if (!body.phone || !body.key) {
        return jsonResponse({ error: 'Missing phone or key' }, 400);
      }
      return handleSaveDB(env, body.phone, body.key, body.data);
    }
    
    // POST /db/load
    if (path === '/db/load' && method === 'POST') {
      const body = await request.json();
      if (!body.phone || !body.key) {
        return jsonResponse({ error: 'Missing phone or key' }, 400);
      }
      return handleLoadDB(env, body.phone, body.key);
    }
    
    // POST /db/list
    if (path === '/db/list' && method === 'POST') {
      const body = await request.json();
      if (!body.phone) {
        return jsonResponse({ error: 'Missing phone' }, 400);
      }
      return handleListDB(env, body.phone);
    }
    
    // POST /db/delete
    if (path === '/db/delete' && method === 'POST') {
      const body = await request.json();
      if (!body.phone || !body.key) {
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
    
    // ===== COMPATIBILITY (legacy endpoints with phone) =====
    
    // POST /save (legacy session)
    if (path === '/save' && method === 'POST') {
      const body = await request.json();
      return handleSaveSession(env, body.phone, body.sessionData);
    }
    
    // GET /load/:shortId (legacy session)
    if (path.startsWith('/load/') && method === 'GET') {
      const shortId = path.split('/')[2];
      return handleLoadSession(env, shortId);
    }
    
    // DELETE /delete/:shortId (legacy session)
    if (path.startsWith('/delete/') && method === 'DELETE') {
      const shortId = path.split('/')[2];
      return handleDeleteSession(env, shortId);
    }
    
    // ===== ROOT =====
    if (path === '/' && method === 'GET') {
      return new Response(`CRYSNOVA Storage API (Per-User Isolated)
    
Session Endpoints:
  POST   /session/save      - Save session (body: { phone, sessionData })
  GET    /session/load/:id  - Load session by shortId
  DELETE /session/delete/:id - Delete session

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
