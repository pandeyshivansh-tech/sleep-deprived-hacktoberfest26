import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkIntegrity, fetchTarball, fetchVersionMetadata } from '../src/ecosystems/npm/registry.js';
import { FetchError, InputError } from '../src/errors.js';
import { DEFAULT_LIMITS } from '../src/limits.js';
import { makeFakeFetch } from '../test-support/fake-fetch.js';

const limits = DEFAULT_LIMITS;
const META_URL = 'https://registry.npmjs.org/debug/4.4.1';
const TARBALL_URL = 'https://registry.npmjs.org/debug/-/debug-4.4.1.tgz';
const bytes = Buffer.from('pretend this is a tarball');
const digest = (algorithm, data = bytes) => createHash(algorithm).update(data).digest('base64');

const meta = (extra = {}) => ({
  name: 'debug',
  version: '4.4.1',
  dist: { tarball: TARBALL_URL, integrity: `sha512-${digest('sha512')}` },
  ...extra,
});

test('fetches the exact version metadata', async () => {
  const { fetchImpl, urls } = makeFakeFetch({ [META_URL]: { body: meta({ gitHead: 'abc' }) } });
  const result = await fetchVersionMetadata({ name: 'debug', version: '4.4.1', fetchImpl, limits });
  assert.equal(result.gitHead, 'abc');
  assert.deepEqual(urls(), [META_URL]);
});

test('encodes scoped names in the request URL', async () => {
  const url = 'https://registry.npmjs.org/@babel%2Fcore/7.26.0';
  const { fetchImpl, urls } = makeFakeFetch({ [url]: { body: { name: '@babel/core', version: '7.26.0' } } });
  await fetchVersionMetadata({ name: '@babel/core', version: '7.26.0', fetchImpl, limits });
  assert.deepEqual(urls(), [url]);
});

test('rejects invalid specs before any request', async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  await assert.rejects(fetchVersionMetadata({ name: 'debug', version: '^4.0.0', fetchImpl, limits }), InputError);
  await assert.rejects(fetchVersionMetadata({ name: '../x', version: '1.0.0', fetchImpl, limits }), InputError);
  assert.equal(calls.length, 0);
});

test('reports an unknown version as a not-found input error', async () => {
  const { fetchImpl } = makeFakeFetch();
  await assert.rejects(fetchVersionMetadata({ name: 'debug', version: '4.4.1', fetchImpl, limits }), (error) => {
    assert.ok(error instanceof InputError);
    assert.equal(error.code, 'not-found');
    return true;
  });
});

test('rejects metadata that is invalid, oversized, or for a different package', async () => {
  for (const [body, code] of [
    ['not json', 'bad-metadata'],
    ['[]', 'bad-metadata'],
    [JSON.stringify({ name: 'other', version: '4.4.1' }), 'bad-metadata'],
    [JSON.stringify({ name: 'debug', version: '9.9.9' }), 'bad-metadata'],
  ]) {
    const { fetchImpl } = makeFakeFetch({ [META_URL]: { body } });
    await assert.rejects(fetchVersionMetadata({ name: 'debug', version: '4.4.1', fetchImpl, limits }), { code });
  }
  const { fetchImpl } = makeFakeFetch({ [META_URL]: { body: meta() } });
  const tiny = { ...limits, network: { ...limits.network, maxMetadataBytes: 10 } };
  await assert.rejects(fetchVersionMetadata({ name: 'debug', version: '4.4.1', fetchImpl, limits: tiny }), { code: 'too-large' });
});

test('downloads the tarball named in the metadata', async () => {
  const { fetchImpl } = makeFakeFetch({ [TARBALL_URL]: { body: bytes } });
  const result = await fetchTarball({ metadata: meta(), fetchImpl, limits });
  assert.equal(result.url, TARBALL_URL);
  assert.deepEqual(result.bytes, bytes);
});

test('never fetches a tarball from a host outside the allowlist', async () => {
  const evil = 'https://evil.example.com/debug-4.4.1.tgz';
  const { fetchImpl, calls } = makeFakeFetch({ [evil]: { body: 'payload' } });
  await assert.rejects(
    fetchTarball({ metadata: meta({ dist: { tarball: evil } }), fetchImpl, limits }),
    (error) => error instanceof FetchError && error.code === 'disallowed-host',
  );
  assert.equal(calls.length, 0);
  await assert.rejects(fetchTarball({ metadata: { name: 'debug', version: '4.4.1', dist: {} }, fetchImpl, limits }), { code: 'bad-metadata' });
});

test('integrity: verifies a matching sha512', () => {
  const result = checkIntegrity(meta(), bytes);
  assert.equal(result.verified, true);
  assert.equal(result.expected, result.actual);
  assert.match(result.actual, /^sha512-/);
  assert.deepEqual(result.notes, []);
});

test('integrity: a tampered tarball is reported as not verified', () => {
  const result = checkIntegrity(meta(), Buffer.concat([bytes, Buffer.from(' + injected code')]));
  assert.equal(result.verified, false);
  assert.notEqual(result.expected, result.actual);
});

test('integrity: prefers the strongest algorithm when several are listed', () => {
  const integrity = `sha1-${digest('sha1')} sha256-${digest('sha256')} sha512-${digest('sha512')}`;
  const result = checkIntegrity(meta({ dist: { integrity } }), bytes);
  assert.match(result.expected, /^sha512-/);
  assert.equal(result.verified, true);
});

test('integrity: ignores unsupported algorithms and malformed tokens', () => {
  const integrity = `md5-${digest('md5')} garbage sha512-${digest('sha512')}`;
  assert.equal(checkIntegrity(meta({ dist: { integrity } }), bytes).verified, true);
});

test('integrity: falls back to the sha1 shasum and says it is weak', () => {
  const shasum = createHash('sha1').update(bytes).digest('hex');
  const ok = checkIntegrity({ dist: { shasum } }, bytes);
  assert.equal(ok.verified, true);
  assert.match(ok.expected, /^sha1-/);
  assert.match(ok.notes[0], /SHA-1/);
  assert.equal(checkIntegrity({ dist: { shasum } }, Buffer.from('other')).verified, false);
});

test('integrity: with no checksum at all it cannot be verified', () => {
  const result = checkIntegrity({ dist: {} }, bytes);
  assert.equal(result.verified, false);
  assert.equal(result.expected, null);
  assert.match(result.notes[0], /no checksum/);
  assert.match(result.actual, /^sha512-/);
});
