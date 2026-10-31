// Decides which published files the scanner reads, and how. Extension and magic
// bytes only: file contents are never executed or interpreted.

const CODE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts',
  'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd',
  'html', 'htm', 'svg', 'py', 'rb', 'pl',
]);
const DOC_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'rst', 'adoc']);

export function extensionOf(path) {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

// Executable formats are recognised by their first bytes, never by name, so a
// renamed binary is still found. `head` is the first (up to) 16 bytes.
export function nativeFormat(head) {
  if (!head || head.length < 4) return null;
  const [a, b, c, d] = head;
  if (a === 0x7f && b === 0x45 && c === 0x4c && d === 0x46) return 'elf';
  if (a === 0x00 && b === 0x61 && c === 0x73 && d === 0x6d) return 'wasm';
  if ((a === 0xfe && b === 0xed && c === 0xfa && (d === 0xce || d === 0xcf)) || (a === 0xcf && b === 0xfa && c === 0xed && d === 0xfe) || (a === 0xce && b === 0xfa && c === 0xed && d === 0xfe)) {
    return 'macho';
  }
  // A DOS header ("MZ") followed by the zero bytes a real PE header has; plain
  // text that merely starts with "MZ" does not match.
  if (a === 0x4d && b === 0x5a && head.length >= 6 && head[3] === 0 && head[5] === 0) return 'pe';
  return null;
}

const startsWithShebang = (head) => head && head.length >= 2 && head[0] === 0x23 && head[1] === 0x21;

// 'native' | 'manifest' | 'code' | 'doc' | 'other'
export function categorize(path, head) {
  if (nativeFormat(head)) return 'native';
  if (path === 'package.json') return 'manifest';
  const extension = extensionOf(path);
  if (CODE_EXTENSIONS.has(extension)) return 'code';
  if (DOC_EXTENSIONS.has(extension)) return 'doc';
  if (extension === '' && startsWithShebang(head)) return 'code';
  return 'other';
}

// Which files an inventory keeps bytes for, by side. Source snapshots hold
// images, fixtures and docs the scanner never reads, so they do not use up the
// retention budget; the package keeps documentation too (for text aimed at AI).
export const retainPackageFile = (path, head) => ['manifest', 'code', 'doc'].includes(categorize(path, head));
export const retainSourceFile = (path, head) => ['manifest', 'code'].includes(categorize(path, head));

// Source directories whose code is build, test or tooling. Behavior found only
// there says nothing about what the published code is allowed to do, so it is
// not counted as the source "having" a capability. Misclassifying a path makes
// package behavior look more introduced, which is the fail-safe direction.
const TOOLING_DIRECTORY =
  /(?:^|\/)(?:tests?|__tests__|specs?|e2e|bench(?:marks?)?|examples?|docs?|fixtures?|scripts?|tools?|tooling|demos?|\.github|\.husky|\.vscode|\.circleci|\.storybook)\//i;
const TOOLING_FILE = /(?:^|\/)(?:[^/]*\.(?:test|spec|config)\.[cm]?[jt]sx?|(?:gulpfile|gruntfile|jakefile|makefile)[^/]*)$/i;

export const isToolingPath = (path) => TOOLING_DIRECTORY.test(path) || TOOLING_FILE.test(path);
