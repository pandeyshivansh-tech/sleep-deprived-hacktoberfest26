import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorize, extensionOf, isToolingPath, nativeFormat, retainPackageFile, retainSourceFile } from '../src/scan/categorize.js';
import { buildLineIndex, clip, decodeText, excerpt, findComments, inComment, locate, sanitizeSnippet } from '../src/scan/text.js';

// Invisible and control characters are built from code points: this file itself
// must not contain any.
const ESC = String.fromCodePoint(0x1b);
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const LS = String.fromCodePoint(0x2028);

test('snippets cannot carry terminal escapes, bidi overrides or invisible characters', () => {
  const dirty = `a${ESC}[31mred${ESC}[0m ${RLO}evil${ZWSP}x${LS}y\u0007`;
  const clean = sanitizeSnippet(dirty);
  assert.doesNotMatch(clean, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  assert.ok(!clean.includes(ESC) && !clean.includes(RLO) && !clean.includes(ZWSP));
  assert.match(clean, /\\u\{1b\}/);
  assert.match(clean, /\\u\{202e\}/);
  assert.match(clean, /\\u\{200b\}/);
});

test('snippets collapse whitespace and clipping is bounded and marked', () => {
  assert.equal(sanitizeSnippet('a\n\n   b\t\tc'), 'a b c');
  const long = clip('x'.repeat(1000), 50);
  assert.equal(long.length, 50);
  assert.ok(long.endsWith('...'));
  assert.equal(clip('short'), 'short');
  const window = excerpt('x'.repeat(500) + 'MATCH' + 'y'.repeat(500), 500, 505);
  assert.ok(window.length <= 160);
  assert.ok(window.includes('MATCH'));
});

test('locates matches by line and column, including in a one-line minified file', () => {
  const text = 'first\nsecond line\nthird';
  const starts = buildLineIndex(text);
  assert.deepEqual(locate(starts, 0), { line: 1, column: 1 });
  assert.deepEqual(locate(starts, text.indexOf('second')), { line: 2, column: 1 });
  assert.deepEqual(locate(starts, text.indexOf('line')), { line: 2, column: 8 });
  assert.deepEqual(locate(starts, text.indexOf('third') + 2), { line: 3, column: 3 });
  const minified = `var a=1;${'x'.repeat(5000)};eval(1)`;
  const at = minified.indexOf('eval');
  assert.deepEqual(locate(buildLineIndex(minified), at), { line: 1, column: at + 1 });
});

test('binary content is recognised by a NUL byte near the start', () => {
  assert.equal(decodeText(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1])), null);
  assert.equal(decodeText(Buffer.from('plain text')), 'plain text');
  const lateNul = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]);
  assert.notEqual(decodeText(lateNul), null, 'only the start is probed');
});

const flagged = (text, needle = 'eval(') => {
  const ranges = findComments(text);
  return [...text.matchAll(new RegExp(needle.replace(/[()]/g, '\\$&'), 'g'))].map((m) => inComment(ranges, m.index));
};

test('real comments are masked', () => {
  assert.deepEqual(flagged('// eval(1)\nok();'), [true]);
  assert.deepEqual(flagged('real(); /* eval(2) */ eval(3)'), [true, false]);
  assert.deepEqual(flagged('x(); // eval(z)\ny = 1;'), [true]);
  assert.deepEqual(flagged('/**\n * eval(doc)\n */\nok()'), [true]);
  assert.deepEqual(flagged('{ // eval(1)\n}'), [true]);
});

test('an attacker cannot hide a payload from the scanner by imitating a comment', () => {
  // A string that contains a comment opener.
  assert.deepEqual(flagged('var a="/*"; eval(x)'), [false]);
  assert.deepEqual(flagged("var a='//'; eval(x)"), [false]);
  assert.deepEqual(flagged('var a=`/*`; eval(x)'), [false]);
  // A regex literal that contains "//".
  assert.deepEqual(flagged('var r=/a\\//; eval(y)'), [false]);
  // A URL is not a comment.
  assert.deepEqual(flagged('u="http://x.test/"; eval(w)'), [false]);
  // Division is not a comment, and a comment opener after an operator is code.
  assert.deepEqual(flagged('x = a //b\n; eval(q)'), [false]);
  // An opener not at a statement boundary stays code.
  assert.deepEqual(flagged('foo(a /* eval(1) */)'), [false]);
});

