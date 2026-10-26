'use strict';

// Penyimpanan token di macOS Keychain.
// Token diminta lewat stdin, TIDAK PERNAH sebagai argumen CLI, supaya tidak
// masuk ~/.zsh_history maupun daftar proses (ps aux).

const { spawnSync } = require('child_process');

const SERVICE = 'slack-as-me';
const SECURITY = '/usr/bin/security';

class KeychainError extends Error {}

function requireDarwin() {
  if (process.platform !== 'darwin') {
    throw new KeychainError(
      'penyimpanan token hanya didukung di macOS (butuh /usr/bin/security). ' +
        'Mode draft tetap jalan tanpa token.'
    );
  }
}

/**
 * Baca token. Mengembalikan null kalau item tidak ada (bukan error) supaya
 * pemanggil bisa memberi pesan yang mengarahkan ke SETUP.md.
 */
function readToken(account) {
  requireDarwin();
  if (!account) throw new KeychainError('account (email) wajib untuk membaca token');
  const r = spawnSync(SECURITY, ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], {
    encoding: 'utf8',
  });
  if (r.status === 0) {
    const tok = (r.stdout || '').trim();
    return tok || null;
  }
  const err = `${r.stderr || ''}`;
  if (/could not be found/i.test(err)) return null;
  throw new KeychainError(`gagal membaca Keychain: ${err.trim() || `exit ${r.status}`}`);
}

/**
 * Tulis/timpa token.
 *
 * Kenapa lewat `security -i` dan bukan `-w` biasa:
 *  - `-w` TANPA nilai selalu membuka prompt interaktif sendiri ("password data
 *    for new item:" + retype) dan mengabaikan stdin yang kita kirim. Akibatnya
 *    user ditanya token dua kali.
 *  - `-w <token>` di argv menghilangkan prompt itu, tapi token jadi terlihat
 *    oleh proses lain lewat `ps`.
 *  - mode `-i` membaca baris perintahnya dari stdin, jadi tidak ada prompt DAN
 *    token tidak pernah masuk daftar argumen proses.
 */
function writeToken(account, token) {
  requireDarwin();
  if (!account) throw new KeychainError('account (email) wajib untuk menyimpan token');
  if (!token) throw new KeychainError('token kosong');

  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const cmd = `add-generic-password -s ${SERVICE} -a "${esc(account)}" -U -w "${esc(token)}"\n`;

  const r = spawnSync(SECURITY, ['-i'], { input: cmd, encoding: 'utf8' });
  const scrub = (v) => String(v || '').split(token).join('<redacted>');
  if (r.status !== 0) {
    throw new KeychainError(
      `gagal menyimpan ke Keychain: ${scrub(r.stderr).trim() || `exit ${r.status}`}`
    );
  }

  // Verifikasi baca-balik: `security -i` bisa keluar 0 walau perintahnya gagal,
  // jadi jangan percaya exit code saja.
  let back;
  try {
    back = readToken(account);
  } catch (err) {
    throw new KeychainError(`token ditulis tapi gagal diverifikasi: ${scrub(err.message)}`);
  }
  if (back !== token) {
    throw new KeychainError(
      'token tidak tersimpan dengan benar (hasil baca-balik tidak sama). ' +
        'Coba simpan manual lewat aplikasi Keychain Access.'
    );
  }
}

module.exports = { readToken, writeToken, KeychainError, SERVICE };
