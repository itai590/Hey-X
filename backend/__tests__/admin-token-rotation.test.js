/**
 * Legacy Bearer strings must not authenticate main-admin routes; primary HEY_ADMIN_TOKEN works for verify-admin.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hey-no-rotation-'));
process.env.HEY_TEST_MODE = '1';
process.env.HEY_DB_PATH = path.join(tmpDir, 'rot.db');
process.env.HEY_CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env.HEY_ADMIN_TOKEN = 'current-secret';

const request = require('supertest');
const app = require('../server');

describe('Admin token (no previous overlap)', () => {
  test('legacy Bearer does not pass main admin auth', async () => {
    const res = await request(app)
      .put('/api/messages/rt1')
      .set({ Authorization: 'Bearer legacy-secret' })
      .send({ text: 'ok' });
    expect(res.status).toBe(401);
  });

  test('primary token passes verify-admin', async () => {
    const res = await request(app)
      .post('/api/auth/verify-admin')
      .send({ password: 'current-secret' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
