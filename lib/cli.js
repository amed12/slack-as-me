'use strict';

// slack-as-me -- kirim/susun pesan Slack dengan identitas yang pasti.
//
// Dua mode:
//   draft (default)  tidak menyentuh Slack sama sekali. Normalisasi ke mrkdwn,
//                    taruh di clipboard, catat receipt.
//   send / schedule  memakai user token pemilik akun sendiri dari Keychain,
//                    jadi pesan tampil sebagai orang itu -- lepas dari akun
//                    MCP mana yang sedang tersambung.
//   --as-bot <nama>  opsional: kirim lewat bot milik operator (mis. buz). Pesan
//                    tampil sebagai bot itu (label APP), bukan sebagai orang.
//                    Harus diminta eksplisit per perintah; tidak pernah default.
//
// Tool ini tidak punya kemampuan mengatur nama/avatar pengirim; lihat lib/slack.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { parseTarget, TargetError } = require('./target');
const { toMrkdwn } = require('./mrkdwn');
const { SlackClient, SlackError } = require('./slack');
const kc = require('./keychain');
const cfg = require('./config');
const receipt = require('./receipt');

const EXIT = { OK: 0, USAGE: 1, INPUT: 2, IDENTITY: 3, RECEIPT: 4, API: 5, TOKEN: 6 };
const DRAFT_DIR = path.join(os.homedir(), '.cache', 'slack-as-me', 'drafts');
const BOOL_FLAGS = new Set(['yes', 'raw', 'verbose', 'no-unwrap', 'no-copy', 'broadcast', 'help', 'no-signature']);

// Ketergantungan yang bisa disuntik lewat run(); default = efek samping nyata.
const CTX = {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
  fetchImpl: globalThis.fetch,
  tokenReader: kc.readToken,
  accountOverride: null,
};
const out = (t) => CTX.out(t);
const errOut = (t) => CTX.err(t);

function newClient(token, flags) {
  return new SlackClient(token, {
    verbose: Boolean(flags && flags.verbose),
    fetchImpl: CTX.fetchImpl,
  });
}

// ---------------------------------------------------------------- utilities

