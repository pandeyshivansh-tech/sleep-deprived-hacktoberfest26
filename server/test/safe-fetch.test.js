import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeFetchBuffer } from '../src/net/safe-fetch.js';
import { FetchError } from '../src/errors.js';
import { makeFakeFetch } from '../test-support/fake-fetch.js';

const OK = 'https://registry.npmjs.org/x';

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof FetchError, `expected FetchError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('fetches an allowed HTTPS URL and returns its bytes', async () => {
  const { fetchImpl, urls } = makeFakeFetch({ [OK]: { body: 'hello' } });
  const body = await safeFetchBuffer(OK, { fetchImpl, maxBytes: 100 });
  assert.equal(body.toString(), 'hello');
  assert.deepEqual(urls(), [OK]);
});

test('refuses non-HTTPS, credentialed, custom-port and disallowed hosts before any request', async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  await rejects(safeFetchBuffer('http://registry.npmjs.org/x', { fetchImpl, maxBytes: 10 }), 'bad-url');
  await rejects(safeFetchBuffer('https://user:pw@registry.npmjs.org/x', { fetchImpl, maxBytes: 10 }), 'bad-url');
  await rejects(safeFetchBuffer('https://registry.npmjs.org:8443/x', { fetchImpl, maxBytes: 10 }), 'bad-url');
  await rejects(safeFetchBuffer('https://evil.example.com/x', { fetchImpl, maxBytes: 10 }), 'disallowed-host');
  await rejects(safeFetchBuffer('https://registry.npmjs.org.evil.com/x', { fetchImpl, maxBytes: 10 }), 'disallowed-host');
  await rejects(safeFetchBuffer('not a url', { fetchImpl, maxBytes: 10 }), 'bad-url');
  assert.equal(calls.length, 0);
});

test('follows redirects only to allowed hosts and re-checks every hop', async () => {
  const { fetchImpl, urls } = makeFakeFetch({
    'https://github.com/o/r/archive/x.tar.gz': { status: 302, headers: { location: 'https://codeload.github.com/o/r/tar.gz/x' } },
    'https://codeload.github.com/o/r/tar.gz/x': { body: 'archive' },
    [OK]: { status: 302, headers: { location: 'https://evil.example.com/steal' } },
  });
  const body = await safeFetchBuffer('https://github.com/o/r/archive/x.tar.gz', { fetchImpl, maxBytes: 100 });
  assert.equal(body.toString(), 'archive');

  await rejects(safeFetchBuffer(OK, { fetchImpl, maxBytes: 100 }), 'disallowed-host');
  assert.ok(!urls().includes('https://evil.example.com/steal'), 'the disallowed redirect target must never be requested');
});

test('refuses a redirect to plain HTTP and a redirect loop', async () => {
  const { fetchImpl } = makeFakeFetch({
    [OK]: { status: 301, headers: { location: 'http://registry.npmjs.org/x' } },
    'https://registry.npmjs.org/loop': { status: 302, headers: { location: '/loop' } },
  });
  await rejects(safeFetchBuffer(OK, { fetchImpl, maxBytes: 100 }), 'bad-url');
  await rejects(safeFetchBuffer('https://registry.npmjs.org/loop', { fetchImpl, maxBytes: 100 }), 'too-many-redirects');
});

test('reports a redirect with no location', async () => {
  const { fetchImpl } = makeFakeFetch({ [OK]: { status: 302 } });
  await rejects(safeFetchBuffer(OK, { fetchImpl, maxBytes: 100 }), 'bad-redirect');
});

test('enforces the size limit from content-length and while streaming', async () => {
  const { fetchImpl } = makeFakeFetch({
    [OK]: { body: 'x'.repeat(50) },
    'https://registry.npmjs.org/declared': { body: 'x', headers: { 'content-length': '5000' } },
    'https://registry.npmjs.org/chunked': () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(60));
            controller.enqueue(new Uint8Array(60));
            controller.close();
          },
        }),
        { status: 200 },
      ),
  });
  await rejects(safeFetchBuffer(OK, { fetchImpl, maxBytes: 10 }), 'too-large');
  await rejects(safeFetchBuffer('https://registry.npmjs.org/declared', { fetchImpl, maxBytes: 100 }), 'too-large');
  await rejects(safeFetchBuffer('https://registry.npmjs.org/chunked', { fetchImpl, maxBytes: 100 }), 'too-large');
  assert.equal((await safeFetchBuffer(OK, { fetchImpl, maxBytes: 50 })).length, 50);
});

test('exposes the HTTP status on non-2xx responses', async () => {
  const { fetchImpl } = makeFakeFetch();
  await assert.rejects(safeFetchBuffer(OK, { fetchImpl, maxBytes: 100 }), (error) => {
    assert.equal(error.code, 'http');
    assert.equal(error.details.status, 404);
    return true;
  });
});

test('maps network failures and timeouts to FetchError', async () => {
  const down = makeFakeFetch({ [OK]: new TypeError('fetch failed') });
  await rejects(safeFetchBuffer(OK, { fetchImpl: down.fetchImpl, maxBytes: 100 }), 'network');

  const timeout = makeFakeFetch({ [OK]: new DOMException('timed out', 'TimeoutError') });
  await rejects(safeFetchBuffer(OK, { fetchImpl: timeout.fetchImpl, maxBytes: 100 }), 'timeout');
});

test('requires an explicit size limit', async () => {
  const { fetchImpl } = makeFakeFetch({ [OK]: { body: 'x' } });
  await assert.rejects(safeFetchBuffer(OK, { fetchImpl }), TypeError);
});
