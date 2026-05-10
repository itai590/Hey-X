const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

/** When set, skip hardware (mic/classifier process), log watcher, and HTTP listen — use with HEY_DB_PATH for tests. */
const HEY_TEST_MODE = process.env.HEY_TEST_MODE === '1';
/**
 * When true, delete mic_temp WAV after handling. Env: true|false (or 1|0, yes|no), case-insensitive.
 * Unset defaults to true. Invalid values log a warning and default to true.
 */
function parseEnvBoolMicUnlink() {
  const raw = (process.env.HEY_UNLINK_MIC_CLIP_AFTER_PROCESS || '').trim().toLowerCase();
  if (raw === '') return true;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  console.warn(
    `[config] HEY_UNLINK_MIC_CLIP_AFTER_PROCESS="${process.env.HEY_UNLINK_MIC_CLIP_AFTER_PROCESS}" is invalid; use true or false (or 1/0); defaulting to true`,
  );
  return true;
}
const HEY_UNLINK_MIC_CLIP_AFTER_PROCESS = parseEnvBoolMicUnlink();
require('./console-timestamp').install();
require('./persistent-logging').install();
const { spawn } = require('child_process');
const db = require('./db');
const SoundDetector = require('./sound-detector');
const MIN_MIC_CLIP_BYTES = SoundDetector.MIN_VALID_CLIP_BYTES ?? 100;
const BarkClassifier = require('./bark-classifier');
const hey = require('./hey');
const syncHey = require('./sync-hey');
const trainingInbox = require('./training-inbox');
const { PRESENCE_ROW_ID } = require('./constants');
const displayTimeZone = require('./display-timezone');

// === CONFIG ===
const configPath = process.env.HEY_CONFIG_PATH
  ? path.resolve(process.env.HEY_CONFIG_PATH)
  : path.resolve(__dirname, 'config.json');
const config = {
  BARK_CONFIDENCE_THRESHOLD: 0.25,
  MIN_RMS_AMPLITUDE: 0.3,
  AI_DETECTION_ENABLED: true,
  DETECTION_THRESHOLD: 1,
  AGGREGATION_TIMER: 60,
  /** When true, the mic capture (sox) is off — no audio is read or sent to the classifier. */
  MIC_MUTED: false,
  /** Optional suffix for the web tab title: Hey {DOG_NAME}, or just Hey when empty */
  DOG_NAME: '',
  /** Avatar image filename under the React `public/` folder (e.g. Sheldon.jpeg). */
  DOG_IMAGE_FILE: 'Sheldon.jpeg',
  /** When true and data/custom_model/head.json exists, merge YAMNet with trained embedding head (recall). */
  CUSTOM_HEAD_ENABLED: false,
  /** Probability threshold for the custom head (0–1). Final is_bark = yamnet_is_bark OR (custom_score >= this). */
  CUSTOM_HEAD_THRESHOLD: 0.55,
  /** Copy each classified clip to data/training_inbox/ with a clip_id (UUID) for logs + promote-to-training. */
  TRAINING_INBOX_ENABLED: true,
  /** Max WAV files kept in training_inbox (oldest removed first). */
  TRAINING_INBOX_MAX_FILES: 1800,
};

/** Upper bound for TRAINING_INBOX_MAX_FILES (API + runtime clamp). */
const TRAINING_INBOX_MAX_FILES_CAP = 1800;

function loadConfig() {
  if (fs.existsSync(configPath)) {
    try {
      let raw = fs.readFileSync(configPath, { encoding: 'utf8' });
      raw = raw.replace(/^\uFEFF/, '').trim();
      /* Tolerate trailing commas (common in hand-edited JSON) */
      raw = raw.replace(/,(\s*[}\]])/g, '$1');
      Object.assign(config, JSON.parse(raw));
    } catch (err) {
      console.error(
        "Couldn't read config.json",
        String(err && err.message ? err.message : err),
        '— path:',
        configPath,
        'using baked-in defaults; fix the file and restart.',
      );
    }
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, '\t') + '\n', 'utf8');
  } catch (err) {
    console.error("Couldn't write config.json", err);
    throw err;
  }
}

/** Docker: HEY_CONFIG_PATH under data/ — seed from shipped template once so first boot matches repo defaults */
function seedConfigFromTemplateIfNeeded() {
  if (!process.env.HEY_CONFIG_PATH || fs.existsSync(configPath)) return;
  const template = path.join(__dirname, 'config.json');
  if (!fs.existsSync(template)) return;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.copyFileSync(template, configPath);
    console.log('[config] Seeded', configPath, 'from template');
  } catch (err) {
    console.error('[config] Could not seed config from template:', err.message);
  }
}

seedConfigFromTemplateIfNeeded();
loadConfig();
console.log("Config loaded:", JSON.stringify(config));

function trimmedDogName() {
  return String(config.DOG_NAME || '').trim();
}

function siteHeyLabel() {
  const n = trimmedDogName();
  return n ? `Hey ${n}` : 'Hey';
}

function siteApiTitle() {
  const n = trimmedDogName();
  return n ? `Hey ${n} API` : 'Hey API';
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CUSTOM_CLIPS_ROOT = path.join(__dirname, 'data', 'custom_clips');
for (const sub of ['bark', 'not_bark']) {
  fs.mkdirSync(path.join(CUSTOM_CLIPS_ROOT, sub), { recursive: true });
}
fs.mkdirSync(path.join(__dirname, 'data', 'custom_model'), { recursive: true });
if (!HEY_TEST_MODE) {
  fs.mkdirSync(path.join(__dirname, 'data', 'training_inbox'), { recursive: true });
}

function customHeadPath() {
  return path.join(__dirname, 'data', 'custom_model', 'head.json');
}

function buildCustomHeadOpts() {
  const p = customHeadPath();
  const enabled = !!config.CUSTOM_HEAD_ENABLED && fs.existsSync(p);
  const thr = Number(config.CUSTOM_HEAD_THRESHOLD);
  return {
    enabled,
    path: p,
    threshold: !Number.isNaN(thr) && thr >= 0 && thr <= 1 ? thr : 0.55,
  };
}

function tryCaptureClip(wavPath, meta) {
  if (!config.TRAINING_INBOX_ENABLED) return null;
  const maxFiles = Math.min(
    TRAINING_INBOX_MAX_FILES_CAP,
    Math.max(10, Number(config.TRAINING_INBOX_MAX_FILES) || 1800),
  );
  try {
    return trainingInbox.captureClip({
      backendRoot: __dirname,
      wavPath,
      maxFiles,
      meta,
    });
  } catch (e) {
    console.warn('[training-inbox]', String(e && e.message ? e.message : e));
    return null;
  }
}

// --- Admin hardening helpers (HTTPS gate, verify-admin throttle, credential match, docs LAN bypass; in-memory state) ---
function parseBoolEnv(raw, fallback) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === '' || s === 'unset') return fallback;
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return fallback;
}

