const KEY = 'hey-admin-token';

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
}

export function clearAdminToken() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
