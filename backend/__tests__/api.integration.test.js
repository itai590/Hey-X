/**
 * API + SQLite integration tests. Requires env before loading server (see load order below).
 * Run: cd backend && npm test
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hey-api-test-'));
process.env.HEY_TEST_MODE = '1';
process.env.HEY_DB_PATH = path.join(tmpDir, 'test.db');
process.env.HEY_CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env.HEY_ADMIN_TOKEN = 'jest-admin-token';

const request = require('supertest');
const app = require('../server');
const db = require('../db');
const hey = require('../hey');
const syncHey = require('../sync-hey');
const { PRESENCE_ROW_ID } = require('../constants');

const auth = { Authorization: 'Bearer jest-admin-token' };

describe('SQLite schema', () => {
  test('messages table columns', () => {
    const cols = db.prepare(`PRAGMA table_info(messages)`).all();
    const names = cols.map((c) => c.name).sort();
    expect(new Set(names)).toEqual(new Set(['create_time', 'id', 'text', 'update_time']));
  });

  test('presence table columns', () => {
    const cols = db.prepare(`PRAGMA table_info(presence)`).all();
    const names = cols.map((c) => c.name).sort();
    expect(new Set(names)).toEqual(new Set(['id', 'last_update']));
  });
});

describe('Auth API', () => {
  test('POST /api/auth/verify-admin rejects wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/verify-admin')
      .send({ password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.needsAdminAuth).toBe(true);
  });

  test('POST /api/auth/verify-admin accepts correct password', async () => {
    const res = await request(app)
      .post('/api/auth/verify-admin')
      .send({ password: 'jest-admin-token' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('Messages API', () => {
  test('GET /api/messages starts empty', async () => {
    const res = await request(app).get('/api/messages');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  test('PUT /api/messages/:id requires auth', async () => {
    const res = await request(app)
      .put('/api/messages/e1')
      .send({ text: 'Woof!' });
    expect(res.status).toBe(401);
  });

  test('PUT /api/messages/:id creates row', async () => {
    const res = await request(app)
      .put('/api/messages/e1')
      .set(auth)
      .send({ text: 'Woof!' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const row = db.prepare(`SELECT * FROM messages WHERE id = ?`).get('e1');
    expect(row.text).toBe('Woof!');
  });

  test('GET /api/messages returns persisted messages', async () => {
    const res = await request(app).get('/api/messages');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].id).toBe('e1');
  });

  test('DELETE /api/messages requires auth', async () => {
    const res = await request(app)
      .delete('/api/messages')
      .send({ ids: ['e1'] });
    expect(res.status).toBe(401);
  });

  test('DELETE /api/messages removes rows', async () => {
    const res = await request(app)
      .delete('/api/messages')
      .set(auth)
      .send({ ids: ['e1'] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);

    const n = db.prepare(`SELECT COUNT(*) AS c FROM messages`).get().c;
    expect(n).toBe(0);
  });

  test('DELETE /api/messages validates body', async () => {
    const res = await request(app)
      .delete('/api/messages')
      .set(auth)
      .send({ ids: [] });
    expect(res.status).toBe(400);
  });
});

describe('Config API', () => {
  test('GET /api/config returns defaults merged shape', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(typeof res.body.BARK_CONFIDENCE_THRESHOLD).toBe('number');
    expect(typeof res.body.MIC_MUTED).toBe('boolean');
    expect(typeof res.body.DOG_NAME).toBe('string');
  });

  test('PUT /api/config rejects unknown keys', async () => {
    const res = await request(app)
      .put('/api/config')
      .set(auth)
      .send({ NOT_A_KEY: true });
    expect(res.status).toBe(400);
  });

  test('PUT /api/config applies allowed updates', async () => {
    const res = await request(app)
      .put('/api/config')
      .set(auth)
      .send({ DOG_NAME: ' TestDog ', DETECTION_THRESHOLD: 3 });
    expect(res.status).toBe(200);
    expect(res.body.DOG_NAME).toBe('TestDog');
    expect(res.body.DETECTION_THRESHOLD).toBe(3);
  });
});

describe('Presence API', () => {
  test('GET /api/presence shape', async () => {
    const res = await request(app).get('/api/presence');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('serverTime');
    expect(res.body).toHaveProperty('micMuted');
    expect(res.body).toHaveProperty('heartbeat');
  });
});

describe('Custom head API', () => {
  test('GET /api/custom-head/status', async () => {
    const res = await request(app).get('/api/custom-head/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('clips');
    expect(res.body.clips).toHaveProperty('bark');
    expect(res.body.clips).toHaveProperty('not_bark');
  });
});

describe('Training inbox API', () => {
  test('GET /api/training/inbox requires admin', async () => {
    const res = await request(app).get('/api/training/inbox');
    expect(res.status).toBe(401);
  });

  test('GET /api/training/inbox with auth returns list shape', async () => {
    const res = await request(app).get('/api/training/inbox').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('clips');
    expect(res.body).toHaveProperty('inboxEnabled');
    expect(Array.isArray(res.body.clips)).toBe(true);
  });

  test('GET /api/training/inbox/:clipId/wav-meta rejects bad clip id', async () => {
    const res = await request(app)
      .get('/api/training/inbox/bad-id/wav-meta')
      .set(auth);
    expect(res.status).toBe(400);
  });

  test('GET /api/training/inbox/:clipId/audio rejects bad clip id', async () => {
    const res = await request(app)
      .get('/api/training/inbox/bad-id/audio')
      .set(auth);
    expect(res.status).toBe(400);
  });

  test('DELETE /api/training/inbox/:clipId rejects bad clip id', async () => {
    const res = await request(app)
      .delete('/api/training/inbox/not-uuid')
      .set(auth);
    expect(res.status).toBe(400);
  });
});

describe('OpenAPI', () => {
  test('GET /api/openapi.yaml returns YAML', async () => {
    const res = await request(app).get('/api/openapi.yaml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type'] || '').toMatch(/yaml/);
    expect(res.text).toContain('openapi:');
    expect(res.text).toMatch(/title:\s*Hey(\s+[^\n]+)?\s+API/);
  });

  test('GET /api/docs serves Swagger UI page', async () => {
    const res = await request(app).get('/api/docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type'] || '').toMatch(/html/);
    expect(res.text.toLowerCase()).toContain('swagger');
    expect(res.text).toContain('heySwaggerPm');
  });
});

describe('Training WAV review (HTTP)', () => {
  test('GET /api/training/listen serves HTML', async () => {
    const res = await request(app).get('/api/training/listen');
    expect(res.status).toBe(200);
    expect(res.headers['content-type'] || '').toMatch(/html/);
    expect(res.text).toContain('WAV review');
    expect(res.text).not.toContain('__DISPLAY_TIME_ZONE_HTML__');
    expect(res.text).not.toContain('__DISPLAY_TIME_ZONE_JSON__');
  });

  test('GET /api/training/audio-catalog requires admin', async () => {
    const res = await request(app).get('/api/training/audio-catalog');
    expect(res.status).toBe(401);
  });

  test('GET /api/training/audio-catalog with auth returns shape', async () => {
    const res = await request(app).get('/api/training/audio-catalog').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('adminRequired');
    expect(res.body).toHaveProperty('inbox');
    expect(res.body).toHaveProperty('micTemp');
    expect(res.body).toHaveProperty('custom');
    expect(res.body.custom).toHaveProperty('bark');
    expect(res.body.custom).toHaveProperty('not_bark');
    expect(Array.isArray(res.body.inbox)).toBe(true);
    expect(Array.isArray(res.body.micTemp)).toBe(true);
  });

  test('GET /api/training/mic-temp rejects invalid filename', async () => {
    const res = await request(app)
      .get('/api/training/mic-temp/not-a-clip.wav/audio')
      .set(auth);
    expect(res.status).toBe(400);
  });

  test('GET /api/training/custom-clips rejects bad label', async () => {
    const res = await request(app)
      .get('/api/training/custom-clips/other/clip.wav/audio')
      .set(auth);
    expect(res.status).toBe(400);
  });
});

describe('hey.send / syncHey (manual scripts → Jest)', () => {
  describe('hey.send bark aggregation', () => {
    beforeEach(() => {
      db.prepare('DELETE FROM messages').run();
      jest.useFakeTimers();
      hey.setAggrTime(60);
    });

    afterEach(() => {
      jest.advanceTimersByTime(61 * 1000);
      jest.useRealTimers();
    });

    test('three sequential sends aggregate into one row (test-hey.js)', async () => {
      await hey.send();
      await hey.send();
      await hey.send();

      const rows = db.prepare('SELECT id, text FROM messages ORDER BY create_time').all();
      expect(rows.length).toBe(1);
      expect(rows[0].text).toBe('Woof! Woof! Woof!');
    });
  });

  test('syncHey updates presence heartbeat row (test-sync-hey.js)', () => {
    const before = db.prepare(`SELECT last_update FROM presence WHERE id = ?`).get(PRESENCE_ROW_ID);

    syncHey();

    const after = db.prepare(`SELECT last_update FROM presence WHERE id = ?`).get(PRESENCE_ROW_ID);
    expect(after).toBeTruthy();
    if (before && before.last_update) {
      expect(new Date(after.last_update).getTime()).toBeGreaterThanOrEqual(
        new Date(before.last_update).getTime(),
      );
    }
  });
});