function parsePositiveInt(raw, fallback) {
  const n = parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function trustProxyExpressValue(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return undefined;
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return s;
}

function isHttpsRequest(req) {
  if (req.secure) return true;
  const first = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return first === 'https';
}

function configureTrustProxy(app, { heyRequireHttps, trustProxyRaw }) {
  const fromEnv = trustProxyExpressValue(trustProxyRaw);
  if (fromEnv !== undefined) {
    app.set('trust proxy', fromEnv);
    return;
  }
  if (heyRequireHttps) {
    app.set('trust proxy', 1);
  }
}

function isProbablyLoopback(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function directTcpRemoteAddress(req) {
  return String(req.socket?.remoteAddress || req.connection?.remoteAddress || '');
}

function normalizeToIpv4String(addr) {
  const s = String(addr || '');
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s.trim());
  return m ? m[1] : s;
}

function isPrivateLanIpv4Address(addr) {
  const v4 = normalizeToIpv4String(addr);
  const parts = v4.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => parseInt(p, 10));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  const [ai, bi] = nums;
  if (ai === 10) return true;
  if (ai === 172 && bi >= 16 && bi <= 31) return true;
  if (ai === 192 && bi === 168) return true;
  if (ai === 169 && bi === 254) return true;
  return false;
}

function createHttpsMiddleware(heyRequireHttps, { trustLoopback = true, trustLan = false } = {}) {
  if (!heyRequireHttps) return function httpsSkip(_req, _res, next) {
    next();
  };
  return function requireHttps(req, res, next) {
    if (trustLoopback && isProbablyLoopback(req)) return next();
    if (trustLan && isPrivateLanIpv4Address(directTcpRemoteAddress(req))) return next();
    if (isHttpsRequest(req)) return next();
    return res.status(403).json({ error: 'HTTPS required', code: 'HTTPS_REQUIRED' });
  };
}

function createVerifyAdminGuard(options) {
  const windowMs = options.windowMs;
  const maxAttempts = options.maxAttempts;
  const lockoutAfterFails = options.lockoutAfterFails;
  const lockoutBaseMs = options.lockoutBaseMs;
  const lockoutMaxMs = options.lockoutMaxMs;

  /** @type Map<string, { hits: number[], consecFail: number, lockedUntil: number }> */
  const byKey = new Map();

  function getState(key) {
    let st = byKey.get(key);
    if (!st) {
      st = { hits: [], consecFail: 0, lockedUntil: 0 };
      byKey.set(key, st);
    }
    return st;
  }

  function pruneHits(st, now) {
    st.hits = st.hits.filter((t) => now - t < windowMs);
  }

  function checkAllowed(key, now = Date.now()) {
    const st = getState(key);
    pruneHits(st, now);
    if (st.lockedUntil > now) {
      return {
        ok: false,
        retryAfterSec: Math.ceil((st.lockedUntil - now) / 1000),
        reason: 'locked_out',
      };
    }
    if (st.hits.length >= maxAttempts) {
      return { ok: false, retryAfterSec: Math.ceil(windowMs / 1000), reason: 'rate_limited' };
    }
    st.hits.push(now);
    return { ok: true };
  }

  function recordFailure(key, now = Date.now()) {
    const st = getState(key);
    st.consecFail += 1;
    if (st.consecFail >= lockoutAfterFails) {
      const power = Math.max(0, st.consecFail - lockoutAfterFails);
      const ms = Math.min(lockoutMaxMs, lockoutBaseMs * Math.pow(2, power));
      st.lockedUntil = now + ms;
    }
  }

  function recordSuccess(key) {
    const st = getState(key);
    st.consecFail = 0;
    st.lockedUntil = 0;
    st.hits = [];
  }

  return { checkAllowed, recordFailure, recordSuccess };
}

function xForwardedForFirst(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff !== 'string' || !xff.trim()) return '';
  return xff.split(',')[0].trim();
}

/** Console-safe attribution behind reverse proxies (nginx sets X-Forwarded-For). */
function auditClientDescription(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const directTcp = req.socket?.remoteAddress || '';
  const xff = xForwardedForFirst(req);
  const safeIp = typeof ip === 'string' ? ip : String(ip);
  const parts = [`ip=${safeIp}`];
  if (xff) parts.push(`xff_first=${xff}`);
  if (directTcp && String(directTcp) !== safeIp) parts.push(`direct_tcp=${directTcp}`);
  return parts.join(' ');
}

function auditMutatingRoute(req, res, next) {
  const start = Date.now();
  const clientLine = auditClientDescription(req);
  const urlPath = req.originalUrl || req.url || '';
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    console.log(
      `[audit-admin] ${req.method} ${urlPath} status=${res.statusCode} duration_ms=${durationMs} ${clientLine}`,
    );
  });
  next();
}

function timingSafeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufa = Buffer.from(a, 'utf8');
  const bufb = Buffer.from(b, 'utf8');
  if (bufa.length !== bufb.length) return false;
  return crypto.timingSafeEqual(bufa, bufb);
}

function adminCredentialMatches(candidate, primaryRaw) {
  if (!candidate || !primaryRaw) return false;
  return timingSafeEqualStrings(primaryRaw, candidate);
}

function shouldBypassDocsAdminForTrustedLan(req, { trustLan, adminActive }) {
  if (!trustLan || !adminActive) return false;
  return isPrivateLanIpv4Address(directTcpRemoteAddress(req));
}

// === Admin token (Bearer) — single secret for SPA, training WAV API, Swagger, etc. ===
const ADMIN_TOKEN_RAW = (process.env.HEY_ADMIN_TOKEN || process.env.ADMIN_TOKEN || '').trim();

const MAIN_ADMIN_ACTIVE = ADMIN_TOKEN_RAW.length > 0;
const ANY_ADMIN_ACTIVE = MAIN_ADMIN_ACTIVE;
/** When true, `/api/docs`, `/api/openapi.yaml`, and docs-gated clip upload skip Bearer for direct private-LAN IPv4 TCP peers only. */
const HEY_DOCS_ADMIN_TRUST_LAN = parseBoolEnv(process.env.HEY_DOCS_ADMIN_TRUST_LAN, false);

/** Always `main`: single admin secret (`HEY_ADMIN_TOKEN`); optional body.audience is ignored. */
function verifyAudienceFromBody(_body) {
  return 'main';
}

function audienceAuthActive(_audience) {
  return MAIN_ADMIN_ACTIVE;
}

function candidateMatchesAudience(candidate, _audience) {
  return adminCredentialMatches(candidate, ADMIN_TOKEN_RAW);
}

/** RFC 6750 Bearer token only — use for mutating APIs and verify-admin Bearer fallback. */
function getBearerTokenStrict(req) {
  const h = req.headers.authorization;
  if (!h || typeof h !== 'string') return '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : '';
}

/**
 * Bearer first; bare Authorization value only for Swagger/OpenAPI (`requireDocsAdmin`) compatibility.
 */
function getBearerTokenAllowBare(req) {
  const strict = getBearerTokenStrict(req);
  if (strict) return strict;
  const h = req.headers.authorization;
  if (!h || typeof h !== 'string') return '';
  return h.trim();
}

function clientKeyForGuards(req) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  return typeof ip === 'string' ? ip : String(ip);
}

const verifyAdminGuard = createVerifyAdminGuard({
  windowMs: parsePositiveInt(process.env.HEY_VERIFY_ADMIN_RL_WINDOW_MS, 60_000),
  maxAttempts: parsePositiveInt(process.env.HEY_VERIFY_ADMIN_RL_MAX, 45),
  lockoutAfterFails: parsePositiveInt(process.env.HEY_VERIFY_ADMIN_LOCKOUT_AFTER_FAILS, 10),
  lockoutBaseMs: parsePositiveInt(process.env.HEY_VERIFY_ADMIN_LOCKOUT_BASE_MS, 120_000),
  lockoutMaxMs: parsePositiveInt(process.env.HEY_VERIFY_ADMIN_LOCKOUT_MAX_MS, 3600_000),
});

