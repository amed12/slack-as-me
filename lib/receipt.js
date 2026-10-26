'use strict';

// Receipt: bukti bahwa isi pesan ini sudah pernah lewat mode `draft`.
//
// Gunanya menjadikan aturan "tampilkan draft dulu, kirim hanya kalau disuruh"
// (~/.claude/CLAUDE.md) sebagai pemeriksaan mesin, bukan sesuatu yang harus
// diingat. `send` menolak kalau receipt untuk body+thread yang persis sama
// tidak ada atau sudah kedaluwarsa -- termasuk kalau body diam-diam berubah
// setelah user menyetujui draftnya.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.cache', 'slack-as-me', 'receipts');
const TTL_MS = 60 * 60 * 1000;

function keyFor(body, threadTs, attachSha) {
  // JSON.stringify dipakai sebagai pemisah yang tidak ambigu antara field.
  // Lampiran ikut dikunci lewat hash isinya: file yang diganti setelah draft
  // disetujui menghasilkan key berbeda, jadi `send` menolaknya. Tanpa lampiran,
  // key sama persis dengan versi lama (receipt yang sudah ada tetap sah).
  const parts = [String(body), String(threadTs || '')];
  if (attachSha) parts.push(String(attachSha));
  const canon = JSON.stringify(parts);
  return crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
}

function fileFor(key) {
  return path.join(DIR, key + '.json');
}

function save({ body, threadTs, channelId, channelLabel, draftFile, attach }) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const key = keyFor(body, threadTs, attach && attach.sha);
  const rec = {
    key,
    createdAt: new Date().toISOString(),
    channelId: channelId || null,
    channelLabel: channelLabel || null,
    threadTs: threadTs || null,
    bodyChars: String(body).length,
    draftFile: draftFile || null,
    attach: attach ? { name: attach.name, size: attach.size, sha: attach.sha } : null,
  };
  fs.writeFileSync(fileFor(key), JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  return rec;
}

/**
 * @returns {{ok: true, receipt: object} | {ok: false, reason: string, detail: string}}
 */
function verify({ body, threadTs, channelId, channelLabel, attachSha }) {
  const key = keyFor(body, threadTs, attachSha);
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(fileFor(key), 'utf8'));
  } catch {
    return {
      ok: false,
      reason: 'tidak-ada',
      detail:
        'Belum ada receipt untuk isi pesan ini. Jalankan `slack-as-me draft` dengan body ' +
        'dan thread yang sama dulu, tunjukkan ke user, baru kirim.',
    };
  }
  const age = Date.now() - Date.parse(rec.createdAt);
  if (!Number.isFinite(age) || age > TTL_MS) {
    return {
      ok: false,
      reason: 'kedaluwarsa',
      detail:
        'Receipt dibuat ' +
        Math.round(age / 60000) +
        ' menit lalu (batas ' +
        TTL_MS / 60000 +
        ' menit). Draft ulang.',
    };
  }
  const idMatch = rec.channelId && channelId && rec.channelId === channelId;
  const labelMatch =
    rec.channelLabel &&
    channelLabel &&
    rec.channelLabel.toLowerCase() === String(channelLabel).toLowerCase();
  if (!idMatch && !labelMatch) {
    return {
      ok: false,
      reason: 'channel-beda',
      detail:
        'Receipt ini untuk ' +
        (rec.channelLabel || rec.channelId) +
        ', bukan ' +
        (channelLabel || channelId) +
        '.',
    };
  }
  return { ok: true, receipt: rec };
}

module.exports = { save, verify, keyFor, DIR, TTL_MS };
