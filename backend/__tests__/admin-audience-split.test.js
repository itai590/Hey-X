/**
 * Separate HEY_* admin tokens per surface (isolated env).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hey-audience-split-'));
process.env.HEY_TEST_MODE = '1';
process.env.HEY_DB_PATH = path.join(tmpDir, 'split.db');
process.env.HEY_CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env.HEY_ADMIN_TOKEN = 'token-main-surface';
process.env.HEY_TRAINING_ADMIN_TOKEN = 'token-training-surface';
process.env.HEY_DOCS_ADMIN_TOKEN = 'token-docs-surface';

const request = require('supertest');
const app = require('../server');

const authMain = { Authorization: 'Bearer token-main-surface' };
const authTraining = { Authorization: 'Bearer token-training-surface' };
const authDocs = { Authorization: 'Bearer token-docs-surface' };

describe('admin audience split', () => {
  test('main token mutates messages but not training catalog', async () => {
    const ok = await request(app)
      .put('/api/messages/a1')
      .set(authMain)
      .send({ text: 'x' });
    expect(ok.status).toBe(200);

    const denyTrain = await request(app).get('/api/training/audio-catalog').set(authMain);
    expect(denyTrain.status).toBe(401);

    const allowTrain = await request(app).get('/api/training/audio-catalog').set(authTraining);
    expect(allowTrain.status).toBe(200);
    expect(allowTrain.body).toHaveProperty('inbox');
  });

  test('training token cannot mutate messages', async () => {
    const denied = await request(app)
      .put('/api/messages/a2')
      .set(authTraining)
      .send({ text: 'no' });
    expect(denied.status).toBe(401);
  });

  test('docs token opens OpenAPI but not messages', async () => {
    const yaml = await request(app).get('/api/openapi.yaml').set(authDocs);
    expect(yaml.status).toBe(200);

    const denyMsg = await request(app)
      .delete('/api/messages')
      .set(authDocs)
      .send({ ids: ['a1'] });
    expect(denyMsg.status).toBe(401);
  });

  test('verify-admin audience main vs training vs docs', async () => {
    const m = await request(app)
      .post('/api/auth/verify-admin')
      .send({ password: 'token-main-surface', audience: 'main' });
    expect(m.status).toBe(200);

    const denyMainOnTraining = await request(app)
      .post('/api/auth/verify-admin')
      .send({ password: 'token-main-surface', audience: 'training' });
    expect(denyMainOnTraining.status).toBe(401);

    const t = await request(app)
      .post('/api/auth/verify-admin')
      .send({ password: 'token-training-surface', audience: 'training' });
    expect(t.status).toBe(200);

    const d = await request(app)
      .post('/api/auth/verify-admin')
      .send({ password: 'token-docs-surface', audience: 'docs' });
    expect(d.status).toBe(200);
  });
});