/** Failed Bearer attempts on mutating routes (high maxAttempts — lockout via consec. failures). */
const mutatingAdminGuard = createVerifyAdminGuard({
  windowMs: parsePositiveInt(process.env.HEY_MAIN_ADMIN_RL_WINDOW_MS, 60_000),
  maxAttempts: parsePositiveInt(process.env.HEY_MAIN_ADMIN_RL_MAX, 1_000_000),
  lockoutAfterFails: parsePositiveInt(process.env.HEY_MAIN_ADMIN_LOCKOUT_AFTER_FAILS, 10),
  lockoutBaseMs: parsePositiveInt(process.env.HEY_MAIN_ADMIN_LOCKOUT_BASE_MS, 120_000),
  lockoutMaxMs: parsePositiveInt(process.env.HEY_MAIN_ADMIN_LOCKOUT_MAX_MS, 3600_000),
});

const ADMIN_LOGIN_USERNAME_MAX = 128;
const XFF_FIRST_MAX = 256;

function insertAdminLoginAudit(req, usernameRaw) {
  const username = typeof usernameRaw === 'string' ? usernameRaw.trim().slice(0, ADMIN_LOGIN_USERNAME_MAX) : '';
  const loggedAt = new Date().toISOString();
  const ip = String(req.ip || req.socket?.remoteAddress || '');
  const xf = xForwardedForFirst(req);
  const xffFirst = xf ? xf.slice(0, XFF_FIRST_MAX) : null;
  try {
    db.prepare(
      'INSERT INTO admin_login_audit (logged_at, username, ip, xff_first) VALUES (?, ?, ?, ?)',
    ).run(loggedAt, username || null, ip || null, xffFirst);
  } catch (e) {
    console.error('admin_login_audit insert failed:', e.message);
  }
}

/** Rate-limit / lockout middleware for POST /api/auth/verify-admin only */
function throttleVerifyAdmin(req, res, next) {
  const audience = verifyAudienceFromBody(req.body);
  if (!audienceAuthActive(audience)) return next();
  const key = `${clientKeyForGuards(req)}|${audience}`;
  const check = verifyAdminGuard.checkAllowed(key);
  if (check.ok) return next();
  if (typeof check.retryAfterSec === 'number' && check.retryAfterSec > 0) {
    res.set('Retry-After', String(check.retryAfterSec));
  }
  const payload = check.reason === 'locked_out'
    ? { error: 'Too many failed attempts — try again later.', code: 'VERIFY_ADMIN_LOCKED' }
    : { error: 'Too many verify-admin requests — try again later.', code: 'VERIFY_ADMIN_RATE_LIMITED' };
  return res.status(429).json(payload);
}

function requireMainAdmin(req, res, next) {
  if (!MAIN_ADMIN_ACTIVE) return next();
  const sent = getBearerTokenStrict(req);
  const key = `${clientKeyForGuards(req)}|main-admin`;
  if (!sent || !candidateMatchesAudience(sent, 'main')) {
    const check = mutatingAdminGuard.checkAllowed(key);
    if (!check.ok) {
      if (typeof check.retryAfterSec === 'number' && check.retryAfterSec > 0) {
        res.set('Retry-After', String(check.retryAfterSec));
      }
      const payload = check.reason === 'locked_out'
        ? { error: 'Too many failed auth attempts — try again later.', code: 'MAIN_ADMIN_AUTH_LOCKED' }
        : { error: 'Too many admin auth attempts — try again later.', code: 'MAIN_ADMIN_AUTH_RATE_LIMITED' };
      return res.status(429).json(payload);
    }
    mutatingAdminGuard.recordFailure(key);
    res.set('WWW-Authenticate', 'Bearer realm="hey-main-admin"');
    return res.status(401).json({ error: 'Unauthorized', needsAdminAuth: true });
  }
  mutatingAdminGuard.recordSuccess(key);
  next();
}

/**
 * Swagger, OpenAPI YAML, and docs-gated clip upload — requires HEY_ADMIN_TOKEN when set,
 * unless `HEY_DOCS_ADMIN_TRUST_LAN` and the TCP peer is private LAN (see `shouldBypassDocsAdminForTrustedLan`).
 */
function requireDocsAdmin(req, res, next) {
  if (!MAIN_ADMIN_ACTIVE) {
    res.set('WWW-Authenticate', 'Bearer realm="hey-main-admin"');
    return res.status(401).json({
      error: 'Unauthorized',
      needsAdminAuth: true,
      detail: 'Set HEY_ADMIN_TOKEN for /api/docs and OpenAPI YAML.',
    });
  }

  if (
    shouldBypassDocsAdminForTrustedLan(req, {
      trustLan: HEY_DOCS_ADMIN_TRUST_LAN,
      adminActive: MAIN_ADMIN_ACTIVE,
    })
  ) {
    return next();
  }

  const sent = getBearerTokenAllowBare(req);
  if (!sent || !adminCredentialMatches(sent, ADMIN_TOKEN_RAW)) {
    res.set('WWW-Authenticate', 'Bearer realm="hey-main-admin"');
    return res.status(401).json({ error: 'Unauthorized', needsAdminAuth: true });
  }
  next();
}

if (!ANY_ADMIN_ACTIVE) {
  console.warn(
    '[security] No admin tokens set — anyone who can reach this server can use mutating APIs and training/docs where applicable. Set HEY_ADMIN_TOKEN.',
  );
} else {
  console.log('[security] HEY_ADMIN_TOKEN is set — mutating APIs + training WAV routes require Authorization: Bearer …');
  if (HEY_DOCS_ADMIN_TRUST_LAN) {
    console.log(
      '[security] HEY_DOCS_ADMIN_TRUST_LAN=true — docs/OpenAPI + docs-gated clip upload skip Bearer for direct private-LAN IPv4 TCP peers',
    );
  }
}
hey.setAggrTime(config.AGGREGATION_TIMER);

// === ML BARK CLASSIFIER ===
const classifier = new BarkClassifier({
  barkThreshold: config.BARK_CONFIDENCE_THRESHOLD,
  customHead: buildCustomHeadOpts(),
});
if (!HEY_TEST_MODE) {
  classifier.start();
}

function syncClassifierOptions() {
  classifier.barkThreshold = config.BARK_CONFIDENCE_THRESHOLD;
  classifier.customHead = buildCustomHeadOpts();
}

// === SOUND DETECTOR SETUP ===
let detections = 0;
let lastSoundTime = null;
/** @type {null | number} */
let lastRms = null;
let lastRmsTime = null;
let lastRmsAboveFloor = null;
/** @type {null | { topLabel: string, topScore: number, barkScore: number, isBark: boolean, aiOff?: boolean, clipId?: string }} */
let lastClassified = null;
const soundDetector = new SoundDetector();
/** Rate-limit "no valid clip" logs until we get a full clip again */
let skipNoSoundLogged = false;

function setMicCaptureEnabled(want) {
  if (want) {
    soundDetector.start();
  } else {
    soundDetector.stop();
  }
}

if (!HEY_TEST_MODE) {
  setMicCaptureEnabled(!config.MIC_MUTED);
} else {
  setMicCaptureEnabled(false);
}

