const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * persistent-logging.install() patches global console and registers process signal
 * handlers, so each test loads a fresh module copy, snapshots console, and restores it.
 */
function withInstalledLogging(env, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hey-logrotate-'));
  const originalConsole = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    originalConsole[level] = console[level];
  }
  const savedEnv = {};
  for (const key of Object.keys(env)) {
    savedEnv[key] = process.env[key];
    process.env[key] = env[key];
  }
  delete process.env.HEY_TEST_MODE;
  process.env.HEY_LOG_DIR = tmpDir;

  jest.resetModules();
  const { install } = require('../persistent-logging');
  let handle = { close: () => {} };
  try {
    handle = install();
    fn(tmpDir);
  } finally {
    handle.close();
    for (const level of Object.keys(originalConsole)) {
      console[level] = originalConsole[level];
    }
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    delete process.env.HEY_LOG_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('persistent-logging rotation', () => {
  test('rotates backend.log once it exceeds HEY_LOG_MAX_BYTES and keeps N files', () => {
    withInstalledLogging(
      { HEY_LOG_MAX_BYTES: '512', HEY_LOG_KEEP_FILES: '2' },
      (dir) => {
        const big = 'x'.repeat(200);
        for (let i = 0; i < 40; i++) console.log(big);

        const files = fs.readdirSync(dir).filter((f) => f.startsWith('backend.log'));
        expect(files).toContain('backend.log');
        expect(files).toContain('backend.log.1');
        // keepFiles=2 → at most backend.log + .1 + .2
        expect(files).toContain('backend.log.2');
        expect(files).not.toContain('backend.log.3');

        const liveSize = fs.statSync(path.join(dir, 'backend.log')).size;
        expect(liveSize).toBeLessThanOrEqual(512 + 300);
      },
    );
  });

  test('does not rotate when under the size limit', () => {
    withInstalledLogging(
      { HEY_LOG_MAX_BYTES: '1048576', HEY_LOG_KEEP_FILES: '5' },
      (dir) => {
        console.log('a small line');
        const files = fs.readdirSync(dir).filter((f) => f.startsWith('backend.log'));
        expect(files).toEqual(['backend.log']);
      },
    );
  });
});
