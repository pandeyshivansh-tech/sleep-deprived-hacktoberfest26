import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { parseTar, readTarGz } from '../src/archive/tar.js';
import { ArchiveError } from '../src/errors.js';
import { buildTar, gz, paxEntry, tarEntry, tarHeader } from '../test-support/tar-builder.js';

const LIMITS = Object.freeze({
  maxCompressedBytes: 1_000_000,
  maxUncompressedBytes: 1_000_000,
  maxEntries: 50,
  maxFileBytes: 100_000,
  maxPathLength: 200,
  maxPathDepth: 8,
  maxCompressionRatio: 200,
});

function expectArchiveError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ArchiveError, `expected ArchiveError, got ${error}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

const parse = (entries, options) => parseTar(buildTar(entries, options), LIMITS);

test('parses files and directories with their data and modes', () => {
  const { entries } = parse([
    tarEntry({ name: 'package/', type: '5', mode: 0o755 }),
    tarEntry({ name: 'package/index.js', mode: 0o644 }, 'console.log(1)'),
    tarEntry({ name: 'package/bin/cli', mode: 0o755 }, '#!/usr/bin/env node'),
  ]);
  assert.deepEqual(
    entries.map(({ path, type, size, mode }) => ({ path, type, size, mode })),
    [
      { path: 'package', type: 'directory', size: 0, mode: 0o755 },
      { path: 'package/index.js', type: 'file', size: 14, mode: 0o644 },
      { path: 'package/bin/cli', type: 'file', size: 19, mode: 0o755 },
    ],
  );
  assert.equal(entries[1].data.toString(), 'console.log(1)');
  assert.equal(entries[0].data, null);
});

test('accepts an archive without a trailer and one with extra zero padding', () => {
  assert.equal(parse([tarEntry({ name: 'package/a' }, 'x')], { trailer: false }).entries.length, 1);
  const padded = Buffer.concat([buildTar([tarEntry({ name: 'package/a' }, 'x')]), Buffer.alloc(10240)]);
  assert.equal(parseTar(padded, LIMITS).entries.length, 1);
});

test('normalizes harmless "." and empty path segments', () => {
  const { entries } = parse([tarEntry({ name: 'package//a/./b.js' }, 'x'), tarEntry({ name: './', type: '5' })]);
  assert.equal(entries[0].path, 'package/a/b.js');
  assert.equal(entries[1].path, '');
});

test('reads long paths from ustar prefix, pax path and GNU long names', () => {
  const long = `package/${'d/'.repeat(5)}${'n'.repeat(120)}.js`;
  const viaPrefix = parse([tarEntry({ name: 'file.js', prefix: 'package/some/dir' }, 'x')]);
  assert.equal(viaPrefix.entries[0].path, 'package/some/dir/file.js');

  const viaPax = parse([paxEntry({ path: long }), tarEntry({ name: 'ignored' }, 'x')]);
  assert.equal(viaPax.entries[0].path, long);

  const viaGnu = parse([tarEntry({ name: '././@LongLink', type: 'L' }, `${long}\0`), tarEntry({ name: 'ignored' }, 'x')]);
  assert.equal(viaGnu.entries[0].path, long);
});

test('does not treat GNU-format bytes at offset 345 as a path prefix', () => {
  const header = tarHeader({ name: 'package/a.js', magic: 'ustar ' });
  header.write('GARBAGE', 345, 'latin1');
  // Recompute the checksum after tampering with the header.
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  const { entries } = parseTar(Buffer.concat([header, Buffer.alloc(512 * 3)]), LIMITS);
  assert.equal(entries[0].path, 'package/a.js');
});

test('returns the commit recorded in a pax global header', () => {
  const sha = 'a'.repeat(40);
  const { globalComment, entries } = parse([paxEntry({ comment: sha }, { global: true }), tarEntry({ name: 'r/a' }, 'x')]);
  assert.equal(globalComment, sha);
  assert.equal(entries.length, 1);
  expectArchiveError(() => parse([paxEntry({ path: 'evil' }, { global: true })]), 'unsupported-entry');
});

test('rejects path traversal, absolute and drive paths, backslashes and NUL', () => {
  for (const path of ['../evil', 'package/../../evil', 'package/a/../../../evil', '/etc/passwd', 'C:/Windows/x', 'package\\..\\evil']) {
    expectArchiveError(() => parse([tarEntry({ name: path }, 'x')]), 'unsafe-path');
  }
  expectArchiveError(() => parse([paxEntry({ path: 'package/a\0b' }), tarEntry({ name: 'x' }, 'x')]), 'unsafe-path');
  expectArchiveError(() => parse([paxEntry({ path: '../../x' }), tarEntry({ name: 'x' }, 'x')]), 'unsafe-path');
});

test('rejects invalid UTF-8 names rather than guessing', () => {
  const header = tarHeader({ name: 'placeholder' });
  header.set([0x70, 0x61, 0x63, 0x6b, 0xff, 0xfe], 0);
  header.fill(0, 6, 100);
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  expectArchiveError(() => parseTar(Buffer.concat([header, Buffer.alloc(1024)]), LIMITS), 'unsafe-path');
});

test('records symlinks and hardlinks as entries without following them', () => {
  const { entries } = parse([
    tarEntry({ name: 'package/link', type: '2', linkname: '../../../etc/passwd' }),
    tarEntry({ name: 'package/hard', type: '1', linkname: 'package/index.js' }),
    tarEntry({ name: 'package/index.js' }, 'x'),
  ]);
  assert.deepEqual(
    entries.map(({ path, type, linkTarget, data }) => ({ path, type, linkTarget, hasData: data !== null })),
    [
      { path: 'package/link', type: 'symlink', linkTarget: '../../../etc/passwd', hasData: false },
      { path: 'package/hard', type: 'hardlink', linkTarget: 'package/index.js', hasData: false },
      { path: 'package/index.js', type: 'file', linkTarget: null, hasData: true },
    ],
  );
});

test('rejects links and directories that smuggle data, and links with no target', () => {
  expectArchiveError(() => parse([tarEntry({ name: 'package/l', type: '2', linkname: 'a' }, 'hidden')]), 'bad-header');
  expectArchiveError(() => parse([tarEntry({ name: 'package/d/', type: '5' }, 'hidden')]), 'bad-header');
  expectArchiveError(() => parse([tarEntry({ name: 'package/l', type: '2', linkname: '' })]), 'unsafe-path');
});

test('rejects devices, FIFOs and unknown entry types', () => {
  for (const type of ['3', '4', '6', 'D', 'S']) {
    expectArchiveError(() => parse([tarEntry({ name: 'package/dev', type })]), 'unsupported-entry');
  }
});

test('rejects the same path appearing twice', () => {
  expectArchiveError(
    () => parse([tarEntry({ name: 'package/a.js' }, 'good'), tarEntry({ name: 'package/a.js' }, 'evil')]),
    'duplicate-path',
  );
  expectArchiveError(
    () => parse([tarEntry({ name: 'package/a.js' }, 'good'), tarEntry({ name: 'package//a.js', type: '2', linkname: 'x' })]),
    'duplicate-path',
  );
});

test('rejects corrupt headers and unsupported number encodings', () => {
  expectArchiveError(() => parseTar(Buffer.concat([tarHeader({ name: 'package/a', badChecksum: true }), Buffer.alloc(1024)]), LIMITS), 'bad-header');

  const header = tarHeader({ name: 'package/a' });
  header[124] = 0x80;
  expectArchiveError(() => parseTar(Buffer.concat([header, Buffer.alloc(1024)]), LIMITS), 'bad-header');
});

test('rejects truncated archives', () => {
  const full = buildTar([tarEntry({ name: 'package/a.js' }, 'x'.repeat(2000))]);
  expectArchiveError(() => parseTar(full.subarray(0, 700), LIMITS), 'truncated');
  expectArchiveError(() => parseTar(full.subarray(0, 100), LIMITS), 'truncated');
});

test('rejects data hidden after the end-of-archive marker', () => {
  const sneaky = Buffer.concat([buildTar([tarEntry({ name: 'package/a' }, 'x')]), tarEntry({ name: 'package/hidden.js' }, 'evil()')]);
  expectArchiveError(() => parseTar(sneaky, LIMITS), 'trailing-data');
});

test('enforces entry count, file size, total size, depth and path length limits', () => {
  const many = Array.from({ length: 51 }, (_, index) => tarEntry({ name: `package/f${index}` }, 'x'));
  expectArchiveError(() => parse(many), 'limit');

  expectArchiveError(() => parse([tarEntry({ name: 'package/big' }, 'x'.repeat(100_001))]), 'limit');

  const total = Array.from({ length: 11 }, (_, index) => tarEntry({ name: `package/f${index}` }, 'x'.repeat(95_000)));
  expectArchiveError(() => parse(total), 'limit');

  expectArchiveError(() => parse([tarEntry({ name: `package/${'d/'.repeat(9)}f` }, 'x')]), 'limit');
  expectArchiveError(() => parse([paxEntry({ path: `package/${'a'.repeat(250)}` }), tarEntry({ name: 'x' }, 'x')]), 'limit');
});

test('a header that claims a huge size is refused before reading any data', () => {
  const header = tarHeader({ name: 'package/huge', size: 0o7777777777 });
  expectArchiveError(() => parseTar(Buffer.concat([header, Buffer.alloc(1024)]), LIMITS), 'limit');
});

test('readTarGz decompresses and parses a valid archive', async () => {
  const { entries } = await readTarGz(gz(buildTar([tarEntry({ name: 'package/a.js' }, 'x')])), LIMITS);
  assert.equal(entries[0].path, 'package/a.js');
});

test('readTarGz stops a gzip bomb at the output cap', async () => {
  const bomb = gz(Buffer.alloc(5_000_000));
  assert.ok(bomb.length < 10_000, 'the bomb must be tiny compressed');
  await assert.rejects(readTarGz(bomb, LIMITS), (error) => {
    assert.ok(error instanceof ArchiveError);
    assert.equal(error.code, 'limit');
    assert.match(error.message, /decompression bomb/);
    return true;
  });
});

test('readTarGz applies the compression-ratio limit even under the output cap', async () => {
  const bomb = gz(Buffer.alloc(5_000_000));
  await assert.rejects(readTarGz(bomb, { ...LIMITS, maxUncompressedBytes: 10_000_000 }), (error) => {
    assert.equal(error.code, 'limit');
    assert.match(error.message, /compression ratio/);
    return true;
  });
});

test('readTarGz rejects oversized, non-gzip and corrupt downloads', async () => {
  const valid = gz(buildTar([tarEntry({ name: 'package/a' }, 'x')]));
  await assert.rejects(readTarGz(valid, { ...LIMITS, maxCompressedBytes: 10 }), { code: 'limit' });
  await assert.rejects(readTarGz(Buffer.from('plain text'), LIMITS), { code: 'bad-gzip' });
  await assert.rejects(readTarGz(Buffer.alloc(0), LIMITS), { code: 'bad-gzip' });
  await assert.rejects(readTarGz(valid.subarray(0, valid.length - 12), LIMITS), { code: 'bad-gzip' });
  await assert.rejects(readTarGz(Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('garbage-garbage')]), LIMITS), { code: 'bad-gzip' });
});

test('readTarGz refuses a gzip that wraps a non-tar payload', async () => {
  await assert.rejects(readTarGz(gzipSync(Buffer.from('x'.repeat(2000))), LIMITS), { code: 'bad-header' });
});