function computeRms(wavPath) {
  const buf = fs.readFileSync(wavPath);
  const dataStart = buf.indexOf('data') + 8;
  if (dataStart < 8 || dataStart >= buf.length) return 0;

  let sumSq = 0;
  let count = 0;
  for (let i = dataStart; i + 1 < buf.length; i += 2) {
    const sample = buf.readInt16LE(i) / 32768;
    sumSq += sample * sample;
    count++;
  }
  return count > 0 ? Math.sqrt(sumSq / count) : 0;
}

function safeUnlinkMicClip(wavPath) {
  if (!HEY_UNLINK_MIC_CLIP_AFTER_PROCESS) return;
  try {
    fs.unlinkSync(wavPath);
  } catch (_) {
    /* ignore */
  }
}

/**
 * Classify clip (or AI-off path), update lastClassified / detections, capture training inbox.
 * Caller sets lastRms* / lastSoundTime; this handles unlink when HEY_UNLINK_MIC_CLIP_AFTER_PROCESS.
 */
async function processDetectedWav(wavPath, rms) {
  try {
    if (config.AI_DETECTION_ENABLED) {
      const result = await classifier.classify(wavPath);
      const topLabel = result.labels?.[0]?.class || '?';
      const topScore = result.labels?.[0]?.score || 0;

      const top5 = (result.labels || [])
        .slice(0, 5)
        .map((l) => `${l.class}=${l.score}`)
        .join(' ');
      const errPart = result.error ? ` error=${result.error}` : '';
      const chPart =
        result.custom_head_used && typeof result.custom_head_score === 'number'
          ? ` custom_head=${result.custom_head_score}`
          : '';
      const relaxedPart = result.yamnet_relaxed_bark ? ' yamnet_relaxed_bark=true' : '';
      const classifyLogLine =
        `rms=${rms.toFixed(4)} classified: ${topLabel} (${topScore}) ` +
        `bark_score=${result.bark_score} yamnet_is_bark=${result.yamnet_is_bark ?? false} is_bark=${result.is_bark ?? false}` +
        `${relaxedPart}${chPart} | top5: ${top5 || '—'}${errPart}`;

      const meta = {
        rms,
        topLabel,
        topScore,
        barkScore: result.bark_score,
        yamnetIsBark: result.yamnet_is_bark,
        yamnetRelaxedBark: !!result.yamnet_relaxed_bark,
        isBark: result.is_bark,
        customHeadScore: result.custom_head_score,
        customHeadUsed: result.custom_head_used,
        top5: (result.labels || []).slice(0, 5).map((l) => ({ class: l.class, score: l.score })),
        classifyError: result.error || null,
        classifyLogLine,
      };
      const clipId = tryCaptureClip(wavPath, meta);

      lastClassified = {
        topLabel,
        topScore,
        barkScore: result.bark_score ?? 0,
        isBark: !!result.is_bark,
        yamnetIsBark: !!result.yamnet_is_bark,
        yamnetRelaxedBark: !!result.yamnet_relaxed_bark,
        customHeadScore: result.custom_head_score,
        customHeadUsed: !!result.custom_head_used,
        clipId: clipId || undefined,
      };

      const idPart = clipId ? ` clip_id=${clipId}` : '';
      console.log(`${classifyLogLine}${idPart}`);

      if (result.is_bark && ++detections >= config.DETECTION_THRESHOLD) {
        hey.send();
      }
    } else {
      const aiOffLogLine = `rms=${rms.toFixed(4)} (AI off, skipping classification)`;
      const clipId = tryCaptureClip(wavPath, { rms, aiOff: true, classifyLogLine: aiOffLogLine });
      lastClassified = {
        topLabel: '—',
        topScore: 0,
        barkScore: 0,
        isBark: false,
        aiOff: true,
        clipId: clipId || undefined,
      };
      const idPart = clipId ? ` clip_id=${clipId}` : '';
      console.log(`${aiOffLogLine}${idPart}`);
      if (++detections >= config.DETECTION_THRESHOLD) {
        hey.send();
      }
    }
  } catch (err) {
    console.error('Classification error:', err.message);
    let cid = null;
    const classifyErrorLogLine =
      `rms=${rms.toFixed(4)} classification error: ${String(err.message || err)}`;
    if (config.TRAINING_INBOX_ENABLED && fs.existsSync(wavPath)) {
      cid = tryCaptureClip(wavPath, {
        rms,
        nodeClassifyError: String(err.message || err),
        classifyLogLine: classifyErrorLogLine,
      });
    }
    if (cid) {
      console.warn(`clip_id=${cid} (classification threw; kept in training inbox for labeling)`);
    }
  } finally {
    safeUnlinkMicClip(wavPath);
  }
}

hey.on('reset', () => {
  console.log('Resetting detections');
  detections = 0;
});

soundDetector.on('skipped', ({ wavPath }) => {
  const t = new Date().toISOString();
  let rmsPart = '';
  if (wavPath && fs.existsSync(wavPath)) {
    try {
      const rms = computeRms(wavPath);
      lastRms = rms;
      lastRmsTime = t;
      lastRmsAboveFloor = rms >= config.MIN_RMS_AMPLITUDE;
      rmsPart = ` rms=${rms.toFixed(4)}`;
    } catch (_) {
      /* ignore */
    }
  }
  if (!skipNoSoundLogged) {
    console.warn(`no valid sound detected, skipping...${rmsPart || ' (no clip file)'}`);
    skipNoSoundLogged = true;
  }
});

soundDetector.on('detected', async ({ wavPath }) => {
  skipNoSoundLogged = false;
  lastSoundTime = new Date().toISOString();

  const rms = computeRms(wavPath);
  lastRms = rms;
  lastRmsTime = lastSoundTime;
  if (rms < config.MIN_RMS_AMPLITUDE) {
    lastRmsAboveFloor = false;
    console.warn(
      `rms=${rms.toFixed(4)} below MIN_RMS_AMPLITUDE (${config.MIN_RMS_AMPLITUDE}), skipping classification`,
    );
    safeUnlinkMicClip(wavPath);
    return;
  }
  lastRmsAboveFloor = true;
  await processDetectedWav(wavPath, rms);
});

// === PRESENCE HEARTBEAT ===
if (!HEY_TEST_MODE) {
  setInterval(syncHey, 60 * 1000);
}
syncHey();

// === EXPRESS SERVER SETUP ===
const app = express();
const PORT = 5100;

const HEY_REQUIRE_HTTPS = parseBoolEnv(process.env.HEY_REQUIRE_HTTPS, false);
const HEY_REQUIRE_HTTPS_TRUST_LOOPBACK = parseBoolEnv(
  process.env.HEY_REQUIRE_HTTPS_TRUST_LOOPBACK,
  true,
);
const HEY_REQUIRE_HTTPS_TRUST_LAN = parseBoolEnv(process.env.HEY_REQUIRE_HTTPS_TRUST_LAN, false);
configureTrustProxy(app, {
  heyRequireHttps: HEY_REQUIRE_HTTPS,
  trustProxyRaw: process.env.HEY_TRUST_PROXY,
});
app.use(
  createHttpsMiddleware(HEY_REQUIRE_HTTPS, {
    trustLoopback: HEY_REQUIRE_HTTPS_TRUST_LOOPBACK,
    trustLan: HEY_REQUIRE_HTTPS_TRUST_LAN,
  }),
);
if (HEY_REQUIRE_HTTPS) {
  const bits = [];
  if (HEY_REQUIRE_HTTPS_TRUST_LOOPBACK) bits.push('localhost HTTP exempt for health checks');
  if (HEY_REQUIRE_HTTPS_TRUST_LAN) bits.push('private-LAN IPv4 (RFC1918 / APIPA) HTTP exempt on TCP peer');
  const loopNote = bits.length ? ` — ${bits.join('; ')}` : '';
  console.log('[security] HTTPS-only mode for API requests' + loopNote);
}

