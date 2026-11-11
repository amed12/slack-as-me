'use strict';

// Wrapper Slack Web API, sengaja dibatasi.
//
// KEPUTUSAN DESAIN PENTING: builder payload di bawah TIDAK menerima
// `username`, `icon_url`, `icon_emoji`, atau `as_user`. Field itu adalah cara
// membuat pesan tampil sebagai orang lain. Tool ini ada supaya pesan tampil
// sebagai pemilik token yang sah -- jadi kemampuan menyamar sengaja tidak
// disediakan, bukan cuma tidak dipakai. Memasukkannya = error, bukan diabaikan
// diam-diam, supaya kesalahan pemanggilan terlihat.

const BASE = 'https://slack.com/api';

// Field yang boleh ikut ke chat.postMessage / chat.scheduleMessage.
const MESSAGE_ALLOWLIST = new Set([
  'channel',
  'text',
  'thread_ts',
  'reply_broadcast',
  'unfurl_links',
  'unfurl_media',
  'mrkdwn',
  'link_names',
  'post_at',
]);

// Field yang memalsukan identitas pengirim -> ditolak keras.
const IDENTITY_OVERRIDE = ['username', 'icon_url', 'icon_emoji', 'as_user', 'blocks', 'attachments'];

class SlackError extends Error {
  constructor(message, code) {
    super(message);
    this.slackCode = code;
  }
}

function scrub(str, token) {
  const s = String(str);
  if (!token) return s;
  return s.split(token).join('<redacted-token>');
}

