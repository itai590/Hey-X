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

const request = require('supertest');
const app = require('../server');

const authMain = { Authorization: 'Bearer token-main-surface' };
const authTraining = { Authorization: 'Bearer token-training-surface' };

describe('admin audience split', () => {
  test('main token mutates messages and can also open training catalog', async () => {
    const ok = await request(app)
      .put('/api/messages/a1')
      .set(authMain)
      .send({ text: 'x' });
    expect(ok.status).toBe(200);

    const allowTrainWithMain = await request(app).get('/api/training/audio-catalog').set(authMain);
    expect(allowTrainWithMain.status).toBe(200);
    expect(allowTrainWithMain.body).toHaveProperty('inbox');

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

  test('main token opens OpenAPI while training token does not', async () => {
    const yaml = await request(app).get('/api/openapi.yaml').set(authMain);
    expect(yaml.status).toBe(200);
    expect(yaml.text).toContain('bearerMainAuth:');
    expect(yaml.text).not.toContain('bearerTrainingAuth:');
    expect(yaml.text).toContain('- bearerMainAuth: []');
    expect(yaml.text).not.toContain('bearerDocsAuth:');

    const denyYaml = await request(app).get('/api/openapi.yaml').set(authTraining);
    expect(denyYaml.status).toBe(401);
  });

  test('verify-admin audience main vs training', async () => {
    const m = await request(app)
      .post('/api/auth/verify-admin')
      .send({ password: 'token-main-surface', audience: 'main' });
    expect(m.status).toBe(200);

    const allowMainOnTraining = await request(app)
      .post('/api/auth/verify-admin')
      .send({ password: 'token-main-surface', audience: 'training' });
    expect(allowMainOnTraining.status).toBe(200);

    const t = await request(app)
      .post('/api/auth/verify-admin')
      .send({ password: 'token-training-surface', audience: 'training' });
    expect(t.status).toBe(200);
  });
});
