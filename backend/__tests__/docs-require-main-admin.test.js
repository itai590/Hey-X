/**
 * OpenAPI/docs require HEY_ADMIN_TOKEN when configured.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hey-docs-main-'));
process.env.HEY_TEST_MODE = '1';
process.env.HEY_DB_PATH = path.join(tmpDir, 'docs.db');
process.env.HEY_CONFIG_PATH = path.join(tmpDir, 'config.json');
delete process.env.HEY_ADMIN_TOKEN;
delete process.env.ADMIN_TOKEN;

const request = require('supertest');
const app = require('../server');

describe('docs surfaces require HEY_ADMIN_TOKEN', () => {
  test('GET /api/openapi.yaml returns 401 when admin token unset', async () => {
    const res = await request(app).get('/api/openapi.yaml');
    expect(res.status).toBe(401);
    expect(res.body.needsAdminAuth).toBe(true);
  });
});
