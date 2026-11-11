'use strict';

// Test tanpa jaringan dan tanpa token nyata: fetch dan pembaca Keychain
// disuntik. Fokusnya keempat pengaman di jalur send/schedule -- kalau ini
// lolos diam-diam, tool ini kehilangan alasan keberadaannya.
//
// jalankan: node test/run.js

const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolasi HOME sebelum modul apa pun di-require, supaya receipt/draft/config
// test tidak bercampur dengan milik user.
const REAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-as-me-test-'));
process.env.HOME = TMP_HOME;
delete process.env.SLACK_AS_ME_ACCOUNT;

const assert = require('assert');
const { parseTarget, normalizeTs, TargetError } = require('../lib/target');
const { toMrkdwn } = require('../lib/mrkdwn');
const { buildMessagePayload, IDENTITY_OVERRIDE } = require('../lib/slack');
const receipt = require('../lib/receipt');
const { run, EXIT } = require('../lib/cli');

let pass = 0;
const fails = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => {
          pass++;
        },
        (e) => fails.push([name, e])
      );
    }
    pass++;
  } catch (e) {
    fails.push([name, e]);
  }
  return Promise.resolve();
}

// ------------------------------------------------------------- stub Slack API

const IDENTITY = {
  user_id: 'U0ACHMAD',
  user: 'achmad',
  team: 'Qiscus',
  team_id: 'T0QISCUS',
};

function makeStub({ identity = IDENTITY, email = 'achmad@qiscus.com', channels = [],
                    scopes = 'identify,chat:write,channels:read,groups:read,users:read,users:read.email',
                    usersInfoFails = false, replies = null, repliesFails = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://files.slack.test/')) {
      calls.push({ method: 'upload_bytes', body: { size: init.body.length } });
      return { ok: true, status: 200 };
    }
    const method = String(url).split('/api/')[1];
    const ctype = (init.headers && init.headers['Content-Type']) || '';
    const body = ctype.startsWith('application/x-www-form-urlencoded')
      ? Object.fromEntries(new URLSearchParams(init.body))
      : JSON.parse(init.body || '{}');
    calls.push({ method, body, auth: init.headers.Authorization });
    const hdrs = { get: (k) => (String(k).toLowerCase() === 'x-oauth-scopes' ? scopes : null) };
    const reply = (o) => ({ ok: true, status: 200, headers: hdrs, json: async () => ({ ok: true, ...o }) });
    const fail = (e, extra = {}) => ({ ok: true, status: 200, headers: hdrs, json: async () => ({ ok: false, error: e, ...extra }) });
    switch (method) {
      case 'auth.test':
        return reply(identity);
      case 'users.info':
        if (usersInfoFails) return fail('user_not_found');
        return reply({ user: { real_name: 'Achmad Fathullah', name: identity.user, profile: { email } } });
      case 'conversations.list':
        return reply({ channels, response_metadata: { next_cursor: '' } });
      case 'conversations.replies':
        // Slack sungguhan: method ini tidak membaca body JSON (invalid_arguments, 2026-11-10).
        if (!ctype.startsWith('application/x-www-form-urlencoded')) return fail('invalid_arguments');
        if (typeof repliesFails === 'string') return fail(repliesFails, { needed: 'channels:history,groups:history,im:history' });
        if (repliesFails) return fail('missing_scope', { needed: 'channels:history,groups:history,im:history' });
        if (typeof replies === 'function') return replies(body, { reply, fail });
        if (Array.isArray(replies)) return reply({ messages: replies, response_metadata: { next_cursor: '' } });
        return reply({
          messages: [
            { type: 'message', user: 'U0ACHMAD', text: 'Pesan induk thread', ts: body.ts || '1784788621.208259' },
            { type: 'message', user: 'U0BUZ', text: 'Balasan bot', ts: '1784788625.000200', blocks: [] },
          ],
          response_metadata: { next_cursor: '' },
        });
      case 'chat.postMessage':
        return reply({ ts: '1784788999.000100', channel: body.channel });
      case 'chat.postEphemeral':
        return reply({ message_ts: '1784788999.000100' });
      case 'chat.scheduleMessage':
        return reply({ scheduled_message_id: 'Q123' });
      case 'files.getUploadURLExternal':
        return reply({ upload_url: 'https://files.slack.test/upload/F123', file_id: 'F123' });
      case 'files.completeUploadExternal':
        return reply({ files: [{ id: 'F123', title: body.files }] });
      case 'chat.getPermalink':
        return reply({ permalink: 'https://qiscus.slack.com/archives/' + body.channel + '/p1784788999000100' });
      default:
        return fail('unknown_method_' + method);
    }
  };
  return { fetchImpl, calls, writes: () => calls.filter((c) => (c.method.startsWith('chat.') && c.method !== 'chat.getPermalink') ||
                                              c.method.startsWith('files.') || c.method === 'upload_bytes') };
}

const TOKEN_OK = () => 'xoxp-test-token';
const TOKEN_NONE = () => null;
const ACCOUNT = 'achmad@qiscus.com';

const cli = (argv, deps = {}) =>
  run({ argv, account: deps.account === null ? null : deps.account || ACCOUNT, ...deps });

// -------------------------------------------------------------------- target