class ExitError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function die(code, msg) {
  throw new ExitError(code, msg);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (BOOL_FLAGS.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[body] = true;
        continue;
      }
      flags[body] = next;
      i++;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

/**
 * Ambil flag yang HARUS berupa string. `--to` tanpa nilai menghasilkan `true`,
 * dan tanpa guard ini String(true) = "true" lolos sebagai nama channel "#true"
 * -- gagal jauh di belakang dengan pesan yang menyesatkan. Lebih baik berhenti
 * di sini dengan sebab yang jelas.
 */
function strFlag(flags, name, { required = false } = {}) {
  const v = flags[name];
  if (v === undefined) {
    if (required) die(EXIT.USAGE, '--' + name + ' wajib diisi');
    return null;
  }
  if (v === true || String(v).trim() === '') {
    die(EXIT.USAGE, '--' + name + ' diberikan tanpa nilai. Tulis --' + name + ' <nilai>.');
  }
  return String(v);
}

// Penanda bahwa pesan dikirim oleh agen AI, bukan diketik manusia (permintaan TL).
// Ditempel di draft DAN send lewat jalur yang sama, jadi receipt draft tetap cocok.
// Teks bisa diganti lewat env SLACK_AS_ME_SIGNATURE; --no-signature mematikannya
// (hanya untuk operator manusia yang mengetik pesannya sendiri; agen tidak boleh memakainya).
const DEFAULT_SIGNATURE = '_sent by Claude Code (AI)_';
// Lewat bot (--as-bot), label APP sudah menandai pesan bukan ketikan manusia, jadi
// penanda tidak ditempel (keputusan TL via operator, 2026-10-26). Jalur akun pribadi tetap wajib.
function signatureLine(flags) {
  if (flags['no-signature']) return '';
  if (flags['as-bot'] !== undefined) return '';
  const custom = process.env.SLACK_AS_ME_SIGNATURE;
  return typeof custom === 'string' && custom.trim() ? custom.trim() : DEFAULT_SIGNATURE;
}
function withSignature(body, flags) {
  const sig = signatureLine(flags);
  if (!sig || body.includes(sig)) return body;
  return body.replace(/\s+$/, '') + '\n\n' + sig;
}

function readBody(flags) {
  if (typeof flags.text === 'string') return flags.text;
  if (typeof flags.file === 'string') {
    if (flags.file === '-') return fs.readFileSync(0, 'utf8');
    try {
      return fs.readFileSync(flags.file, 'utf8');
    } catch (err) {
      die(EXIT.INPUT, 'gagal membaca --file ' + flags.file + ': ' + err.message);
    }
  }
  if (!process.stdin.isTTY) return fs.readFileSync(0, 'utf8');
  die(EXIT.INPUT, 'isi pesan belum diberikan. Pakai --file <path>, --text "...", atau pipe ke stdin.');
}

/** Baca file --attach: nama, ukuran, hash (dikunci di receipt), dan byte-nya. */
function readAttach(flags) {
  const p = strFlag(flags, 'attach');
  if (!p) return null;
  let bytes;
  try {
    bytes = fs.readFileSync(p);
  } catch (err) {
    die(EXIT.INPUT, 'gagal membaca --attach ' + p + ': ' + err.message);
  }
  if (bytes.length === 0) die(EXIT.INPUT, '--attach ' + p + ' kosong');
  const sha = require('crypto').createHash('sha256').update(bytes).digest('hex');
  return { path: p, name: path.basename(p), size: bytes.length, sha, bytes };
}

function fmtAttach(a) {
  return a.name + ' (' + Math.round(a.size / 1024) + ' KB, sha ' + a.sha.slice(0, 12) + ')';
}

function readSecret(prompt) {
  errOut(prompt);
  if (!process.stdin.isTTY) {
    const piped = fs.readFileSync(0, 'utf8');
    errOut('\n');
    return piped.trim();
  }
  spawnSync('stty', ['-echo'], { stdio: 'inherit' });
  let buf = '';
  try {
    const fd = fs.openSync('/dev/tty', 'rs');
    const one = Buffer.alloc(1);
    for (;;) {
      const n = fs.readSync(fd, one, 0, 1, null);
      if (n === 0) break;
      const ch = one.toString('utf8');
      if (ch === '\n' || ch === '\r') break;
      buf += ch;
    }
    fs.closeSync(fd);
  } finally {
    spawnSync('stty', ['echo'], { stdio: 'inherit' });
    errOut('\n');
  }
  return buf.trim();
}

function copyToClipboard(text) {
  if (process.platform !== 'darwin') return { ok: false, why: 'bukan macOS' };
  const r = spawnSync('/usr/bin/pbcopy', { input: text });
  return r.status === 0 ? { ok: true } : { ok: false, why: 'pbcopy exit ' + r.status };
}

// Bot disimpan di Keychain dengan account "bot:<nama>", terpisah dari user token.
const BOT_PREFIX = 'bot:';
const BOT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function botName(flags) {
  const name = strFlag(flags, 'as-bot');
  if (name === null) return null;
  if (!BOT_NAME_RE.test(name)) {
    die(EXIT.USAGE, '--as-bot "' + name + '" tidak valid. Pakai huruf kecil/angka/-/_, mis. --as-bot buz');
  }
  return name;
}

function requireToken(flags) {
  const bot = botName(flags);
  if (bot) {
    const account = BOT_PREFIX + bot;
    let token;
    try {
      token = CTX.tokenReader(account);
    } catch (err) {
      die(EXIT.TOKEN, err.message);
    }
    if (!token) {
      die(
        EXIT.TOKEN,
        'tidak ada token bot "' + bot + '" di Keychain.\n' +
          'Pemilik bot menjalankan sendiri: slack-as-me login --bot ' + bot + '\n' +
          'Lihat SETUP.md bagian "Mode bot".'
      );
    }
    return { account, token, bot };
  }
  const account = CTX.accountOverride || cfg.resolveAccount(strFlag(flags, 'account'));
  if (!account) {
    die(
      EXIT.TOKEN,
      'belum ada account pengirim. Pemilik akun Slack harus menjalankan sendiri:\n' +
        '  slack-as-me login --account <email-slack-nya>\n' +
        'Langkah lengkap ada di SETUP.md. Mode `draft` tetap jalan tanpa ini.'
    );
  }
  let token;
  try {
    token = CTX.tokenReader(account);
  } catch (err) {
    die(EXIT.TOKEN, err.message);
  }
  if (!token) {
    die(
      EXIT.TOKEN,
      'tidak ada token di Keychain untuk "' + account + '".\n' +
        'Pemilik akun menjalankan sendiri: slack-as-me login --account ' + account + '\n' +
        'Lihat SETUP.md.'
    );
  }
  return { account, token, bot: null };
}

function fmtTarget(t) {
  const where = t.channelId ? t.channelId + (t.channelLabel !== t.channelId ? ' (' + t.channelLabel + ')' : '') : t.channelLabel;
  return where + (t.threadTs ? ' thread ' + t.threadTs : ' (pesan baru, bukan reply)');
}

// ------------------------------------------------------------ identity gate

async function resolveIdentity(client) {
  const auth = await client.authTest();
  let email = null;
  let realName = null;
  let profileError = null;
  try {
    const info = await client.usersInfo(auth.user_id);
    email = (info.user && info.user.profile && info.user.profile.email) || null;
    realName = (info.user && (info.user.real_name || info.user.name)) || null;
    if (!email) profileError = 'users.info berhasil tapi tidak memuat email';
  } catch (err) {
    // Jangan ditelan diam-diam: kalau email tidak terbaca, --confirm-as <email>
    // akan selalu gagal, dan tanpa alasan yang terlihat itu mudah disalahartikan
    // sebagai "email akunnya beda" lalu orang mulai menebak-nebak alamat.
    profileError = (err && err.message) || String(err);
  }
  return {
    userId: auth.user_id,
    handle: auth.user,
    team: auth.team,
    workspaceUrl: auth.url || null,
    teamId: auth.team_id,
    isBot: Boolean(auth.bot_id),
    botId: auth.bot_id || null,
    email,
    realName,
    profileError,
  };
}

function identityMatches(id, claim) {
  const c = String(claim).trim().toLowerCase();
  return acceptedClaims(id).some((v) => String(v).toLowerCase() === c);
}

/** Nilai apa saja yang akan diterima --confirm-as untuk token ini. */
function acceptedClaims(id) {
  return [id.userId, id.handle, id.email, id.realName, id.botId].filter(Boolean);
}

function describeIdentity(id) {
  const bits = [
    (id.isBot ? 'BOT ' : '') + (id.realName || id.handle),
    id.email,
    id.userId,
    id.botId,
    'workspace ' + (id.team || id.teamId),
  ];
  return bits.filter(Boolean).join(' | ');
}

// ------------------------------------------------------------------ commands

function cmdDraft(flags) {
  if (!flags.to) die(EXIT.USAGE, 'draft butuh --to <link|channelId|#nama>');
  const to = strFlag(flags, 'to', { required: true });
  const thread = strFlag(flags, 'thread');
  let target;
  try {
    target = parseTarget(to, { thread });
  } catch (err) {
    die(EXIT.INPUT, err.message);
  }

  const body = withSignature(toMrkdwn(readBody(flags), { raw: flags.raw, unwrap: !flags['no-unwrap'] }), flags);
  if (!body.trim()) die(EXIT.INPUT, 'isi pesan kosong setelah normalisasi');
  const attach = readAttach(flags);

  fs.mkdirSync(DRAFT_DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = (target.channelLabel || 'draft').replace(/[^A-Za-z0-9._-]/g, '');
  const draftFile = path.join(DRAFT_DIR, stamp + '-' + slug + '.txt');
  fs.writeFileSync(draftFile, body + '\n', { mode: 0o600 });

  const clip = flags['no-copy'] ? { ok: false, why: 'dilewati (--no-copy)' } : copyToClipboard(body);
  const rec = receipt.save({
    body,
    threadTs: target.threadTs,
    channelId: target.channelId,
    channelLabel: target.channelLabel,
    draftFile,
    attach,
  });

  out('--- draft (mrkdwn Slack) ---\n' + body + '\n--- akhir draft ---\n\n');
  out('target    : ' + fmtTarget(target) + '\n');
  if (!target.resolved) {
    out('            catatan: "' + target.channelLabel + '" baru label; `send` akan resolve ke channel ID.\n');
  }
  if (attach) out('lampiran  : ' + fmtAttach(attach) + '\n');
  out('file      : ' + draftFile + '\n');
  out('clipboard : ' + (clip.ok ? 'OK, tinggal Cmd+V' : 'TIDAK (' + clip.why + ')') + '\n');
  out('salin ulang: pbcopy < ' + JSON.stringify(draftFile) + '\n');
  out('receipt   : ' + rec.key.slice(0, 12) + ' (berlaku ' + receipt.TTL_MS / 60000 + ' menit)\n');
  out('\nTIDAK ADA yang dikirim ke Slack. Tunjukkan draft ini ke user dulu.\n');
}

async function cmdWhoami(flags) {
  const { account, token, bot } = requireToken(flags);
  const client = newClient(token, flags);
  const id = await resolveIdentity(client);
  out('account Keychain : ' + account + '\n');
  out('identitas Slack  : ' + describeIdentity(id) + '\n');
  out('tipe token       : ' + (id.isBot ? (bot ? 'bot (mode --as-bot ' + bot + ')' : 'BOT (bukan user token!)') : 'user token') + '\n');
  out('--confirm-as     : ' + acceptedClaims(id).join(' | ') + '\n');
  if (bot && !id.isBot) {
    out('\nPERINGATAN: token di "' + account + '" ternyata user token, bukan bot. send --as-bot akan menolaknya.\n');
  }
  if (!id.email && !bot) {
    out(
      'email            : TIDAK TERSEDIA -- ' + (id.profileError || 'sebab tidak diketahui') + '\n' +
        '                   Karena itu --confirm-as <email> akan SELALU gagal (exit 3)\n' +
        '                   di workspace ini. Pakai salah satu nilai di baris --confirm-as.\n'
    );
  }
  if (id.isBot && !bot) {
    out('\nPERINGATAN: ini bot token. Pesan akan tampil sebagai bot, bukan sebagai orangnya.\n');
  }
  if (!client.wroteNothing) die(EXIT.API, 'bug: whoami seharusnya read-only');
}

async function cmdLoginBot(flags) {
  const bot = botName(flags);
  errOut(
    'Token bot adalah kredensial. Yang menempel token HARUS pemilik bot itu sendiri.\n' +
      'Langkah membuat token ada di SETUP.md bagian "Mode bot" (Bot Token Scopes: chat:write).\n\n'
  );
  const token = readSecret('Paste bot token (xoxb-...) lalu Enter (tidak tampil): ');
  if (!token) die(EXIT.INPUT, 'token kosong, tidak ada yang disimpan');
  if (!token.startsWith('xoxb-')) {
    die(EXIT.INPUT, 'login --bot hanya menerima bot token (xoxb-). User token disimpan lewat `login --account`.');
  }
  const client = newClient(token, flags);
  let id;
  try {
    id = await resolveIdentity(client);
  } catch (err) {
    die(EXIT.API, 'token ditolak Slack, tidak disimpan: ' + err.message);
  }
  if (!id.isBot) die(EXIT.INPUT, 'auth.test tidak menyebut bot_id; token ini bukan bot. Tidak disimpan.');

  const account = BOT_PREFIX + bot;
  try {
    kc.writeToken(account, token);
  } catch (err) {
    die(EXIT.TOKEN, err.message);
  }
  // Sengaja TIDAK menulis config.account: bot tidak boleh jadi pengirim default.
  out('Token bot tersimpan di Keychain (service ' + kc.SERVICE + ', account ' + account + ').\n');
  out('Terverifikasi sebagai: ' + describeIdentity(id) + '\n');
  out('\nKirim lewat bot: slack-as-me send --as-bot ' + bot + ' --confirm-as ' + id.userId + ' ...\n');
  out('Undang bot ke channel tujuan dulu (/invite @' + (id.handle || bot) + '), kalau tidak Slack menjawab not_in_channel.\n');
}

async function cmdLogin(flags) {
  if (flags.bot !== undefined) {
    flags['as-bot'] = flags.bot;
    return cmdLoginBot(flags);
  }
  const account = flags.account;
  if (!account || account === true) {
    die(EXIT.USAGE, 'login butuh --account <email-slack>, mis. --account nama@qiscus.com');
  }
  errOut(
    'Token ini kredensial pribadi pemilik akun. Yang menempel token HARUS pemilik akun itu sendiri.\n' +
      'Langkah membuat token ada di SETUP.md (User Token Scopes, bukan Bot Token Scopes).\n\n'
  );
  const token = readSecret('Paste user token (xoxp-...) lalu Enter (tidak tampil): ');
  if (!token) die(EXIT.INPUT, 'token kosong, tidak ada yang disimpan');
  if (token.startsWith('xoxb-')) {
    die(
      EXIT.INPUT,
      'itu bot token (xoxb-). Pesan dari bot token tampil sebagai bot, bukan sebagai Anda, ' +
        'jadi tidak menyelesaikan masalah identitas. Ambil User OAuth Token (xoxp-) di halaman ' +
        'OAuth & Permissions.'
    );
  }
  if (!token.startsWith('xoxp-')) {
    errOut('Catatan: token tidak berawalan xoxp-. Lanjut, tapi auth.test yang menentukan.\n');
  }

  const client = newClient(token, flags);
  let id;
  try {
    id = await resolveIdentity(client);
  } catch (err) {
    die(EXIT.API, 'token ditolak Slack, tidak disimpan: ' + err.message);
  }
  if (id.isBot) die(EXIT.INPUT, 'token ini milik bot, bukan user. Tidak disimpan.');

  try {
    kc.writeToken(account, token);
  } catch (err) {
    die(EXIT.TOKEN, err.message);
  }
  cfg.write({ account });

  out('Token tersimpan di Keychain (service ' + kc.SERVICE + ', account ' + account + ').\n');
  out('Terverifikasi sebagai: ' + describeIdentity(id) + '\n');
  if (id.email && id.email.toLowerCase() !== String(account).toLowerCase()) {
    out(
      '\nPERHATIAN: email akun Slack (' + id.email + ') berbeda dari --account (' + account + ').\n' +
        'Pesan akan terkirim sebagai ' + id.email + '. Pastikan itu memang yang dimaksud.\n'
    );
  }
  out('\nMulai sekarang `send` butuh --confirm-as ' + (id.email || id.userId) + '\n');
}

async function cmdSend(flags, { schedule = false } = {}) {
  if (!flags.to) die(EXIT.USAGE, (schedule ? 'schedule' : 'send') + ' butuh --to <link|channelId|#nama>');
  if (!flags['confirm-as'] || flags['confirm-as'] === true) {
    die(
      EXIT.USAGE,
      '--confirm-as <user_id|handle|email> wajib. Sebutkan siapa yang Anda harapkan jadi ' +
        'pengirim; kalau token yang aktif ternyata milik orang lain, pengiriman dibatalkan.\n' +
        'Jalankan `slack-as-me doctor` untuk melihat nilai yang sah bagi token yang terpasang ' +
        '-- jangan menebak, dan jangan mencoba nilai berulang ke jalur kirim.'
    );
  }
  let postAt = null;
  if (schedule) {
    if (!flags.at || flags.at === true) die(EXIT.USAGE, 'schedule butuh --at <ISO8601>, mis. --at 2026-09-10T09:00:00+07:00');
    const ms = Date.parse(flags.at);
    if (!Number.isFinite(ms)) die(EXIT.INPUT, '--at "' + flags.at + '" bukan waktu ISO8601 yang valid');
    if (ms <= Date.now()) die(EXIT.INPUT, '--at sudah lewat');
    postAt = Math.floor(ms / 1000);
  }

  const to = strFlag(flags, 'to', { required: true });
  const thread = strFlag(flags, 'thread');
  let target;
  try {
    target = parseTarget(to, { thread });
  } catch (err) {
    die(EXIT.INPUT, err.message);
  }

  const body = withSignature(toMrkdwn(readBody(flags), { raw: flags.raw, unwrap: !flags['no-unwrap'] }), flags);
  if (!body.trim()) die(EXIT.INPUT, 'isi pesan kosong setelah normalisasi');
  const attach = readAttach(flags);
  if (attach && schedule) die(EXIT.USAGE, '--attach belum didukung untuk schedule (Slack tidak bisa menjadwalkan unggahan file)');

  const { account, token, bot } = requireToken(flags);
  const client = newClient(token, flags);

  // Pengaman 1: identitas harus cocok dengan yang dinyatakan pemanggil.
  let id;
  try {
    id = await resolveIdentity(client);
  } catch (err) {
    die(EXIT.API, err.message);
  }
  if (bot && !id.isBot) {
    die(EXIT.IDENTITY, 'token di "' + account + '" bukan bot token. --as-bot hanya mengirim lewat bot.');
  }
  if (!bot && id.isBot) {
    die(
      EXIT.IDENTITY,
      'token yang aktif adalah bot token. Tanpa --as-bot, tool ini hanya mengirim sebagai user asli.'
    );
  }
  if (!identityMatches(id, flags['confirm-as'])) {
    const accepted = acceptedClaims(id);
    let hint = '';
    // Sebagian workspace menolak users.info (user_not_found) walau scope sudah
    // ada, sehingga email tidak pernah terisi. Tanpa penjelasan ini, exit 3
    // mudah disalahartikan sebagai "email akunnya beda", lalu orang mulai
    // menebak-nebak alamat email -- padahal email tidak dipakai sama sekali.
    if (!id.email && /@/.test(String(flags['confirm-as']))) {
      hint =
        '\nCatatan: workspace ini tidak memberikan email lewat users.info, jadi email ' +
        'TIDAK bisa dipakai untuk --confirm-as (nilai apa pun akan gagal). Pakai user ID ' +
        'atau handle di atas. Jangan menebak-nebak alamat email.';
    }
    die(
      EXIT.IDENTITY,
      'identitas tidak cocok. --confirm-as "' + flags['confirm-as'] + '", tapi token milik:\n' +
        '  ' + describeIdentity(id) + '\n' +
        'Nilai --confirm-as yang diterima untuk token ini: ' + accepted.join(', ') + hint + '\n' +
        'Pengiriman DIBATALKAN. Tidak ada apa pun yang masuk ke Slack.'
    );
  }

  // Lampiran butuh files:write. Cek dari scope token sebelum ada panggilan tulis.
  if (attach && client.lastScopes && !client.lastScopes.includes('files:write')) {
    die(
      EXIT.TOKEN,
      'token belum punya scope files:write, jadi --attach tidak bisa dipakai.\n' +
        'Tambahkan files:write di User Token Scopes Slack app (manifest.yaml sudah memuatnya), ' +
        'reinstall app, lalu pemilik akun menjalankan `slack-as-me login` lagi (SETUP.md).\n' +
        'Pengiriman DIBATALKAN. Tidak ada apa pun yang masuk ke Slack.'
    );
  }

  // Pengaman 4: channel harus resolve ke satu channel ID.
  if (!target.channelId) {
    let matches;
    try {
      matches = await client.findChannelsByName(target.channelLabel);
    } catch (err) {
      die(EXIT.API, 'gagal resolve ' + target.channelLabel + ': ' + err.message);
    }
    if (matches.length === 0) die(EXIT.INPUT, 'channel ' + target.channelLabel + ' tidak ditemukan (atau token tidak punya akses)');
    if (matches.length > 1) {
      die(
        EXIT.INPUT,
        target.channelLabel + ' cocok ke ' + matches.length + ' channel: ' +
          matches.map((m) => m.id + ' #' + m.name).join(', ') + '. Pakai channel ID langsung.'
      );
    }
    target.channelId = matches[0].id;
    target.resolved = true;
  }

  // Pengaman 2: receipt dari mode draft.
  const rv = receipt.verify({
    body,
    threadTs: target.threadTs,
    channelId: target.channelId,
    channelLabel: target.channelLabel,
    attachSha: attach && attach.sha,
  });
  if (!rv.ok) {
    die(EXIT.RECEIPT, 'receipt draft ' + rv.reason + '. ' + rv.detail + '\nPengiriman DIBATALKAN.');
  }

  // Pengaman 3: tanpa --yes, hanya dry-run.
  if (!flags.yes) {
    out('DRY RUN -- tidak ada yang dikirim.\n\n');
    out('akan kirim sebagai : ' + describeIdentity(id) + '\n');
    out('ke                 : ' + fmtTarget(target) + '\n');
    if (schedule) out('dijadwalkan        : ' + new Date(postAt * 1000).toISOString() + '\n');
    if (attach) out('lampiran           : ' + fmtAttach(attach) + '\n');
    out('receipt            : ' + rv.receipt.key.slice(0, 12) + ' OK\n');
    out('\n--- isi ---\n' + body + '\n--- akhir ---\n');
    out('\nTambahkan --yes untuk benar-benar mengirim.\n');
    if (!client.wroteNothing) die(EXIT.API, 'bug: dry-run melakukan panggilan tulis');
    return;
  }

  const payload = {
    channel: target.channelId,
    text: body,
    thread_ts: target.threadTs || undefined,
    reply_broadcast: target.threadTs && flags.broadcast ? true : undefined,
    mrkdwn: true,
    ...(schedule ? { post_at: postAt } : {}),
  };

  if (attach) {
    try {
      await client.uploadFile({
        channel: target.channelId,
        threadTs: target.threadTs,
        name: attach.name,
        bytes: attach.bytes,
        initialComment: body,
      });
    } catch (err) {
      die(EXIT.API, err.message);
    }
    out('Terkirim sebagai ' + describeIdentity(id) + ' (teks + lampiran ' + attach.name + ')\n');
    if (id.workspaceUrl) {
      const base = id.workspaceUrl.replace(/\/$/, '') + '/archives/' + target.channelId;
      out('lihat di : ' + (target.threadTs ? base + '/p' + target.threadTs.replace('.', '') : base) + '\n');
    }
    out('account : ' + account + '\n');
    return;
  }

  let res;
  try {
    res = schedule ? await client.scheduleMessage(payload) : await client.postMessage(payload);
  } catch (err) {
    if (bot && err.slackCode === 'not_in_channel') {
      die(EXIT.API, err.message + '\nBot belum ada di channel ' + target.channelId + '. Undang dulu: /invite @' + (id.handle || bot));
    }
    die(EXIT.API, err.message);
  }

  if (schedule) {
    out('Terjadwal. scheduled_message_id=' + res.scheduled_message_id + '\n');
    out('kirim pada : ' + new Date(postAt * 1000).toISOString() + '\n');
  } else {
    out('Terkirim sebagai ' + describeIdentity(id) + '\n');
    out('ts      : ' + res.ts + '\n');

    // Gagal mengambil permalink BUKAN kegagalan kirim -- pesannya sudah masuk.
    // Tapi jangan ditelan diam-diam: sebut sebabnya dan beri URL susunan sendiri,
    // supaya user tetap punya cara membuka pesannya.
    let link = null;
    let why = null;
    try {
      const pl = await client.permalink(target.channelId, res.ts);
      link = pl.permalink || null;
      if (!link) why = 'chat.getPermalink berhasil tapi tidak memuat permalink';
    } catch (err) {
      why = (err && err.message) || String(err);
    }
    if (link) {
      out('permalink: ' + link + '\n');
    } else {
      if (id.workspaceUrl) {
        out('permalink: ' + id.workspaceUrl.replace(/\/$/, '') + '/archives/' +
            target.channelId + '/p' + String(res.ts).replace('.', '') + '  (disusun sendiri)\n');
      }
      out('           catatan: ' + why + '\n');
    }
  }
  out('account : ' + account + '\n');
}


const NEEDED_SCOPES = ['chat:write', 'channels:read', 'groups:read', 'users:read', 'users:read.email'];
const NEEDED_BOT_SCOPES = ['chat:write'];

/**
 * Pemeriksaan read-only menyeluruh. Tujuannya: siapa pun (termasuk sesi Claude
 * lain) bisa memastikan kondisi alat ini TANPA menembak parameter ke jalur
 * kirim, dan tanpa perlu mempercayai klaim dari pihak lain.
 */
async function cmdDoctor(flags) {
  const rows = [];
  const add = (ok, label, detail) => rows.push({ ok, label, detail: detail || '' });

  add(process.platform === 'darwin', 'platform macOS', process.platform);
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 18, 'Node >= 18 (fetch bawaan)', 'v' + process.versions.node);
  add(require('fs').existsSync('/usr/bin/pbcopy'), 'pbcopy tersedia (untuk draft)');

  for (const dir of [receipt.DIR, DRAFT_DIR]) {
    let ok = false;
    try {
      require('fs').mkdirSync(dir, { recursive: true, mode: 0o700 });
      require('fs').accessSync(dir, require('fs').constants.W_OK);
      ok = true;
    } catch (err) {
      add(false, 'direktori bisa ditulis: ' + dir, err.message);
    }
    if (ok) add(true, 'direktori bisa ditulis', dir);
  }

  const bot = botName(flags);
  const account = bot ? BOT_PREFIX + bot : CTX.accountOverride || cfg.resolveAccount(strFlag(flags, 'account'));
  add(Boolean(account), 'account pengirim terpasang', account || 'belum ada -- jalankan `login`');

  let token = null;
  if (account) {
    try {
      token = CTX.tokenReader(account);
    } catch (err) {
      add(false, 'baca Keychain', err.message);
    }
    add(Boolean(token), 'token ada di Keychain', token ? 'ya' : 'tidak -- jalankan `login' + (bot ? ' --bot ' + bot : '') + '`');
  }

  let id = null;
  if (token) {
    const client = newClient(token, flags);
    try {
      id = await resolveIdentity(client);
      add(true, 'token diterima Slack (auth.test)');
      if (bot) add(id.isBot, 'token bertipe bot', id.isBot ? 'bot ' + id.botId : 'BUKAN bot -- --as-bot akan ditolak');
      else add(!id.isBot, 'token bertipe user (bukan bot)', id.isBot ? 'BOT -- pesan akan tampil sebagai bot' : 'user token');
      add(true, 'identitas', describeIdentity(id));
      add(true, 'nilai --confirm-as yang sah', acceptedClaims(id).join(' | '));
      if (!id.email && !bot) {
        add(true, 'email tidak tersedia (bukan masalah)',
          (id.profileError || 'sebab tidak diketahui') + ' -> JANGAN pakai email di --confirm-as');
      }
      const got = client.lastScopes;
      if (got) {
        const need = bot ? NEEDED_BOT_SCOPES : NEEDED_SCOPES;
        const missing = need.filter((x) => !got.includes(x));
        add(missing.length === 0, 'scope lengkap',
          missing.length ? 'hilang: ' + missing.join(', ') : need.join(', '));
        if (bot) {
          add(true, 'catatan bot', 'kirim ke #nama butuh channels:read/groups:read; pakai channel ID atau link. ' +
            'Bot harus sudah diundang ke channel tujuan.');
        }
        // Opsional: tanpa files:write, hanya --attach yang tidak bisa dipakai.
        add(true, 'scope files:write (untuk --attach)',
          got.includes('files:write') ? 'ada' : 'belum ada -- --attach akan ditolak (exit 6)');
      }
    } catch (err) {
      add(false, 'token diterima Slack (auth.test)', err.message);
    }
  }

  const width = rows.reduce((m, r) => Math.max(m, r.label.length), 0);
  for (const r of rows) {
    out((r.ok ? 'OK   ' : 'GAGAL') + '  ' + r.label.padEnd(width) + (r.detail ? '  ' + r.detail : '') + '\n');
  }

  const bad = rows.filter((r) => !r.ok);
  out('\n');
  if (bad.length === 0) {
    out('Semua siap. `draft` dan `send` bisa dipakai.\n');
    if (id) {
      out('Contoh: slack-as-me send ' + (bot ? '--as-bot ' + bot + ' ' : '') +
        '--to <link/channel> --file <draft> --confirm-as ' + acceptedClaims(id)[0] + ' --yes\n');
    }
    out('Ingat: `send` tetap menolak body yang belum lewat `draft` (exit 4).\n');
  } else {
    out(bad.length + ' pemeriksaan gagal. `draft` mungkin masih jalan; `send` belum.\n');
    die(EXIT.TOKEN, 'doctor menemukan ' + bad.length + ' masalah (lihat daftar di atas)');
  }
}

function usage() {
  out(
    [
      'slack-as-me -- susun/kirim pesan Slack dengan identitas yang pasti',
      '',
      '  slack-as-me draft --to <link|channelId|#nama> [--file f | --text s]',
      '  slack-as-me whoami',
      '  slack-as-me doctor        # periksa semuanya, read-only',
      '  slack-as-me send --to <...> --file f --confirm-as <user-id> [--yes]',
      '  slack-as-me schedule --to <...> --file f --confirm-as <user-id> --at <ISO> [--yes]',
      '  slack-as-me login --account <email>',
      '  slack-as-me login --bot <nama>      # simpan bot token (xoxb-) milik operator',
      '',
      'Flag umum:',
      '  --to <t>          link arsip Slack, channel ID (C.../G.../D...), atau #nama',
      '  --thread <ts>     reply ke thread tertentu (1784788621.208259 atau p1784788621208259)',
      '  --file <path>     isi pesan dari file ("-" = stdin)',
      '  --attach <path>   lampirkan satu file (draft + send; butuh scope files:write)',
      '  --text <str>      isi pesan inline',
      '  --raw             lewati normalisasi mrkdwn',
      '  --no-signature    jangan tempel penanda "sent by Claude Code (AI)" (HANYA operator manusia;',
      '                    agen AI wajib membiarkan penanda; teks diganti lewat SLACK_AS_ME_SIGNATURE)',
      '  --no-unwrap       pertahankan patahan baris manual',
      '  --no-copy         jangan sentuh clipboard (draft)',
      '  --account <email> pilih token mana yang dipakai',
      '  --as-bot <nama>   kirim/periksa lewat bot <nama> (send/schedule/whoami/doctor). Pesan tampil',
      '                    sebagai bot itu (label APP). Wajib eksplisit. Penanda AI tidak ditempel',
      '                    (label APP sudah menandainya); draft juga harus pakai --as-bot.',
      '  --confirm-as <x>  WAJIB untuk send/schedule: identitas pengirim yang diharapkan.',
      '                    Nilai yang sah dicetak oleh `doctor`/`whoami` -- jangan menebak.',
      '                    Di sebagian workspace email tidak tersedia; pakai user ID.',
      '  --yes             benar-benar kirim (tanpa ini: dry-run)',
      '  --broadcast       reply thread sekalian tampil di channel',
      '  --verbose         cetak tiap panggilan API ke stderr',
      '',
      'Exit code: 0 ok, 1 usage, 2 input, 3 identitas tidak cocok, 4 receipt draft,',
      '           5 error Slack API, 6 token/account belum siap',
      '',
      'Mode draft TIDAK PERNAH menyentuh Slack. send/schedule butuh token pemilik akun',
      'sendiri di Keychain (lihat SETUP.md) dan lolos 4 pengaman: identitas, receipt draft,',
      '--yes, dan channel yang sudah resolve.',
      '',
    ].join('\n')
  );
}

// --------------------------------------------------------------------- main

async function main(argv) {
  const { flags, positional } = parseArgs(argv);
  const cmd = positional[0] || (Object.keys(flags).length ? 'draft' : 'help');

  if (flags.help || cmd === 'help') {
    usage();
    return;
  }

  switch (cmd) {
    case 'draft':
      return cmdDraft(flags);
    case 'whoami':
      return cmdWhoami(flags);
    case 'doctor':
      return cmdDoctor(flags);
    case 'login':
      return cmdLogin(flags);
    case 'send':
      return cmdSend(flags, { schedule: false });
    case 'schedule':
      return cmdSend(flags, { schedule: true });
    default:
      usage();
      die(EXIT.USAGE, 'perintah tidak dikenal: ' + cmd);
  }
}

/**
 * Jalankan CLI. Semua ketergantungan bisa disuntik supaya jalur send/schedule
 * (termasuk keempat pengamannya) bisa diuji tanpa token dan tanpa jaringan.
 *
 * @param {{argv?: string[], fetchImpl?: Function, tokenReader?: Function,
 *          account?: string, stdout?: Function, stderr?: Function}} deps
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function run(deps = {}) {
  const outBuf = [];
  const errBuf = [];
  CTX.out = deps.stdout || ((s) => outBuf.push(s));
  CTX.err = deps.stderr || ((s) => errBuf.push(s));
  CTX.fetchImpl = deps.fetchImpl || globalThis.fetch;
  CTX.tokenReader = deps.tokenReader || kc.readToken;
  CTX.accountOverride = deps.account || null;

  let code = EXIT.OK;
  try {
    await main(deps.argv || process.argv.slice(2));
  } catch (err) {
    if (err instanceof ExitError) {
      code = err.code;
      CTX.err('slack-as-me: ' + err.message + '\n');
    } else if (err instanceof TargetError) {
      code = EXIT.INPUT;
      CTX.err('slack-as-me: ' + err.message + '\n');
    } else if (err instanceof SlackError) {
      code = EXIT.API;
      CTX.err('slack-as-me: ' + err.message + '\n');
    } else if (err instanceof kc.KeychainError) {
      code = EXIT.TOKEN;
      CTX.err('slack-as-me: ' + err.message + '\n');
    } else {
      code = EXIT.USAGE;
      CTX.err('slack-as-me: ' + ((err && err.stack) || String(err)) + '\n');
    }
  }
  return { code, stdout: outBuf.join(''), stderr: errBuf.join('') };
}

module.exports = { run, EXIT, ExitError };
