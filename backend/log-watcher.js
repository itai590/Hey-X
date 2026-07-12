const { spawn } = require('child_process');
const readline = require('readline');
const nodemailer = require('nodemailer');
const { formatDisplayDateTime } = require('./format-display-time');

/** Parse a non-negative numeric env var, falling back to `fallback` when unset/empty/invalid. */
function envNonNegative(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

const LOG_PATH = process.env.NGINX_LOG_PATH || '/var/log/nginx/access.log';
// Clamp to >=1 min so idle IP state is not discarded every tick (would defeat cooldown).
const COOLDOWN_MS = Math.max(1, envNonNegative('ALERT_COOLDOWN_MINUTES', 30)) * 60 * 1000;
const MAX_EMAILS_PER_HOUR = envNonNegative('ALERT_MAX_EMAILS_PER_HOUR', 20);
/** How often to email the suppressed-activity digest, in hours (default 24 = daily; clamp >=1). */
const DIGEST_HOURS = Math.max(1, envNonNegative('ALERT_DIGEST_HOURS', 24));

/** High-severity categories bypass the hourly email cap (per-IP cooldown still applies). */
const ALWAYS_ALERT_CATEGORIES = new Set([
  'Env file leak',
  'Git leak',
  'Config probe',
  'RDP probe',
]);

/**
 * HTTP 200 on a suspicious path means the probe succeeded — email immediately.
 * Rejected probes (400/403/404/etc.) are digest-only scanner noise.
 */
function isSuccessfulSuspiciousResponse(responseCode) {
  return responseCode === 200;
}

/** Comma-separated HTTP status codes to alert on when no named pattern matched (default: none). */
function httpStatusAlertCodes() {
  const raw = String(process.env.ALERT_LOG_HTTP_STATUS || '').trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((code) => Number.isInteger(code) && code >= 400 && code <= 599),
  );
}

const SUSPICIOUS_PATTERNS = [
  { name: 'RDP probe', regex: /mstshash=/i },
  { name: 'Binary protocol probe', regex: /\\x[0-9a-f]{2}/i },
  { name: 'WordPress scan', regex: /\/wp-(admin|login|content|includes)/i },
  { name: 'phpMyAdmin scan', regex: /\/phpmyadmin/i },
  { name: 'Env file leak', regex: /\/\.env/i },
  { name: 'Git leak', regex: /\/\.git/i },
  { name: 'XML-RPC probe', regex: /\/xmlrpc\.php/i },
  { name: 'Spring Actuator scan', regex: /\/actuator/i },
  { name: 'Shell injection', regex: /\/cgi-bin/i },
  { name: 'Config probe', regex: /\/(config\.json|credentials|\.aws|\.ssh)/i },
  { name: 'Path traversal', regex: /\.\.\//i },
];

const HTTP_STATUS_IN_LINE = /"\s([1-5]\d{2})\s/;

const DIGEST_INTERVAL_MS = DIGEST_HOURS * 3600000;

const ipState = new Map();
let emailsSentThisHour = 0;
let hourWindowStart = Date.now();
let globalLimitLoggedThisHour = false;
// Suppressed-match accounting for the hourly digest (reset when the digest is flushed).
let suppressedThisHour = 0;
const suppressedByIp = new Map();
const suppressedByStatus = new Map();
let digestTimer = null;

function resetHourlyWindowIfNeeded(now = Date.now()) {
  if (now - hourWindowStart < 3600000) return;
  hourWindowStart = now;
  emailsSentThisHour = 0;
  globalLimitLoggedThisHour = false;
}

function canSendGlobally() {
  resetHourlyWindowIfNeeded();
  if (MAX_EMAILS_PER_HOUR === 0) return true;
  return emailsSentThisHour < MAX_EMAILS_PER_HOUR;
}

/** Record any match that was not emailed, for the hourly digest. */
function recordSuppressed(ip, responseCode = null) {
  suppressedThisHour++;
  suppressedByIp.set(ip, (suppressedByIp.get(ip) || 0) + 1);
  const statusKey = responseCode !== null ? String(responseCode) : 'unknown';
  suppressedByStatus.set(statusKey, (suppressedByStatus.get(statusKey) || 0) + 1);
}

function noteCapReached() {
  resetHourlyWindowIfNeeded();
  if (!globalLimitLoggedThisHour) {
    globalLimitLoggedThisHour = true;
    console.warn(
      `[log-watcher] Hourly alert cap (${MAX_EMAILS_PER_HOUR}/h) reached — further low-severity alerts suppressed until next hour`,
    );
  }
}

/** Drop per-IP state that has been idle longer than the cooldown window to bound memory. */
function pruneIpState(now) {
  for (const [ip, state] of ipState) {
    if (now - state.lastHit > COOLDOWN_MS) {
      ipState.delete(ip);
    }
  }
}

/**
 * Per-IP cooldown gate for HTTP 200 alerts.
 * Returns:
 *   { action: 'alert' }    — emit an alert
 *   { action: 'cooldown' } — already alerted recently (caller records it for the digest)
 */
function reserveAlertSlot(ip) {
  const now = Date.now();
  pruneIpState(now);
  let state = ipState.get(ip);

  if (!state || now - state.lastHit > COOLDOWN_MS) {
    state = { lastHit: now, lastAlert: null };
  } else {
    state.lastHit = now;
  }

  if (state.lastAlert && now - state.lastAlert < COOLDOWN_MS) {
    ipState.set(ip, state);
    return { action: 'cooldown' };
  }

  state.lastAlert = now;
  ipState.set(ip, state);
  return { action: 'alert' };
}

function buildTransport() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    console.warn('[log-watcher] SMTP not configured — alerts will only log to console');
    return null;
  }

  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user, pass },
  });
}