/** CORS: explicit list wins; else https:// + apex/www from PRIMARY_DOMAIN (same hostname as nginx). */
function parseCorsOrigins() {
  const raw = (process.env.CORS_ALLOWED_ORIGINS || '').trim();
  if (raw) {
    return raw.split(',').map((o) => o.trim()).filter(Boolean);
  }
  const out = [];
  const host = (process.env.PRIMARY_DOMAIN || '').trim();
  if (host) {
    out.push(`https://${host}`);
    if (!/^www\./i.test(host)) {
      out.push(`https://www.${host}`);
    }
  }
  return out;
}
const ALLOWED_ORIGINS = parseCorsOrigins();

app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin) ||
      /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d{1,3}\.\d{1,3})(:\d+)?$/.test(origin)) {
      return cb(null, true);
    }
    cb(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '16kb' }));

/**
 * Public: lets a UI check a typed token before storing it (wrong token → 401 + message).
 * Validates `HEY_ADMIN_TOKEN`. Body `audience` is ignored (compat). Optional `username` is audit-only.
 */
app.post('/api/auth/verify-admin', throttleVerifyAdmin, (req, res) => {
  const audience = verifyAudienceFromBody(req.body);
  if (!audienceAuthActive(audience)) {
    return res.json({ ok: true, authDisabled: true, audience });
  }
  const key = `${clientKeyForGuards(req)}|${audience}`;
  const pwd = req.body && typeof req.body.password === 'string' ? req.body.password.trim() : '';
  const bearer = getBearerTokenStrict(req);
  const candidate = pwd || bearer || '';
  if (!candidate || !candidateMatchesAudience(candidate, audience)) {
    verifyAdminGuard.recordFailure(key);
    return res.status(401).json({ error: 'Invalid admin token', needsAdminAuth: true });
  }
  verifyAdminGuard.recordSuccess(key);
  const uname = req.body && typeof req.body.username === 'string' ? req.body.username : '';
  insertAdminLoginAudit(req, uname);
  return res.json({ ok: true, audience });
});

const LOG_TAIL_BYTES_DEFAULT = 384 * 1024;
const LOG_TAIL_BYTES_MAX = 2 * 1024 * 1024;

/**
 * Read last `maxBytes` of UTF-8 text; if not from start of file, drop first partial line.
 * @param {string} logAbsPath
 * @param {number} maxBytes
 * @returns {Promise<{ text: string, truncated: boolean, size: number }>}
 */
async function readBackendLogTail(logAbsPath, maxBytes) {
  const st = await fs.promises.stat(logAbsPath);
  const size = st.size;
  if (size === 0) {
    return { text: '', truncated: false, size: 0 };
  }
  const readLen = Math.min(maxBytes, size);
  const start = size - readLen;
  const fh = await fs.promises.open(logAbsPath, 'r');
  try {
    const buf = Buffer.alloc(readLen);
    const { bytesRead } = await fh.read(buf, 0, readLen, start);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      if (nl !== -1) {
        text = text.slice(nl + 1);
      }
    }
    return { text, truncated: start > 0, size };
  } finally {
    await fh.close();
  }
}

/** Admin: tail of persistent backend log file (HEY_LOG_DIR/backend.log). */
app.get('/api/admin/logs', requireMainAdmin, async (req, res) => {
  try {
    const raw = (process.env.HEY_LOG_DIR || '').trim();
    if (!raw) {
      return res.json({
        ok: true,
        configured: false,
        message:
          'HEY_LOG_DIR is not set on the server — logs are not written to a file. '
          + 'Use docker logs / journalctl on the host, or set HEY_LOG_DIR to enable file logging.',
        text: '',
      });
    }

    const dir = path.resolve(raw);
    const logFile = path.join(dir, 'backend.log');

    let maxBytes = LOG_TAIL_BYTES_DEFAULT;
    if (req.query && req.query.maxBytes != null) {
      const n = parseInt(String(req.query.maxBytes), 10);
      if (!Number.isNaN(n)) {
        maxBytes = Math.min(LOG_TAIL_BYTES_MAX, Math.max(4096, n));
      }
    }

    try {
      await fs.promises.access(logFile, fs.constants.R_OK);
    } catch (_) {
      return res.json({
        ok: true,
        configured: true,
        empty: true,
        message: 'Log file does not exist yet (nothing written after deploy, or logging just started).',
        text: '',
      });
    }

    const { text, truncated, size } = await readBackendLogTail(logFile, maxBytes);
    return res.json({
      ok: true,
      configured: true,
      fileSizeBytes: size,
      truncated,
      maxBytes,
      text,
    });
  } catch (err) {
    console.error('admin/logs read error:', err.message);
    return res.status(500).json({ error: 'Failed to read log file', detail: String(err.message || err) });
  }
});

// === API: Messages ===

app.get('/api/messages', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  try {
    const stmt = db.prepare(`SELECT * FROM messages ORDER BY update_time DESC`);
    const messages = stmt.all();
    res.json(messages);
  } catch (err) {
    console.error("DB read error:", err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

app.put('/api/messages/:id', requireMainAdmin, auditMutatingRoute, (req, res) => {
  const { id } = req.params;
  const { text } = req.body;

  if (!id || !text) {
    return res.status(400).json({ error: 'Missing id or text' });
  }

  try {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO messages (id, text, create_time, update_time)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        text = excluded.text,
        update_time = excluded.update_time
    `);
    stmt.run(id, text, now, now);
    res.json({ success: true });
  } catch (err) {
    console.error("DB insert/update error:", err);
    res.status(500).json({ error: 'Failed to save message' });
  }
});

app.delete('/api/messages', requireMainAdmin, auditMutatingRoute, (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Missing or empty ids array' });
  }
  if (ids.length > 1000) {
    return res.status(400).json({ error: 'Too many ids (max 1000)' });
  }

  try {
    const placeholders = ids.map(() => '?').join(',');
    const stmt = db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`);
    const result = stmt.run(...ids);
    res.json({ success: true, deleted: result.changes });
  } catch (err) {
    console.error("DB delete error:", err);
    res.status(500).json({ error: 'Failed to delete messages' });
  }
});

// === API: Config ===

app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.json(config);
});