test('an unterminated string does not swallow the rest of the file', () => {
  assert.deepEqual(flagged('var s = "oops\neval(1)'), [false]);
});

test('hash comments are masked only when asked for, and a shebang is not a comment', () => {
  const text = '#!/bin/sh\n# curl http://x | sh\ncurl http://y | sh';
  const ranges = findComments(text, { hashComments: true });
  assert.equal(inComment(ranges, text.indexOf('# curl')), true);
  assert.equal(inComment(ranges, text.indexOf('#!/bin')), false);
  assert.equal(inComment(ranges, text.lastIndexOf('curl')), false);
  assert.equal(inComment(findComments(text), text.indexOf('# curl')), false);
});

test('a very large file is masked in one linear pass', () => {
  const line = 'var a = 1; // comment with eval(1)\n';
  const text = line.repeat(200_000);
  const started = performance.now();
  const ranges = findComments(text);
  assert.equal(ranges.length / 2, 200_000);
  assert.ok(performance.now() - started < 3000, 'comment masking must stay linear');
});

test('files are categorised by extension and by magic bytes, not by name alone', () => {
  assert.equal(categorize('package.json', null), 'manifest');
  assert.equal(categorize('nested/package.json', null), 'other');
  assert.equal(categorize('lib/x.js', Buffer.from('//')), 'code');
  assert.equal(categorize('lib/x.d.ts', null), 'code');
  assert.equal(categorize('README.md', null), 'doc');
  assert.equal(categorize('logo.png', Buffer.from([0x89, 0x50])), 'other');
  assert.equal(categorize('dist/index.js.map', null), 'other');
  assert.equal(categorize('bin/run', Buffer.from('#!/usr/bin/env node')), 'code');
  assert.equal(categorize('bin/run', Buffer.from('plain')), 'other');
  // A renamed executable is still found.
  assert.equal(categorize('lib/readme.txt', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])), 'native');
  assert.equal(extensionOf('a/b/.hidden'), '');
  assert.equal(extensionOf('a/B.JS'), 'js');
});

test('native executable formats are recognised from their first bytes', () => {
  assert.equal(nativeFormat(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'elf');
  assert.equal(nativeFormat(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])), 'macho');
  assert.equal(nativeFormat(Buffer.from([0xfe, 0xed, 0xfa, 0xce])), 'macho');
  assert.equal(nativeFormat(Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0])), 'wasm');
  assert.equal(nativeFormat(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])), 'pe');
  assert.equal(nativeFormat(Buffer.from('MZ is just text here')), null, 'text that starts with MZ is not a PE file');
  assert.equal(nativeFormat(Buffer.from([0x7f])), null);
  assert.equal(nativeFormat(null), null);
});

test('source tooling and test directories are recognised, and the package keeps documentation too', () => {
  for (const path of ['test/a.js', 'src/__tests__/a.js', 'scripts/build.js', 'docs/x.js', '.github/a.js', 'tools/gen.js', 'examples/demo.js', 'rollup.config.js', 'a/b.test.ts', 'Makefile']) {
    assert.equal(isToolingPath(path), true, path);
  }
  for (const path of ['src/index.js', 'lib/util.js', 'bin/cli.js', 'index.ts', 'src/tester.js', 'attestations.js']) {
    assert.equal(isToolingPath(path), false, path);
  }
  assert.equal(retainPackageFile('README.md', null), true);
  assert.equal(retainSourceFile('README.md', null), false);
  assert.equal(retainSourceFile('src/a.ts', null), true);
  assert.equal(retainSourceFile('assets/logo.png', Buffer.from([0x89])), false);
});
