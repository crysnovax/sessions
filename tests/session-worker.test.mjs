import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { validateSessionData } from '../worker.js';

const legacyCreds = JSON.stringify({
  noiseKey: { private: 'secret' },
  me: { id: '123:1@s.whatsapp.net' },
  myAppStateKeyId: 'key-id-only'
});

const authBundle = {
  version: 1,
  files: {
    'creds.json': JSON.stringify({ me: { id: '123:1@s.whatsapp.net' } }),
    'app-state-sync-key-key-id.json': JSON.stringify({ keyData: 'encrypted-key' }),
    'session-123.json': JSON.stringify({ session: true })
  }
};

test('rejects credentials-only sessions', () => {
  assert.throws(
    () => validateSessionData(legacyCreds),
    /credentials-only sessions are not supported/
  );
});

test('accepts a complete multi-file auth bundle', () => {
  const normalized = validateSessionData(authBundle);
  assert.deepEqual(JSON.parse(normalized), authBundle);
});

test('accepts CODY_AI base64-encoded auth bundles', () => {
  const encoded = `CODY_AI!${Buffer.from(JSON.stringify(authBundle)).toString('base64')}`;
  const normalized = validateSessionData(encoded);
  assert.deepEqual(JSON.parse(normalized), authBundle);
});

test('save endpoint rejects incomplete sessions before writing KV', async () => {
  let writes = 0;
  const response = await worker.fetch(
    new Request('https://example.test/session/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '+15551234567', sessionData: legacyCreds })
    }),
    { SESSION_KV: { put: async () => { writes++; } } }
  );

  assert.equal(response.status, 422);
  assert.equal(writes, 0);
  assert.match((await response.json()).error, /app-state-sync-key/);
});

test('save endpoint stores complete auth bundles', async () => {
  let saved;
  const response = await worker.fetch(
    new Request('https://example.test/session/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: '+15551234567', sessionData: authBundle })
    }),
    { SESSION_KV: { put: async (_key, value) => { saved = JSON.parse(value); } } }
  );

  assert.equal(response.status, 200);
  assert.equal(saved.data, JSON.stringify(authBundle));
  assert.equal(saved.phone, '+15551234567');
});