app.put('/api/config', requireMainAdmin, auditMutatingRoute, (req, res) => {
  const updates = req.body;

  if (typeof updates !== 'object' || updates === null) {
    return res.status(400).json({ error: 'Invalid config body' });
  }

  const allowed = [
    'BARK_CONFIDENCE_THRESHOLD',
    'MIN_RMS_AMPLITUDE',
    'AI_DETECTION_ENABLED',
    'DETECTION_THRESHOLD',
    'AGGREGATION_TIMER',
    'MIC_MUTED',
    'DOG_NAME',
    'DOG_IMAGE_FILE',
    'CUSTOM_HEAD_ENABLED',
    'CUSTOM_HEAD_THRESHOLD',
    'TRAINING_INBOX_ENABLED',
    'TRAINING_INBOX_MAX_FILES',
  ];
  for (const key of Object.keys(updates)) {
    if (!allowed.includes(key)) {
      return res.status(400).json({ error: `Unknown config key: ${key}` });
    }
  }

  if (updates.BARK_CONFIDENCE_THRESHOLD !== undefined) {
    const v = Number(updates.BARK_CONFIDENCE_THRESHOLD);
    if (isNaN(v) || v < 0 || v > 1) {
      return res.status(400).json({ error: 'BARK_CONFIDENCE_THRESHOLD must be 0-1' });
    }
    config.BARK_CONFIDENCE_THRESHOLD = v;
    classifier.barkThreshold = v;
  }

  if (updates.MIN_RMS_AMPLITUDE !== undefined) {
    const v = Number(updates.MIN_RMS_AMPLITUDE);
    if (isNaN(v) || v < 0 || v > 1) {
      return res.status(400).json({ error: 'MIN_RMS_AMPLITUDE must be 0-1' });
    }
    config.MIN_RMS_AMPLITUDE = v;
  }

  if (updates.AI_DETECTION_ENABLED !== undefined) {
    if (typeof updates.AI_DETECTION_ENABLED !== 'boolean') {
      return res.status(400).json({ error: 'AI_DETECTION_ENABLED must be a boolean' });
    }
    config.AI_DETECTION_ENABLED = updates.AI_DETECTION_ENABLED;
  }

  if (updates.MIC_MUTED !== undefined) {
    if (typeof updates.MIC_MUTED !== 'boolean') {
      return res.status(400).json({ error: 'MIC_MUTED must be a boolean' });
    }
    config.MIC_MUTED = updates.MIC_MUTED;
    setMicCaptureEnabled(!config.MIC_MUTED);
  }

  if (updates.DETECTION_THRESHOLD !== undefined) {
    const v = Math.round(Number(updates.DETECTION_THRESHOLD));
    if (isNaN(v) || v < 1 || v > 20) {
      return res.status(400).json({ error: 'DETECTION_THRESHOLD must be 1-20' });
    }
    config.DETECTION_THRESHOLD = v;
  }

  if (updates.AGGREGATION_TIMER !== undefined) {
    const v = Math.round(Number(updates.AGGREGATION_TIMER));
    if (isNaN(v) || v < 10 || v > 300) {
      return res.status(400).json({ error: 'AGGREGATION_TIMER must be 10-300' });
    }
    config.AGGREGATION_TIMER = v;
    hey.setAggrTime(v);
  }

  if (updates.DOG_NAME !== undefined) {
    if (typeof updates.DOG_NAME !== 'string') {
      return res.status(400).json({ error: 'DOG_NAME must be a string' });
    }
    const t = updates.DOG_NAME.trim();
    if (t.length > 64) {
      return res.status(400).json({ error: 'DOG_NAME must be at most 64 characters' });
    }
    config.DOG_NAME = t;
    if (typeof openApiSpec !== 'undefined' && openApiSpec && openApiSpec.info) {
      openApiSpec.info.title = siteApiTitle();
    }
  }

  if (updates.DOG_IMAGE_FILE !== undefined) {
    if (typeof updates.DOG_IMAGE_FILE !== 'string') {
      return res.status(400).json({ error: 'DOG_IMAGE_FILE must be a string' });
    }
    const f = updates.DOG_IMAGE_FILE.trim();
    if (f.length > 128 || !/^[a-zA-Z0-9._-]+$/.test(f)) {
      return res.status(400).json({ error: 'DOG_IMAGE_FILE must be a safe filename (letters, numbers, ._-)' });
    }
    config.DOG_IMAGE_FILE = f || `${config.DOG_NAME}.jpeg`;
  }

  if (updates.CUSTOM_HEAD_ENABLED !== undefined) {
    if (typeof updates.CUSTOM_HEAD_ENABLED !== 'boolean') {
      return res.status(400).json({ error: 'CUSTOM_HEAD_ENABLED must be a boolean' });
    }
    config.CUSTOM_HEAD_ENABLED = updates.CUSTOM_HEAD_ENABLED;
  }

  if (updates.CUSTOM_HEAD_THRESHOLD !== undefined) {
    const v = Number(updates.CUSTOM_HEAD_THRESHOLD);
    if (isNaN(v) || v < 0 || v > 1) {
      return res.status(400).json({ error: 'CUSTOM_HEAD_THRESHOLD must be 0-1' });
    }
    config.CUSTOM_HEAD_THRESHOLD = v;
  }

  if (updates.TRAINING_INBOX_ENABLED !== undefined) {
    if (typeof updates.TRAINING_INBOX_ENABLED !== 'boolean') {
      return res.status(400).json({ error: 'TRAINING_INBOX_ENABLED must be a boolean' });
    }
    config.TRAINING_INBOX_ENABLED = updates.TRAINING_INBOX_ENABLED;
  }

  if (updates.TRAINING_INBOX_MAX_FILES !== undefined) {
    const v = Math.round(Number(updates.TRAINING_INBOX_MAX_FILES));
    if (isNaN(v) || v < 10 || v > TRAINING_INBOX_MAX_FILES_CAP) {
      return res.status(400).json({
        error: `TRAINING_INBOX_MAX_FILES must be 10-${TRAINING_INBOX_MAX_FILES_CAP}`,
      });
    }
    config.TRAINING_INBOX_MAX_FILES = v;
  }

  detections = 0;

  try {
    saveConfig();
    syncClassifierOptions();
    console.log("Config updated:", JSON.stringify(config));
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save config' });
  }
});

// === API: Custom embedding head (training clips + train job) ===

app.get('/api/custom-head/status', (_req, res) => {
  try {
    const countWav = (dir) => {
      if (!fs.existsSync(dir)) return 0;
      return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wav')).length;
    };
    const hp = customHeadPath();
    let headPreview = null;
    if (fs.existsSync(hp)) {
      try {
        const raw = fs.readFileSync(hp, 'utf8');
        const j = JSON.parse(raw);
        headPreview = {
          trained_at: j.trained_at,
          samples: j.samples,
          train_accuracy: j.train_accuracy,
          threshold: j.threshold,
        };
      } catch (_) {
        headPreview = { parseError: true };
      }
    }
    res.json({
      enabled: !!config.CUSTOM_HEAD_ENABLED && fs.existsSync(hp),
      configEnabled: !!config.CUSTOM_HEAD_ENABLED,
      headPath: hp,
      headExists: fs.existsSync(hp),
      configThreshold: config.CUSTOM_HEAD_THRESHOLD,
      clips: {
        bark: countWav(path.join(CUSTOM_CLIPS_ROOT, 'bark')),
        not_bark: countWav(path.join(CUSTOM_CLIPS_ROOT, 'not_bark')),
      },
      head: headPreview,
    });
  } catch (err) {
    console.error('custom-head status:', err);
    res.status(500).json({ error: 'Failed to read status' });
  }
});

