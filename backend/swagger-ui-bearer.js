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
 * Runs in the browser inside Swagger UI (swagger-ui-express embeds this via `function.toString()`).
 * It MUST NOT close over module scope — those bindings are not present after serialization.
 *
 * @param {string} [globalKey] — must match {@link buildAuthorizeInputScript}; default baked in for embed safety.
 */
function createBearerTokenRequestInterceptor(globalKey = DEFAULT_GLOBAL_KEY) {
  // NOTE: Do not reference module-level helpers/constants inside the returned function.
  return new Function(
    'req',
    `
  var TOKEN_KEY = ${JSON.stringify(globalKey)};
  var BROKEN_AUTH = ${JSON.stringify(BROKEN_AUTHORIZATION)};
  var BAD_LITERAL = ${JSON.stringify(INVALID_TOKEN_LITERAL)};
  var PREFIX = /^Bearer\\s+/i;

  function stripBearer(value) {
    return String(value == null ? '' : value).replace(PREFIX, '').trim();
  }
  function usableSecret(raw) {
    var t = stripBearer(raw);
    return t && t !== BAD_LITERAL ? t : '';
  }
  function headersToObject(h) {
    var out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function') {
      h.forEach(function (v, k) { out[k] = v; });
      return out;
    }
    if (typeof h === 'object') {
      for (var k in h) {
        if (Object.prototype.hasOwnProperty.call(h, k)) out[k] = h[k];
      }
    }
    return out;
  }
  function applyAuth(headers, value) {
    var next = headersToObject(headers);
    next.Authorization = value;
    delete next.authorization;
    return next;
  }
  function stripAuth(headers) {
    var next = headersToObject(headers);
    delete next.Authorization;
    delete next.authorization;
    return next;
  }
  function getAuthHeader(headers) {
    if (!headers) return '';
    if (typeof headers.get === 'function') {
      return headers.get('Authorization') || headers.get('authorization') || '';
    }
    return headers.Authorization || headers.authorization || '';
  }

  var win = typeof window !== 'undefined' ? window : undefined;
  var stored = win && win[TOKEN_KEY] != null ? win[TOKEN_KEY] : '';
  var token = usableSecret(stored);

  var rawAuth = getAuthHeader(req.headers);
  var authTrim = String(rawAuth || '').trim();
  var broken =
    authTrim === BROKEN_AUTH ||
    authTrim.indexOf('[object Object]') !== -1;

  if (token) {
    req.headers = applyAuth(req.headers, 'Bearer ' + token);
  } else if (broken) {
    req.headers = stripAuth(req.headers);
  }

  return req;
`,
  );
}

module.exports = {
  DEFAULT_GLOBAL_KEY,
  buildAuthorizeInputScript,
  createBearerTokenRequestInterceptor,
};