async function main() {
  await t('ts: p-form -> message_ts (contoh dari skill)', () => {
    assert.strictEqual(normalizeTs('p1784788621208259'), '1784788621.208259');
    assert.strictEqual(normalizeTs('1784788621.208259'), '1784788621.208259');
  });

  await t('target: link arsip', () => {
    const r = parseTarget('https://qiscus.slack.com/archives/C0ABCDEF/p1784788621208259');
    assert.strictEqual(r.channelId, 'C0ABCDEF');
    assert.strictEqual(r.threadTs, '1784788621.208259');
    assert.strictEqual(r.resolved, true);
  });

  await t('target: link reply pakai thread_ts induk', () => {
    const r = parseTarget(
      'https://qiscus.slack.com/archives/C0ABCDEF/p1784799999000200?thread_ts=1784788621.208259&cid=C0ABCDEF'
    );
    assert.strictEqual(r.threadTs, '1784788621.208259', 'harus balas ke induk, bukan ke reply');
  });

  await t('target: link channel/DM tanpa /p<ts> (hasil Copy link channel)', () => {
    const r = parseTarget('https://qiscustech.slack.com/archives/D01CVHMF69M');
    assert.strictEqual(r.channelId, 'D01CVHMF69M');
    assert.strictEqual(r.threadTs, null, 'tanpa ts berarti pesan baru, bukan reply');
    assert.strictEqual(r.resolved, true);
  });

  await t('target: link channel + --thread eksplisit', () => {
    const r = parseTarget('https://qiscustech.slack.com/archives/C0ABCDEF/', {
      thread: 'p1784788621208259',
    });
    assert.strictEqual(r.channelId, 'C0ABCDEF');
    assert.strictEqual(r.threadTs, '1784788621.208259');
  });

  await t('target: channel ID mentah + --thread', () => {
    const r = parseTarget('C0ABCDEF', { thread: 'p1784788621208259' });
    assert.strictEqual(r.channelId, 'C0ABCDEF');
    assert.strictEqual(r.threadTs, '1784788621.208259');
  });

  await t('target: #nama belum resolved', () => {
    const r = parseTarget('#tim-support');
    assert.strictEqual(r.channelId, null);
    assert.strictEqual(r.channelLabel, '#tim-support');
    assert.strictEqual(r.resolved, false);
  });

  await t('target: input ngawur ditolak', () => {
    assert.throws(() => parseTarget('https://example.com/x'), TargetError);
    assert.throws(() => parseTarget(''), TargetError);
  });

  // ------------------------------------------------------------------ mrkdwn

  await t('mrkdwn: bold ganda -> tunggal, paragraf digabung', () => {
    const r = toMrkdwn('Ini **tebal**\ndipatah manual.');
    assert.strictEqual(r, 'Ini *tebal* dipatah manual.');
  });

  await t('mrkdwn: fenced code tidak disentuh', () => {
    const src = ['teks **a**', '```', 'raw  **b**', '```'].join('\n');
    assert.ok(toMrkdwn(src).includes('raw  **b**'), 'isi code block harus utuh');
  });

  await t('mrkdwn: inline code tidak disentuh', () => {
    assert.strictEqual(toMrkdwn('pakai `**x**` di sini'), 'pakai `**x**` di sini');
  });

  await t('mrkdwn: --raw melewati normalisasi', () => {
    assert.strictEqual(toMrkdwn('a **b**\nc', { raw: true }), 'a **b**\nc');
  });

  // ------------------------------------------------- allowlist / anti-spoofing

  await t('payload: field penyamaran identitas ditolak keras', () => {
    for (const bad of IDENTITY_OVERRIDE) {
      assert.throws(
        () => buildMessagePayload({ channel: 'C1', text: 'hi', [bad]: 'X' }),
        (e) => new RegExp(bad).test(e.message),
        'field ' + bad + ' HARUS ditolak'
      );
    }
  });

  await t('payload: field tak dikenal dibuang, bukan diteruskan', () => {
    const p = buildMessagePayload({ channel: 'C1', text: 'hi', bogus: 'x', thread_ts: '1.2' });
    assert.deepStrictEqual(Object.keys(p).sort(), ['channel', 'text', 'thread_ts']);
  });

  // ----------------------------------------------------------------- receipt

  await t('receipt: cocok setelah save', () => {
    receipt.save({ body: 'isi A', threadTs: '1.2', channelId: 'C1', channelLabel: 'C1' });
    const v = receipt.verify({ body: 'isi A', threadTs: '1.2', channelId: 'C1', channelLabel: 'C1' });
    assert.strictEqual(v.ok, true);
  });

  await t('receipt: body berubah 1 karakter -> tidak cocok', () => {
    const v = receipt.verify({ body: 'isi A.', threadTs: '1.2', channelId: 'C1', channelLabel: 'C1' });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, 'tidak-ada');
  });

  await t('receipt: channel beda -> ditolak', () => {
    const v = receipt.verify({ body: 'isi A', threadTs: '1.2', channelId: 'C9', channelLabel: 'C9' });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, 'channel-beda');
  });

  await t('receipt: kedaluwarsa ditolak', () => {
    const key = receipt.keyFor('isi lama', '');
    const f = path.join(receipt.DIR, key + '.json');
    fs.writeFileSync(
      f,
      JSON.stringify({
        key,
        createdAt: new Date(Date.now() - 2 * receipt.TTL_MS).toISOString(),
        channelId: 'C1',
        channelLabel: 'C1',
      })
    );
    const v = receipt.verify({ body: 'isi lama', threadTs: '', channelId: 'C1', channelLabel: 'C1' });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, 'kedaluwarsa');
  });

  // --------------------------------------------------------------- CLI draft

  const MSG = 'Halo mas, ini **update** progres.';

  await t('draft: nol panggilan ke Slack', async () => {
    const stub = makeStub();
    const r = await cli(['draft', '--to', 'C0ABCDEF', '--text', MSG, '--no-copy'], {
      fetchImpl: stub.fetchImpl,
      tokenReader: TOKEN_OK,
    });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    assert.strictEqual(stub.calls.length, 0, 'draft TIDAK BOLEH menyentuh Slack');
    assert.ok(r.stdout.includes('*update*'), 'draft harus sudah mrkdwn');
    assert.ok(r.stdout.includes('TIDAK ADA yang dikirim'));
  });

  await t('draft: tanpa --to ditolak', async () => {
    const r = await cli(['draft', '--text', MSG, '--no-copy'], { tokenReader: TOKEN_OK });
    assert.strictEqual(r.code, EXIT.USAGE);
  });

  // ---------------------------------------------------------------- CLI send

  await t('send: tanpa --confirm-as ditolak sebelum apa pun', async () => {
    const stub = makeStub();
    const r = await cli(['send', '--to', 'C0ABCDEF', '--text', MSG, '--yes'], {
      fetchImpl: stub.fetchImpl,
      tokenReader: TOKEN_OK,
    });
    assert.strictEqual(r.code, EXIT.USAGE, r.stderr);
    assert.strictEqual(stub.calls.length, 0);
  });

  await t('send: tanpa token -> exit 6, tidak ada panggilan', async () => {
    const stub = makeStub();
    const r = await cli(['send', '--to', 'C0ABCDEF', '--text', MSG, '--confirm-as', ACCOUNT, '--yes'], {
      fetchImpl: stub.fetchImpl,
      tokenReader: TOKEN_NONE,
    });
    assert.strictEqual(r.code, EXIT.TOKEN, r.stderr);
    assert.strictEqual(stub.calls.length, 0);
    assert.ok(/SETUP\.md/.test(r.stderr), 'error harus mengarahkan ke SETUP.md');
  });

  await t('send: identitas tidak cocok -> exit 3, tidak menulis', async () => {
    const stub = makeStub();
    const r = await cli(
      ['send', '--to', 'C0ABCDEF', '--text', MSG, '--confirm-as', 'ratih@qiscus.com', '--yes'],
      { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK }
    );
    assert.strictEqual(r.code, EXIT.IDENTITY, r.stderr);
    assert.strictEqual(stub.writes().length, 0, 'tidak boleh ada chat.postMessage');
    assert.ok(/DIBATALKAN/.test(r.stderr));
    assert.ok(/Achmad Fathullah/.test(r.stderr), 'harus menyebut identitas token sebenarnya');
  });

  await t('send: identitas cocok tapi belum ada receipt -> exit 4', async () => {
    const stub = makeStub();
    const r = await cli(
      ['send', '--to', 'C0ABCDEF', '--text', 'pesan yang belum pernah didraft', '--confirm-as', ACCOUNT, '--yes'],
      { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK }
    );
    assert.strictEqual(r.code, EXIT.RECEIPT, r.stderr);
    assert.strictEqual(stub.writes().length, 0);
  });

  await t('send: sudah draft tapi tanpa --yes -> dry-run, tidak menulis', async () => {
    const stub = makeStub();
    const body = 'Draft dulu lalu dry run.';
    await cli(['draft', '--to', 'C0ABCDEF', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    const r = await cli(['send', '--to', 'C0ABCDEF', '--text', body, '--confirm-as', ACCOUNT], {
      fetchImpl: stub.fetchImpl,
      tokenReader: TOKEN_OK,
    });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    assert.ok(/DRY RUN/.test(r.stdout));
    assert.strictEqual(stub.writes().length, 0, 'dry-run tidak boleh menulis');
  });

  await t('send: draft -> confirm-as benar -> --yes = terkirim sekali', async () => {
    const stub = makeStub();
    const body = 'Pesan yang benar-benar dikirim.';
    await cli(['draft', '--to', 'C0ABCDEF', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    const r = await cli(['send', '--to', 'C0ABCDEF', '--text', body, '--confirm-as', ACCOUNT, '--yes'], {
      fetchImpl: stub.fetchImpl,
      tokenReader: TOKEN_OK,
    });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    const posts = stub.calls.filter((c) => c.method === 'chat.postMessage');
    assert.strictEqual(posts.length, 1, 'harus tepat satu chat.postMessage');
    assert.strictEqual(posts[0].body.channel, 'C0ABCDEF');
    assert.strictEqual(posts[0].body.text, body + '\n\n_sent by Claude Code (AI)_', 'isi + penanda AI');
    assert.ok(/permalink/.test(r.stdout));
  });

  await t('send: --confirm-as boleh pakai user_id atau handle', async () => {
    const stub = makeStub();
    const body = 'Cocokkan lewat user id.';
    await cli(['draft', '--to', 'C0ABCDEF', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    const r = await cli(['send', '--to', 'C0ABCDEF', '--text', body, '--confirm-as', 'U0ACHMAD', '--yes'], {
      fetchImpl: stub.fetchImpl,
      tokenReader: TOKEN_OK,
    });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
  });

  await t('send: --username diselundupkan tidak sampai ke payload', async () => {
    const stub = makeStub();
    const body = 'Coba selundupkan nama pengirim.';
    await cli(['draft', '--to', 'C0ABCDEF', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    const r = await cli(
      ['send', '--to', 'C0ABCDEF', '--text', body, '--confirm-as', ACCOUNT, '--yes',
       '--username', 'Achmad Fathullah', '--icon_emoji', ':smile:'],
      { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK }
    );
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    const post = stub.calls.find((c) => c.method === 'chat.postMessage');
    assert.ok(post, 'pesan tetap terkirim');
    assert.strictEqual(post.body.username, undefined, 'username TIDAK BOLEH ikut');
    assert.strictEqual(post.body.icon_emoji, undefined, 'icon_emoji TIDAK BOLEH ikut');
  });

  await t('signature: draft dan send menempel penanda AI yang sama, receipt cocok', async () => {
    const stub = makeStub();
    const body = 'Update progress.';
    const d = await cli(['draft', '--to', 'C0ABCDEF', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    assert.ok(d.stdout.includes('_sent by Claude Code (AI)_'), 'draft harus menampilkan penanda');
    const r = await cli(['send', '--to', 'C0ABCDEF', '--text', body, '--confirm-as', ACCOUNT, '--yes'], {
      fetchImpl: stub.fetchImpl,
      tokenReader: TOKEN_OK,
    });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    const post = stub.calls.find((c) => c.method === 'chat.postMessage');
    assert.ok(post.body.text.endsWith('\n\n_sent by Claude Code (AI)_'), 'penanda di akhir pesan terkirim');
    assert.strictEqual(post.body.text.split('_sent by Claude Code (AI)_').length, 2, 'tidak ganda');
  });

  await t('signature: tidak digandakan bila isi sudah memuatnya', async () => {
    const stub = makeStub();
    const body = 'Sudah bertanda.\n\n_sent by Claude Code (AI)_';
    await cli(['draft', '--to', 'C0ABCDEF', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    const r = await cli(['send', '--to', 'C0ABCDEF', '--text', body, '--confirm-as', ACCOUNT, '--yes'], {
      fetchImpl: stub.fetchImpl,
      tokenReader: TOKEN_OK,
    });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    const post = stub.calls.find((c) => c.method === 'chat.postMessage');
    assert.strictEqual(post.body.text.split('_sent by Claude Code (AI)_').length, 2);
  });

  await t('signature: --no-signature mematikan, SLACK_AS_ME_SIGNATURE mengganti', async () => {
    const stub = makeStub();
    const body = 'Ketik manual oleh operator.';
    await cli(['draft', '--to', 'C0ABCDEF', '--text', body, '--no-copy', '--no-signature'], { tokenReader: TOKEN_OK });
    const r = await cli(['send', '--to', 'C0ABCDEF', '--text', body, '--confirm-as', ACCOUNT, '--yes', '--no-signature'], {
      fetchImpl: stub.fetchImpl,
      tokenReader: TOKEN_OK,
    });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    const post = stub.calls.find((c) => c.method === 'chat.postMessage');
    assert.strictEqual(post.body.text, body, 'tanpa penanda');

    process.env.SLACK_AS_ME_SIGNATURE = '_sent by Claude (AI)_';
    try {
      const d = await cli(['draft', '--to', 'C0ABCDEF', '--text', 'Isi lain.', '--no-copy'], { tokenReader: TOKEN_OK });
      assert.ok(d.stdout.includes('_sent by Claude (AI)_'));
      assert.ok(!d.stdout.includes('Claude Code (AI)'));
    } finally {
      delete process.env.SLACK_AS_ME_SIGNATURE;
    }
  });

  await t('send: bot token ditolak (bukan user asli)', async () => {
    const stub = makeStub({ identity: { ...IDENTITY, bot_id: 'B123' } });
    const body = 'Lewat bot token.';
    await cli(['draft', '--to', 'C0ABCDEF', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    const r = await cli(['send', '--to', 'C0ABCDEF', '--text', body, '--confirm-as', ACCOUNT, '--yes'], {
      fetchImpl: stub.fetchImpl,
      tokenReader: TOKEN_OK,
    });
    assert.strictEqual(r.code, EXIT.IDENTITY, r.stderr);
    assert.strictEqual(stub.writes().length, 0);
  });

  // --------------------------------------------------------------- mode bot

  const BOT_IDENTITY = { user_id: 'U0BUZ', user: 'buz', team: 'Qiscus', team_id: 'T0QISCUS', bot_id: 'B0BUZ' };
  const BOT_SCOPES = 'chat:write';
  const botReader = (seen) => (acct) => {
    seen.push(acct);
    return acct === 'bot:buz' ? 'xoxb-test-bot' : null;
  };

  await t('bot: approval buttons menghasilkan blocks tetap dan ts', async () => {
    const stub = makeStub({ identity: BOT_IDENTITY, usersInfoFails: true });
    const args = ['--as-bot', 'buz', '--to', 'C0ABCDEF', '--text', 'Approval test'];
    await cli(['draft', ...args, '--no-copy']);
    const r = await cli(['send', ...args, '--yes', '--approval-buttons', '012345abcdef'], { fetchImpl: stub.fetchImpl, tokenReader: botReader([]) });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    const post = stub.calls.find(c => c.method === 'chat.postMessage');
    assert.strictEqual(post.body.text, 'Approval test');
    assert.deepStrictEqual(post.body.blocks, [
      { type: 'section', text: { type: 'mrkdwn', text: 'Approval test' } },
      { type: 'actions', elements: [
        { type: 'button', text: { type: 'plain_text', text: 'Kirim' }, action_id: 'guz_send', style: 'primary', value: '012345abcdef' },
        { type: 'button', text: { type: 'plain_text', text: 'Tolak' }, action_id: 'guz_reject', value: '012345abcdef' },
      ] },
    ]);
    assert.match(r.stdout, /^ts\s*:\s*1784788999\.000100/m);
  });

  await t('approval buttons menolak ID invalid dan mode pribadi tanpa menulis', async () => {
    for (const args of [ ['--as-bot', 'buz', '--approval-buttons', 'INVALID'], ['--approval-buttons', '012345abcdef'] ]) {
      const stub = makeStub({ identity: BOT_IDENTITY });
      const r = await cli(['send', '--to', 'C0ABCDEF', '--text', 'test', '--yes', ...args], { fetchImpl: stub.fetchImpl, tokenReader: botReader([]) });
      assert.notStrictEqual(r.code, EXIT.OK);
      assert.strictEqual(stub.writes().length, 0);
    }
  });

  await t('bot: ephemeral membutuhkan receipt dan mengirim ke user pada thread', async () => {
    const stub = makeStub({ identity: BOT_IDENTITY, usersInfoFails: true });
    const args = ['--as-bot', 'buz', '--to', 'C0ABCDEF', '--thread', '1784788621.208259', '--text', 'Ephemeral test'];
    const deps = { fetchImpl: stub.fetchImpl, tokenReader: botReader([]) };
    const before = await cli(['send-ephemeral', ...args, '--user', 'U123ABC'], deps);
    assert.strictEqual(before.code, EXIT.RECEIPT, before.stderr);
    await cli(['draft', ...args, '--no-copy']);
    const after = await cli(['send-ephemeral', ...args, '--user', 'U123ABC'], deps);
    assert.strictEqual(after.code, EXIT.OK, after.stderr);
    const posts = stub.calls.filter(c => c.method === 'chat.postEphemeral');
    assert.strictEqual(posts.length, 1);
    assert.strictEqual(posts[0].body.user, 'U123ABC');
    assert.strictEqual(posts[0].body.thread_ts, '1784788621.208259');
    assert.strictEqual(posts[0].body.text, 'Ephemeral test');
  });

  await t('ephemeral menolak mode pribadi, user invalid, dan target tanpa thread', async () => {
    for (const args of [ ['--user', 'U123ABC'], ['--as-bot', 'buz', '--user', 'invalid'], ['--as-bot', 'buz', '--user', 'U123ABC'] ]) {
      const stub = makeStub({ identity: BOT_IDENTITY });
      const r = await cli(['send-ephemeral', '--to', 'C0ABCDEF', '--text', 'test', ...args], { fetchImpl: stub.fetchImpl, tokenReader: botReader([]) });
      assert.notStrictEqual(r.code, EXIT.OK);
      assert.strictEqual(stub.writes().length, 0);
    }
  });

  await t('bot: --as-bot kirim lewat token bot, tanpa penanda AI', async () => {
    const stub = makeStub({ identity: BOT_IDENTITY, scopes: BOT_SCOPES, usersInfoFails: true });
    const seen = [];
    const body = 'Lewat bot buz.';
    await cli(['draft', '--as-bot', 'buz', '--to', 'C0ABCDEF', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    const r = await cli(['send', '--as-bot', 'buz', '--to', 'C0ABCDEF', '--text', body,
                         '--confirm-as', 'U0BUZ', '--yes'], { fetchImpl: stub.fetchImpl, tokenReader: botReader(seen) });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    assert.deepStrictEqual(seen, ['bot:buz'], 'hanya token bot yang dibaca');
    const post = stub.calls.find((c) => c.method === 'chat.postMessage');
    assert.strictEqual(post.auth, 'Bearer xoxb-test-bot');
    assert.strictEqual(post.body.text, body, 'lewat bot tanpa penanda');
    assert.ok(!('username' in post.body) && !('icon_emoji' in post.body), 'tidak ada penyamaran nama');
    assert.ok(r.stdout.includes('BOT buz'));
  });

  await t('bot: --confirm-as bot_id juga diterima', async () => {
    const stub = makeStub({ identity: BOT_IDENTITY, scopes: BOT_SCOPES, usersInfoFails: true });
    const body = 'Konfirmasi pakai bot_id.';
    await cli(['draft', '--as-bot', 'buz', '--to', 'C0ABCDEF', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    const r = await cli(['send', '--as-bot', 'buz', '--to', 'C0ABCDEF', '--text', body,
                         '--confirm-as', 'B0BUZ', '--yes'], { fetchImpl: stub.fetchImpl, tokenReader: botReader([]) });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
  });

  await t('bot: --confirm-as user manusia ditolak saat --as-bot', async () => {
    const stub = makeStub({ identity: BOT_IDENTITY, scopes: BOT_SCOPES, usersInfoFails: true });
    const body = 'Salah identitas bot.';
    await cli(['draft', '--as-bot', 'buz', '--to', 'C0ABCDEF', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    const r = await cli(['send', '--as-bot', 'buz', '--to', 'C0ABCDEF', '--text', body,
                         '--confirm-as', 'U0ACHMAD', '--yes'], { fetchImpl: stub.fetchImpl, tokenReader: botReader([]) });
    assert.strictEqual(r.code, EXIT.IDENTITY, r.stderr);
    assert.strictEqual(stub.writes().length, 0);
  });

  await t('bot: --as-bot dengan user token di slot bot ditolak', async () => {
    const stub = makeStub();
    const body = 'Slot bot berisi user token.';
    await cli(['draft', '--as-bot', 'buz', '--to', 'C0ABCDEF', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    const r = await cli(['send', '--as-bot', 'buz', '--to', 'C0ABCDEF', '--text', body,
                         '--confirm-as', 'U0ACHMAD', '--yes'], { fetchImpl: stub.fetchImpl, tokenReader: () => 'xoxp-x' });
    assert.strictEqual(r.code, EXIT.IDENTITY, r.stderr);
    assert.strictEqual(stub.writes().length, 0);
  });

  await t('bot: token bot belum ada -> exit 6, tidak memakai user token', async () => {
    const stub = makeStub({ identity: BOT_IDENTITY });
    const seen = [];
    const r = await cli(['send', '--as-bot', 'lain', '--to', 'C0ABCDEF', '--text', 'x',
                         '--confirm-as', 'U0BUZ', '--yes'], { fetchImpl: stub.fetchImpl, tokenReader: botReader(seen) });
    assert.strictEqual(r.code, EXIT.TOKEN, r.stderr);
    assert.deepStrictEqual(seen, ['bot:lain']);
    assert.ok(/login --bot lain/.test(r.stderr));
  });

  await t('bot: tanpa receipt draft tetap ditolak', async () => {
    const stub = makeStub({ identity: BOT_IDENTITY, scopes: BOT_SCOPES, usersInfoFails: true });
    const r = await cli(['send', '--as-bot', 'buz', '--to', 'C0ABCDEF', '--text', 'Belum pernah di-draft bot.',
                         '--confirm-as', 'U0BUZ', '--yes'], { fetchImpl: stub.fetchImpl, tokenReader: botReader([]) });
    assert.strictEqual(r.code, EXIT.RECEIPT, r.stderr);
    assert.strictEqual(stub.writes().length, 0);
  });

  await t('bot: nama bot tidak valid ditolak', async () => {
    const r = await cli(['send', '--as-bot', 'Buz Bot', '--to', 'C0ABCDEF', '--text', 'x', '--confirm-as', 'U0BUZ'],
                        { tokenReader: botReader([]) });
    assert.strictEqual(r.code, EXIT.USAGE, r.stderr);
  });

  await t('bot: not_in_channel diberi petunjuk /invite', async () => {
    const base = makeStub({ identity: BOT_IDENTITY, scopes: BOT_SCOPES, usersInfoFails: true });
    const fetchImpl = async (url, init) => {
      if (String(url).endsWith('/chat.postMessage')) {
        return { ok: true, status: 200, headers: { get: () => null },
                 json: async () => ({ ok: false, error: 'not_in_channel' }) };
      }
      return base.fetchImpl(url, init);
    };
    const body = 'Bot belum diundang.';
    await cli(['draft', '--as-bot', 'buz', '--to', 'C0ABCDEF', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    const r = await cli(['send', '--as-bot', 'buz', '--to', 'C0ABCDEF', '--text', body,
                         '--confirm-as', 'U0BUZ', '--yes'], { fetchImpl, tokenReader: botReader([]) });
    assert.strictEqual(r.code, EXIT.API, r.stderr);
    assert.ok(/\/invite @buz/.test(r.stderr));
  });

  await t('bot: draft tanpa --as-bot (ada penanda) tidak cocok dengan send --as-bot', async () => {
    const stub = makeStub({ identity: BOT_IDENTITY, scopes: BOT_SCOPES, usersInfoFails: true });
    const body = 'Draft akun pribadi, kirim lewat bot.';
    await cli(['draft', '--to', 'C0ABCDEF', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    const r = await cli(['send', '--as-bot', 'buz', '--to', 'C0ABCDEF', '--text', body,
                         '--confirm-as', 'U0BUZ', '--yes'], { fetchImpl: stub.fetchImpl, tokenReader: botReader([]) });
    assert.strictEqual(r.code, EXIT.RECEIPT, r.stderr);
    assert.strictEqual(stub.writes().length, 0);
  });

  await t('bot: send tanpa --as-bot tidak pernah membaca token bot', async () => {
    const stub = makeStub();
    const seen = [];
    const body = 'Jalur user biasa.';
    await cli(['draft', '--to', 'C0ABCDEF', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    const r = await cli(['send', '--to', 'C0ABCDEF', '--text', body, '--confirm-as', ACCOUNT, '--yes'], {
      fetchImpl: stub.fetchImpl,
      tokenReader: (a) => { seen.push(a); return 'xoxp-test-token'; },
    });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    assert.ok(seen.every((a) => !a.startsWith('bot:')));
  });

  await t('bot: doctor --as-bot hanya menuntut chat:write', async () => {
    const stub = makeStub({ identity: BOT_IDENTITY, scopes: BOT_SCOPES, usersInfoFails: true });
    const r = await cli(['doctor', '--as-bot', 'buz'], { fetchImpl: stub.fetchImpl, tokenReader: botReader([]) });
    assert.strictEqual(r.code, EXIT.OK, r.stdout + r.stderr);
    assert.ok(r.stdout.includes('token bertipe bot'));
    assert.strictEqual(stub.writes().length, 0);
  });

  await t('bot: doctor --as-bot beri WARN bila im:history belum ada (bukan gagal)', async () => {
    const stub = makeStub({ identity: BOT_IDENTITY, scopes: 'chat:write', usersInfoFails: true });
    const r = await cli(['doctor', '--as-bot', 'buz'], { fetchImpl: stub.fetchImpl, tokenReader: botReader([]) });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    assert.ok(r.stdout.includes('WARN   scope im:history'));
    assert.ok(r.stdout.includes('belum ada'));
    assert.strictEqual(stub.writes().length, 0);
  });

  await t('bot: doctor --as-bot tampilkan OK bila im:history ada', async () => {
    const stub = makeStub({ identity: BOT_IDENTITY, scopes: 'chat:write,im:history', usersInfoFails: true });
    const r = await cli(['doctor', '--as-bot', 'buz'], { fetchImpl: stub.fetchImpl, tokenReader: botReader([]) });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    assert.ok(r.stdout.includes('OK     scope im:history'));
    assert.ok(r.stdout.includes('ada'));
    assert.strictEqual(stub.writes().length, 0);
  });

  await t('send: #nama ambigu ditolak', async () => {
    const stub = makeStub({
      channels: [
        { id: 'C1', name: 'support' },
        { id: 'C2', name: 'support' },
      ],
    });
    const body = 'Ke channel ambigu.';
    await cli(['draft', '--to', '#support', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    const r = await cli(['send', '--to', '#support', '--text', body, '--confirm-as', ACCOUNT, '--yes'], {
      fetchImpl: stub.fetchImpl,
      tokenReader: TOKEN_OK,
    });
    assert.strictEqual(r.code, EXIT.INPUT, r.stderr);
    assert.strictEqual(stub.writes().length, 0);
  });

  await t('send: #nama unik diresolusi lalu terkirim', async () => {
    const stub = makeStub({ channels: [{ id: 'C0UNIQ', name: 'tim-support' }] });
    const body = 'Ke channel unik.';
    await cli(['draft', '--to', '#tim-support', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    const r = await cli(['send', '--to', '#tim-support', '--text', body, '--confirm-as', ACCOUNT, '--yes'], {
      fetchImpl: stub.fetchImpl,
      tokenReader: TOKEN_OK,
    });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    const post = stub.calls.find((c) => c.method === 'chat.postMessage');
    assert.strictEqual(post.body.channel, 'C0UNIQ');
  });

  await t('send: reply masuk thread yang benar', async () => {
    const stub = makeStub();
    const body = 'Balasan di thread.';
    const link = 'https://qiscus.slack.com/archives/C0ABCDEF/p1784788621208259';
    await cli(['draft', '--to', link, '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    const r = await cli(['send', '--to', link, '--text', body, '--confirm-as', ACCOUNT, '--yes'], {
      fetchImpl: stub.fetchImpl,
      tokenReader: TOKEN_OK,
    });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    const post = stub.calls.find((c) => c.method === 'chat.postMessage');
    assert.strictEqual(post.body.thread_ts, '1784788621.208259');
  });

  await t('send: token dikirim di header, tidak di body', async () => {
    const stub = makeStub();
    const body = 'Periksa header.';
    await cli(['draft', '--to', 'C0ABCDEF', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    await cli(['send', '--to', 'C0ABCDEF', '--text', body, '--confirm-as', ACCOUNT, '--yes'], {
      fetchImpl: stub.fetchImpl,
      tokenReader: TOKEN_OK,
    });
    for (const c of stub.calls) {
      assert.strictEqual(c.auth, 'Bearer xoxp-test-token');
      assert.ok(!JSON.stringify(c.body).includes('xoxp-'), 'token tidak boleh ada di body');
    }
  });

  // ---------------------------------------------------------------- doctor

  await t('doctor: semua sehat -> exit 0 dan sebut nilai --confirm-as', async () => {
    const stub = makeStub();
    const r = await cli(['doctor'], { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    assert.ok(/Semua siap/.test(r.stdout));
    assert.ok(/nilai --confirm-as yang sah/.test(r.stdout));
    assert.ok(/scope lengkap/.test(r.stdout));
    assert.strictEqual(stub.writes().length, 0, 'doctor harus read-only');
  });

  await t('doctor: tanpa token -> gagal, tetap read-only', async () => {
    const stub = makeStub();
    const r = await cli(['doctor'], { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_NONE });
    assert.notStrictEqual(r.code, EXIT.OK);
    assert.ok(/GAGAL/.test(r.stdout));
    assert.strictEqual(stub.writes().length, 0);
  });

  await t('doctor: scope kurang dilaporkan spesifik', async () => {
    const stub = makeStub({ scopes: 'identify,channels:read' });
    const r = await cli(['doctor'], { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK });
    assert.notStrictEqual(r.code, EXIT.OK);
    assert.ok(/hilang: .*chat:write/.test(r.stdout), 'harus menyebut scope yang hilang');
  });

  await t('doctor: email tak tersedia dilaporkan sebagai bukan-masalah', async () => {
    const stub = makeStub({ usersInfoFails: true });
    const r = await cli(['doctor'], { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    assert.ok(/JANGAN pakai email/.test(r.stdout));
    assert.ok(/user_not_found/.test(r.stdout), 'harus menyebut sebab aslinya');
  });

  await t('send: email sebagai confirm-as saat email kosong -> exit 3 + petunjuk', async () => {
    const stub = makeStub({ usersInfoFails: true });
    const body = 'Coba pakai email padahal kosong.';
    await cli(['draft', '--to', 'C0ABCDEF', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    const r = await cli(
      ['send', '--to', 'C0ABCDEF', '--text', body, '--confirm-as', 'achmad@qiscus.com', '--yes'],
      { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK }
    );
    assert.strictEqual(r.code, EXIT.IDENTITY, r.stderr);
    assert.ok(/email TIDAK bisa dipakai/.test(r.stderr), 'harus menjelaskan kenapa email gagal');
    assert.ok(/U0ACHMAD/.test(r.stderr), 'harus menyebut nilai yang sah');
    assert.strictEqual(stub.writes().length, 0);
  });

  // ------------------------------------------------------- flag tanpa nilai

  await t('flag tanpa nilai ditolak, tidak jadi "#true"', async () => {
    // --to dan --thread dipakai oleh draft; tanpa guard, String(true) = "true"
    // lolos sebagai nama channel "#true".
    for (const f of ['to', 'thread']) {
      const argv = ['draft', '--text', 'x', '--no-copy', '--' + f];
      if (f !== 'to') argv.push('--to', 'C0ABCDEF');
      const r = await cli(argv, { tokenReader: TOKEN_OK });
      assert.strictEqual(r.code, EXIT.USAGE, '--' + f + ' tanpa nilai harus exit 1: ' + r.stderr);
      assert.ok(/tanpa nilai/.test(r.stderr), '--' + f + ': pesan harus jelas');
    }
    // --account hanya dibaca oleh perintah yang butuh token; draft tidak.
    const stub = makeStub();
    const r = await cli(['whoami', '--account'], {
      fetchImpl: stub.fetchImpl,
      tokenReader: TOKEN_OK,
      account: null,
    });
    assert.strictEqual(r.code, EXIT.USAGE, '--account tanpa nilai harus exit 1: ' + r.stderr);
    assert.ok(/tanpa nilai/.test(r.stderr));
  });

  await t('draft tetap jalan walau --account diberi tanpa nilai (tidak dipakai)', async () => {
    const stub = makeStub();
    const r = await cli(['draft', '--to', 'C0ABCDEF', '--text', 'x', '--no-copy', '--account'], {
      fetchImpl: stub.fetchImpl,
      tokenReader: TOKEN_OK,
    });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    assert.strictEqual(stub.calls.length, 0);
  });

  // ----------------------------------------------------------- Keychain I/O

  // Regresi: `security -w` tanpa nilai membuka prompt interaktif sendiri dan
  // mengabaikan stdin, sehingga user ditanya token dua kali. Test ini memakai
  // Keychain sungguhan dengan entri probe, lalu membersihkannya. Kalau writeToken
  // kembali memakai jalur yang prompt, node akan menggantung di sini -- itu
  // justru sinyal yang kita mau.
  await t('keychain: tulis lalu baca tanpa prompt interaktif', () => {
    if (process.platform !== 'darwin') return;
    const kc = require('../lib/keychain');
    const acct = 'slack-as-me-selftest@example.invalid';
    const fake = 'xoxp-selftest-' + 'Z'.repeat(32);
    // security(1) mencari login keychain lewat HOME; test menimpanya ke tmp,
    // jadi kembalikan sebentar atau security akan menggantung.
    process.env.HOME = REAL_HOME;
    try {
      kc.writeToken(acct, fake);
      assert.strictEqual(kc.readToken(acct), fake);
      require('child_process').spawnSync('/usr/bin/security', [
        'delete-generic-password', '-s', kc.SERVICE, '-a', acct,
      ]);
      assert.strictEqual(kc.readToken(acct), null, 'probe harus terhapus');
    } finally {
      process.env.HOME = TMP_HOME;
    }
  });

  await t('keychain: token tidak pernah muncul di argumen proses', () => {
    if (process.platform !== 'darwin') return;
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'keychain.js'), 'utf8');
    assert.ok(!/'-w',\s*token/.test(src), 'token tidak boleh diteruskan sebagai argv ke security');
    assert.ok(/spawnSync\(SECURITY, \['-i'\]/.test(src), 'harus memakai mode security -i');
  });

  // ------------------------------------------------------------ CLI schedule

  await t('schedule: --at sudah lewat ditolak', async () => {
    const stub = makeStub();
    const r = await cli(
      ['schedule', '--to', 'C0ABCDEF', '--text', MSG, '--confirm-as', ACCOUNT, '--at', '2020-01-01T00:00:00Z', '--yes'],
      { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK }
    );
    assert.strictEqual(r.code, EXIT.INPUT, r.stderr);
    assert.strictEqual(stub.writes().length, 0);
  });

  await t('schedule: waktu valid + receipt -> terjadwal', async () => {
    const stub = makeStub();
    const body = 'Pesan terjadwal.';
    const at = new Date(Date.now() + 3600e3).toISOString();
    await cli(['draft', '--to', 'C0ABCDEF', '--text', body, '--no-copy'], { tokenReader: TOKEN_OK });
    const r = await cli(
      ['schedule', '--to', 'C0ABCDEF', '--text', body, '--confirm-as', ACCOUNT, '--at', at, '--yes'],
      { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK }
    );
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    const s = stub.calls.find((c) => c.method === 'chat.scheduleMessage');
    assert.ok(s && s.body.post_at > Math.floor(Date.now() / 1000));
  });

  // ------------------------------------------------------------- lampiran

  const ATTACH = path.join(TMP_HOME, 'brief.pdf');
  fs.writeFileSync(ATTACH, Buffer.from('%PDF-1.4 contoh'));
  const SCOPES_FILES = 'identify,chat:write,files:write,channels:read,groups:read,users:read,users:read.email';
  const THREAD = 'https://qiscus.slack.com/archives/D0ABCDEF/p1784788621208259';
  const ATT_MSG = 'Mas, ini revisinya ya, PDF terlampir.';

  await t('receipt: tanpa lampiran, key sama dengan format lama', () => {
    const crypto = require('crypto');
    const old = crypto.createHash('sha256').update(JSON.stringify(['x', '1.2']), 'utf8').digest('hex');
    assert.strictEqual(receipt.keyFor('x', '1.2'), old);
    assert.notStrictEqual(receipt.keyFor('x', '1.2', 'abc'), old);
  });

  await t('attach: draft mencatat lampiran tanpa menyentuh Slack', async () => {
    const stub = makeStub({ scopes: SCOPES_FILES });
    const r = await cli(['draft', '--to', THREAD, '--text', ATT_MSG, '--attach', ATTACH, '--no-copy'], {
      fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK,
    });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    assert.strictEqual(stub.calls.length, 0);
    assert.ok(r.stdout.includes('lampiran  : brief.pdf'));
  });

  await t('attach: send mengunggah file + teks sebagai satu pesan di thread', async () => {
    const stub = makeStub({ scopes: SCOPES_FILES });
    const r = await cli(['send', '--to', THREAD, '--text', ATT_MSG, '--attach', ATTACH,
                         '--confirm-as', ACCOUNT, '--yes'], { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    const names = stub.writes().map((c) => c.method);
    assert.deepStrictEqual(names, ['files.getUploadURLExternal', 'upload_bytes', 'files.completeUploadExternal']);
    const done = stub.calls.find((c) => c.method === 'files.completeUploadExternal');
    assert.strictEqual(done.body.channel_id, 'D0ABCDEF');
    assert.strictEqual(done.body.thread_ts, '1784788621.208259');
    assert.strictEqual(done.body.initial_comment, ATT_MSG + '\n\n_sent by Claude Code (AI)_', 'komentar lampiran juga bertanda AI');
    assert.ok(!stub.calls.some((c) => c.method === 'chat.postMessage'), 'teks tidak boleh terkirim dobel');
  });

  await t('attach: file diganti setelah draft -> exit 4, tidak menulis', async () => {
    const other = path.join(TMP_HOME, 'brief-lain.pdf');
    fs.writeFileSync(other, Buffer.from('%PDF-1.4 isi lain'));
    const stub = makeStub({ scopes: SCOPES_FILES });
    const r = await cli(['send', '--to', THREAD, '--text', ATT_MSG, '--attach', other,
                         '--confirm-as', ACCOUNT, '--yes'], { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK });
    assert.strictEqual(r.code, EXIT.RECEIPT, r.stderr);
    assert.strictEqual(stub.writes().length, 0);
  });

  await t('attach: token tanpa files:write -> exit 6 sebelum menulis', async () => {
    const stub = makeStub();
    const r = await cli(['send', '--to', THREAD, '--text', ATT_MSG, '--attach', ATTACH,
                         '--confirm-as', ACCOUNT, '--yes'], { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK });
    assert.strictEqual(r.code, EXIT.TOKEN, r.stderr);
    assert.ok(/files:write/.test(r.stderr));
    assert.strictEqual(stub.writes().length, 0);
  });

  await t('attach: dry-run menyebut lampiran dan tidak menulis', async () => {
    const stub = makeStub({ scopes: SCOPES_FILES });
    const r = await cli(['send', '--to', THREAD, '--text', ATT_MSG, '--attach', ATTACH,
                         '--confirm-as', ACCOUNT], { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK });
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    assert.ok(r.stdout.includes('lampiran           : brief.pdf'));
    assert.strictEqual(stub.writes().length, 0);
  });

  // ------------------------------------------------------------- read-thread

  await t('read-thread: sukses keluaran JSON [{"user","ts","text"}] dan read-only', async () => {
    const stub = makeStub();
    const r = await cli(
      ['read-thread', '--channel', 'C0ABCDEF', '--ts', '1784788621.208259'],
      { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK }
    );
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    assert.strictEqual(stub.writes().length, 0);
    const data = JSON.parse(r.stdout);
    assert.strictEqual(Array.isArray(data), true);
    assert.strictEqual(data.length, 2);
    // Pastikan field lain dibuang (hanya user, ts, text)
    assert.deepStrictEqual(data[0], {
      user: 'U0ACHMAD',
      ts: '1784788621.208259',
      text: 'Pesan induk thread',
    });
    assert.deepStrictEqual(data[1], {
      user: 'U0BUZ',
      ts: '1784788625.000200',
      text: 'Balasan bot',
    });
    assert.deepStrictEqual(Object.keys(data[1]).sort(), ['text', 'ts', 'user']);
  });

  await t('read-thread: sukses dengan --as-bot dan flag --json', async () => {
    const seen = [];
    const stub = makeStub({ identity: BOT_IDENTITY, scopes: 'chat:write,im:history' });
    const r = await cli(
      ['read-thread', '--as-bot', 'buz', '--channel', 'D0ABCDEF', '--ts', '1784788621.208259', '--json'],
      { fetchImpl: stub.fetchImpl, tokenReader: botReader(seen) }
    );
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    assert.strictEqual(seen.includes('bot:buz'), true);
    assert.strictEqual(stub.writes().length, 0);
    const data = JSON.parse(r.stdout);
    assert.strictEqual(data.length, 2);
  });

  await t('read-thread: mengikuti paginasi next_cursor', async () => {
    let callCount = 0;
    const stub = makeStub({
      replies: (body, { reply }) => {
        callCount++;
        if (!body.cursor) {
          return reply({
            messages: [{ user: 'U1', ts: '1784788621.000001', text: 'Hal 1' }],
            response_metadata: { next_cursor: 'cur_page_2' },
          });
        }
        if (body.cursor === 'cur_page_2') {
          return reply({
            messages: [{ user: 'U2', ts: '1784788621.000002', text: 'Hal 2' }],
            response_metadata: { next_cursor: '' },
          });
        }
        return reply({ messages: [], response_metadata: { next_cursor: '' } });
      },
    });

    const r = await cli(
      ['read-thread', '--channel', 'C0ABCDEF', '--ts', '1784788621.208259'],
      { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK }
    );
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    assert.strictEqual(callCount, 2);
    const data = JSON.parse(r.stdout);
    assert.strictEqual(data.length, 2);
    assert.strictEqual(data[0].text, 'Hal 1');
    assert.strictEqual(data[1].text, 'Hal 2');
    assert.strictEqual(stub.writes().length, 0);
  });

  await t('read-thread: oldest diteruskan pada setiap halaman', async () => {
    const seen = [];
    const stub = makeStub({ replies: (body, { reply }) => {
      seen.push(body);
      return reply({ messages: [], response_metadata: { next_cursor: seen.length === 1 ? 'next' : '' } });
    }});
    const r = await cli(
      ['read-thread', '--channel', 'C0ABCDEF', '--ts', '1784788621.208259', '--oldest', '1784788622.000001'],
      { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK }
    );
    assert.strictEqual(r.code, EXIT.OK, r.stderr);
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[0].oldest, '1784788622.000001');
    assert.strictEqual(seen[1].oldest, '1784788622.000001');
    assert.strictEqual(seen[1].cursor, 'next');
  });

  await t('read-thread: validasi channel (kosong/salah) -> exit 2', async () => {
    const stub = makeStub();
    // Tanpa --channel
    const r1 = await cli(
      ['read-thread', '--ts', '1784788621.208259'],
      { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK }
    );
    assert.strictEqual(r1.code, EXIT.INPUT, r1.stderr);
    assert.ok(r1.stderr.includes('--channel'));

    // Channel bukan diawali C/G/D
    const r2 = await cli(
      ['read-thread', '--channel', 'X0123', '--ts', '1784788621.208259'],
      { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK }
    );
    assert.strictEqual(r2.code, EXIT.INPUT, r2.stderr);
    assert.ok(r2.stderr.includes('--channel'));

    // Channel nama (#general) ditolak untuk read-thread
    const r3 = await cli(
      ['read-thread', '--channel', '#general', '--ts', '1784788621.208259'],
      { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK }
    );
    assert.strictEqual(r3.code, EXIT.INPUT, r3.stderr);
    assert.ok(r3.stderr.includes('--channel'));
    assert.strictEqual(stub.writes().length, 0);
  });

  await t('read-thread: validasi ts (kosong/salah) -> exit 2', async () => {
    const stub = makeStub();
    // Tanpa --ts
    const r1 = await cli(
      ['read-thread', '--channel', 'C0ABCDEF'],
      { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK }
    );
    assert.strictEqual(r1.code, EXIT.INPUT, r1.stderr);
    assert.ok(r1.stderr.includes('--ts'));

    // ts bukan angka/timestamp
    const r2 = await cli(
      ['read-thread', '--channel', 'C0ABCDEF', '--ts', 'invalid-ts'],
      { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK }
    );
    assert.strictEqual(r2.code, EXIT.INPUT, r2.stderr);
    assert.ok(r2.stderr.includes('--ts'));
    assert.strictEqual(stub.writes().length, 0);
  });

  await t('read-thread: scope kurang -> exit 6 dan menyebut scope yang dibutuhkan', async () => {
    const stub = makeStub({
      repliesFails: 'missing_scope',
    });
    const r = await cli(
      ['read-thread', '--channel', 'C0ABCDEF', '--ts', '1784788621.208259'],
      { fetchImpl: stub.fetchImpl, tokenReader: TOKEN_OK }
    );
    assert.strictEqual(r.code, EXIT.TOKEN, r.stderr);
    assert.ok(r.stderr.includes('channels:history'));
    assert.ok(r.stderr.includes('groups:history'));
    assert.ok(r.stderr.includes('im:history'));
    assert.strictEqual(stub.writes().length, 0);
  });

  await t('read-thread: token tidak pernah muncul di output atau error', async () => {
    const SECRET_TOKEN = 'xoxp-rahasia-jangan-bocor-12345';
    const stub = makeStub({
      replies: (body, { fail }) => {
        // Slack menyisipkan token di pesan error (skenario bocor)
        return fail('token_rejected_with_' + SECRET_TOKEN);
      },
    });
    const r = await cli(
      ['read-thread', '--channel', 'C0ABCDEF', '--ts', '1784788621.208259'],
      { fetchImpl: stub.fetchImpl, tokenReader: () => SECRET_TOKEN }
    );
    assert.notStrictEqual(r.code, EXIT.OK);
    assert.strictEqual(r.stdout.includes(SECRET_TOKEN), false, 'token tidak boleh ada di stdout');
    assert.strictEqual(r.stderr.includes(SECRET_TOKEN), false, 'token tidak boleh ada di stderr');
    assert.ok(r.stderr.includes('<redacted-token>'), 'token harus di-scrub');
  });

  // ------------------------------------------------------------------ report

  const total = pass + fails.length;
  process.stdout.write('\n' + pass + '/' + total + ' test lulus\n');
  for (const [name, err] of fails) {
    process.stdout.write('\nGAGAL: ' + name + '\n  ' + (err.message || err) + '\n');
  }
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  process.exit(fails.length ? 1 : 0);
}

main();
