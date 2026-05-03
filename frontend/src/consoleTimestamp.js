import { formatConsoleTimestamp } from './formatDisplayTime';

/**
 * Prefix browser console.log/info/warn/error/debug with `[d/m/y, HH:MM:SS] [level]` (VITE_TZ).
 * Disabled under Vitest (`import.meta.env.MODE === 'test'`).
 */
function installConsoleTimestamp() {
  if (import.meta.env.MODE === 'test') return;

  const levels = ['log', 'info', 'warn', 'error', 'debug'];
  for (const level of levels) {
    if (typeof console[level] !== 'function') continue;
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      const ts = formatConsoleTimestamp(new Date());
      orig(`[${ts}] [${level}]`, ...args);
    };
  }
}

installConsoleTimestamp();
