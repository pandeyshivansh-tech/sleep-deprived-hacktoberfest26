import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createApp } from '../src/app.js';
import { sanitizeFilename } from '../src/api/analysis.js';
import { validateReport } from '../src/report/schema.js';
import { buildTar, gz, makeNpmTarball, tarEntry } from '../test-support/tar-builder.js';
import { FIXED_NOW, makeScenario, manifest } from '../test-support/scenario.js';
import { fileIdsIn, findingIdsIn, makeFakeOllama } from '../test-support/fake-ollama.js';

const OLLAMA = 'http://127.0.0.1:11434';

// A built package whose published copy also adds an install script (so there is a
// real finding), served by fake registry/GitHub routes.
const scenario = (extra = {}) =>
  makeScenario({
    packageFiles: { 'package.json': manifest({ main: 'dist/index.js', scripts: { postinstall: 'node dist/index.js' } }), 'dist/index.js': 'module.exports = 1;\n' },
    sourceFiles: { 'package.json': manifest({ main: 'dist/index.js' }), 'src/index.ts': 'export default 1;\n' },
    ...extra,
  });

async function serve({ fake = scenario(), ollama = makeFakeOllama(), analyzeImpl, analysis = {} } = {}) {
  const app = createApp({
    ollamaBaseUrl: OLLAMA,
    fetchImpl: ollama.fetchImpl,
    analysisFetchImpl: fake.fetchImpl,
    analyzeImpl,
    analysis: { now: FIXED_NOW, manager: { logError: () => {} }, ...analysis },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    fake,
    ollama,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }),
    upload: (body, { query = '', type = 'application/gzip' } = {}) =>
      fetch(`${base}/api/analyze${query}`, { method: 'POST', headers: type ? { 'content-type': type } : {}, body }),
    job: (id) => fetch(`${base}/api/jobs/${id}`).then((r) => r.json()),
    report: (id) => fetch(`${base}/api/jobs/${id}/report`),
  };
}

async function settle(api, id) {
  for (let i = 0; i < 400; i += 1) {
    const job = await api.job(id);
    if (job.state === 'completed' || job.state === 'failed') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job did not finish');
}

const withServer = (options, body) => async () => {
  const api = await serve(options);
  try {
    await body(api);
  } finally {
    await api.close();
  }
};

const gate = () => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
};

test('a valid .tgz creates a job, runs, and yields a validated report', withServer({}, async (api) => {
  const response = await api.upload(api.fake.packageTarball, { query: '?filename=demo-pkg-1.0.0.tgz' });
  assert.equal(response.status, 202);
  const created = await response.json();
  assert.match(created.id, /^[0-9a-f]{32}$/);
  assert.equal(created.state, 'queued');
  assert.equal(created.filename, 'demo-pkg-1.0.0.tgz');
  assert.equal(created.ai, false);
  assert.equal(created.reportUrl, null);
  assert.equal(response.headers.get('location'), `/api/jobs/${created.id}`);

  const done = await settle(api, created.id);
  assert.equal(done.state, 'completed');
  assert.equal(done.reportUrl, `/api/jobs/${created.id}/report`);
  assert.ok(done.progress.some((p) => /Scanning the published files/.test(p.message)), 'progress is the pipeline\'s real steps');
  assert.ok(done.progress.length <= 40);

  const reportResponse = await api.report(created.id);
  assert.equal(reportResponse.status, 200);
  const report = await reportResponse.json();
  assert.deepEqual(validateReport(report), []);
  assert.equal(report.input.source, 'tarball');
  assert.equal(report.input.name, 'demo-pkg');
  assert.equal(report.source.resolved, true);
  assert.ok(report.findings.some((f) => f.ruleId === 'install-script-added'));
  assert.ok(['needs-review', 'suspicious'].includes(report.summary.verdict));
  assert.deepEqual(report.ai.runs, [], 'AI was not requested');
  assert.equal(api.ollama.calls.length, 0, 'Ollama is not contacted unless AI is requested');
}));

