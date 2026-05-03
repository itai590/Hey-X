#!/usr/bin/env node
/**
 * Polls Docker Engine API over the unix socket for backend + frontend container health.
 * Sends email when a service becomes unreachable or Docker reports unhealthy (after SMTP cooldown).
 *
 * Env: DOG_SLUG, SMTP_HOST, SMTP_USER, SMTP_PASS, ALERT_EMAIL_TO (ALERT_EMAIL_FROM optional).
 * Optional: HEALTH_WATCH_INTERVAL_SEC (default 60), HEALTH_ALERT_COOLDOWN_MINUTES (default 30),
 * HEALTH_WATCH_EMAIL_ON_RECOVERY (true/false), DOCKER_SOCKET_PATH, DOCKER_API_VERSION (default v1.41).
 */

const http = require('http');
const nodemailer = require('nodemailer');
const { formatDisplayDateTime } = require('./format-display-time');

const SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
const API_VERSION = process.env.DOCKER_API_VERSION || 'v1.41';
const SLUG = (process.env.DOG_SLUG || '').trim();
const PREFIX = (process.env.HEY_CONTAINER_PREFIX || 'hey').trim();
const INTERVAL_MS = Math.max(15, Number(process.env.HEALTH_WATCH_INTERVAL_SEC) || 60) * 1000;
const COOLDOWN_MS = Math.max(1, Number(process.env.HEALTH_ALERT_COOLDOWN_MINUTES) || 30) * 60 * 1000;
const EMAIL_ON_RECOVERY = /^1|true|yes$/i.test(
  String(process.env.HEALTH_WATCH_EMAIL_ON_RECOVERY || '').trim(),
);

function containerNames() {
  if (!SLUG) {
    console.error('[health-watch] DOG_SLUG is unset — nothing to watch');
    return [];
  }
  return [`${PREFIX}-${SLUG}-backend`, `${PREFIX}-${SLUG}-frontend`];
}

function buildTransport() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    console.warn('[health-watch] SMTP not configured — alerts only logged to console');
    return null;
  }

  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: { user, pass },
  });
}

function dockerInspect(name) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCKET_PATH,
        path: `/${API_VERSION}/containers/${encodeURIComponent(name)}/json`,
        method: 'GET',
        headers: { Host: 'localhost' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode === 404) {
            resolve({ missing: true });
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Docker API HTTP ${res.statusCode}: ${body.slice(0, 240)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy(new Error('Docker socket request timeout'));
    });
    req.end();
  });
}

function summarize(inspect) {
  if (inspect.missing) {
    return {
      running: false,
      health: 'missing',
      statusText: 'container not found',
      exitCode: null,
    };
  }
  const st = inspect.State || {};
  const running = st.Status === 'running';
  const healthStatus = st.Health && st.Health.Status ? st.Health.Status : null;
  let statusText = st.Status || 'unknown';
  if (st.Error) statusText += ` (${st.Error})`;
  return {
    running,
    health: healthStatus,
    statusText,
    exitCode: typeof st.ExitCode === 'number' ? st.ExitCode : null,
  };
}

/** Skip alerts during normal Docker "starting" grace (healthcheck start_period). */
function isTransientStarting(state) {
  return state.running && state.health === 'starting';
}

/** Problem worth reporting (not just "still booting"). */
function isBad(state) {
  if (isTransientStarting(state)) return false;
  if (!state.running) return true;
  if (state.health === 'unhealthy') return true;
  return false;
}

function brandTitle() {
  return SLUG ? `Hey ${SLUG}` : 'Hey';
}

async function sendMail(transport, subject, lines) {
  const body = lines.join('\n');
  console.warn(`[health-watch] ${subject}`);

  if (!transport || !process.env.ALERT_EMAIL_TO) {
    return;
  }

  try {
    await transport.sendMail({
      from: process.env.ALERT_EMAIL_FROM || process.env.SMTP_USER,
      to: process.env.ALERT_EMAIL_TO,
      subject,
      text: body,
    });
    console.log(`[health-watch] Email sent to ${process.env.ALERT_EMAIL_TO}`);
  } catch (err) {
    console.error('[health-watch] Failed to send email:', err.message);
  }
}

async function main() {
  const transport = buildTransport();
  const names = containerNames();
  if (names.length === 0) {
    process.exit(1);
  }

  /** Once the container has existed (Docker returned json), we may alert on down/missing. */
  const seenContainer = new Map(names.map((n) => [n, false]));
  const lastAlertAt = new Map();
  const lastWasBad = new Map(names.map((n) => [n, false]));

  async function tick() {
    const ts = formatDisplayDateTime(new Date());

    for (const name of names) {
      let inspect;
      try {
        inspect = await dockerInspect(name);
      } catch (err) {
        console.error(`[health-watch] inspect ${name}:`, err.message);
        continue;
      }

      if (!inspect.missing) {
        seenContainer.set(name, true);
      }

      const state = summarize(inspect);

      const bad = isBad(state);
      const wasBad = lastWasBad.get(name);
      lastWasBad.set(name, bad);

      if (!bad) {
        if (EMAIL_ON_RECOVERY && wasBad && seenContainer.get(name)) {
          await sendMail(transport, `[${brandTitle()}] ${name} recovered`, [
            `Container is OK again.`,
            ``,
            `Time: ${ts}`,
            `Container: ${name}`,
            `State: ${state.statusText}`,
            state.health ? `Health: ${state.health}` : '',
            ``,
            `${brandTitle()} health watch`,
          ].filter(Boolean));
        }
        continue;
      }

      if (!seenContainer.get(name)) {
        continue;
      }

      const last = lastAlertAt.get(name);
      if (last && Date.now() - last < COOLDOWN_MS) {
        continue;
      }

      lastAlertAt.set(name, Date.now());

      const detailLines = [
        `Service check failed for Docker container.`,
        ``,
        `Time: ${ts}`,
        `Container: ${name}`,
        `Running: ${state.running}`,
        state.health ? `Health: ${state.health}` : `Health: (no healthcheck or n/a)`,
        `Status: ${state.statusText}`,
        state.exitCode !== null && !state.running ? `Exit code: ${state.exitCode}` : '',
        ``,
        `Inspect on host: docker inspect ${name}`,
        ``,
        `${brandTitle()} health watch`,
      ].filter(Boolean);

      await sendMail(
        transport,
        `[${brandTitle()}] DOWN: ${name}`,
        detailLines,
      );
    }
  }

  console.log(
    `[health-watch] Watching ${names.join(', ')} every ${INTERVAL_MS / 1000}s (cooldown ${COOLDOWN_MS / 60000} min)`,
  );

  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.error('[health-watch] tick error:', e.message || e);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main();
