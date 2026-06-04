export function apiUrl(path) {
  const prefix = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (!prefix) {
    return `/api${normalized}`;
  }
  return `${prefix}/api${normalized}`;
}

/**
 * Bare backend HTTP origin when the Express API listens on another host/port than the SPA
 * When the API listens on another origin than the SPA (e.g. different host or port). Leave unset to use same-origin
 * `/api` (Vite proxy, nginx, or subpath BASE_URL).
 */
export function backendOriginFromEnv() {
  return (import.meta.env.VITE_BACKEND_ORIGIN || '').trim().replace(/\/+$/, '');
}

/** `GET /api/training/listen` — standalone WAV review HTML (not the React SPA). */
export function trainingListenPageUrl() {
  const origin = backendOriginFromEnv();
  if (origin) {
    return `${origin}/api/training/listen`;
  }
  return apiUrl('/training/listen');
}
