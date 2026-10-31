import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLED_REPORTS } from '../src/lib/examples.js';
import { MAX_UPLOAD_BYTES, checkUploadFile, getJob, getReport, runAnalysis, submitAnalysis } from '../src/lib/analysis-client.js';

const REPORT = BUNDLED_REPORTS.find((e) => e.id === 'tampered').report;
const file = (over = {}) => ({ name: 'debug-4.4.1.tgz', size: 1234, ...over });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const job = (state, extra = {}) => ({ id: 'a'.repeat(32), state, filename: 'debug-4.4.1.tgz', ai: false, progress: [], error: null, queuePosition: null, reportUrl: null, ...extra });
const noSleep = async () => {};

// A scripted fake server: each entry answers the next request to that route.
function fakeServer(script) {
  const calls = [];
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const fetchImpl = async (url, options = {}) => {
    const path = String(url).replace(/\?.*/, '').replace(/[0-9a-f]{32}/, ':id');
    const key = `${options.method ?? 'GET'} ${path}`;
    calls.push({ key, url: String(url), options });
    const next = queues[key]?.length > 1 ? queues[key].shift() : queues[key]?.[0];
    if (!next) throw new Error(`unscripted request: ${key}`);
    if (next instanceof Error) throw next;
    return next();
  };
  return { fetchImpl, calls };
}

test('upload selection: only plausible, non-empty, in-limit archives are submitted', () => {
  assert.equal(checkUploadFile(file()).ok, true);
  assert.equal(checkUploadFile(file({ name: 'PKG.TGZ' })).ok, true);
  assert.equal(checkUploadFile(file({ name: 'pkg.tar.gz' })).ok, true);
  assert.equal(checkUploadFile(file({ name: 'report.json' })).code, 'wrong-extension');
  assert.equal(checkUploadFile(file({ name: 'a.tgz.exe' })).code, 'wrong-extension');
  assert.equal(checkUploadFile(file({ size: 0 })).code, 'empty');
  assert.equal(checkUploadFile(file({ size: MAX_UPLOAD_BYTES + 1 })).code, 'too-large');
  assert.equal(checkUploadFile(file({ size: MAX_UPLOAD_BYTES })).ok, true);
  assert.equal(checkUploadFile(null).code, 'no-file');
  assert.equal(checkUploadFile({ name: 5, size: 1 }).code, 'no-file');
  assert.equal(checkUploadFile(file({ size: NaN })).code, 'empty');
});

test('submission sends only the bytes, a display filename and the AI flag', async () => {
  const server = fakeServer({ 'POST /api/analyze': [() => json(202, job('queued'))] });
  const result = await submitAnalysis({ file: file({ name: 'a b&c.tgz' }), ai: true, fetchImpl: server.fetchImpl });
  assert.equal(result.ok, true);
  const call = server.calls[0];
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers['Content-Type'], 'application/gzip');
  assert.match(call.url, /^\/api\/analyze\?filename=a\+b%26c\.tgz&ai=1$/);
  assert.ok(!call.url.includes('http'), 'only the same-origin API is used');
});

test('a full run: queued, running, completed, and the report passes validation', async () => {
  const server = fakeServer({
    'POST /api/analyze': [() => json(202, job('queued', { queuePosition: 1 }))],
    'GET /api/jobs/:id': [
      () => json(200, job('running', { progress: [{ at: 't', message: 'Fetching npm metadata for debug@4.4.1' }] })),
      () => json(200, job('completed', { reportUrl: '/x' })),
    ],
    'GET /api/jobs/:id/report': [() => json(200, REPORT)],
  });
  const seen = [];
  const result = await runAnalysis({ file: file(), fetchImpl: server.fetchImpl, sleep: noSleep, onUpdate: (u) => seen.push(`${u.phase}:${u.job?.state ?? '-'}`) });
  assert.equal(result.status, 'completed');
  assert.equal(result.report.summary.verdict, 'suspicious');
  assert.deepEqual(seen, ['uploading:-', 'job:queued', 'job:running', 'job:completed']);
  const polls = server.calls.filter((c) => c.key === 'GET /api/jobs/:id');
  assert.equal(polls.length, 2, 'polling stops at the terminal state');
  assert.equal(server.calls.at(-1).key, 'GET /api/jobs/:id/report');
});

test('a failed job is reported with the server\'s own message and stops polling', async () => {
  const server = fakeServer({
    'POST /api/analyze': [() => json(202, job('queued'))],
    'GET /api/jobs/:id': [() => json(200, job('failed', { error: { code: 'unidentifiable-tarball', message: 'The supplied tarball cannot be identified.' } }))],
  });
  const result = await runAnalysis({ file: file(), fetchImpl: server.fetchImpl, sleep: noSleep });
  assert.equal(result.status, 'failed');
  assert.equal(result.kind, 'analysis-failed');
  assert.equal(result.code, 'unidentifiable-tarball');
  assert.match(result.message, /cannot be identified/);
});

