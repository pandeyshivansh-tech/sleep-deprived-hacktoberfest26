import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildInventory } from '../src/archive/inventory.js';
import { parseTar } from '../src/archive/tar.js';
import { compareInventories } from '../src/compare/diff.js';
import { ArchiveError } from '../src/errors.js';
import { buildTar, tarEntry } from '../test-support/tar-builder.js';

const LIMITS = Object.freeze({
  maxUncompressedBytes: 1_000_000,
  maxEntries: 100,
  maxFileBytes: 100_000,
  maxPathLength: 200,
  maxPathDepth: 10,
  maxRetainedFileBytes: 100,
  maxRetainedTotalBytes: 250,
});

const sha = (text) => createHash('sha256').update(text).digest('hex');

function inventoryOf(entries, options = {}) {
  return buildInventory(parseTar(buildTar(entries), LIMITS), { limits: LIMITS, ...options });
}

const file = (path, content, spec = {}) => tarEntry({ name: path, ...spec }, content);

test('strips the single top-level directory and hashes every file with SHA-256', () => {
  const inventory = inventoryOf([
    tarEntry({ name: 'package/', type: '5' }),
    file('package/index.js', 'hello'),
    file('package/lib/util.js', ''),
  ]);
  assert.equal(inventory.rootName, 'package');
  assert.deepEqual([...inventory.files.keys()], ['index.js', 'lib/util.js']);
  assert.equal(inventory.files.get('index.js').sha256, sha('hello'));
  assert.equal(inventory.files.get('lib/util.js').sha256, sha(''));
  assert.equal(inventory.files.get('index.js').size, 5);
  assert.deepEqual(inventory.stats, { directories: 1, files: 2, symlinks: 0, hardlinks: 0, outsideDirectory: 0 });
});

test('accepts any top-level directory name (GitHub archives use repo-ref)', () => {
  const inventory = inventoryOf([file('repo-abc123/src/a.js', 'x')]);
  assert.equal(inventory.rootName, 'repo-abc123');
  assert.ok(inventory.files.has('src/a.js'));
});

test('rejects entries outside the single top-level directory instead of ignoring them', () => {
  for (const entries of [
    [file('package/a.js', 'x'), file('evil/payload.js', 'x')],
    [file('package/a.js', 'x'), file('top-level-file.js', 'x')],
    [file('top-level-file.js', 'x')],
  ]) {
    assert.throws(() => inventoryOf(entries), (error) => error instanceof ArchiveError && error.code === 'entry-outside-root');
  }
});

test('rejects an empty archive', () => {
  assert.throws(() => buildInventory({ entries: [] }, { limits: LIMITS }), { code: 'empty-archive' });
});

test('records links by target text and flags links that leave the package', () => {
  const inventory = inventoryOf([
    file('package/real.js', 'x'),
    file('package/ok-link', '', { type: '2', linkname: 'real.js' }),
    file('package/sub/up-link', '', { type: '2', linkname: '../real.js' }),
    file('package/escape', '', { type: '2', linkname: '../../outside' }),
    file('package/abs', '', { type: '2', linkname: '/etc/passwd' }),
    file('package/hard-ok', '', { type: '1', linkname: 'package/real.js' }),
    file('package/hard-bad', '', { type: '1', linkname: 'other/real.js' }),
  ]);
  const link = (path) => inventory.files.get(path);
  assert.equal(link('ok-link').type, 'symlink');
  assert.equal(link('ok-link').sha256, sha('real.js'));
  assert.equal(link('ok-link').data, null);
  assert.equal(link('ok-link').linkEscapes, false);
  assert.equal(link('sub/up-link').linkEscapes, false);
  assert.equal(link('escape').linkEscapes, true);
  assert.equal(link('abs').linkEscapes, true);
  assert.equal(link('hard-ok').type, 'hardlink');
  assert.equal(link('hard-ok').linkEscapes, false);
  assert.equal(link('hard-bad').linkEscapes, true);
  assert.equal(inventory.stats.symlinks, 4);
  assert.equal(inventory.stats.hardlinks, 2);
});