app.post('/api/custom-head/train', requireMainAdmin, auditMutatingRoute, (_req, res) => {
  const trainPy = path.join(__dirname, 'train_custom_head.py');
  if (!fs.existsSync(trainPy)) {
    return res.status(500).json({ error: 'train_custom_head.py not found' });
  }
  const child = spawn('python3', [trainPy], {
    cwd: __dirname,
    env: { ...process.env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  child.on('error', (err) => {
    res.status(500).json({ error: String(err.message || err) });
  });
  child.on('close', (code) => {
    const lines = stdout.trim().split('\n').filter(Boolean);
    let summary = null;
    if (lines.length) {
      try {
        summary = JSON.parse(lines[lines.length - 1]);
      } catch (_) {
        summary = { raw: lines[lines.length - 1] };
      }
    }
    if (code !== 0) {
      return res.status(500).json({
        error: 'Training failed',
        code,
        summary,
        stderr: stderr.slice(-12000),
        stdout: stdout.slice(-6000),
      });
    }
    syncClassifierOptions();
    res.json({ ok: true, summary, log: stderr.slice(-12000) });
  });
});

app.put('/api/custom-head/clip/:label', requireDocsAdmin, auditMutatingRoute, (req, res) => {
  const label = req.params.label;
  if (label !== 'bark' && label !== 'not_bark') {
    return res.status(400).json({ error: 'label must be bark or not_bark' });
  }
  const maxBytes = 4 * 1024 * 1024;
  const chunks = [];
  let total = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    if (aborted) return;
    total += chunk.length;
    if (total > maxBytes) {
      aborted = true;
      if (!res.headersSent) {
        res.status(413).json({ error: 'Body too large (max 4 MB)' });
      }
      try {
        req.destroy();
      } catch (_) { /* ignore */ }
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      const buf = Buffer.concat(chunks);
      if (buf.length < 64) {
        return res.status(400).json({ error: 'WAV too small' });
      }
      const dir = path.join(CUSTOM_CLIPS_ROOT, label);
      fs.mkdirSync(dir, { recursive: true });
      const fn = `clip-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`;
      const fpath = path.join(dir, fn);
      fs.writeFileSync(fpath, buf);
      res.json({ ok: true, saved: path.relative(path.join(__dirname, 'data'), fpath), bytes: buf.length });
    } catch (err) {
      console.error('custom-head clip save:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to save clip' });
    }
  });
  req.on('error', (err) => {
    if (!res.headersSent) res.status(400).json({ error: String(err.message || err) });
  });
});

// === API: Training inbox (log line clip_id → WAV + metadata → promote to custom_clips) ===

const CLIP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIC_TEMP_DIR = path.join(__dirname, 'data', 'mic_temp');
const SAFE_MIC_WAV_RE = /^clip-\d+\.wav$/i;
const SAFE_CUSTOM_WAV_RE = /^[a-zA-Z0-9._-]+\.wav$/i;

function fileResolvedUnder(filePath, rootDir) {
  const f = path.resolve(filePath);
  const r = path.resolve(rootDir);
  return f === r || f.startsWith(r + path.sep);
}

function listWavsInDataSubdir(subPathFromData, opts = {}) {
  const mergeSidecarJson = !!opts.mergeSidecarJson;
  const dir = path.join(__dirname, 'data', subPathFromData);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.wav'))
    .map((name) => {
      const p = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(p);
      } catch (_) {
        return null;
      }
      const row = { name, bytes: st.size, mtime: st.mtime.toISOString() };
      if (mergeSidecarJson) {
        const jsonPath = path.join(dir, name.replace(/\.wav$/i, '.json'));
        if (fs.existsSync(jsonPath)) {
          try {
            const o = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            if (o && typeof o === 'object') {
              if (o.capturedAt) row.capturedAt = o.capturedAt;
              if (o.clipId) row.clipId = o.clipId;
            }
          } catch (_) { /* ignore */ }
        }
      }
      try {
        row.rms = computeRms(p);
      } catch (_) {
        row.rms = null;
      }
      return row;
    })
    .filter(Boolean)
    .sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
}

