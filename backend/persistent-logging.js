const fs = require('fs');
const path = require('path');
const util = require('util');
const { formatDisplayDateTime } = require('./format-display-time');

/** Parse a positive integer env var, falling back when unset/empty/invalid. */
function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Tee console.* to a file under HEY_LOG_DIR (e.g. /var/log/hey/backend.log) so logs survive
 * container restarts, with size-based rotation so the file never grows unbounded.
 *
 * Retention is bounded by HEY_LOG_MAX_BYTES (per file) * (HEY_LOG_KEEP_FILES + 1) total.
 * Synchronous fd writes keep rotation deterministic and avoid async stream error events.
 * Skipped when HEY_TEST_MODE=1 or HEY_LOG_DIR is unset.
 *
 * @returns {{ close: () => void }} handle to flush/close the log file (used by tests/shutdown).
 */
function install() {
  const noop = { close: () => {} };
  if (process.env.HEY_TEST_MODE === '1') return noop;
  const dir = (process.env.HEY_LOG_DIR || '').trim();
  if (!dir) return noop;

  const maxBytes = envPositiveInt('HEY_LOG_MAX_BYTES', 10 * 1024 * 1024);
  const keepFiles = envPositiveInt('HEY_LOG_KEEP_FILES', 5);
  const logFile = path.join(dir, 'backend.log');

  let fd;
  let written = 0;

  function openFile() {
    fd = fs.openSync(logFile, 'a');
    try {
      written = fs.statSync(logFile).size;
    } catch (_) {
      written = 0;
    }
  }

  // Shift backend.log -> backend.log.1 -> ... -> backend.log.N, dropping the oldest.
  function rotate() {
    try {
      fs.closeSync(fd);
    } catch (_) {
      /* ignore */
    }
    try {
      fs.unlinkSync(`${logFile}.${keepFiles}`);
    } catch (_) {
      /* ignore */
    }
    for (let i = keepFiles - 1; i >= 1; i--) {
      try {
        fs.renameSync(`${logFile}.${i}`, `${logFile}.${i + 1}`);
      } catch (_) {
        /* ignore */
      }
    }
    try {
      fs.renameSync(logFile, `${logFile}.1`);
    } catch (_) {
      /* ignore */
    }
    openFile();
  }

  function writeLine(line) {
    const len = Buffer.byteLength(line);
    if (written + len > maxBytes && written > 0) rotate();
    fs.writeSync(fd, line);
    written += len;
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    openFile();
    writeLine(`\n--- ${formatDisplayDateTime(new Date())} pid=${process.pid} started ---\n`);
  } catch (err) {
    process.stderr.write(
      `[${formatDisplayDateTime(new Date())}] [persistent-logging] cannot open log dir ${dir}: ${err.message}\n`,
    );
    return noop;
  }

  const levels = ['log', 'info', 'warn', 'error', 'debug'];
  for (const level of levels) {
    if (typeof console[level] !== 'function') continue;
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      try {
        writeLine(`[${formatDisplayDateTime(new Date())}] [${level}] ${util.format(...args)}\n`);
      } catch (_) {
        /* ignore */
      }
    };
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      writeLine(`--- ${formatDisplayDateTime(new Date())} pid=${process.pid} exiting ---\n`);
      fs.closeSync(fd);
    } catch (_) {
      /* ignore */
    }
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);

  return { close };
}

module.exports = { install };
