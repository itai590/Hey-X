import { afterEach, describe, expect, test, vi } from 'vitest';
import { apiUrl, trainingListenPageUrl } from './apiBase';

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

describe('trainingListenPageUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('without VITE_BACKEND_ORIGIN uses apiUrl /api/training/listen', () => {
    vi.stubEnv('BASE_URL', '/');
    expect(trainingListenPageUrl()).toBe('/api/training/listen');
  });

  test('with subpath base includes basename before /api/training/listen', () => {
    vi.stubEnv('BASE_URL', `${SUBPATH_BASE}/`);
    expect(trainingListenPageUrl()).toBe(`${SUBPATH_BASE}/api/training/listen`);
  });

  test('with VITE_BACKEND_ORIGIN points at bare backend origin (not SPA host)', () => {
    vi.stubEnv('BASE_URL', '/');
    vi.stubEnv('VITE_BACKEND_ORIGIN', 'http://api.example.test:5100');
    expect(trainingListenPageUrl()).toBe('http://api.example.test:5100/api/training/listen');
  });

  test('VITE_BACKEND_ORIGIN trims trailing slash', () => {
    vi.stubEnv('BASE_URL', '/');
    vi.stubEnv('VITE_BACKEND_ORIGIN', 'http://api.example.test:5100/');
    expect(trainingListenPageUrl()).toBe('http://api.example.test:5100/api/training/listen');
  });
});
