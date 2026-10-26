'use strict';

// Resolusi target Slack: link arsip, channel ID mentah, atau #nama-channel.
//
// Aturan konversi `p<digits>` -> message_ts diambil dari
// ~/.claude/skills/slack-progress-report/SKILL.md §1: sisipkan titik desimal
// 6 digit dari belakang. p1784788621208259 -> 1784788621.208259

const ARCHIVE_RE = /^https?:\/\/[^/\s]+\/archives\/([A-Z0-9]+)\/p(\d{7,})/i;
// "Copy link" pada sebuah channel/DM (bukan pada satu pesan) tidak membawa
// bagian /p<ts>. Bentuk ini sah dan artinya: channel-nya, bukan thread tertentu.
const CHANNEL_LINK_RE = /^https?:\/\/[^/\s]+\/archives\/([A-Z0-9]+)\/?(?:[?#].*)?$/i;
const ID_RE = /^[CGD][A-Z0-9]{1,}$/;
const NAME_RE = /^#?([a-z0-9][a-z0-9._-]{0,79})$/;
const TS_RE = /^\d{10}\.\d{6}$/;

class TargetError extends Error {}

function tsFromPForm(digits) {
  if (digits.length < 7) {
    throw new TargetError(`timestamp "p${digits}" terlalu pendek untuk jadi message_ts`);
  }
  const cut = digits.length - 6;
  return `${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

// Terima ts apa adanya (1784788621.208259) atau bentuk p<digits>.
function normalizeTs(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (TS_RE.test(s)) return s;
  const p = s.match(/^p?(\d{7,})$/);
  if (p) return tsFromPForm(p[1]);
  throw new TargetError(
    `"${raw}" bukan message_ts yang valid (harap 1784788621.208259 atau p1784788621208259)`
  );
}

/**
 * @param {string} input  link arsip / channel ID / #nama
 * @param {{thread?: string}} opts
 * @returns {{channelId: string|null, channelLabel: string, threadTs: string|null,
 *            resolved: boolean, source: string}}
 */
function parseTarget(input, opts = {}) {
  if (!input || !String(input).trim()) {
    throw new TargetError('target kosong — pakai --to <link|channelId|#nama>');
  }
  const raw = String(input).trim();
  const explicitThread = opts.thread ? normalizeTs(opts.thread) : null;

  const archive = raw.match(ARCHIVE_RE);
  if (archive) {
    const channelId = archive[1].toUpperCase();
    const own = tsFromPForm(archive[2]);
    // Link ke reply di dalam thread membawa ?thread_ts=<parent>. Kalau ada,
    // parent itulah thread_ts-nya; kalau tidak, p<ts> sendiri yang jadi parent.
    let parent = null;
    const q = raw.indexOf('?');
    if (q !== -1) {
      const params = new URLSearchParams(raw.slice(q + 1));
      const t = params.get('thread_ts');
      if (t) parent = normalizeTs(t);
    }
    return {
      channelId,
      channelLabel: channelId,
      threadTs: explicitThread || parent || own,
      resolved: true,
      source: 'archive-link',
    };
  }

  const channelLink = raw.match(CHANNEL_LINK_RE);
  if (channelLink) {
    const channelId = channelLink[1].toUpperCase();
    return {
      channelId,
      channelLabel: channelId,
      threadTs: explicitThread,
      resolved: true,
      source: 'channel-link',
    };
  }

  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    throw new TargetError(
      `link Slack tidak dikenali: ${raw}\n` +
        'Yang didukung:\n' +
        '  https://<workspace>.slack.com/archives/<channelId>            (channel/DM)\n' +
        '  https://<workspace>.slack.com/archives/<channelId>/p<digits>  (pesan/thread)'
    );
  }

  const upper = raw.toUpperCase();
  if (ID_RE.test(upper)) {
    return {
      channelId: upper,
      channelLabel: upper,
      threadTs: explicitThread,
      resolved: true,
      source: 'channel-id',
    };
  }

  const named = raw.match(NAME_RE);
  if (named) {
    return {
      channelId: null,
      channelLabel: `#${named[1]}`,
      threadTs: explicitThread,
      resolved: false,
      source: 'channel-name',
    };
  }

  throw new TargetError(
    `target "${raw}" tidak dikenali sebagai link arsip, channel ID, maupun #nama-channel`
  );
}

module.exports = { parseTarget, normalizeTs, tsFromPForm, TargetError };
