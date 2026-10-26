'use strict';

// Config non-rahasia: mencatat account (email) mana yang jadi default pengirim.
// TIDAK PERNAH memuat token — token hanya ada di Keychain.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.config', 'slack-as-me');
const FILE = path.join(DIR, 'config.json');

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function write(patch) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const next = { ...read(), ...patch };
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

/** Account efektif: --account > env > config > null */
function resolveAccount(flag) {
  return flag || process.env.SLACK_AS_ME_ACCOUNT || read().account || null;
}

module.exports = { read, write, resolveAccount, FILE };
