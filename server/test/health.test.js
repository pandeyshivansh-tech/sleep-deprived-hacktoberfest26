import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { getHealth } from '../src/health.js';

const BASE_URL = 'http://127.0.0.1:11434';

// Records every URL requested so tests can prove the health check only lists
// models and never asks Ollama to load one or run inference.
function fakeFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(String(url));
    return respond(String(url), options);
  };
  return { fetchImpl, calls };
}

const tagsResponse = (models) => new Response(JSON.stringify({ models }), { status: 200 });

test('reports both models installed when Ollama lists them', async () => {
  const { fetchImpl, calls } = fakeFetch(() =>
    tagsResponse([
      { name: 'gemma4:e4b', digest: 'aaa' },
      { name: 'deepseek-r1:8b', digest: 'bbb' },
      { name: 'some-other-model:latest', digest: 'ccc' },
    ]),
  );
  const health = await getHealth({ ollamaBaseUrl: BASE_URL, fetchImpl, version: 'test' });

  assert.equal(health.status, 'ok');
  assert.equal(health.ollama.reachable, true);
  assert.equal(health.ollama.error, null);
  assert.deepEqual(
    health.models.map(({ name, installed, digest }) => ({ name, installed, digest })),
    [
      { name: 'gemma4:e4b', installed: true, digest: 'aaa' },
      { name: 'deepseek-r1:8b', installed: true, digest: 'bbb' },
    ],
  );
  assert.equal(health.ai.ready, true);
  assert.deepEqual(calls, [`${BASE_URL}/api/tags`]);
});

test('reports a missing model separately from connectivity', async () => {
  const { fetchImpl } = fakeFetch(() => tagsResponse([{ name: 'gemma4:e4b', digest: 'aaa' }]));
  const health = await getHealth({ ollamaBaseUrl: BASE_URL, fetchImpl, version: 'test' });

  assert.equal(health.ollama.reachable, true);
  assert.equal(health.models.find((m) => m.name === 'gemma4:e4b').installed, true);
  assert.equal(health.models.find((m) => m.name === 'deepseek-r1:8b').installed, false);
  assert.equal(health.ai.ready, false);
});

test('requires the exact model tag and accepts the "model" field', async () => {
  const { fetchImpl } = fakeFetch(() =>
    tagsResponse([{ name: 'gemma4:e2b' }, { model: 'deepseek-r1:8b' }]),
  );
  const health = await getHealth({ ollamaBaseUrl: BASE_URL, fetchImpl, version: 'test' });
  assert.deepEqual(health.models.map((m) => m.installed), [false, true]);
});

test('stays healthy with unknown model status when Ollama is unreachable', async () => {
  const { fetchImpl } = fakeFetch(() => {
    throw new TypeError('fetch failed');
  });
  const health = await getHealth({ ollamaBaseUrl: BASE_URL, fetchImpl, version: 'test' });

  assert.equal(health.status, 'ok');
  assert.equal(health.ollama.reachable, false);
  assert.match(health.ollama.error, /Could not connect to Ollama: fetch failed/);
  assert.deepEqual(health.models.map((m) => m.installed), [null, null]);
  assert.equal(health.ai.ready, false);
});

test('reports a timeout clearly', async () => {
  const { fetchImpl } = fakeFetch(() => {
    throw new DOMException('The operation timed out.', 'TimeoutError');
  });
  const health = await getHealth({ ollamaBaseUrl: BASE_URL, fetchImpl, version: 'test' });
  assert.match(health.ollama.error, /timed out/);
});

test('treats HTTP errors and malformed bodies as unreachable', async () => {
  for (const response of [
    new Response('boom', { status: 500 }),
    new Response('not json', { status: 200 }),
    new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
  ]) {
    const { fetchImpl } = fakeFetch(() => response);
    const health = await getHealth({ ollamaBaseUrl: BASE_URL, fetchImpl, version: 'test' });
    assert.equal(health.ollama.reachable, false);
    assert.equal(typeof health.ollama.error, 'string');
    assert.deepEqual(health.models.map((m) => m.installed), [null, null]);
  }
});

test('GET /api/health serves the health report over HTTP', async (t) => {
  const { fetchImpl } = fakeFetch(() => tagsResponse([{ name: 'gemma4:e4b' }]));
  const server = createApp({ ollamaBaseUrl: BASE_URL, fetchImpl }).listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-powered-by'), null);
  const body = await response.json();
  assert.equal(body.service, 'audyssey-server');
  assert.equal(body.ollama.reachable, true);
  assert.deepEqual(body.models.map((m) => m.installed), [true, false]);

  const missing = await fetch(`http://127.0.0.1:${port}/api/does-not-exist`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Not found' });
});
