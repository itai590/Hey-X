/**
 * IANA timezone for `Intl` (logs via `format-display-time`, API responses that expose tz, training UI).
 * Prefer DISPLAY_TIME_ZONE; fall back to TZ (often set in Docker); default UTC.
 */
function displayTimeZone() {
  const z = String(
    process.env.DISPLAY_TIME_ZONE || process.env.TZ || 'UTC',
  ).trim();
  return z || 'UTC';
}

module.exports = displayTimeZone;
