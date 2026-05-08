/**
 * Single HEY_ADMIN_TOKEN for all admin surfaces (legacy test name kept for CI filters).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hey-admin-single-'));
process.env.HEY_TEST_MODE = '1';
process.env.HEY_DB_PATH = path.join(tmpDir, 'split.db');
process.env.HEY_CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env.HEY_ADMIN_TOKEN = 'token-admin';

const request = require('supertest');
const app = require('../server');

const auth = { Authorization: 'Bearer token-admin' };

describe('admin token', () => {
  test('token mutates messages and opens training catalog', async () => {
    const ok = await request(app)
      .put('/api/messages/a1')
      .set(auth)
      .send({ text: 'x' });
    expect(ok.status).toBe(200);

    const catalog = await request(app).get('/api/training/audio-catalog').set(auth);
    expect(catalog.status).toBe(200);
    expect(catalog.body).toHaveProperty('inbox');
  });

  test('wrong token cannot mutate messages', async () => {
    const denied = await request(app)
      .put('/api/messages/a2')
      .set({ Authorization: 'Bearer wrong' })
      .send({ text: 'no' });
    expect(denied.status).toBe(401);
  });

  test('token opens OpenAPI YAML', async () => {
    const yaml = await request(app).get('/api/openapi.yaml').set(auth);
    expect(yaml.status).toBe(200);
    expect(yaml.text).toContain('bearerAuth:');
  });

  test('verify-admin accepts HEY_ADMIN_TOKEN (optional legacy audience ignored)', async () => {
    const m = await request(app)
      .post('/api/auth/verify-admin')
      .send({ password: 'token-admin' });
    expect(m.status).toBe(200);
    expect(m.body.audience).toBe('main');

    const legacy = await request(app)
      .post('/api/auth/verify-admin')
      .send({ password: 'token-admin', audience: 'training' });
    expect(legacy.status).toBe(200);
    expect(legacy.body.audience).toBe('main');
  });
});
