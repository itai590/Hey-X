const { spawn } = require('child_process');
const readline = require('readline');
const nodemailer = require('nodemailer');
const { formatDisplayDateTime } = require('./format-display-time');

const LOG_PATH = process.env.NGINX_LOG_PATH || '/var/log/nginx/access.log';
const COOLDOWN_MS = (Number(process.env.ALERT_COOLDOWN_MINUTES) || 5) * 60 * 1000;

/** When true, email on Config probe lines even if nginx returned 404 (scanner noise by default). */
function alertConfigProbe404() {
  return /^1|true|yes$/i.test(String(process.env.ALERT_LOG_CONFIG_PROBE_404 || '').trim());
}

// ignoreResponseCodes: skip alert for benign statuses (e.g. 404 on /config.json probes).
const SUSPICIOUS_PATTERNS = [
  { name: 'RDP probe', regex: /mstshash=/i },
  { name: 'Binary protocol probe', regex: /^"\\x[0-9a-f]{2}/i },
  { name: 'WordPress scan', regex: /\/wp-(admin|login|content|includes)/i },
  { name: 'phpMyAdmin scan', regex: /\/phpmyadmin/i },
  { name: 'Env file leak', regex: /\/\.env/i },
  { name: 'Git leak', regex: /\/\.git/i },
  { name: 'XML-RPC probe', regex: /\/xmlrpc\.php/i },
  { name: 'Spring Actuator scan', regex: /\/actuator/i },
  { name: 'Shell injection', regex: /\/cgi-bin/i },
  {
    name: 'Config probe',
    regex: /\/(config\.json|credentials|\.aws|\.ssh)/i,
    ignoreResponseCodes: [404],
  },
  { name: 'Path traversal', regex: /\.\.\//i },
];

const HTTP_STATUS_IN_LINE = /"\s([1-5]\d{2})\s/;

const HTTP_STATUS_SUSPICIOUS = /"\s([4-5]\d{2})\s/;

const recentAlerts = new Map();

function isCoolingDown(ip) {
  const last = recentAlerts.get(ip);
  if (!last) return false;
  if (Date.now() - last.time < COOLDOWN_MS) {
    last.suppressed++;
    return true;
  }
  return false;
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

function matchPatterns(logLine) {
  const matches = [];
  const statusMatchAll = logLine.match(HTTP_STATUS_IN_LINE);
  const responseCode = statusMatchAll ? Number(statusMatchAll[1]) : null;

  const configProbe404Alerts = alertConfigProbe404();

  for (const p of SUSPICIOUS_PATTERNS) {
    if (!p.regex.test(logLine)) continue;
    const skipBenignStatus =
      responseCode !== null &&
      Array.isArray(p.ignoreResponseCodes) &&
      p.ignoreResponseCodes.includes(responseCode);
    const allowConfig404 =
      p.name === 'Config probe' && responseCode === 404 && configProbe404Alerts;
    if (skipBenignStatus && !allowConfig404) {
      continue;
    }
    matches.push(p.name);
  }

  const statusMatch = logLine.match(HTTP_STATUS_SUSPICIOUS);
  if (statusMatch) {
    const code = Number(statusMatch[1]);
    if (code === 400 || code === 403 || code === 444) {
      matches.push(`HTTP ${code}`);
    }
  }

  return matches;
}

async function sendAlert(transport, ip, categories, logLine, options = {}) {
  const brand =
    typeof options.getBrandTitle === 'function' ? options.getBrandTitle() : 'Hey';
  const timestamp = formatDisplayDateTime(new Date());

  const prev = recentAlerts.get(ip);
  const suppressedNote = prev && prev.suppressed > 0
    ? `\n(${prev.suppressed} additional hit(s) from this IP were suppressed since last alert)\n`
    : '';

  const subject = `[${brand}] Suspicious request from ${ip}`;
  const body = [
    `Suspicious activity detected on your server.`,
    ``,
    `Time:       ${timestamp}`,
    `Source IP:  ${ip}`,
    `Category:   ${categories.join(', ')}`,
    suppressedNote,
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
    } catch (err) {
      console.error('[log-watcher] Failed to send email:', err.message);
    }
  }

  recentAlerts.set(ip, { time: Date.now(), suppressed: 0 });
}

function startWatcher(options = {}) {
  const transport = buildTransport();
  console.log(`[log-watcher] Watching ${LOG_PATH} (cooldown: ${COOLDOWN_MS / 1000}s)`);
  if (alertConfigProbe404()) {
    console.log('[log-watcher] ALERT_LOG_CONFIG_PROBE_404=yes — Config probe emails include HTTP 404');
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

async function processLine(transport, line, options = {}) {
  const categories = matchPatterns(line);
  if (categories.length === 0) return;

  const ip = extractIp(line);
  if (isCoolingDown(ip)) return;

  await sendAlert(transport, ip, categories, line, options);
}

module.exports = { startWatcher };