/** HTML player + JSON catalog for listening to training_inbox, mic_temp, and custom_clips WAVs over HTTP. */
app.get('/api/training/listen', (_req, res) => {
  try {
    let html = fs.readFileSync(path.join(__dirname, 'training-listen.html'), 'utf8');
    const title = `${siteHeyLabel()} — WAV review`;
    const titleEsc = escapeHtml(title);
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${titleEsc}</title>`);
    html = html.replace(
      /<h1 id="training-listen-title">[^<]*<\/h1>/,
      `<h1 id="training-listen-title">${titleEsc}</h1>`,
    );
    const tz = displayTimeZone();
    html = html.replace(/__DISPLAY_TIME_ZONE_HTML__/g, escapeHtml(tz));
    html = html.replace(/__DISPLAY_TIME_ZONE_JSON__/g, JSON.stringify(tz));
    res.type('html');
    res.send(html);
  } catch (err) {
    console.error('[training/listen]', err);
    res.status(500).type('text/plain').send('Failed to load training listen page');
  }
});

app.get('/api/training/audio-catalog', requireMainAdmin, (req, res) => {
  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 50);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const { total: inboxTotal, rows: inboxPage } = trainingInbox.listInbox(__dirname, { limit, offset });
    const inbox = inboxPage.map((row) => ({ ...row, rms: row.rms != null ? row.rms : null }));
    const micTemp = listWavsInDataSubdir('mic_temp')
      .filter((row) => SAFE_MIC_WAV_RE.test(row.name))
      .filter((row) => row.bytes >= MIN_MIC_CLIP_BYTES);
    const custom = {
      bark: listWavsInDataSubdir(path.join('custom_clips', 'bark'), { mergeSidecarJson: true }),
      not_bark: listWavsInDataSubdir(path.join('custom_clips', 'not_bark'), { mergeSidecarJson: true }),
    };
    res.json({
      adminRequired: MAIN_ADMIN_ACTIVE,
      inboxTotal,
      inboxOffset: offset,
      inboxLimit: limit,
      inbox,
      micTemp,
      custom,
    });
  } catch (err) {
    console.error('audio-catalog:', err);
    res.status(500).json({ error: 'Failed to list WAVs' });
  }
});

app.get('/api/training/mic-temp/:filename/audio', requireMainAdmin, (req, res) => {
  const fn = path.basename(req.params.filename || '');
  if (!SAFE_MIC_WAV_RE.test(fn)) {
    return res.status(400).json({ error: 'invalid filename' });
  }
  const full = path.join(MIC_TEMP_DIR, fn);
  if (!fileResolvedUnder(full, MIC_TEMP_DIR) || !fs.existsSync(full)) {
    return res.status(404).json({ error: 'not found' });
  }
  let st;
  try {
    st = fs.statSync(full);
  } catch (_) {
    return res.status(404).json({ error: 'not found' });
  }
  if (st.size < MIN_MIC_CLIP_BYTES) {
    return res.status(404).json({
      error: 'WAV is still being recorded or is invalid (file too small to play)',
    });
  }
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Content-Length', String(st.size));
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(full).pipe(res);
});

app.get('/api/training/custom-clips/:label/:filename/audio', requireMainAdmin, (req, res) => {
  const label = req.params.label;
  if (label !== 'bark' && label !== 'not_bark') {
    return res.status(400).json({ error: 'label must be bark or not_bark' });
  }
  const fn = path.basename(req.params.filename || '');
  if (!SAFE_CUSTOM_WAV_RE.test(fn)) {
    return res.status(400).json({ error: 'invalid filename' });
  }
  const root = path.join(CUSTOM_CLIPS_ROOT, label);
  const full = path.join(root, fn);
  if (!fileResolvedUnder(full, root) || !fs.existsSync(full)) {
    return res.status(404).json({ error: 'not found' });
  }
  let st;
  try {
    st = fs.statSync(full);
  } catch (_) {
    return res.status(404).json({ error: 'not found' });
  }
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Content-Length', String(st.size));
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(full).pipe(res);
});

app.get('/api/training/inbox', requireMainAdmin, (req, res) => {
  try {
    const limit = req.query.limit != null ? Math.max(1, parseInt(req.query.limit, 10) || 100) : null;
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const { total, rows } = trainingInbox.listInbox(__dirname, { limit, offset });
    res.json({
      inboxEnabled: !!config.TRAINING_INBOX_ENABLED,
      maxFiles: config.TRAINING_INBOX_MAX_FILES,
      total,
      clips: rows,
    });
  } catch (err) {
    console.error('training inbox list:', err);
    res.status(500).json({ error: 'Failed to list inbox clips' });
  }
});

app.delete('/api/training/inbox', requireMainAdmin, auditMutatingRoute, (_req, res) => {
  try {
    const { removedFiles } = trainingInbox.clearEntireInbox(__dirname);
    res.json({ ok: true, removedFiles });
  } catch (err) {
    console.error('training inbox clear:', err);
    res.status(500).json({ error: 'Failed to clear training inbox' });
  }
});

/** JSON: RMS from PCM + capturedAt (inbox JSON or custom_clips sidecar). Used by training-listen pasted IDs. */
app.get('/api/training/inbox/:clipId/wav-meta', requireMainAdmin, (req, res) => {
  const { clipId } = req.params;
  if (!CLIP_ID_RE.test(clipId)) {
    return res.status(400).json({ error: 'invalid clipId' });
  }
  const wav = trainingInbox.resolveInboxOrPromotedWav(__dirname, clipId);
  if (!wav) {
    return res.status(404).json({ error: 'clip not found or expired' });
  }
  let rms = null;
  try {
    rms = computeRms(wav);
  } catch (_) {
    rms = null;
  }
  let capturedAt = null;
  const inboxDir = trainingInbox.getInboxDir(__dirname);
  const inboxWav = trainingInbox.clipPaths(inboxDir, clipId).wav;
  if (wav === inboxWav) {
    const m = trainingInbox.readMeta(inboxDir, clipId);
    if (m && m.capturedAt) capturedAt = m.capturedAt;
  } else {
    const j = wav.replace(/\.wav$/i, '.json');
    if (fs.existsSync(j)) {
      try {
        const o = JSON.parse(fs.readFileSync(j, 'utf8'));
        if (o && o.capturedAt) capturedAt = o.capturedAt;
      } catch (_) { /* ignore */ }
    }
  }
  res.json({ clipId, rms, capturedAt });
});

app.get('/api/training/inbox/:clipId/audio', requireMainAdmin, (req, res) => {
  const { clipId } = req.params;
  if (!CLIP_ID_RE.test(clipId)) {
    return res.status(400).json({ error: 'invalid clipId' });
  }
  const wav = trainingInbox.resolveInboxOrPromotedWav(__dirname, clipId);
  if (!wav) {
    return res.status(404).json({ error: 'clip not found or expired' });
  }
  let st;
  try {
    st = fs.statSync(wav);
  } catch (_) {
    return res.status(404).json({ error: 'clip not found or expired' });
  }
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Content-Length', String(st.size));
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(wav).pipe(res);
});

app.post('/api/training/inbox/:clipId/promote', requireMainAdmin, auditMutatingRoute, (req, res) => {
  const { clipId } = req.params;
  if (!CLIP_ID_RE.test(clipId)) {
    return res.status(400).json({ error: 'invalid clipId' });
  }
  const label = req.body && req.body.label;
  if (label !== 'bark' && label !== 'not_bark') {
    return res.status(400).json({ error: 'body.label must be bark or not_bark' });
  }
  const out = trainingInbox.promoteToTraining(__dirname, clipId, label);
  if (!out.ok) {
    return res.status(out.error === 'clip not found or expired' ? 404 : 400).json(out);
  }
  res.json({ ok: true, saved: out.saved, message: 'Run POST /api/custom-head/train to retrain the head.' });
});

app.delete('/api/training/inbox/:clipId', requireMainAdmin, auditMutatingRoute, (req, res) => {
  const { clipId } = req.params;
  if (!CLIP_ID_RE.test(clipId)) {
    return res.status(400).json({ error: 'invalid clipId' });
  }
  const ok = trainingInbox.deleteFromInbox(__dirname, clipId);
  if (!ok) {
    return res.status(404).json({ error: 'clip not found' });
  }
  res.json({ ok: true });
});

// === API: Presence / Status ===

app.get('/api/presence', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  let heartbeat = null;
  try {
    const row = db.prepare(`SELECT last_update FROM presence WHERE id = ?`).get(PRESENCE_ROW_ID);
    if (row) heartbeat = row.last_update;
  } catch (_) { /* ignore */ }

  res.json({
    heartbeat,
    lastSoundTime,
    serverTime: new Date().toISOString(),
    minRmsFloor: config.MIN_RMS_AMPLITUDE,
    lastRms,
    lastRmsTime,
    lastRmsAboveFloor,
    lastClassified,
    micMuted: config.MIC_MUTED,
  });
});

// === OpenAPI / Swagger UI ===
const swaggerUi = require('swagger-ui-express');
const yaml = require('js-yaml');

const openApiPath = path.join(__dirname, 'openapi.yaml');
let openApiSpec;
try {
  openApiSpec = yaml.load(fs.readFileSync(openApiPath, 'utf8'), { filename: openApiPath });
} catch (err) {
  console.error(
    '[openapi] could not read openapi.yaml:',
    err && err.message ? err.message : err,
  );
  openApiSpec = {
    openapi: '3.0.3',
    info: { title: siteApiTitle(), version: '0' },
    paths: {},
  };
}
if (openApiSpec && openApiSpec.info) {
  openApiSpec.info.title = siteApiTitle();
}

app.get('/api/openapi.yaml', requireDocsAdmin, (_req, res) => {
  res.type('text/yaml; charset=utf-8');
  res.send(yaml.dump(openApiSpec, { lineWidth: -1 }));
});

app.use(
  '/api/docs',
  requireDocsAdmin,
  swaggerUi.serve,
  swaggerUi.setup(openApiSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: siteApiTitle(),
    persistAuthorization: false,
  }),
);

// === SUSPICIOUS LOG WATCHER ===
if (!HEY_TEST_MODE) {
  const { startWatcher } = require('./log-watcher');
  startWatcher({ getBrandTitle: () => siteHeyLabel() });
}

if (HEY_TEST_MODE) {
  app.adminSecurityForTests = {
    parseBoolEnv,
    parsePositiveInt,
    trustProxyExpressValue,
    configureTrustProxy,
    createHttpsMiddleware,
    isPrivateLanIpv4Address,
    directTcpRemoteAddress,
    createVerifyAdminGuard,
    auditMutatingRoute,
    timingSafeEqualStrings,
    adminCredentialMatches,
    shouldBypassDocsAdminForTrustedLan,
  };
}

module.exports = app;

// === Server ===
if (!HEY_TEST_MODE) {
  app.listen(PORT, () => {
    console.log(
      `Server running: ML bark detection + API at http://localhost:${PORT} — OpenAPI docs http://localhost:${PORT}/api/docs`,
    );
  });
}
