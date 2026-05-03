
function extraDomainsFromEnv() {
  const p = (import.meta.env.VITE_PRIMARY_DOMAIN || '').trim();
  return p ? [p] : [];
}

/**
 * Same URL prefix as Vite `base` / nginx / docker compose build args (e.g. `/hey-x-<DOG_SLUG>`).
 * `DOG_NAME` from `/api/config` is display-only and does not drive routing without matching rebuild.
 * `import.meta.env.BASE_URL` is always '/' or '/path/' (trailing slash) — strip it.
 */
function mainPathFromPublicUrl() {
  const u = (import.meta.env.BASE_URL || '/').trim();
  if (!u || u === '/' || u === './') return '/';
  return u.replace(/\/+$/, '') || '/';
}

const config = {
  /**
   * Apex suffixes for App.js hub/document routing. Not CORS/nginx.
   * `localhost` and `127.0.0.1` are handled in App.js.
   */
  extraDomains: extraDomainsFromEnv(),
  mainPath: mainPathFromPublicUrl(),
};

export default config;
