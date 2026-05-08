/**
 * Isolated bundle: verifies rate-limit / lockout for POST /api/auth/verify-admin
 * (different env knobs than api.integration.test.js — must reset modules).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hey-verify-phase1-'));

process.env.HEY_TEST_MODE = '1';
process.env.HEY_DB_PATH = path.join(tmpDir, 'test.db');
process.env.HEY_CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env.HEY_ADMIN_TOKEN = 'phase1-verify-token';

process.env.HEY_VERIFY_ADMIN_RL_MAX = '6';
process.env.HEY_VERIFY_ADMIN_RL_WINDOW_MS = '300000';

/** High threshold so lockout does not dominate this scenario (tests rate-limit only). */
process.env.HEY_VERIFY_ADMIN_LOCKOUT_AFTER_FAILS = '999';

const request = require('supertest');
const app = require('../server');

describe('verify-admin phase-1 throttle', () => {
  test('successful verification starts with fresh budget when under limit', async () => {
    const res = await request(app)
      .post('/api/auth/verify-admin')
      .send({ password: 'phase1-verify-token' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('returns 429 after exceeding per-window attempts', async () => {
    const maxAllowed = Number(process.env.HEY_VERIFY_ADMIN_RL_MAX || 45);
    for (let i = 0; i < maxAllowed; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app)
        .post('/api/auth/verify-admin')
        .send({ password: 'nope' });
      expect(res.status).toBe(401);
    }
    const blocked = await request(app)
      .post('/api/auth/verify-admin')
      .send({ password: 'nope' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('VERIFY_ADMIN_RATE_LIMITED');
  });
});
