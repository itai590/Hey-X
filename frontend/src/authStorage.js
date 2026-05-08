const KEY = 'hey-admin-token';
export const HEY_ADMIN_TOKEN_CHANGED = 'hey-admin-token-changed';

function notifyAdminTokenChanged(hasToken) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(HEY_ADMIN_TOKEN_CHANGED, { detail: { hasToken: !!hasToken } }));
}

export function getAdminToken() {
  try {
    return sessionStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}

export function setAdminToken(token) {
  try {
    if (token) sessionStorage.setItem(KEY, token);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* ignore quota / private mode */
  }
  notifyAdminTokenChanged(Boolean(token && String(token).trim()));
}

export function clearAdminToken() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  notifyAdminTokenChanged(false);
}
