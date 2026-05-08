const {
  adminCredentialMatches,
  createVerifyAdminGuard,
} = require('../admin-security-phase1');

describe('adminCredentialMatches', () => {
  test('matches primary token', () => {
    expect(adminCredentialMatches('abc', 'abc', '')).toBe(true);
    expect(adminCredentialMatches('abc', 'abc', 'old')).toBe(true);
  });
  test('matches previous rotation token only', () => {
    expect(adminCredentialMatches('oldsecret', 'newsecret', 'oldsecret')).toBe(true);
    expect(adminCredentialMatches('wrong', 'newsecret', 'oldsecret')).toBe(false);
  });
  test('empty previous is ignored', () => {
    expect(adminCredentialMatches('oldsecret', 'newsecret', '   ')).toBe(false);
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