test('server refusals become specific, honest errors', async () => {
  const cases = [
    [429, { code: 'busy', error: 'The server is busy.' }, 'busy'],
    [413, { code: 'too-large', error: 'The upload is larger than the 25 MB limit.' }, 'too-large'],
    [400, { code: 'not-gzip', error: 'The upload is not a gzip-compressed archive.' }, 'rejected'],
    [500, { error: 'Internal server error' }, 'server'],
  ];
  for (const [status, body, kind] of cases) {
    const server = fakeServer({ 'POST /api/analyze': [() => json(status, body)] });
    const result = await runAnalysis({ file: file(), fetchImpl: server.fetchImpl, sleep: noSleep });
    assert.equal(result.status, 'failed');
    assert.equal(result.kind, kind, String(status));
    assert.equal(result.message, body.error);
  }
});

test('no server: a clear network error, never a fake running state', async () => {
  const seen = [];
  const result = await runAnalysis({ file: file(), fetchImpl: async () => { throw new TypeError('fetch failed'); }, sleep: noSleep, onUpdate: (u) => seen.push(u.phase) });
  assert.equal(result.status, 'failed');
  assert.equal(result.kind, 'network');
  assert.deepEqual(seen, ['uploading'], 'it never claimed a job exists');
});

test('a network blip while polling is retried; a long outage gives up honestly', async () => {
  const blip = fakeServer({
    'POST /api/analyze': [() => json(202, job('queued'))],
    'GET /api/jobs/:id': [new TypeError('fetch failed'), () => json(200, job('completed'))],
    'GET /api/jobs/:id/report': [() => json(200, REPORT)],
  });
  const messages = [];
  const recovered = await runAnalysis({ file: file(), fetchImpl: blip.fetchImpl, sleep: noSleep, onUpdate: (u) => u.message && messages.push(u.message) });
  assert.equal(recovered.status, 'completed');
  assert.match(messages[0], /Retrying \(1\/5\)/);

  const outage = fakeServer({
    'POST /api/analyze': [() => json(202, job('queued'))],
    'GET /api/jobs/:id': [new TypeError('fetch failed')],
  });
  const gaveUp = await runAnalysis({ file: file(), fetchImpl: outage.fetchImpl, sleep: noSleep });
  assert.equal(gaveUp.status, 'failed');
  assert.equal(gaveUp.kind, 'network');
  assert.match(gaveUp.message, /may still be running/);
  assert.equal(outage.calls.filter((c) => c.key === 'GET /api/jobs/:id').length, 5);
});

test('a server restart (job unknown) is explained and stops polling', async () => {
  const server = fakeServer({
    'POST /api/analyze': [() => json(202, job('queued'))],
    'GET /api/jobs/:id': [() => json(200, job('running')), () => json(404, { code: 'unknown-job', error: 'No such analysis job.' })],
  });
  const result = await runAnalysis({ file: file(), fetchImpl: server.fetchImpl, sleep: noSleep });
  assert.equal(result.status, 'failed');
  assert.equal(result.kind, 'lost');
  assert.match(result.message, /server restart/);
});

test('a completed job whose report fails validation is rejected, not displayed', async () => {
  const broken = structuredClone(REPORT);
  broken.summary.riskScore = 1;
  const server = fakeServer({
    'POST /api/analyze': [() => json(202, job('completed'))],
    'GET /api/jobs/:id/report': [() => json(200, broken)],
  });
  const result = await runAnalysis({ file: file(), fetchImpl: server.fetchImpl, sleep: noSleep });
  assert.equal(result.status, 'failed');
  assert.equal(result.kind, 'invalid-report');
  assert.ok(result.problems.length > 0);
  assert.equal(result.report, undefined);
});

test('an invalid file never reaches the network', async () => {
  const server = fakeServer({});
  const result = await runAnalysis({ file: file({ name: 'notes.txt' }), fetchImpl: server.fetchImpl, sleep: noSleep });
  assert.equal(result.status, 'failed');
  assert.equal(result.kind, 'wrong-extension');
  assert.equal(server.calls.length, 0);
});

test('stopping the watch aborts cleanly', async () => {
  const controller = new AbortController();
  const server = fakeServer({
    'POST /api/analyze': [() => json(202, job('queued'))],
    'GET /api/jobs/:id': [() => json(200, job('running'))],
  });
  const result = await runAnalysis({ file: file(), fetchImpl: server.fetchImpl, signal: controller.signal, sleep: async () => controller.abort() });
  assert.equal(result.status, 'aborted');
});

test('malformed server answers are handled', async () => {
  assert.equal((await getJob('x', { fetchImpl: async () => new Response('<html>', { status: 200 }) })).ok, false);
  assert.equal((await getReport('x', { fetchImpl: async () => new Response('nope', { status: 200 }) })).ok, false);
  assert.equal((await submitAnalysis({ file: file(), fetchImpl: async () => new Response('', { status: 202 }) })).ok, false);
});