function extractIp(logLine) {
  const match = logLine.match(/^(\S+)/);
  return match ? match[1] : 'unknown';
}

function extractResponseCode(logLine) {
  const match = logLine.match(HTTP_STATUS_IN_LINE);
  return match ? Number(match[1]) : null;
}

function matchPatterns(logLine) {
  const matches = [];
  const statusMatchAll = logLine.match(HTTP_STATUS_IN_LINE);
  const responseCode = statusMatchAll ? Number(statusMatchAll[1]) : null;

  for (const p of SUSPICIOUS_PATTERNS) {
    if (p.regex.test(logLine)) matches.push(p.name);
  }

  if (responseCode !== null && httpStatusAlertCodes().has(responseCode)) {
    matches.push(`HTTP ${responseCode}`);
  }

  return matches;
}

async function sendAlert(transport, ip, categories, logLine, options = {}) {
  const brand =
    typeof options.getBrandTitle === 'function' ? options.getBrandTitle() : 'Hey';
  const timestamp = formatDisplayDateTime(new Date());

  const subject = `[${brand}] Suspicious request from ${ip}`;
  const body = [
    `Suspicious activity detected on your server.`,
    ``,
    `Time:       ${timestamp}`,
    `Source IP:  ${ip}`,
    `Category:   ${categories.join(', ')}`,
    ``,
    `Raw log line:`,
    logLine.trim(),
    ``,
    `---`,
    `${brand} Log Watcher`,
  ].join('\n');

  console.log(`[log-watcher] ALERT: ${subject}`);

  if (transport) {
    try {
      await transport.sendMail({
        from: process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER,
        to: process.env.ALERT_EMAIL_TO,
        subject,
        text: body,
      });
      console.log(`[log-watcher] Email sent to ${process.env.ALERT_EMAIL_TO}`);
      resetHourlyWindowIfNeeded();
      emailsSentThisHour++;
    } catch (err) {
      console.error('[log-watcher] Failed to send email:', err.message);
    }
  }
}

function startWatcher(options = {}) {
  const transport = buildTransport();
  console.log(
    `[log-watcher] Watching ${LOG_PATH} (cooldown: ${COOLDOWN_MS / 1000}s, cap: ${MAX_EMAILS_PER_HOUR}/h, digest: every ${DIGEST_HOURS}h; individual alerts: HTTP 200 only)`,
  );
  const statusCodes = httpStatusAlertCodes();
  if (statusCodes.size > 0) {
    console.log(
      `[log-watcher] ALERT_LOG_HTTP_STATUS=${[...statusCodes].join(',')} — standalone HTTP status matches enabled (always digest-only; codes are 4xx/5xx)`,
    );
  }

  // Create the hourly digest timer once, even across tail restarts.
  if (!digestTimer) {
    digestTimer = setInterval(() => {
      flushHourlyDigest(transport, options).catch((err) =>
        console.error('[log-watcher] Unhandled error sending digest:', err.message),
      );
    }, DIGEST_INTERVAL_MS);
    if (typeof digestTimer.unref === 'function') digestTimer.unref();
  }

  const tail = spawn('tail', ['--follow=name', '--retry', '-n', '0', LOG_PATH]);

  const rl = readline.createInterface({ input: tail.stdout });
  rl.on('line', (line) => {
    processLine(transport, line, options).catch((err) => {
      console.error('[log-watcher] Unhandled error processing line:', err.message);
    });
  });

  tail.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg.includes('has appeared') || msg.includes('has been replaced')) {
      console.log(`[log-watcher] ${msg}`);
    }
  });

  tail.on('error', (err) => {
    console.error('[log-watcher] tail spawn error:', err.message);
    setTimeout(() => startWatcher(options), 60000);
  });

  tail.on('close', (code) => {
    console.warn(`[log-watcher] tail exited with code ${code} — restarting in 60s`);
    setTimeout(() => startWatcher(options), 60000);
  });
}

