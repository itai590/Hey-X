import { apiUrl } from './apiBase';
import { getAdminToken } from './authStorage';

/** Dispatched after a mutating request returns 401 (listeners can open the login dialog). */
export const HEY_ADMIN_UNAUTHORIZED = 'hey-admin-unauthorized';

export function getAuthHeaders() {
  const t = getAdminToken().trim();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/**
 * @param {string} path Path after /api, e.g. '/config' or '/messages'
 * @param {RequestInit & { json?: unknown }} opts
 */
export async function apiFetch(path, opts = {}) {
  const { json, method = 'GET', headers: hdrs = {}, ...rest } = opts;
  const headers = { ...getAuthHeaders(), ...hdrs };
  let body = rest.body;
  if (json !== undefined) {
    body = JSON.stringify(json);
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
  }
  const res = await fetch(apiUrl(path), {
    ...rest,
    method,
    headers,
    body,
  });
  const m = (method || 'GET').toUpperCase();
  if (res.status === 401 && !['GET', 'HEAD', 'OPTIONS'].includes(m)) {
    window.dispatchEvent(new CustomEvent(HEY_ADMIN_UNAUTHORIZED));
  }
  return res;
}
