'use strict';

// Normalisasi teks -> mrkdwn Slack.
// Aturan diambil dari ~/.claude/skills/pb-copy/SKILL.md bagian 2:
//  - bold pakai *satu asterisk*, bukan **dua** (di Slack **x** tampil apa adanya)
//  - jangan patah baris manual di tengah paragraf; biarkan Slack yang wrap
//  - isi fenced code block dan inline code tidak boleh disentuh

const FENCE_RE = /^\s*```/;
// Baris yang harus tetap jadi baris sendiri (jangan digabung ke paragraf).
const STANDALONE_RE = /^\s*(?:[-*+•]\s+|\d+[.)]\s+|>\s?|\||#{1,6}\s+)/;

// Placeholder inline code. Printable murni supaya file ini tetap aman diedit
// lewat heredoc/sed; tabrakan dengan teks asli praktis mustahil.
const MARK_PREFIX = '@@SAMCODE';
const MARK_SUFFIX = '@@';
const RESTORE_RE = /@@SAMCODE(\d+)@@/g;

function splitFences(text) {
  const out = [];
  let buf = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (FENCE_RE.test(line)) {
      out.push({ code: inFence, lines: buf });
      out.push({ fence: true, lines: [line] });
      buf = [];
      inFence = !inFence;
      continue;
    }
    buf.push(line);
  }
  out.push({ code: inFence, lines: buf });
  return out;
}

// Lindungi inline code supaya transformasi bold/link tidak masuk ke dalamnya.
function protectInlineCode(s) {
  const stash = [];
  const masked = s.replace(/`[^`\n]*`/g, (m) => {
    stash.push(m);
    return MARK_PREFIX + (stash.length - 1) + MARK_SUFFIX;
  });
  return { masked, stash };
}

function inlineTransforms(line) {
  const { masked, stash } = protectInlineCode(line);
  let s = masked;

  // [teks](url) -> <url|teks>
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => '<' + u + '|' + t + '>');
  // **bold** / __bold__ -> *bold*
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');
  s = s.replace(/__([^_\n]+)__/g, '*$1*');
  // ~~strike~~ -> ~strike~
  s = s.replace(/~~([^~\n]+)~~/g, '~$1~');

  return s.replace(RESTORE_RE, (_, i) => stash[Number(i)]);
}

function lineLevelTransforms(line) {
  // Heading markdown tidak ada di Slack -> jadikan bold satu baris.
  const h = line.match(/^\s*#{1,6}\s+(.*\S)\s*$/);
  if (h) {
    const inner = inlineTransforms(h[1]).replace(/^\*(.*)\*$/, '$1');
    return '*' + inner + '*';
  }
  // Bullet "-" / "*" / "+" -> bullet dot
  const b = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (b) return b[1] + '• ' + inlineTransforms(b[2]);
  return inlineTransforms(line);
}

// Gabungkan baris-baris dalam satu paragraf jadi satu baris panjang.
function unwrapParagraphs(lines) {
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) {
      out.push(para.join(' ').replace(/[ \t]+/g, ' ').trim());
      para = [];
    }
  };
  for (const line of lines) {
    if (line.trim() === '') {
      flush();
      out.push('');
    } else if (STANDALONE_RE.test(line)) {
      flush();
      out.push(line.replace(/\s+$/, ''));
    } else {
      para.push(line.trim());
    }
  }
  flush();
  return out;
}

/**
 * @param {string} text
 * @param {{raw?: boolean, unwrap?: boolean}} opts
 */
function toMrkdwn(text, opts = {}) {
  if (opts.raw) return String(text).replace(/\s+$/, '');
  const unwrap = opts.unwrap !== false;

  const parts = splitFences(String(text));
  const rendered = parts.map((part) => {
    if (part.fence || part.code) return part.lines.join('\n');
    let lines = part.lines;
    if (unwrap) lines = unwrapParagraphs(lines);
    return lines.map(lineLevelTransforms).join('\n');
  });

  return rendered
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\s+$/, '');
}

module.exports = { toMrkdwn };
