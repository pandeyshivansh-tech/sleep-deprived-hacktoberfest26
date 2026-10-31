import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSource } from '../src/source/resolve.js';
import { DEFAULT_LIMITS } from '../src/limits.js';
import { buildTar, gz, tarEntry } from '../test-support/tar-builder.js';
import { makeFakeFetch } from '../test-support/fake-fetch.js';
import { makeSourceTarball } from '../test-support/tar-builder.js';

const SHA = '33330fa8616b9b33f29f7674747be77266878ba6';
const REPO = 'https://github.com/debug-js/debug';
const code = (ref) => `https://codeload.github.com/debug-js/debug/tar.gz/${ref}`;
const pkgJson = (extra = {}) => JSON.stringify({ name: 'debug', version: '4.4.1', ...extra });
const metadata = (extra = {}) => ({ name: 'debug', version: '4.4.1', repository: { url: 'git://github.com/debug-js/debug.git' }, ...extra });
const resolve = (fetchImpl, meta = metadata(), name = 'debug', version = '4.4.1', limits = DEFAULT_LIMITS) =>
  resolveSource({ metadata: meta, name, version, fetchImpl, limits });

test('resolves the exact commit npm recorded (gitHead)', async () => {
  const { fetchImpl, urls } = makeFakeFetch({
    [code(SHA)]: { body: makeSourceTarball({ 'package.json': pkgJson(), 'src/index.js': 'x' }, { commit: SHA }) },
  });
  const result = await resolve(fetchImpl, metadata({ gitHead: SHA }));
  assert.equal(result.resolved, true);
  assert.equal(result.confidence, 'exact-commit');
  assert.deepEqual(result.ref, { type: 'gitHead', value: SHA, commit: SHA });
  assert.equal(result.repository, REPO);
  assert.deepEqual([...result.inventory.files.keys()].sort(), ['package.json', 'src/index.js']);
  assert.match(result.notes.join(' '), /exact commit that npm recorded/);
  assert.match(result.notes.join(' '), /name matches/);
  assert.match(result.notes.join(' '), /version matches/);
  assert.deepEqual(urls(), [code(SHA)], 'no tag lookups are needed when gitHead works');
});

test('falls back to a version tag when npm recorded no gitHead, reading the commit from the archive', async () => {
  const { fetchImpl, urls } = makeFakeFetch({
    [code('refs/tags/v4.4.1')]: { status: 404 },
    [code('refs/tags/4.4.1')]: { body: makeSourceTarball({ 'package.json': pkgJson() }, { commit: SHA }) },
  });
  const result = await resolve(fetchImpl);
  assert.equal(result.resolved, true);
  assert.equal(result.confidence, 'tag');
  assert.deepEqual(result.ref, { type: 'tag', value: '4.4.1', commit: SHA });
  assert.match(result.notes.join(' '), /no gitHead/);
  assert.match(result.notes.join(' '), /not proof/);
  assert.deepEqual(urls(), [code('refs/tags/v4.4.1'), code('refs/tags/4.4.1')]);
});

test('falls back to a tag when the recorded gitHead is not in the repository', async () => {
  const { fetchImpl } = makeFakeFetch({
    [code('refs/tags/v4.4.1')]: { body: makeSourceTarball({ 'package.json': pkgJson() }, { commit: SHA }) },
  });
  const result = await resolve(fetchImpl, metadata({ gitHead: 'f'.repeat(40) }));
  assert.equal(result.confidence, 'tag');
  assert.match(result.notes.join(' '), /gitHead could not be used/);
});

test('ignores a malformed gitHead rather than putting it in a URL', async () => {
  const { fetchImpl, urls } = makeFakeFetch({
    [code('refs/tags/v4.4.1')]: { body: makeSourceTarball({ 'package.json': pkgJson() }) },
  });
  const result = await resolve(fetchImpl, metadata({ gitHead: '../../evil' }));
  assert.equal(result.resolved, true);
  assert.ok(urls().every((url) => !url.includes('evil')));
  assert.equal(result.ref.commit, null, 'no commit is claimed when it cannot be established');
});

test('tries scoped monorepo tag names and compares only the package directory', async () => {
  const url = 'https://codeload.github.com/o/mono/tar.gz/refs/tags/@scope/pkg@1.0.0';
  const files = {
    'packages/pkg/package.json': JSON.stringify({ name: '@scope/pkg', version: '1.0.0' }),
    'packages/pkg/src/a.js': 'a',
    'packages/other/b.js': 'b',
    'package.json': JSON.stringify({ name: 'mono-root' }),
  };
  const { fetchImpl, urls } = makeFakeFetch({ [url]: { body: makeSourceTarball(files, { commit: SHA }) } });
  const result = await resolveSource({
    metadata: { repository: { url: 'https://github.com/o/mono', directory: 'packages/pkg' } },
    name: '@scope/pkg',
    version: '1.0.0',
    fetchImpl,
    limits: DEFAULT_LIMITS,
  });
  assert.equal(result.resolved, true);
  assert.equal(result.directory, 'packages/pkg');
  assert.deepEqual([...result.inventory.files.keys()].sort(), ['package.json', 'src/a.js']);
  assert.ok(urls().includes(url));
  assert.match(result.notes.join(' '), /subdirectory "packages\/pkg"/);
});

