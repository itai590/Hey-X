/**
 * Phase-1 admin hardening: HTTPS gate, verify-admin throttle + lockout, mutation audit helpers.
 *
 * All state is in-memory (single process); lost on restart.
 */
const crypto = require('crypto');

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

/** Trust proxy Express setting: undefined → leave unset unless HTTPS required uses default hop. */
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

/** When `trustLoopback` is true (default), direct HTTP hits from localhost still work for health checks. */
function createHttpsMiddleware(heyRequireHttps, { trustLoopback = true } = {}) {
  if (!heyRequireHttps) return function httpsSkip(_req, _res, next) {
    next();
  };
  return function requireHttps(req, res, next) {
    if (trustLoopback && isProbablyLoopback(req)) return next();
    if (isHttpsRequest(req)) return next();
    return res.status(403).json({ error: 'HTTPS required', code: 'HTTPS_REQUIRED' });
  };
}

/** Per-key verify-admin throttle + exponential lockout after repeated failures */
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

  /** @returns {{ ok: boolean, retryAfterSec?: number, reason?: string }} */
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

function auditMutatingRoute(req, res, next) {
  const start = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const path = req.originalUrl || req.url || '';
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const safeIp = typeof ip === 'string' ? ip : String(ip);
    console.log(
      `[audit-admin] ${req.method} ${path} status=${res.statusCode} duration_ms=${durationMs} ip=${safeIp}`,
    );
  });
  next();
}

/**
 * Timing-safe equality for UTF-8 strings (same semantics as server.js).
 */
function timingSafeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufa = Buffer.from(a, 'utf8');
  const bufb = Buffer.from(b, 'utf8');
  if (bufa.length !== bufb.length) return false;
  return crypto.timingSafeEqual(bufa, bufb);
}

/**
 * @returns {boolean} true if `candidate` equals primary or optional previous rotation token (non-empty only).
 */
function adminCredentialMatches(candidate, primaryRaw, previousRaw) {
  if (!candidate) return false;
  if (timingSafeEqualStrings(primaryRaw, candidate)) return true;
  if (previousRaw && timingSafeEqualStrings(previousRaw, candidate)) return true;
  return false;
}

module.exports = {
  parseBoolEnv,
  parsePositiveInt,
  trustProxyExpressValue,
  configureTrustProxy,
  createHttpsMiddleware,
  createVerifyAdminGuard,
  auditMutatingRoute,
  timingSafeEqualStrings,
  adminCredentialMatches,
};