/** Durable audit line for every suspicious match, whether or not it is emailed. */
function logMatch(ip, categories, severity, action) {
  console.log(
    `[log-watcher] MATCH ip=${ip} severity=${severity} action=${action} cat="${categories.join(', ')}"`,
  );
}

async function processLine(transport, line, options = {}) {
  const categories = matchPatterns(line);
  if (categories.length === 0) return;

  const ip = extractIp(line);
  const responseCode = extractResponseCode(line);
  const highSeverity = categories.some((c) => ALWAYS_ALERT_CATEGORIES.has(c));
  const severity = highSeverity ? 'high' : 'low';

  // Rejected probes (non-200): digest only — the server already blocked them.
  if (!isSuccessfulSuspiciousResponse(responseCode)) {
    recordSuppressed(ip, responseCode);
    logMatch(ip, categories, severity, 'suppressed-rejected');
    return;
  }

  // HTTP 200: probe succeeded — alert immediately (per-IP cooldown still applies).
  const decision = reserveAlertSlot(ip);
  if (decision.action !== 'alert') {
    recordSuppressed(ip, responseCode);
    logMatch(ip, categories, severity, 'suppressed-cooldown');
    return;
  }
  // High-severity alerts (e.g. credential/secret access) bypass the hourly cap so they
  // are never dropped behind a wall of low-severity noise. Per-IP cooldown still applies.
  if (!highSeverity && !canSendGlobally()) {
    recordSuppressed(ip, responseCode);
    noteCapReached();
    logMatch(ip, categories, severity, 'suppressed-hourly-cap');
    return;
  }

  logMatch(ip, categories, severity, 'emailed');
  await sendAlert(transport, ip, categories, line, options);
}

/**
 * Send a single summary email of everything suppressed since the last digest, then reset
 * the counters. Sent only when there is something to report, so it is at most 1 email per
 * digest window (ALERT_DIGEST_HOURS, default daily).
 */
async function flushHourlyDigest(transport, options = {}) {
  const total = suppressedThisHour;
  if (total <= 0) return;

  const offenders = [...suppressedByIp.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  const uniqueIps = suppressedByIp.size;
  const statusCounts = [...suppressedByStatus.entries()].sort((a, b) => b[1] - a[1]);

  suppressedThisHour = 0;
  suppressedByIp.clear();
  suppressedByStatus.clear();

  const brand =
    typeof options.getBrandTitle === 'function' ? options.getBrandTitle() : 'Hey';
  const timestamp = formatDisplayDateTime(new Date());
  const periodLabel = DIGEST_HOURS === 24 ? 'last 24h' : `last ${DIGEST_HOURS}h`;
  const subject = `[${brand}] Suspicious activity digest — ${total} suppressed in ${periodLabel}`;
  const body = [
    `Summary of suspicious requests that were detected but not individually emailed.`,
    ``,
    `Time:               ${timestamp}`,
    `Window:             ${periodLabel}`,
    `Suppressed matches: ${total}`,
    `Unique source IPs:  ${uniqueIps}`,
    ``,
    `Top source IPs:`,
    ...offenders.map(([ip, count]) => `  ${count.toString().padStart(5)}  ${ip}`),
    ``,
    `Response status codes:`,
    ...statusCounts.map(([code, count]) => `  ${count.toString().padStart(5)}  HTTP ${code}`),
    ``,
    `Rejected probes (non-200) are digest-only; HTTP 200 matches email immediately.`,
    `Other suppressions: per-IP cooldown or the hourly cap.`,
    `Full detail is in the watcher log (grep "[log-watcher] MATCH").`,
    ``,
    `---`,
    `${brand} Log Watcher`,
  ].join('\n');

  console.log(`[log-watcher] DIGEST: ${total} suppressed across ${uniqueIps} IP(s)`);

  if (transport) {
    try {
      await transport.sendMail({
        from: process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER,
        to: process.env.ALERT_EMAIL_TO,
        subject,
        text: body,
      });
      console.log(`[log-watcher] Digest sent to ${process.env.ALERT_EMAIL_TO}`);
    } catch (err) {
      console.error('[log-watcher] Failed to send digest:', err.message);
    }
  }
}

function resetWatcherStateForTests() {
  ipState.clear();
  emailsSentThisHour = 0;
  hourWindowStart = Date.now();
  globalLimitLoggedThisHour = false;
  suppressedThisHour = 0;
  suppressedByIp.clear();
  suppressedByStatus.clear();
  if (digestTimer) {
    clearInterval(digestTimer);
    digestTimer = null;
  }
}

module.exports = {
  startWatcher,
  processLine,
  flushHourlyDigest,
  matchPatterns,
  extractIp,
  extractResponseCode,
  reserveAlertSlot,
  resetWatcherStateForTests,
};