test('refuses a snapshot whose package.json names a different package', async () => {
  const { fetchImpl } = makeFakeFetch({
    [code(SHA)]: { body: makeSourceTarball({ 'package.json': JSON.stringify({ name: 'something-else', version: '4.4.1' }) }) },
  });
  const result = await resolve(fetchImpl, metadata({ gitHead: SHA }));
  assert.equal(result.resolved, false);
  assert.equal(result.confidence, 'unresolved');
  assert.equal(result.inventory, null);
  assert.match(result.notes.join(' '), /is named "something-else", not "debug"/);
});

test('refuses a snapshot with a missing or unreadable package.json', async () => {
  const noManifest = makeFakeFetch({ [code(SHA)]: { body: makeSourceTarball({ 'README.md': 'x' }) } });
  assert.equal((await resolve(noManifest.fetchImpl, metadata({ gitHead: SHA }))).resolved, false);

  const badManifest = makeFakeFetch({ [code(SHA)]: { body: makeSourceTarball({ 'package.json': '{ nope' }) } });
  const result = await resolve(badManifest.fetchImpl, metadata({ gitHead: SHA }));
  assert.equal(result.resolved, false);
  assert.match(result.notes.join(' '), /could not be verified/);
});

test('accepts a version difference but says so', async () => {
  const { fetchImpl } = makeFakeFetch({
    [code(SHA)]: { body: makeSourceTarball({ 'package.json': pkgJson({ version: '0.0.0-development' }) }) },
  });
  const result = await resolve(fetchImpl, metadata({ gitHead: SHA }));
  assert.equal(result.resolved, true);
  assert.match(result.notes.join(' '), /"0\.0\.0-development", not "4\.4\.1"/);
});

test('is unresolved, not clean, when no ref exists', async () => {
  const { fetchImpl } = makeFakeFetch();
  const result = await resolve(fetchImpl, metadata({ gitHead: SHA }));
  assert.equal(result.resolved, false);
  assert.equal(result.confidence, 'unresolved');
  assert.deepEqual(result.ref, { type: 'none', value: null, commit: null });
  assert.equal(result.repository, REPO);
  assert.match(result.notes[0], /No matching source snapshot/);
  assert.match(result.notes[0], /gitHead 33330fa8616b: not found/);
  assert.match(result.notes[0], /tag "v4\.4\.1": not found/);
});

test('is unresolved for unsupported hosts and missing repositories, without any request', async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  const gitlab = await resolve(fetchImpl, metadata({ repository: { url: 'https://gitlab.com/a/b' } }));
  assert.equal(gitlab.resolved, false);
  assert.match(gitlab.notes[0], /Only GitHub/);
  const none = await resolve(fetchImpl, { name: 'debug', version: '4.4.1' });
  assert.match(none.notes[0], /no repository field/);
  assert.equal(calls.length, 0);
});

test('a rejected or oversized source archive makes the source unresolved with the reason', async () => {
  const traversal = gz(buildTar([tarEntry({ name: 'repo/../../evil' }, 'x')]));
  const hostile = makeFakeFetch({ [code(SHA)]: { body: traversal } });
  const result = await resolve(hostile.fetchImpl, metadata({ gitHead: SHA }));
  assert.equal(result.resolved, false);
  assert.match(result.notes.join(' '), /was rejected: .*escapes its root/);
  assert.equal(hostile.calls.length, 1, 'a hostile archive stops resolution immediately');

  const big = makeFakeFetch({ [code(SHA)]: { body: makeSourceTarball({ 'package.json': pkgJson() }) } });
  const tiny = { ...DEFAULT_LIMITS, source: { ...DEFAULT_LIMITS.source, maxCompressedBytes: 10 } };
  const tooBig = await resolve(big.fetchImpl, metadata({ gitHead: SHA }), 'debug', '4.4.1', tiny);
  assert.equal(tooBig.resolved, false);
  assert.match(tooBig.notes.join(' '), /larger than the 10 byte limit/);
});

test('a network failure is reported as unresolved, not as a clean result', async () => {
  const { fetchImpl } = makeFakeFetch({ [code(SHA)]: new TypeError('fetch failed') });
  const result = await resolve(fetchImpl, metadata({ gitHead: SHA }));
  assert.equal(result.resolved, false);
  assert.match(result.notes.join(' '), /Could not download the source archive/);
});