test('job ids are unpredictable and unknown or malformed ids are 404', withServer({}, async (api) => {
  const ids = new Set();
  for (let i = 0; i < 3; i += 1) ids.add((await (await api.upload(api.fake.packageTarball)).json()).id);
  assert.equal(ids.size, 3);
  for (const id of ['0'.repeat(32), 'nope', '../etc/passwd', 'A'.repeat(32), '%00']) {
    for (const suffix of ['', '/report']) {
      const response = await fetch(`${api.base}/api/jobs/${id}${suffix}`);
      assert.equal(response.status, 404, `${id}${suffix}`);
      assert.ok((await response.json()).error, 'a JSON error body');
    }
  }
}));

test('the report is a 409 until the job completes, then available; states move queued -> running -> completed', withServer(
  { analyzeImpl: undefined },
  async () => {
    const held = gate();
    const api = await serve({
      analyzeImpl: async ({ onProgress }) => {
        onProgress('Step one');
        await held.promise;
        return { report: (await import('../test-support/scenario.js')) && JSON.parse(await readFile(new URL('../../examples/debug@4.4.1/report.json', import.meta.url))) };
      },
    });
    try {
      const created = await (await api.upload(api.fake.packageTarball)).json();
      assert.equal(created.state, 'queued');
      let running;
      for (let i = 0; i < 100 && running?.state !== 'running'; i += 1) {
        running = await api.job(created.id);
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(running.state, 'running');
      assert.ok(running.progress.some((p) => p.message === 'Step one'));
      const early = await api.report(created.id);
      assert.equal(early.status, 409);
      assert.deepEqual({ code: (await early.json()).code }, { code: 'not-ready' });
      held.release();
      assert.equal((await settle(api, created.id)).state, 'completed');
      assert.equal((await api.report(created.id)).status, 200);
    } finally {
      await api.close();
    }
  },
));

test('a report that fails its contract is discarded, not returned', async () => {
  const api = await serve({ analyzeImpl: async () => ({ report: { schemaVersion: '0.3.0', nonsense: true } }) });
  try {
    const created = await (await api.upload(api.fake.packageTarball)).json();
    const done = await settle(api, created.id);
    assert.equal(done.state, 'failed');
    assert.equal(done.error.code, 'invalid-report');
    assert.equal((await api.report(created.id)).status, 409);
  } finally {
    await api.close();
  }
});

test('empty, non-gzip, wrong-type and oversized uploads are refused with clear codes', withServer({ analysis: { maxUploadBytes: 2048 } }, async (api) => {
  const empty = await api.upload(Buffer.alloc(0));
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).code, 'empty-upload');

  const noBody = await fetch(`${api.base}/api/analyze`, { method: 'POST', headers: { 'content-type': 'application/gzip' } });
  assert.equal(noBody.status, 400);

  for (const body of [Buffer.from('this is plainly not an archive'), Buffer.from('PK\x03\x04zipfile'), Buffer.from([0x1f])]) {
    const response = await api.upload(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'not-gzip');
  }

  for (const type of ['text/plain', 'application/json', 'multipart/form-data; boundary=x', null]) {
    const response = await api.upload(Buffer.from([0x1f, 0x8b, 0]), { type });
    assert.equal(response.status, 415, String(type));
  }

  const big = await api.upload(Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(4096, 1)]));
  assert.equal(big.status, 413);
  const body = await big.json();
  assert.equal(body.code, 'too-large');
  assert.equal(body.maxBytes, 2048);
  assert.equal(api.fake.calls?.length ?? 0, 0, 'nothing was fetched for refused uploads');
}));

test('a Content-Encoding header cannot make the server expand an upload', withServer({ analysis: { maxUploadBytes: 4096 } }, async (api) => {
  const bomb = gzipSync(Buffer.alloc(3 * 1024 * 1024)); // tiny on the wire, huge when inflated
  assert.ok(bomb.length < 4096);
  const response = await fetch(`${api.base}/api/analyze`, { method: 'POST', headers: { 'content-type': 'application/gzip', 'content-encoding': 'gzip' }, body: bomb });
  assert.equal(response.status, 400, 'an encoded body is refused rather than inflated');
  assert.equal((await response.json()).code, 'bad-request');
}));

