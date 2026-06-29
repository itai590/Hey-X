import fs from 'node:fs';
import path from 'node:path';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function makeSilentWav() {
  const samples = 4000;
  const dataSize = samples * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}

function createInbox(count = 186) {
  const labels = ['Bark', 'Dog', 'Music', 'Silence', 'Speech'];
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const isBark = n % 3 === 0;
    const clipId = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const topLabel = isBark ? 'Bark' : labels[n % labels.length];
    const capturedAt = new Date(Date.now() - index * 45000).toISOString();
    return {
      clipId,
      capturedAt,
      bytes: 8044 + (n % 8) * 512,
      rms: 0.08 + (n % 9) * 0.021,
      topLabel,
      topScore: Number((0.45 + (n % 5) * 0.09).toFixed(2)),
      barkScore: isBark ? 0.78 : 0.12,
      yamnetIsBark: isBark,
      isBark,
      classifyLogLine:
        `rms=${(0.08 + (n % 9) * 0.021).toFixed(4)} classified: ${topLabel} `
        + `(${isBark ? '0.78' : '0.12'}) bark_score=${isBark ? '0.78' : '0.12'} `
        + `yamnet_is_bark=${isBark} is_bark=${isBark}`,
    };
  });
}

function createCustom(label, count) {
  return Array.from({ length: count }, (_, index) => ({
    name: `demo-${label}-${String(index + 1).padStart(3, '0')}.wav`,
    bytes: 12044 + index * 37,
    rms: 0.1 + (index % 7) * 0.018,
    capturedAt: new Date(Date.now() - index * 3600000).toISOString(),
    clipId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  }));
}

export function renderTrainingListenDemo(template, { title, timeZone }) {
  const safeTitle = String(title).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
  const safeTimeZone = String(timeZone).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
  return template
    .replace(/<title>[^<]*<\/title>/, `<title>${safeTitle}</title>`)
    .replace(
      /<h1 id="training-listen-title">[^<]*<\/h1>/,
      `<h1 id="training-listen-title">${safeTitle}</h1>`,
    )
    .replace(/__DISPLAY_TIME_ZONE_HTML__/g, safeTimeZone)
    .replace(/__DISPLAY_TIME_ZONE_JSON__/g, JSON.stringify(String(timeZone)));
}