test('restricts a monorepo snapshot to the package directory and counts the rest', () => {
  const inventory = inventoryOf(
    [
      tarEntry({ name: 'repo-1/', type: '5' }),
      tarEntry({ name: 'repo-1/packages/core/', type: '5' }),
      file('repo-1/packages/core/package.json', '{}'),
      file('repo-1/packages/core/src/a.js', 'a'),
      file('repo-1/packages/other/b.js', 'b'),
      file('repo-1/package.json', '{}'),
      file('repo-1/packages/core-extra/c.js', 'c'),
    ],
    { directory: 'packages/core' },
  );
  assert.deepEqual([...inventory.files.keys()], ['package.json', 'src/a.js']);
  assert.equal(inventory.stats.outsideDirectory, 3);
});

test('keeps bytes only for small files and within the total budget', () => {
  const inventory = inventoryOf([
    file('package/small-a', 'a'.repeat(90)),
    file('package/small-b', 'b'.repeat(90)),
    file('package/small-c', 'c'.repeat(90)),
    file('package/big', 'd'.repeat(101)),
  ]);
  assert.equal(inventory.files.get('small-a').data.length, 90);
  assert.equal(inventory.files.get('small-b').data.length, 90);
  assert.equal(inventory.files.get('small-c').data, null, 'over the total retention budget');
  assert.equal(inventory.files.get('big').data, null, 'over the per-file retention limit');
  assert.equal(inventory.files.get('big').sha256, sha('d'.repeat(101)), 'dropped bytes are still hashed');
});

test('compare: identical, modified, package-only and source-only, sorted by path', () => {
  const packageInventory = inventoryOf([
    file('package/same.js', 'same'),
    file('package/changed.js', 'minified'),
    file('package/dist/index.js', 'built'),
    file('package/Z-last', 'z'),
  ]);
  const sourceInventory = inventoryOf([
    file('repo/same.js', 'same'),
    file('repo/changed.js', 'readable'),
    file('repo/src/index.ts', 'ts'),
  ]);
  const result = compareInventories(packageInventory, sourceInventory);
  assert.deepEqual(
    result.map(({ path, status }) => [path, status]),
    [
      ['Z-last', 'package-only'],
      ['changed.js', 'modified'],
      ['dist/index.js', 'package-only'],
      ['same.js', 'identical'],
      ['src/index.ts', 'source-only'],
    ],
  );
  const changed = result.find((r) => r.path === 'changed.js');
  assert.notEqual(changed.package.sha256, changed.source.sha256);
  assert.equal(result.find((r) => r.path === 'dist/index.js').source, null);
  assert.equal(result.find((r) => r.path === 'src/index.ts').package, null);
});

test('compare: a file replaced by a link (or a different link target) is a modification', () => {
  const packageInventory = inventoryOf([
    file('package/a', '', { type: '2', linkname: 'target-one' }),
    file('package/b', '', { type: '2', linkname: 'same-target' }),
    file('package/c', 'real file'),
  ]);
  const sourceInventory = inventoryOf([
    file('repo/a', '', { type: '2', linkname: 'target-two' }),
    file('repo/b', '', { type: '2', linkname: 'same-target' }),
    file('repo/c', '', { type: '2', linkname: 'real file' }),
  ]);
  const byPath = Object.fromEntries(compareInventories(packageInventory, sourceInventory).map((r) => [r.path, r.status]));
  assert.deepEqual(byPath, { a: 'modified', b: 'identical', c: 'modified' });
});

test('compare: is deterministic regardless of archive order', () => {
  const order1 = inventoryOf([file('p/a', '1'), file('p/b', '2'), file('p/c', '3')]);
  const order2 = inventoryOf([file('p/c', '3'), file('p/a', '1'), file('p/b', '2')]);
  const empty = inventoryOf([file('p/z', 'z')]);
  assert.deepEqual(
    compareInventories(order1, empty).map((r) => r.path),
    compareInventories(order2, empty).map((r) => r.path),
  );
});
