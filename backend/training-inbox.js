const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

/**
 * Copy a mic temp WAV + write metadata JSON so logs/API can reference clip_id and promote to training sets.
 * Clips live in data/training_inbox/ (a short-lived inbox before labeling / custom_clips).
 */
function getInboxDir(backendRoot) {
  return path.join(backendRoot, 'data', 'training_inbox');
}

function pruneInbox(inboxDir, maxFiles) {
  let wavs;
  try {
    wavs = fs.readdirSync(inboxDir).filter((f) => f.toLowerCase().endsWith('.wav'));
  } catch (_) {
    return;
  }
  if (wavs.length <= maxFiles) return;

  const withMtime = wavs.map((f) => {
    const full = path.join(inboxDir, f);
    return { base: f.slice(0, -4), mtime: fs.statSync(full).mtimeMs };
  });
  withMtime.sort((a, b) => a.mtime - b.mtime);
  const excess = withMtime.slice(0, wavs.length - maxFiles);
  for (const { base } of excess) {
    try {
      fs.unlinkSync(path.join(inboxDir, `${base}.wav`));
    } catch (_) { /* ignore */ }
    try {
      fs.unlinkSync(path.join(inboxDir, `${base}.json`));
    } catch (_) { /* ignore */ }
  }
}

/**
 * @param {object} opts
 * @param {string} opts.backendRoot __dirname of server
 * @param {string} opts.wavPath source temp wav (still on disk)
 * @param {number} opts.maxFiles
 * @param {Record<string, unknown>} opts.meta metadata (rms, labels, etc.)
 * @returns {string|null} clipId
 */
function captureClip(opts) {
  const { backendRoot, wavPath, maxFiles, meta } = opts;
  const inboxDir = getInboxDir(backendRoot);
  fs.mkdirSync(inboxDir, { recursive: true });

  const clipId = randomUUID();
  const wavDest = path.join(inboxDir, `${clipId}.wav`);
  const jsonDest = path.join(inboxDir, `${clipId}.json`);

  fs.copyFileSync(wavPath, wavDest);
  const payload = {
    clipId,
    capturedAt: new Date().toISOString(),
    ...meta,
  };
  fs.writeFileSync(jsonDest, `${JSON.stringify(payload, null, '\t')}\n`, 'utf8');
  pruneInbox(inboxDir, maxFiles);
  return clipId;
}

function readMeta(inboxDir, clipId) {
  const jsonDest = path.join(inboxDir, `${clipId}.json`);
  if (!fs.existsSync(jsonDest)) return null;
  try {
    const raw = fs.readFileSync(jsonDest, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function clipPaths(inboxDir, clipId) {
  return {
    wav: path.join(inboxDir, `${clipId}.wav`),
    json: path.join(inboxDir, `${clipId}.json`),
  };
}

function listInbox(backendRoot) {
  const inboxDir = getInboxDir(backendRoot);
  if (!fs.existsSync(inboxDir)) return [];
  const names = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.json'));
  const rows = [];
  for (const name of names) {
    const clipId = name.slice(0, -5);
    const meta = readMeta(inboxDir, clipId);
    if (!meta) continue;
    const { wav } = clipPaths(inboxDir, clipId);
    let bytes = 0;
    try {
      bytes = fs.statSync(wav).size;
    } catch (_) { /* ignore */ }
    rows.push({ ...meta, bytes });
  }
  rows.sort((a, b) => String(b.capturedAt || '').localeCompare(String(a.capturedAt || '')));
  return rows;
}

function deleteFromInbox(backendRoot, clipId) {
  if (!/^[0-9a-f-]{36}$/i.test(clipId)) return false;
  const inboxDir = getInboxDir(backendRoot);
  const { wav, json } = clipPaths(inboxDir, clipId);
  let removed = false;
  try {
    if (fs.existsSync(wav)) {
      fs.unlinkSync(wav);
      removed = true;
    }
  } catch (_) { /* ignore */ }
  try {
    if (fs.existsSync(json)) {
      fs.unlinkSync(json);
      removed = true;
    }
  } catch (_) { /* ignore */ }
  return removed;
}

/**
 * Copy wav into custom_clips/{label}/ and remove inbox files.
 * Writes a sidecar JSON next to the WAV so /api/training/audio-catalog can show original
 * capturedAt (and clipId) after promotion, and GET /api/training/inbox/:clipId/audio can
 * resolve the file under custom_clips.
 */
function promoteToTraining(backendRoot, clipId, label) {
  if (label !== 'bark' && label !== 'not_bark') {
    return { ok: false, error: 'label must be bark or not_bark' };
  }
  if (!/^[0-9a-f-]{36}$/i.test(clipId)) {
    return { ok: false, error: 'invalid clipId' };
  }
  const inboxDir = getInboxDir(backendRoot);
  const { wav: srcWav, json: srcJson } = clipPaths(inboxDir, clipId);
  if (!fs.existsSync(srcWav)) {
    return { ok: false, error: 'clip not found or expired' };
  }

  const destDir = path.join(backendRoot, 'data', 'custom_clips', label);
  fs.mkdirSync(destDir, { recursive: true });
  const destName = `from-inbox-${clipId}.wav`;
  const destPath = path.join(destDir, destName);
  const destJsonPath = path.join(destDir, `from-inbox-${clipId}.json`);
  const inboxMeta = readMeta(inboxDir, clipId) || { clipId };
  const sidecar = {
    clipId,
    capturedAt: inboxMeta.capturedAt || null,
    promotedAt: new Date().toISOString(),
    promotedLabel: label,
    rms: inboxMeta.rms != null ? inboxMeta.rms : undefined,
    topLabel: inboxMeta.topLabel,
    topScore: inboxMeta.topScore,
    isBark: inboxMeta.isBark,
    barkScore: inboxMeta.barkScore,
  };
  fs.copyFileSync(srcWav, destPath);
  try {
    fs.writeFileSync(destJsonPath, `${JSON.stringify(sidecar, null, '\t')}\n`, 'utf8');
  } catch (_) {
    /* ignore sidecar failure; WAV still promoted */
  }
  try {
    fs.unlinkSync(srcWav);
  } catch (_) { /* ignore */ }
  try {
    fs.unlinkSync(srcJson);
  } catch (_) { /* ignore */ }

  return {
    ok: true,
    saved: path.relative(path.join(backendRoot, 'data'), destPath),
    destPath,
  };
}

/** Inbox WAV path, or promoted copy under custom_clips (same clip_id in logs / UI). */
function resolveInboxOrPromotedWav(backendRoot, clipId) {
  if (!/^[0-9a-f-]{36}$/i.test(clipId)) return null;
  const inboxDir = getInboxDir(backendRoot);
  const { wav } = clipPaths(inboxDir, clipId);
  if (fs.existsSync(wav)) return wav;
  const base = `from-inbox-${clipId}.wav`;
  for (const lab of ['bark', 'not_bark']) {
    const p = path.join(backendRoot, 'data', 'custom_clips', lab, base);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

module.exports = {
  getInboxDir,
  captureClip,
  listInbox,
  deleteFromInbox,
  promoteToTraining,
  readMeta,
  clipPaths,
  resolveInboxOrPromotedWav,
};