export function demoApiPlugin({
  adminToken,
  repoRoot,
  timeZone = 'UTC',
}) {
  const silentWav = makeSilentWav();
  const state = {
    config: {
      BARK_CONFIDENCE_THRESHOLD: 0.25,
      MIN_RMS_AMPLITUDE: 0.1,
      AI_DETECTION_ENABLED: true,
      DETECTION_THRESHOLD: 2,
      AGGREGATION_TIMER: 60,
      MIC_MUTED: false,
      DOG_NAME: 'Sheldon Demo',
      DOG_IMAGE_FILE: 'Sheldon.jpeg',
      CUSTOM_HEAD_ENABLED: true,
    },
    messages: [
      {
        id: 'demo-bark-1',
        text: 'Bark detected near the living-room window.',
        create_time: new Date(Date.now() - 120000).toISOString(),
        update_time: new Date(Date.now() - 30000).toISOString(),
      },
      {
        id: 'demo-bark-2',
        text: 'rms=0.1842 classified: Bark (0.86) bark_score=0.86 is_bark=true | top5: Bark 0.86, Dog 0.63, Animal 0.41, Speech 0.08, Music 0.03',
        create_time: new Date(Date.now() - 720000).toISOString(),
        update_time: new Date(Date.now() - 480000).toISOString(),
      },
      {
        id: 'demo-bark-3',
        text: 'Three barks grouped during the configured aggregation window.',
        create_time: new Date(Date.now() - 3600000).toISOString(),
        update_time: new Date(Date.now() - 3300000).toISOString(),
      },
    ],
    inbox: createInbox(),
    custom: {
      bark: createCustom('bark', 55),
      not_bark: createCustom('not-bark', 142),
    },
  };

  function authorized(req) {
    return req.headers.authorization === `Bearer ${adminToken}`;
  }

  function requireAdmin(req, res) {
    if (authorized(req)) return true;
    json(res, 401, { error: 'Invalid demo admin token', needsAdminAuth: true });
    return false;
  }

  return {
    name: 'hey-demo-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://demo.local');
        const pathname = url.pathname;
        if (!pathname.startsWith('/api/')) return next();

        try {
          if (pathname === '/api/auth/verify-admin' && req.method === 'POST') {
            const body = await readBody(req);
            return body.password === adminToken
              ? json(res, 200, { ok: true, audience: 'main', demo: true })
              : json(res, 401, { error: 'Invalid demo admin token' });
          }

          if (pathname === '/api/messages' && req.method === 'GET') {
            return json(res, 200, state.messages);
          }
          if (pathname === '/api/messages' && req.method === 'DELETE') {
            if (!requireAdmin(req, res)) return;
            const body = await readBody(req);
            const ids = Array.isArray(body.ids) ? new Set(body.ids) : new Set();
            const before = state.messages.length;
            state.messages = state.messages.filter((message) => !ids.has(message.id));
            return json(res, 200, { success: true, deleted: before - state.messages.length });
          }
          if (/^\/api\/messages\/[^/]+$/.test(pathname) && req.method === 'PUT') {
            if (!requireAdmin(req, res)) return;
            const id = decodeURIComponent(pathname.split('/').pop());
            const body = await readBody(req);
            const now = new Date().toISOString();
            const current = state.messages.find((message) => message.id === id);
            if (current) {
              Object.assign(current, body, { id, update_time: now });
            } else {
              state.messages.push({ ...body, id, create_time: now, update_time: now });
            }
            return json(res, 200, { success: true });
          }

          if (pathname === '/api/config' && req.method === 'GET') {
            return json(res, 200, state.config);
          }
          if (pathname === '/api/config' && req.method === 'PUT') {
            if (!requireAdmin(req, res)) return;
            Object.assign(state.config, await readBody(req));
            return json(res, 200, state.config);
          }
          if (pathname === '/api/presence' && req.method === 'GET') {
            const now = new Date();
            return json(res, 200, {
              heartbeat: now.toISOString(),
              serverTime: now.toISOString(),
              lastSoundTime: new Date(now - 1200).toISOString(),
              lastRms: 0.1842,
              lastRmsTime: new Date(now - 900).toISOString(),
              lastRmsAboveFloor: !state.config.MIC_MUTED,
              lastClassified: { isBark: true, topLabel: 'Bark', topScore: 0.86 },
              micMuted: state.config.MIC_MUTED,
            });
          }
          if (pathname === '/api/admin/logs' && req.method === 'GET') {
            if (!requireAdmin(req, res)) return;
            return json(res, 200, {
              ok: true,
              configured: true,
              truncated: false,
              text: [
                '[demo] Hey-X frontend demo API started',
                '[demo] microphone listener ready',
                '[demo] rms=0.1842 classified: Bark (0.86) is_bark=true',
                '[demo] alert aggregation complete: 3 barks',
                '[demo] settings and destructive actions are stored in memory only',
              ].join('\n'),
            });
          }

          if (pathname === '/api/training/listen' && req.method === 'GET') {
            const template = fs.readFileSync(
              path.join(repoRoot, 'backend', 'training-listen.html'),
              'utf8',
            );
            const html = renderTrainingListenDemo(template, {
              title: 'Hey Sheldon Demo — WAV review',
              timeZone,
            });
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.end(html);
          }
          if (pathname === '/api/training/audio-catalog' && req.method === 'GET') {
            if (!requireAdmin(req, res)) return;
            const limit = Math.max(1, Number(url.searchParams.get('limit')) || 50);
            const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
            const filter = url.searchParams.get('is_bark');
            const rows = filter === 'true'
              ? state.inbox.filter((row) => row.isBark === true)
              : filter === 'false'
                ? state.inbox.filter((row) => row.isBark === false)
                : state.inbox;
            return json(res, 200, {
              adminRequired: true,
              inboxTotal: rows.length,
              inboxOffset: offset,
              inboxLimit: limit,
              inbox: rows.slice(offset, offset + limit),
              micTemp: [{
                name: 'clip-demo.wav',
                bytes: silentWav.length,
                rms: 0.1325,
                mtime: new Date().toISOString(),
              }],
              custom: state.custom,
            });
          }
          if (pathname === '/api/training/inbox' && req.method === 'DELETE') {
            if (!requireAdmin(req, res)) return;
            const removedFiles = state.inbox.length * 2;
            state.inbox = [];
            return json(res, 200, { ok: true, removedFiles });
          }
          if (/^\/api\/training\/inbox\/[^/]+\/promote$/.test(pathname) && req.method === 'POST') {
            if (!requireAdmin(req, res)) return;
            const clipId = pathname.split('/')[4];
            const body = await readBody(req);
            const row = state.inbox.find((clip) => clip.clipId === clipId);
            state.inbox = state.inbox.filter((clip) => clip.clipId !== clipId);
            if (row && (body.label === 'bark' || body.label === 'not_bark')) {
              state.custom[body.label].unshift({
                name: `from-inbox-${clipId}.wav`,
                bytes: row.bytes,
                rms: row.rms,
                capturedAt: row.capturedAt,
                clipId,
              });
            }
            return json(res, 200, { ok: true, demo: true });
          }
          if (/^\/api\/training\/inbox\/[^/]+\/wav-meta$/.test(pathname) && req.method === 'GET') {
            if (!requireAdmin(req, res)) return;
            const clipId = pathname.split('/')[4];
            const row = state.inbox.find((clip) => clip.clipId === clipId);
            return row ? json(res, 200, row) : json(res, 404, { error: 'not found' });
          }
          if (pathname === '/api/custom-head/train' && req.method === 'POST') {
            if (!requireAdmin(req, res)) return;
            return json(res, 200, {
              ok: true,
              summary: 'Demo training completed: accuracy 0.94',
              log: 'Loaded demo clips\nEpoch 10/10\nValidation accuracy: 0.94\nSaved demo head',
            });
          }
          if (
            pathname.endsWith('/audio')
            && (
              pathname.startsWith('/api/training/inbox/')
              || pathname.startsWith('/api/training/mic-temp/')
              || pathname.startsWith('/api/training/custom-clips/')
            )
          ) {
            if (!requireAdmin(req, res)) return;
            res.statusCode = 200;
            res.setHeader('Content-Type', 'audio/wav');
            res.setHeader('Content-Length', String(silentWav.length));
            return res.end(silentWav);
          }

          return json(res, 404, { error: `No demo route for ${req.method} ${pathname}` });
        } catch (error) {
          return json(res, 500, { error: `Demo API error: ${error.message}` });
        }
      });
    },
  };
}
