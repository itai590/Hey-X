const EventEmitter = require('events');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

/**
 * Raw mic captures must live on persisted data (Docker: bind ./backend/data → /app/backend/data), not
 * container /tmp (tmpfs), or clips vanish on restart and cannot be copied to training_inbox after a crash.
 * Override with HEY_CLIP_TMP_DIR (e.g. /tmp/hey-presence for tests).
 */
function clipTempDir() {
  const fromEnv = (process.env.HEY_CLIP_TMP_DIR || '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(__dirname, 'data', 'mic_temp');
}

/** Same threshold as exit handler: below this, WAV is empty/header-only or invalid for playback. */
const MIN_VALID_CLIP_BYTES = 100;

const TMP_DIR = clipTempDir();
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

/** Delete clip-*.wav older than this (ms). 0 = never prune on startup. Default 7 days. */
const MIC_TEMP_MAX_AGE_MS = Number(process.env.HEY_MIC_TEMP_MAX_AGE_MS ?? 7 * 24 * 60 * 60 * 1000);
try {
  for (const f of fs.readdirSync(TMP_DIR)) {
    if (!f.startsWith('clip-') || !f.toLowerCase().endsWith('.wav')) continue;
    const full = path.join(TMP_DIR, f);
    let st;
    try {
      st = fs.statSync(full);
    } catch (_) {
      continue;
    }
    const tooSmall = st.size < MIN_VALID_CLIP_BYTES;
    const tooOld = MIC_TEMP_MAX_AGE_MS > 0 && st.mtimeMs < Date.now() - MIC_TEMP_MAX_AGE_MS;
    if (tooSmall || tooOld) {
      try {
        fs.unlinkSync(full);
      } catch (_) {
        /* ignore */
      }
    }
  }
} catch (_) {
  /* ignore */
}

class SoundDetector extends EventEmitter {
  constructor() {
    super();
    this.config = {
      PERCENTAGE_START: '10%',
      PERCENTAGE_END: '10%',
    };
    this._started = false;
    this.recorder = null;
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._listen();
  }

  stop() {
    this._started = false;
    if (this.recorder) {
      this.recorder.kill();
      this.recorder = null;
    }
  }

  _listen() {
    if (!this._started) {
      return this.emit('error', 'Listener not running');
    }

    const inputArgs = ({
      Linux: ['-t', 'alsa', 'hw:1,0'],
      Windows_NT: ['-t', 'waveaudio', '-d'],
      Darwin: ['-t', 'coreaudio', 'default'],
    })[os.type()];

    const wavPath = path.join(TMP_DIR, `clip-${Date.now()}.wav`);

    const args = [
      ...inputArgs,
      '-r', '16000', '-c', '1', '-b', '16',   // 16 kHz mono 16-bit (YAMNet input format)
      '-t', 'wav', wavPath,
      'silence', '1', '0.0001', this.config.PERCENTAGE_START,
      '1', '0.1', this.config.PERCENTAGE_END,
    ];

    const child = spawn('sox', args);
    this.recorder = child;

    let stderrBuf = '';
    child.stderr.on('data', (buf) => { stderrBuf += buf; });

    child.on('exit', () => {
      if (!this._started) {
        this._cleanup(wavPath);
        return;
      }
      if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size < MIN_VALID_CLIP_BYTES) {
        // Emit before cleanup so listeners can read the WAV for RMS (partial clips).
        this.emit('skipped', { wavPath });
        this._cleanup(wavPath);
        setTimeout(() => {
          if (this._started) this._listen();
        }, 500);
        return;
      }

      this.emit('detected', { wavPath });
      if (this._started) this._listen();
    });
  }

  _cleanup(filePath) {
    try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
  }

  isStarted() {
    return this._started;
  }
}

module.exports = SoundDetector;
module.exports.MIN_VALID_CLIP_BYTES = MIN_VALID_CLIP_BYTES;
