/**
 * HEY_ADMIN_TOKEN_PREVIOUS overlap (isolated env).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hey-rotation-'));
process.env.HEY_TEST_MODE = '1';
process.env.HEY_DB_PATH = path.join(tmpDir, 'rot.db');
process.env.HEY_CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env.HEY_ADMIN_TOKEN = 'new-shared-secret';
process.env.HEY_ADMIN_TOKEN_PREVIOUS = 'legacy-secret';

const request = require('supertest');
const app = require('../server');

describe('Admin token rotation', () => {
  test('Bearer HEY_ADMIN_TOKEN_PREVIOUS passes main admin auth', async () => {
    const res = await request(app)
      .put('/api/messages/rt1')
      .set({ Authorization: 'Bearer legacy-secret' })
      .send({ text: 'ok' });
    expect(res.status).toBe(200);
  });

  test('Bearer primary token passes', async () => {
    const res = await request(app)
      .post('/api/auth/verify-admin')
      .send({ password: 'new-shared-secret' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
