'use strict';

/**
 * Swagger UI "Try it out" can mis-handle http bearer schemes and send
 * `Authorization: Bearer [object Object]`. We persist the raw secret from the authorize
 * modal on `window` and normalize outgoing requests via swagger-ui's requestInterceptor.
 *
 * The authorize modal uses a plain text input by default; we coerce inputs to type=password and
 * autocomplete so password managers behave like on `/api/training/listen`.
 */

const DEFAULT_GLOBAL_KEY = '__heySwaggerBearerMainToken';
const BROKEN_AUTHORIZATION = 'Bearer [object Object]';
const INVALID_TOKEN_LITERAL = '[object Object]';
const BEARER_PREFIX_RE = /^Bearer\s+/i;

function stripBearerPrefix(value) {
  return String(value ?? '').replace(BEARER_PREFIX_RE, '').trim();
}

/** Raw modal value → secret string suitable for `Authorization: Bearer …`, or empty if unusable. */
function normalizedBearerSecret(value) {
  const t = stripBearerPrefix(value);
  return t && t !== INVALID_TOKEN_LITERAL ? t : '';
}

function setHeader(headers, name, value) {
  if (headers && typeof headers.set === 'function') {
    const next = headers.set(name, value);
    return next || headers;
  }
  return Object.assign({}, headers || {}, { [name]: value });
}

function deleteHeader(headers, name) {
  if (headers && typeof headers.delete === 'function') {
    const next = headers.delete(name);
    return next || headers;
  }
  const next = Object.assign({}, headers || {});
  delete next[name];
  return next;
}

function getHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name];
}

/**
 * @param {string} [globalKey]
 * @returns {string} IIFE source for swagger-ui `customJsStr`
 */
function buildAuthorizeInputScript(globalKey = DEFAULT_GLOBAL_KEY) {
  const keyJson = JSON.stringify(globalKey);
  return `
(function () {
  var TOKEN_KEY = ${keyJson};
  var root = document.getElementById('swagger-ui');
  if (!root) return;

  function cleanToken(value) {
    return String(value || '').replace(${BEARER_PREFIX_RE}, '').trim();
  }

  function rememberToken(value) {
    var token = cleanToken(value);
    if (token && token !== ${JSON.stringify(INVALID_TOKEN_LITERAL)}) {
      window[TOKEN_KEY] = token;
    }
  }

  function prepareAuthInputs() {
    root.querySelectorAll('.dialog-ux input, .modal-ux input, [role=dialog] input')
      .forEach(function (input) {
        if (!input.dataset.heySwaggerPm) {
          input.dataset.heySwaggerPm = '1';
          input.type = 'password';
          input.setAttribute('autocomplete', 'current-password');
          input.setAttribute('name', 'hey-admin-bearer-token');
          input.setAttribute('autocorrect', 'off');
          input.setAttribute('autocapitalize', 'off');
          input.setAttribute('spellcheck', 'false');
          input.addEventListener('input', function () { rememberToken(input.value); });
          input.addEventListener('change', function () { rememberToken(input.value); });
        }
        rememberToken(input.value);
      });
  }

  root.addEventListener('click', function (event) {
    var target = event && event.target;
    var text = String((target && (target.textContent || target.value)) || '');
    if (/authorize/i.test(text)) setTimeout(prepareAuthInputs, 0);
  }, true);

  prepareAuthInputs();
  new MutationObserver(prepareAuthInputs).observe(root, { childList: true, subtree: true });
}());
`.trim();
}

/**
 * @param {string} [globalKey] — must match {@link buildAuthorizeInputScript}
 */
function createBearerTokenRequestInterceptor(globalKey = DEFAULT_GLOBAL_KEY) {
  return function swaggerUiBearerTokenRequestInterceptor(req) {
    const win = typeof window !== 'undefined' ? window : undefined;
    const stored = win && typeof win[globalKey] !== 'undefined' ? win[globalKey] : '';
    const token = normalizedBearerSecret(stored);

    const header =
      getHeader(req.headers, 'Authorization') || getHeader(req.headers, 'authorization');
    const hasBrokenSwaggerAuth = String(header || '').trim() === BROKEN_AUTHORIZATION;

    if (token) {
      req.headers = setHeader(req.headers, 'Authorization', `Bearer ${token}`);
    } else if (hasBrokenSwaggerAuth) {
      req.headers = deleteHeader(req.headers, 'Authorization');
      req.headers = deleteHeader(req.headers, 'authorization');
    }

    return req;
  };
}

module.exports = {
  DEFAULT_GLOBAL_KEY,
  buildAuthorizeInputScript,
  createBearerTokenRequestInterceptor,
};
