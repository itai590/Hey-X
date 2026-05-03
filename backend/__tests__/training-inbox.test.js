const fs = require('fs');
const os = require('os');
const path = require('path');
const trainingInbox = require('../training-inbox');

function writeMinimalWav16Mono8000Hz(wavPath, sampleCount = 80) {
  const numChannels = 1;
  const sampleRate = 8000;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = sampleCount * blockAlign;
  const bufferSize = 44 + dataSize;
  const buf = Buffer.alloc(bufferSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(bufferSize - 8, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < sampleCount; i += 1) {
    buf.writeInt16LE(2000, 44 + i * 2);
  }
  fs.writeFileSync(wavPath, buf);
}

describe('training-inbox promote + resolve', () => {
  let root;
  const clipId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hey-inbox-'));
    const inbox = path.join(root, 'data', 'training_inbox');
    fs.mkdirSync(inbox, { recursive: true });
    writeMinimalWav16Mono8000Hz(path.join(inbox, `${clipId}.wav`));
    fs.writeFileSync(
      path.join(inbox, `${clipId}.json`),
      `${JSON.stringify({
        clipId,
        capturedAt: '2026-05-03T08:00:00.000Z',
        rms: 0.1111,
        topLabel: 'Dog',
        isBark: false,
      })}\n`,
      'utf8',
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
  });

  test('promote copies wav, writes sidecar with capturedAt, removes inbox', () => {
    const out = trainingInbox.promoteToTraining(root, clipId, 'bark');
    expect(out.ok).toBe(true);
    expect(fs.existsSync(path.join(root, 'data', 'training_inbox', `${clipId}.wav`))).toBe(false);
    const destWav = path.join(root, 'data', 'custom_clips', 'bark', `from-inbox-${clipId}.wav`);
    expect(fs.existsSync(destWav)).toBe(true);
    const side = JSON.parse(fs.readFileSync(destWav.replace(/\.wav$/i, '.json'), 'utf8'));
    expect(side.clipId).toBe(clipId);
    expect(side.capturedAt).toBe('2026-05-03T08:00:00.000Z');
    expect(side.promotedLabel).toBe('bark');
  });

  test('resolveInboxOrPromotedWav finds inbox then custom_clips', () => {
    expect(trainingInbox.resolveInboxOrPromotedWav(root, clipId)).toContain('training_inbox');
    trainingInbox.promoteToTraining(root, clipId, 'not_bark');
    const p = trainingInbox.resolveInboxOrPromotedWav(root, clipId);
    expect(p).toContain('custom_clips');
    expect(p).toContain('not_bark');
    expect(p).toContain(`from-inbox-${clipId}.wav`);
  });

  test('clearEntireInbox removes wav/json and leaves dir empty of clips', () => {
    const out = trainingInbox.clearEntireInbox(root);
    expect(out.removedFiles).toBeGreaterThanOrEqual(2);
    expect(trainingInbox.listInbox(root).length).toBe(0);
    const again = trainingInbox.clearEntireInbox(root);
    expect(again.removedFiles).toBe(0);
  });
});
