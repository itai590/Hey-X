/**
 * Helpers are inlined in server.js; `adminSecurityForTests` exists only when HEY_TEST_MODE=1.
 * When this file runs alone, seeds minimal env; when run after other suites, reuses cached server.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.HEY_DB_PATH) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hey-adminsec-unit-'));
  process.env.HEY_TEST_MODE = '1';
  process.env.HEY_DB_PATH = path.join(tmpDir, 'adminsec.db');
  process.env.HEY_CONFIG_PATH = path.join(tmpDir, 'config.json');
}

const app = require('../server');
const as = app.adminSecurityForTests;
if (!as) {
  throw new Error('Expected app.adminSecurityForTests (run with HEY_TEST_MODE=1)');
}
const {
  adminCredentialMatches,
  createHttpsMiddleware,
  createVerifyAdminGuard,
  isPrivateLanIpv4Address,
  shouldBypassDocsAdminForTrustedLan,
} = as;

describe('adminCredentialMatches', () => {
  test('matches primary token', () => {
    expect(adminCredentialMatches('abc', 'abc')).toBe(true);
    expect(adminCredentialMatches('wrong', 'abc')).toBe(false);
  });
});

describe('isPrivateLanIpv4Address', () => {
  test('accepts RFC1918 and APIPA forms', () => {
    expect(isPrivateLanIpv4Address('192.168.148.114')).toBe(true);
    expect(isPrivateLanIpv4Address('::ffff:192.168.0.1')).toBe(true);
    expect(isPrivateLanIpv4Address('10.0.0.2')).toBe(true);
    expect(isPrivateLanIpv4Address('172.20.1.1')).toBe(true);
    expect(isPrivateLanIpv4Address('169.254.3.4')).toBe(true);
  });
  test('rejects public and non-IPv4', () => {
    expect(isPrivateLanIpv4Address('203.0.113.1')).toBe(false);
    expect(isPrivateLanIpv4Address('172.32.1.1')).toBe(false);
    expect(isPrivateLanIpv4Address('fe80::1')).toBe(false);
    expect(isPrivateLanIpv4Address('')).toBe(false);
  });
});

describe('createHttpsMiddleware trustLan', () => {
  test('allows HTTP when TCP peer is private LAN and trustLan is on', () => {
    const mw = createHttpsMiddleware(true, { trustLoopback: false, trustLan: true });
    const req = {
      secure: false,
      headers: {},
      socket: { remoteAddress: '192.168.1.5' },
      ip: '203.0.113.99',
    };
    let nextCalled = false;
    mw(req, {}, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });
  test('HTTPS still required for public TCP peer when trustLan is on', () => {
    const mw = createHttpsMiddleware(true, { trustLoopback: false, trustLan: true });
    const req = {
      secure: false,
      headers: {},
      socket: { remoteAddress: '198.51.100.22' },
    };
    const res = {
      statusCode: 0,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(_b) {},
    };
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(403);
  });
  test('does not treat spoofed req.ip as LAN (uses socket only)', () => {
    const mw = createHttpsMiddleware(true, { trustLoopback: false, trustLan: true });
    const req = {
      secure: false,
      headers: { 'x-forwarded-for': '192.168.99.99' },
      ip: '192.168.99.99',
      socket: { remoteAddress: '198.51.100.22' },
    };
    const res = {
      statusCode: 0,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(_b) {},
    };
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
  });
});

describe('shouldBypassDocsAdminForTrustedLan', () => {
  test('allows bypass when trustLan + adminActive and TCP peer is RFC1918', () => {
    const req = { socket: { remoteAddress: '192.168.1.5' } };
    expect(
      shouldBypassDocsAdminForTrustedLan(req, { trustLan: true, adminActive: true }),
    ).toBe(true);
  });
  test('no bypass when trustLan off', () => {
    const req = { socket: { remoteAddress: '192.168.1.5' } };
    expect(
      shouldBypassDocsAdminForTrustedLan(req, { trustLan: false, adminActive: true }),
    ).toBe(false);
  });
  test('no bypass when admin not configured', () => {
    const req = { socket: { remoteAddress: '192.168.1.5' } };
    expect(
      shouldBypassDocsAdminForTrustedLan(req, { trustLan: true, adminActive: false }),
    ).toBe(false);
  });
  test('no bypass for public TCP peer', () => {
    const req = { socket: { remoteAddress: '198.51.100.1' } };
    expect(
      shouldBypassDocsAdminForTrustedLan(req, { trustLan: true, adminActive: true }),
    ).toBe(false);
  });
});

describe('createVerifyAdminGuard', () => {
  test('lockout after failures without consuming budget after lock engages', () => {
    const g = createVerifyAdminGuard({
      windowMs: 60_000,
      maxAttempts: 999,
      lockoutAfterFails: 2,
      lockoutBaseMs: 3600_000,
      lockoutMaxMs: 7200_000,
    });
    const key = 'k1';

    expect(g.checkAllowed(key).ok).toBe(true);
    g.recordFailure(key);
    expect(g.checkAllowed(key).ok).toBe(true);
    g.recordFailure(key);
    const afterLock = g.checkAllowed(key);
    expect(afterLock.ok).toBe(false);
    expect(afterLock.reason).toBe('locked_out');
  });

  test('recordSuccess resets lock and rate buckets', () => {
    const g = createVerifyAdminGuard({
      windowMs: 60_000,
      maxAttempts: 2,
      lockoutAfterFails: 999,
      lockoutBaseMs: 1000,
      lockoutMaxMs: 2000,
    });
    const key = 'k2';
    expect(g.checkAllowed(key).ok).toBe(true);
    expect(g.checkAllowed(key).ok).toBe(true);
    expect(g.checkAllowed(key).ok).toBe(false);
    g.recordSuccess(key);
    expect(g.checkAllowed(key).ok).toBe(true);
  });
});