function buildMessagePayload(fields) {
  for (const bad of IDENTITY_OVERRIDE) {
    if (Object.prototype.hasOwnProperty.call(fields, bad)) {
      throw new SlackError(
        `field "${bad}" tidak didukung oleh slack-as-me. Tool ini hanya mengirim sebagai ` +
          'pemilik token; mengatur tampilan pengirim (atau blocks/attachments yang bisa ' +
          'menirunya) tidak disediakan.'
      );
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (MESSAGE_ALLOWLIST.has(k)) out[k] = v;
  }
  if (!out.channel) throw new SlackError('payload tanpa channel');
  if (!out.text) throw new SlackError('payload tanpa text');
  return out;
}

// Slack membatasi teks satu blok section 3000 karakter; pecah di batas baris bila bisa.
function chunkText(text, max) {
  const out = [];
  let rest = String(text || '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  out.push(rest);
  return out;
}

class SlackClient {
  constructor(token, { verbose = false, fetchImpl = globalThis.fetch } = {}) {
    if (!token) throw new SlackError('token kosong');
    this.token = token;
    this.verbose = verbose;
    this.fetch = fetchImpl;
    this.callLog = [];
    this.lastScopes = null;
  }

  async call(method, params = {}, { write = false, form = false } = {}) {
    this.callLog.push({ method, write, at: new Date().toISOString() });
    if (this.verbose) {
      const shown = { ...params };
      if (shown.text) shown.text = `<${String(shown.text).length} chars>`;
      if (shown.blocks) shown.blocks = '<generated approval blocks>';
      process.stderr.write(`[slack-as-me] ${write ? 'WRITE' : 'read'} ${method} ${JSON.stringify(shown)}\n`);
    }

    let res;
    try {
      res = await this.fetch(`${BASE}/${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': form
            ? 'application/x-www-form-urlencoded; charset=utf-8'
            : 'application/json; charset=utf-8',
        },
        // Beberapa method file (files.getUploadURLExternal) tidak menerima JSON.
        body: form ? new URLSearchParams(params).toString() : JSON.stringify(params),
      });
    } catch (err) {
      throw new SlackError(`gagal menghubungi Slack (${method}): ${scrub(err.message, this.token)}`);
    }

    // Scope yang benar-benar melekat pada token dikirim Slack di header ini.
    // Dipakai `doctor` supaya tidak ada yang perlu menebak scope.
    const hdr = res.headers && res.headers.get && res.headers.get('x-oauth-scopes');
    if (hdr) this.lastScopes = hdr.split(',').map((x) => x.trim()).filter(Boolean);

    let body;
    try {
      body = await res.json();
    } catch {
      throw new SlackError(`respons ${method} bukan JSON (HTTP ${res.status})`);
    }
    if (!body.ok) {
      throw new SlackError(
        `Slack menolak ${method}: ${scrub(body.error || 'unknown_error', this.token)}` +
          (body.needed ? ` (butuh scope: ${body.needed})` : ''),
        body.error
      );
    }
    return body;
  }

  authTest() {
    return this.call('auth.test');
  }

  usersInfo(userId) {
    return this.call('users.info', { user: userId });
  }

  /** Cari channel berdasarkan nama. Mengembalikan semua kandidat yang cocok. */
  async findChannelsByName(name) {
    const want = name.replace(/^#/, '').toLowerCase();
    const matches = [];
    let cursor;
    do {
      const page = await this.call('conversations.list', {
        limit: 1000,
        exclude_archived: true,
        types: 'public_channel,private_channel',
        ...(cursor ? { cursor } : {}),
      });
      for (const c of page.channels || []) {
        if ((c.name || '').toLowerCase() === want) matches.push({ id: c.id, name: c.name });
      }
      cursor = page.response_metadata && page.response_metadata.next_cursor;
    } while (cursor);
    return matches;
  }

  postMessage(fields, approvalId) {
    const payload = buildMessagePayload(fields);
    if (approvalId !== undefined && approvalId !== null) {
      if (!/^[0-9a-f]{12}$/.test(approvalId)) throw new SlackError('approval ID tidak valid');
      payload.blocks = [
        ...chunkText(payload.text, 2900).map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: t } })),
        { type: 'actions', elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Kirim' }, action_id: 'guz_send', style: 'primary', value: approvalId },
          { type: 'button', text: { type: 'plain_text', text: 'Tolak' }, action_id: 'guz_reject', value: approvalId },
        ] },
      ];
    }
    return this.call('chat.postMessage', payload, { write: true });
  }

  postEphemeral(fields, user) {
    if (!/^U[A-Z0-9]+$/.test(user || '')) throw new SlackError('user ID tidak valid');
    const payload = buildMessagePayload(fields);
    if (!payload.thread_ts) throw new SlackError('ephemeral membutuhkan thread');
    return this.call('chat.postEphemeral', { ...payload, user }, { write: true });
  }

  scheduleMessage(fields) {
    return this.call('chat.scheduleMessage', buildMessagePayload(fields), { write: true });
  }

  /**
   * Unggah satu file ke channel/thread dengan alur resmi Slack
   * (getUploadURLExternal -> POST byte -> completeUploadExternal). Teks pesan
   * ikut sebagai `initial_comment`, jadi file + teks tampil sebagai satu pesan
   * dari pemilik token. Butuh scope `files:write`.
   */
  async uploadFile({ channel, threadTs, name, bytes, initialComment }) {
    if (!channel) throw new SlackError('upload tanpa channel');
    const url = await this.call(
      'files.getUploadURLExternal',
      { filename: name, length: String(bytes.length) },
      { write: true, form: true }
    );
    this.callLog.push({ method: 'upload_url', write: true, at: new Date().toISOString() });
    let res;
    try {
      res = await this.fetch(url.upload_url, { method: 'POST', body: bytes });
    } catch (err) {
      throw new SlackError('gagal mengunggah byte file: ' + scrub(err.message, this.token));
    }
    if (!res.ok) throw new SlackError('unggah byte file ditolak (HTTP ' + res.status + ')');
    const params = {
      files: JSON.stringify([{ id: url.file_id, title: name }]),
      channel_id: channel,
    };
    if (threadTs) params.thread_ts = threadTs;
    if (initialComment) params.initial_comment = initialComment;
    return this.call('files.completeUploadExternal', params, { write: true, form: true });
  }

  permalink(channel, ts) {
    return this.call('chat.getPermalink', { channel, message_ts: ts });
  }

  /**
   * Baca balasan di dalam thread (conversations.replies). Mengikuti paginasi
   * response_metadata.next_cursor sampai selesai.
   */
  async replies(channel, ts, oldest) {
    if (!channel) throw new SlackError('channel kosong');
    if (!ts) throw new SlackError('ts kosong');
    const messages = [];
    let cursor;
    do {
      // conversations.replies tidak membaca body JSON (Slack menjawab invalid_arguments),
      // jadi argumennya wajib form-encoded.
      const page = await this.call(
        'conversations.replies',
        { channel, ts, ...(oldest !== undefined ? { oldest } : {}), ...(cursor ? { cursor } : {}) },
        { form: true }
      );
      for (const m of page.messages || []) {
        messages.push(m);
      }
      cursor = (page.response_metadata && page.response_metadata.next_cursor) || null;
    } while (cursor);
    return messages;
  }

  /** true kalau belum ada panggilan tulis sama sekali (dipakai untuk verifikasi dry-run). */
  get wroteNothing() {
    return this.callLog.every((c) => !c.write);
  }
}

module.exports = { SlackClient, SlackError, buildMessagePayload, IDENTITY_OVERRIDE, scrub };
