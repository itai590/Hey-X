
export function apiUrl(path) {
  const prefix = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (!prefix) {
    return `/api${normalized}`;
  }
  return `${prefix}/api${normalized}`;
}
