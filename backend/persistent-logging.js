const fs = require('fs');
const path = require('path');
const util = require('util');
const { formatDisplayDateTime } = require('./format-display-time');

/**
 * Tee console.* to a file under HEY_LOG_DIR (e.g. /var/log/hey/backend.log) so logs survive container restarts.
 * Skipped when HEY_TEST_MODE=1 or HEY_LOG_DIR is unset.
 */
function install() {
  if (process.env.HEY_TEST_MODE === '1') return;
  const dir = (process.env.HEY_LOG_DIR || '').trim();
  if (!dir) return;

  let stream;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const logFile = path.join(dir, 'backend.log');
    stream = fs.createWriteStream(logFile, { flags: 'a' });
    stream.write(`\n--- ${formatDisplayDateTime(new Date())} pid=${process.pid} started ---\n`);
  } catch (err) {
    process.stderr.write(
      `[${formatDisplayDateTime(new Date())}] [persistent-logging] cannot open log dir ${dir}: ${err.message}\n`,
    );
    return;
  }

  const levels = ['log', 'info', 'warn', 'error', 'debug'];
  for (const level of levels) {
    if (typeof console[level] !== 'function') continue;
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      try {
        stream.write(`[${formatDisplayDateTime(new Date())}] [${level}] ${util.format(...args)}\n`);
      } catch (_) {
        /* ignore */
      }
    };
  }

  const shutdown = () => {
    try {
      stream.end(`--- ${formatDisplayDateTime(new Date())} pid=${process.pid} exiting ---\n`);
    } catch (_) {
      /* ignore */
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

module.exports = { install };
