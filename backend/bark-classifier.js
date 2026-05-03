const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');
const EventEmitter = require('events');

const RESTART_INITIAL_MS = 1000;
const RESTART_MAX_MS = 30000;
const RESTART_RESET_AFTER_MS = 60000;
const CLASSIFY_TIMEOUT_MS = 15000;

class BarkClassifier extends EventEmitter {
  constructor({ barkThreshold = 0.25, customHead = { enabled: false, path: '', threshold: 0.55 } } = {}) {
    super();
    this.barkThreshold = barkThreshold;
    /** @type {{ enabled: boolean, path: string, threshold: number }} */
    this.customHead = customHead;
    this._process = null;
    this._rl = null;
    this._pending = [];
    this._stopped = false;
    this._restartDelay = RESTART_INITIAL_MS;
    this._stableTimer = null;
  }

  start() {
    if (this._process || this._stopped) return;

    this._process = spawn('python3', [path.join(__dirname, 'classify_bark.py'), '--stream'], {
      env: { ...process.env, BARK_THRESHOLD: String(this.barkThreshold) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._rl = readline.createInterface({ input: this._process.stdout });
    this._rl.on('line', (line) => {
      let result;
      try {
        result = JSON.parse(line);
      } catch (_err) {
        // Stray non-JSON line on stdout — log and skip without popping the queue,
        // otherwise responses would misalign with requests.
        console.warn('[bark-classifier] non-JSON line on stdout:', line);
        return;
      }
      const cb = this._pending.shift();
      if (cb) cb(null, result);
    });

    this._process.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.error('[bark-classifier]', msg);
    });

    this._process.on('exit', (code) => {
      console.error(`[bark-classifier] exited with code ${code}`);
      this._process = null;
      this._rl = null;
      if (this._stableTimer) {
        clearTimeout(this._stableTimer);
        this._stableTimer = null;
      }
      while (this._pending.length) {
        const cb = this._pending.shift();
        cb(new Error('classifier process exited'));
      }
      if (!this._stopped) {
        const delay = this._restartDelay;
        this._restartDelay = Math.min(delay * 2, RESTART_MAX_MS);
        console.log(`[bark-classifier] restarting in ${delay}ms`);
        setTimeout(() => this.start(), delay);
      }
    });

    // If the process stays up long enough to look stable, reset the backoff.
    this._stableTimer = setTimeout(() => {
      this._restartDelay = RESTART_INITIAL_MS;
    }, RESTART_RESET_AFTER_MS);
  }

  classify(wavFilePath) {
    return new Promise((resolve, reject) => {
      if (!this._process) {
        return reject(new Error('classifier not running'));
      }

      const timer = setTimeout(() => {
        const idx = this._pending.indexOf(cb);
        if (idx !== -1) this._pending.splice(idx, 1);
        reject(new Error(`classify timed out after ${CLASSIFY_TIMEOUT_MS}ms`));
      }, CLASSIFY_TIMEOUT_MS);

      const cb = (err, result) => {
        clearTimeout(timer);
        if (err) return reject(err);
        resolve(result);
      };

      this._pending.push(cb);
      const ch = this.customHead;
      const custom_head =
        ch && ch.enabled && typeof ch.path === 'string' && ch.path.length > 0
          ? { enabled: true, path: ch.path, threshold: Number(ch.threshold) || 0.55 }
          : { enabled: false };
      const payload = JSON.stringify({
        path: wavFilePath,
        threshold: this.barkThreshold,
        custom_head,
      });
      this._process.stdin.write(payload + '\n');
    });
  }

  stop() {
    this._stopped = true;
    if (this._stableTimer) {
      clearTimeout(this._stableTimer);
      this._stableTimer = null;
    }
    if (this._process) {
      this._process.kill();
      this._process = null;
    }
  }
}

module.exports = BarkClassifier;
