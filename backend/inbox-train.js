#!/usr/bin/env node
/**
 * CLI: promote a training-inbox clip (UUID from logs / GET /api/training/inbox) into
 * custom_clips/{bark|not_bark}/ and run train_custom_head.py (same as POST .../promote + POST .../train).
 *
 * Usage:
 *   node inbox-train.js <clip-uuid> <bark|not_bark>
 *   npm run inbox-train -- <clip-uuid> bark
 *
 * Options:
 *   --promote-only   Copy WAV into custom_clips but do not run Python training
 */

require('./console-timestamp').install();
const path = require('path');
const { spawnSync } = require('child_process');
const trainingInbox = require('./training-inbox');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function usage(msg) {
  if (msg) console.error(msg);
  console.error(`
Usage: node inbox-train.js <clip-uuid> <bark|not_bark> [--promote-only]

  Promotes data/training_inbox/<uuid>.wav (+ .json) into data/custom_clips/<label>/
  then runs train_custom_head.py unless --promote-only is set.

  Run from the backend directory (or use npm run from backend/).
`);
  process.exit(msg ? 1 : 0);
}

function main() {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const promoteOnly = argv.includes('--promote-only');
  const args = argv.filter((a) => a !== '--promote-only');

  if (args.length === 1 && (args[0] === '-h' || args[0] === '--help')) {
    usage();
  }
  if (args.length < 2) {
    usage('Missing arguments.');
  }

  const clipId = args[0].trim();
  const label = args[1].trim().toLowerCase();

  if (!UUID_RE.test(clipId)) {
    usage(`Invalid clip UUID: ${clipId}`);
  }
  if (label !== 'bark' && label !== 'not_bark') {
    usage(`Label must be bark or not_bark, got: ${label}`);
  }

  const backendRoot = path.resolve(__dirname);

  const out = trainingInbox.promoteToTraining(backendRoot, clipId, label);
  if (!out.ok) {
    console.error(`Promote failed: ${out.error}`);
    process.exit(1);
  }

  console.log(`Promoted → ${out.saved}`);

  if (promoteOnly) {
    console.log('Skipping training (--promote-only).');
    process.exit(0);
  }

  const trainPy = path.join(backendRoot, 'train_custom_head.py');
  const run = spawnSync('python3', [trainPy], {
    cwd: backendRoot,
    stdio: 'inherit',
    env: process.env,
  });

  const code = run.status;
  if (code !== 0) {
    console.error(`train_custom_head.py exited with code ${code}`);
    process.exit(code === null ? 1 : code);
  }

  console.log('Training finished. Restart the backend or rely on next classify to reload head.json if applicable.');
}

main();
