import { afterEach, describe, expect, test, vi } from 'vitest';
import { apiUrl } from './apiBase';

/** Typical subpath deploy after `.env` interpolation (e.g. `PUBLIC_URL=/hey-x-${DOG_SLUG}` → `/hey-x-sheldon`). */
const SUBPATH_BASE = '/hey-x-sheldon';

describe('apiUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('without PUBLIC_URL (base = /) prepends /api', () => {
    vi.stubEnv('BASE_URL', '/');
    expect(apiUrl('/messages')).toBe('/api/messages');
    expect(apiUrl('config')).toBe('/api/config');
  });

  test('with subpath base (trailing slash) prefixes /api with deploy basename', () => {
    vi.stubEnv('BASE_URL', `${SUBPATH_BASE}/`);
    expect(apiUrl('/messages')).toBe(`${SUBPATH_BASE}/api/messages`);
  });

  test('with subpath base missing trailing slash still builds correct API path', () => {
    vi.stubEnv('BASE_URL', SUBPATH_BASE);
    expect(apiUrl('/messages')).toBe(`${SUBPATH_BASE}/api/messages`);
  });
});
