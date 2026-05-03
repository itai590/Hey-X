const { formatDisplayDateTime } = require('./format-display-time');

/**
 * Prefix every console.log/info/warn/error/debug line with `[DISPLAY_TIME d/m/y, HH:MM:SS] [level]`.
 * Skipped in tests (`HEY_TEST_MODE` / `NODE_ENV=test`). Install before `persistent-logging`.
 */
function install() {
  if (process.env.HEY_TEST_MODE === '1') return;
  if (process.env.NODE_ENV === 'test') return;

  const levels = ['log', 'info', 'warn', 'error', 'debug'];
  for (const level of levels) {
    if (typeof console[level] !== 'function') continue;
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      const ts = formatDisplayDateTime(new Date());
      orig(`[${ts}] [${level}]`, ...args);
    };
  }
}

module.exports = { install };
