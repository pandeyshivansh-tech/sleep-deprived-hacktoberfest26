// Text helpers for scanning untrusted file contents: decoding, locating a match
// by line and column, comment awareness, and snippets that are safe to print.

const BINARY_PROBE_BYTES = 8192;

// Returns null for binary data (a NUL byte near the start), else the text.
export function decodeText(buffer) {
  const probe = buffer.subarray(0, BINARY_PROBE_BYTES);
  if (probe.includes(0)) return null;
  return buffer.toString('utf8');
}

// Offsets at which each line starts. A minified bundle is one line, which is
// why evidence also carries a column.
export function buildLineIndex(text) {
  const starts = [0];
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  return starts;
}

export function locate(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - starts[low] + 1 };
}

// Controls, DEL, C1, zero-width characters and bidirectional overrides can hide
// text or move a terminal cursor. Snippets are quoted from untrusted files and
// printed by the CLI, so they are shown as visible escapes instead. The class is
// built from code points so no invisible character sits in this source file.
const UNSAFE_RANGES = [
  [0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x2029],
  [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff],
];
const UNSAFE = new RegExp(`[${UNSAFE_RANGES.map(([from, to]) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`).join('')}]`, 'gu');

const escapeChar = (char) => `\\u{${char.codePointAt(0).toString(16)}}`;

// Escapes unsafe characters but keeps line structure (tab and newline are not
// in the unsafe set). For whole blocks of output that quote untrusted names.
export function escapeUnsafe(text) {
  return text.replace(UNSAFE, escapeChar);
}

export function sanitizeSnippet(text) {
  return escapeUnsafe(text.replace(/\s+/g, ' ')).trim();
}

// Sanitizes and shortens text that is not a window into a file (a command line,
// a link target, a checksum) so it fits an evidence snippet.
export function clip(text, max = 300) {
  const clean = sanitizeSnippet(String(text));
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

const SNIPPET_BEFORE = 30;
const SNIPPET_AFTER = 70;
const SNIPPET_MAX = 160;

// A bounded, sanitized window around a match: some text before it, the match, and
// what follows (the argument of a call, the value read), so a reviewer sees the
// code and not just the keyword.
export function excerpt(text, start, end) {
  const from = Math.max(0, start - SNIPPET_BEFORE);
  const to = Math.min(text.length, Math.max(end, start + 1) + SNIPPET_AFTER, from + SNIPPET_MAX);
  return sanitizeSnippet(text.slice(from, Math.max(to, start + 1)));
}

// Comment awareness without parsing the language.
//
// A single pass finds stretches that are confidently comments, so a match inside
// one (for example "eval(" in a doc comment) is not reported. "Confident" is
// deliberately narrow, because an attacker controls the file: "//" or "/*" only
// starts a comment at the beginning of a line, or right after one of ; { } ) ,
// and never inside a quoted string. So a payload placed after `"/*"` or a regex
// such as /a\// is still scanned. Anything unsure stays code, which can only
// produce more findings, never fewer.
const COMMENT_OPENERS = new Set([';', '{', '}', ')', ',']);
const QUOTES = new Set(['"', "'", '`']);

// Returns a flat array [start0, end0, start1, end1, ...] of comment ranges.
export function findComments(text, { hashComments = false } = {}) {
  const ranges = [];
  const length = text.length;
  let previous = '\n'; // last non-blank character on the current line
  let quote = null;
  let index = 0;

  while (index < length) {
    const char = text[index];

    if (quote !== null) {
      if (char === '\\') index += 1; // skip the escaped character
      else if (char === quote) quote = null;
      else if (char === '\n' && quote !== '`') quote = null; // unterminated: do not swallow the file
      index += 1;
      continue;
    }

    if (char === '\n') {
      previous = '\n';
    } else if (char === '/' && (text[index + 1] === '/' || text[index + 1] === '*') && (previous === '\n' || COMMENT_OPENERS.has(previous))) {
      if (text[index + 1] === '/') {
        let end = text.indexOf('\n', index);
        if (end === -1) end = length;
        ranges.push(index, end);
        index = end;
        continue;
      }
      let end = text.indexOf('*/', index + 2);
      end = end === -1 ? length : end + 2;
      ranges.push(index, end);
      const lastNewline = text.lastIndexOf('\n', end - 1);
      previous = lastNewline >= index ? '\n' : previous;
      index = end;
      continue;
    } else if (char === '#' && hashComments && previous === '\n' && text[index + 1] !== '!') {
      let end = text.indexOf('\n', index);
      if (end === -1) end = length;
      ranges.push(index, end);
      index = end;
      continue;
    } else if (QUOTES.has(char)) {
      quote = char;
      previous = char;
    } else if (char !== ' ' && char !== '\t' && char !== '\r') {
      previous = char;
    }
    index += 1;
  }
  return ranges;
}

export function inComment(ranges, offset) {
  let low = 0;
  let high = ranges.length / 2 - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offset < ranges[2 * mid]) high = mid - 1;
    else if (offset >= ranges[2 * mid + 1]) low = mid + 1;
    else return true;
  }
  return false;
}