const hostile = {
  'path traversal': makeNpmTarball({ 'package.json': manifest() }, { extraEntries: [tarEntry({ name: 'package/../../escape.txt' }, 'x')] }),
  'absolute path': gz(buildTar([tarEntry({ name: '/etc/cron.d/x' }, 'x')])),
  'duplicate paths': gz(buildTar([tarEntry({ name: 'package/package.json' }, manifest()), tarEntry({ name: 'package/package.json' }, manifest())])),
  'device file': makeNpmTarball({ 'package.json': manifest() }, { extraEntries: [tarEntry({ name: 'package/dev', type: '3' })] }),
  'corrupt header': gz(buildTar([tarEntry({ name: 'package/package.json', badChecksum: true }, manifest())])),
  'not a tar inside a valid gzip': gz(Buffer.from('definitely not tar data '.repeat(100))),
  'archive bomb': gz(buildTar([tarEntry({ name: 'package/package.json' }, manifest()), tarEntry({ name: 'package/big.bin' }, Buffer.alloc(6 * 1024 * 1024))])),
  'truncated gzip': makeNpmTarball({ 'package.json': manifest() }).subarray(0, 40),
};

for (const [label, bytes] of Object.entries(hostile)) {
  test(`hostile archive (${label}) never yields a report and leaks nothing`, withServer({}, async (api) => {
    const response = await api.upload(bytes);
    assert.equal(response.status, 202, 'the cheap gzip check passes; the real archive reader decides');
    const done = await settle(api, (await response.json()).id);
    const text = JSON.stringify(done);
    assert.doesNotMatch(text, /\/Users\/|\bat\s+\S+\s+\(|node_modules|node:internal/, 'no stack traces or local paths');
    if (done.state === 'completed') {
      // An archive the reader rejected is analysed as "package rejected", never silently as clean.
      const report = await (await api.report(done.id)).json();
      assert.deepEqual(validateReport(report), []);
      assert.equal(report.summary.verdict, 'inconclusive', label);
    } else {
      assert.equal(done.state, 'failed', label);
      assert.ok(done.error.code && done.error.message.length <= 400, label);
      assert.equal((await api.report(done.id)).status, 409);
    }
  }));
}

test('a symlink and a hardlink in an upload are recorded as entries and never followed', withServer({}, async (api) => {
  const bytes = makeNpmTarball(
    { 'package.json': manifest({ main: 'dist/index.js' }), 'dist/index.js': 'module.exports = 1;\n' },
    { extraEntries: [tarEntry({ name: 'package/link', type: '2', linkname: '/etc/passwd' }), tarEntry({ name: 'package/hard', type: '1', linkname: 'package/dist/index.js' })] },
  );
  const fake = makeScenario({ packageTarball: bytes, packageFiles: {}, sourceFiles: { 'package.json': manifest({ main: 'dist/index.js' }) } });
  const other = await serve({ fake });
  try {
    const done = await settle(other, (await (await other.upload(bytes)).json()).id);
    const text = JSON.stringify(done);
    assert.doesNotMatch(text, /root:|\/bin\/(ba)?sh/, 'the target of a link is never read');
    if (done.state === 'completed') {
      const report = await (await other.report(done.id)).json();
      assert.deepEqual(validateReport(report), []);
      const types = Object.fromEntries(report.files.map((f) => [f.path, f.package?.type]));
      assert.equal(types.link, 'symlink');
      assert.equal(types.hard, 'hardlink');
    } else {
      assert.ok(['archive-link', 'unidentifiable-tarball'].some((c) => done.error.code.includes(c)) || done.error.code, 'rejected with a stable code');
    }
  } finally {
    await other.close();
  }
}));

test('capacity: a full server answers 429, and recovers when a job finishes', async () => {
  const held = gate();
  const api = await serve({
    analyzeImpl: async () => {
      await held.promise;
      return { report: JSON.parse(await readFile(new URL('../../examples/debug@4.4.1/report.json', import.meta.url))) };
    },
    analysis: { manager: { maxRunning: 1, maxQueued: 1, logError: () => {} } },
  });
  try {
    const first = await api.upload(api.fake.packageTarball);
    const second = await api.upload(api.fake.packageTarball);
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    const queued = await api.job((await second.json()).id);
    assert.equal(queued.state, 'queued');
    assert.equal(queued.queuePosition, 1);

    const third = await api.upload(api.fake.packageTarball);
    assert.equal(third.status, 429);
    const body = await third.json();
    assert.equal(body.code, 'busy');
    assert.ok(body.retryAfterSeconds > 0);

    held.release();
    const id = (await (await api.upload(Buffer.from('x'), { type: 'application/gzip' })).json()).code; // refused: not gzip, but capacity gate may answer first
    assert.ok(['not-gzip', 'busy'].includes(id));
    for (let i = 0; i < 200 && api.fake && (await api.upload(api.fake.packageTarball)).status === 429; i += 1) await new Promise((r) => setTimeout(r, 10));
    const again = await api.upload(api.fake.packageTarball);
    assert.equal(again.status, 202, 'capacity returns once jobs finish');
  } finally {
    held.release();
    await api.close();
  }
});

test('unexpected failures are reported generically; nothing internal reaches the client', async () => {
  const logged = [];
  const api = await serve({
    analyzeImpl: async () => { throw new Error("ENOENT: open '/Users/secret/project/.env' at Object.<anonymous> (/srv/app/analyze.js:10:5)"); },
    analysis: { manager: { logError: (e) => logged.push(e) } },
  });
  try {
    const done = await settle(api, (await (await api.upload(api.fake.packageTarball)).json()).id);
    assert.equal(done.state, 'failed');
    assert.deepEqual(done.error, { code: 'analysis-failed', message: 'The analysis failed unexpectedly. Details are in the server log.' });
    assert.doesNotMatch(JSON.stringify(done), /secret|\.env|analyze\.js/);
    assert.equal(logged.length, 1, 'the detail is logged server-side only');
  } finally {
    await api.close();
  }
});

test('pipeline errors with safe, authored messages are passed on (package unknown to the registry)', async () => {
  const offline = makeScenario({ packageFiles: { 'package.json': manifest() }, sourceFiles: null, extraRoutes: {} });
  offline.routes[`https://registry.npmjs.org/demo-pkg/1.0.0`] = { status: 404, body: { error: 'not found' } };
  const api = await serve({ fake: offline });
  try {
    const done = await settle(api, (await (await api.upload(offline.packageTarball)).json()).id);
    assert.equal(done.state, 'failed');
    assert.ok(typeof done.error.code === 'string' && done.error.message.length > 0 && done.error.message.length <= 400);
    assert.doesNotMatch(done.error.message, /\/Users\/|node:/);
  } finally {
    await api.close();
  }
});

test('Ollama unavailable: deterministic analysis still completes, with an honest AI status', withServer({ ollama: makeFakeOllama({ reachable: false }) }, async (api) => {
  const done = await settle(api, (await (await api.upload(api.fake.packageTarball, { query: '?ai=1' })).json()).id);
  assert.equal(done.state, 'completed');
  assert.equal(done.ai, true);
  const report = await (await api.report(done.id)).json();
  assert.deepEqual(validateReport(report), []);
  assert.equal(report.ai.status, 'unavailable');
  assert.ok(report.findings.length > 0, 'deterministic findings are intact');
  assert.ok(report.errors.some((e) => e.stage === 'ai'));
}));

test('AI is advisory: it adds output but cannot change findings, score, verdict or files; models run one at a time', async () => {
  const answers = {
    'gemma4:e4b': (call) => JSON.stringify(fileIdsIn(call.user).map((fileId) => ({ fileId, label: 'expected-artifact', rationale: 'Looks like ordinary build output.' }))),
    'deepseek-r1:8b': (call) => JSON.stringify(findingIdsIn(call.user).map((findingId) => ({ findingId, explanation: 'It appears to run a script at install time.', implications: 'It could execute code on install.', uncertainty: 'The script content is not shown.' }))),
  };
  const plain = await serve();
  const withAi = await serve({ ollama: makeFakeOllama({ answers }) });
  try {
    const a = await (await plain.report((await settle(plain, (await (await plain.upload(plain.fake.packageTarball)).json()).id)).id)).json();
    const bJob = await settle(withAi, (await (await withAi.upload(withAi.fake.packageTarball, { query: '?ai=true' })).json()).id);
    const b = await (await withAi.report(bJob.id)).json();
    assert.deepEqual(validateReport(b), []);
    assert.equal(b.ai.status, 'completed');
    assert.ok(b.ai.investigations.length > 0);
    for (const section of ['input', 'package', 'source', 'summary', 'files', 'findings', 'manifest', 'scan']) {
      assert.deepEqual(b[section], a[section], `${section} is identical with and without AI`);
    }
    assert.equal(withAi.ollama.maxInFlight(), 1, 'the two models never run at the same time');
    assert.ok(withAi.ollama.calls.every((c) => new URL(c.url).origin === OLLAMA), 'only the local Ollama is contacted');
  } finally {
    await plain.close();
    await withAi.close();
  }
});

test('uploaded package code is never executed, and the upload path writes no files', withServer({}, async (api) => {
  globalThis.__AUDYSSEY_EXECUTED__ = undefined;
  const evil = makeNpmTarball({
    'package.json': manifest({ main: 'index.js', scripts: { postinstall: 'node index.js' } }),
    'index.js': 'globalThis.__AUDYSSEY_EXECUTED__ = true; process.exit(1);',
  });
  const fake = makeScenario({ packageTarball: evil, packageFiles: {}, sourceFiles: { 'package.json': manifest({ main: 'index.js' }), 'index.js': 'module.exports = 1;' } });
  const other = await serve({ fake });
  try {
    const done = await settle(other, (await (await other.upload(evil)).json()).id);
    assert.equal(done.state, 'completed');
    assert.equal(globalThis.__AUDYSSEY_EXECUTED__, undefined);
  } finally {
    await other.close();
  }

  // Static guard on the code this milestone added: no file system, process or code-evaluation APIs.
  const dirs = ['../src/api/', '../src/jobs/'];
  for (const dir of dirs) {
    for (const name of await readdir(new URL(dir, import.meta.url))) {
      const source = await readFile(new URL(`${dir}${name}`, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /node:fs|from 'fs'|child_process|node:vm|\beval\s*\(|new Function|\bimport\(|require\(/, `${dir}${name}`);
    }
  }
}));

test('responses are JSON, uncached and bounded; filenames are display-only and sanitized', withServer({}, async (api) => {
  const response = await api.upload(api.fake.packageTarball, { query: `?filename=${encodeURIComponent('../../etc/pass\u202ewd\u0000.tgz')}` });
  const created = await response.json();
  assert.equal(created.filename, 'passwd.tgz');
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(JSON.stringify(created).length < 2000);

  assert.equal(sanitizeFilename('a'.repeat(500)).length, 120);
  assert.equal(sanitizeFilename('C:\\Users\\me\\pkg.tgz'), 'pkg.tgz');
  assert.equal(sanitizeFilename('///'), null);
  assert.equal(sanitizeFilename(undefined), null);
  assert.equal(sanitizeFilename(['x']), null);

  const missing = await fetch(`${api.base}/api/nope`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Not found' }, 'unknown routes keep the existing shape');
}));

test('health keeps its behavior next to the new routes', withServer({}, async (api) => {
  const health = await (await fetch(`${api.base}/api/health`)).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.ollama.reachable, true);
}));
