import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/cli.js';
import { InputError, FetchError } from '../src/errors.js';
import { DEFAULT_LIMITS } from '../src/limits.js';
import { compareVersions, fetchLatestVersion, resolveInterval, watchPackage } from '../src/watch.js';
import { validateReport } from '../src/report/schema.js';
import { FIXED_NOW, makeScenario, manifest } from '../test-support/scenario.js';

const LATEST_URL = 'https://registry.npmjs.org/demo-pkg/latest';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

// A registry whose "latest" the test controls; every request is recorded.
function registry(initial) {
  const state = { latest: initial, fail: false, calls: [] };
  state.fetchImpl = async (url) => {
    state.calls.push(String(url));
    if (state.fail) throw new TypeError('fetch failed');
    if (String(url) !== LATEST_URL) return new Response('not found', { status: 404 });
    return json({ name: 'demo-pkg', version: state.latest });
  };
  return state;
}

// Runs watchPackage for `polls` waits (so that many checks), calling `between(n)` at each wait.
async function watch(options, { polls = 1, between = () => {} } = {}) {
  const events = [];
  const controller = new AbortController();
  let slept = 0;
  const result = await watchPackage({
    name: 'demo-pkg',
    intervalSeconds: 60,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
    sleep: async () => {
      slept += 1;
      between(slept);
      if (slept >= polls) controller.abort();
    },
    ...options,
  });
  return { events, result, slept };
}

const fakeAnalyze = () => {
  const calls = [];
  const analyze = async (args) => {
    calls.push(args);
    return { report: { input: { name: args.name, version: args.version } } };
  };
  return { analyze, calls };
};

test('reads the latest version from the registry, validated', async () => {
  const reg = registry('2.3.4');
  assert.equal(await fetchLatestVersion({ name: 'demo-pkg', fetchImpl: reg.fetchImpl }), '2.3.4');
  assert.deepEqual(reg.calls, [LATEST_URL]);

  const scoped = [];
  await fetchLatestVersion({ name: '@acme/demo', fetchImpl: async (url) => { scoped.push(String(url)); return json({ name: '@acme/demo', version: '1.0.0' }); } });
  assert.equal(scoped[0], 'https://registry.npmjs.org/@acme%2Fdemo/latest');
});

test('rejects bad names, 404s, malformed and mismatched metadata, and network failures', async () => {
  await assert.rejects(fetchLatestVersion({ name: 'bad name!', fetchImpl: registry('1.0.0').fetchImpl }), { code: 'invalid-name' });
  await assert.rejects(fetchLatestVersion({ name: 'demo-pkg', fetchImpl: async () => new Response('', { status: 404 }) }), (e) => e instanceof InputError && e.code === 'not-found');
  for (const body of ['<html>', json({ name: 'other', version: '1.0.0' }), json({ name: 'demo-pkg', version: '^1.0.0' }), json({ name: 'demo-pkg' }), json(null), json([])]) {
    await assert.rejects(fetchLatestVersion({ name: 'demo-pkg', fetchImpl: async () => (typeof body === 'string' ? new Response(body) : body) }), (e) => e instanceof FetchError && e.code === 'bad-metadata');
  }
  await assert.rejects(fetchLatestVersion({ name: 'demo-pkg', fetchImpl: registry('1.0.0').fetchImpl.bind(null) && (async () => { throw new TypeError('fetch failed'); }) }), FetchError);
});

test('version ordering follows semver precedence', () => {
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0', '1.0.1', '1.1.0', '2.0.0', '10.0.0'];
  for (let i = 0; i < order.length - 1; i += 1) {
    assert.equal(compareVersions(order[i], order[i + 1]), -1, `${order[i]} < ${order[i + 1]}`);
    assert.equal(compareVersions(order[i + 1], order[i]), 1);
  }
  assert.equal(compareVersions('1.2.3', '1.2.3+build.5'), 0);
});

test('no update: the baseline is recorded, nothing is analyzed', async () => {
  const reg = registry('1.0.0');
  const { analyze, calls } = fakeAnalyze();
  const { events } = await watch({ fetchImpl: reg.fetchImpl, analyze }, { polls: 3 });
  assert.deepEqual(events.map((e) => e.type), ['baseline', 'unchanged', 'unchanged']);
  assert.equal(calls.length, 0);
});

test('a new version is detected and analyzed once, through the existing pipeline', async () => {
  const reg = registry('1.0.0');
  const { analyze, calls } = fakeAnalyze();
  const { events } = await watch({ fetchImpl: reg.fetchImpl, analyze }, { polls: 4, between: (n) => { if (n === 1) reg.latest = '1.1.0'; } });
  assert.deepEqual(events.map((e) => e.type), ['baseline', 'release', 'report', 'unchanged', 'unchanged']);
  const release = events.find((e) => e.type === 'release');
  assert.deepEqual({ version: release.version, previous: release.previous }, { version: '1.1.0', previous: '1.0.0' });
  assert.equal(calls.length, 1, 'duplicate versions are not analyzed again');
  assert.equal(calls[0].name, 'demo-pkg');
  assert.equal(calls[0].version, '1.1.0');
  assert.equal(calls[0].fetchImpl, reg.fetchImpl, 'same fetch, so same host allowlist and limits');
  assert.equal(calls[0].limits, DEFAULT_LIMITS);
});

test('--since compares against a known version; an older or moved tag is never analyzed', async () => {
  const reg = registry('1.5.0');
  const { analyze, calls } = fakeAnalyze();
  await watch({ fetchImpl: reg.fetchImpl, analyze, since: '1.2.0' });
  assert.deepEqual(calls.map((c) => c.version), ['1.5.0']);

  const older = fakeAnalyze();
  const { events } = await watch({ fetchImpl: registry('1.0.0').fetchImpl, analyze: older.analyze, since: '1.2.0' });
  assert.equal(older.calls.length, 0);
  assert.equal(events[0].type, 'unchanged');
});

test('registry or network failure is reported and watching continues and recovers', async () => {
  const reg = registry('1.0.0');
  const { analyze, calls } = fakeAnalyze();
  reg.fail = true;
  const { events } = await watch({ fetchImpl: reg.fetchImpl, analyze, since: '1.0.0' }, { polls: 3, between: (n) => { if (n === 1) { reg.fail = false; reg.latest = '1.0.1'; } } });
  assert.deepEqual(events.map((e) => e.type), ['error', 'release', 'report', 'unchanged']);
  assert.equal(events[0].stage, 'check');
  assert.doesNotMatch(events[0].message, /TypeError|at /);
  assert.equal(calls.length, 1);
});

test('a failed analysis is reported, then retried at the next poll, and analyzed once when it works', async () => {
  const reg = registry('2.0.0');
  let attempts = 0;
  const analyze = async ({ version }) => {
    attempts += 1;
    if (attempts === 1) throw new FetchError('The npm registry timed out', 'timeout');
    return { report: { version } };
  };
  const { events } = await watch({ fetchImpl: reg.fetchImpl, analyze, since: '1.0.0' }, { polls: 3 });
  assert.deepEqual(events.map((e) => e.type), ['release', 'error', 'release', 'report', 'unchanged'].slice(0, events.length));
  assert.equal(events.filter((e) => e.type === 'report').length, 1);
  assert.equal(attempts, 2);
});

test('a package that does not exist stops with an input error instead of polling forever', async () => {
  const { events, result } = await watch({ fetchImpl: async () => new Response('', { status: 404 }) }, { polls: 4 });
  assert.equal(result.failed, true);
  assert.equal(result.checks, 1);
  assert.equal(events[0].type, 'error');
});

test('--once checks a single time without sleeping', async () => {
  const reg = registry('1.0.0');
  let slept = false;
  const { result } = await watchPackage({ name: 'demo-pkg', once: true, fetchImpl: reg.fetchImpl, sleep: async () => { slept = true; } });
  assert.deepEqual(result ?? { checks: 1, failed: false }, { checks: 1, failed: false });
  assert.equal(slept, false);
  assert.equal(reg.calls.length, 1);
});

test('graceful shutdown: an abort ends the loop, even mid-wait, and no more requests are made', async () => {
  const reg = registry('1.0.0');
  const controller = new AbortController();
  const finished = watchPackage({
    name: 'demo-pkg',
    intervalSeconds: 3600,
    fetchImpl: reg.fetchImpl,
    signal: controller.signal,
    // the real sleep: it must wake up when aborted rather than wait an hour
  });
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  const result = await Promise.race([finished, new Promise((r) => setTimeout(() => r('hung'), 1000))]);
  assert.notEqual(result, 'hung');
  assert.equal(result.checks, 1);
  assert.equal(reg.calls.length, 1);

  const already = new AbortController();
  already.abort();
  assert.equal((await watchPackage({ name: 'demo-pkg', fetchImpl: reg.fetchImpl, signal: already.signal })).checks, 0);
});

test('interval bounds protect the registry', () => {
  assert.equal(resolveInterval(undefined), 300);
  assert.equal(resolveInterval('60'), 60);
  assert.equal(resolveInterval('86400'), 86400);
  for (const bad of ['59', '0', '-5', '86401', '1.5', 'abc', '']) assert.throws(() => resolveInterval(bad), { code: 'bad-interval' }, bad);
});

// --- CLI, with the real analysis pipeline over faked registry/GitHub ---

function cliIo(scenario, extra = {}) {
  const out = [];
  const err = [];
  return { out, err, options: { stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => err.push(t) }, fetchImpl: scenario.fetchImpl, now: FIXED_NOW, ...extra } };
}

const scenario = () => {
  const s = makeScenario({
    packageFiles: { 'package.json': manifest({ main: 'a.js' }), 'a.js': 'module.exports = 1;\n' },
    sourceFiles: { 'package.json': manifest({ main: 'a.js' }), 'a.js': 'module.exports = 1;\n' },
  });
  s.routes[LATEST_URL] = { body: { name: 'demo-pkg', version: '1.0.0' } };
  return s;
};

test('CLI: a new release runs the real analysis pipeline and prints the standard report', async () => {
  const { out, err, options } = cliIo(scenario());
  const code = await run(['watch', 'demo-pkg', '--since', '0.9.0', '--once'], options);
  assert.equal(code, 0);
  const text = out.join('');
  assert.match(text, /New release: demo-pkg@1\.0\.0 \(was 0\.9\.0\)/);
  assert.match(text, /Audyssey report for demo-pkg@1\.0\.0/);
  assert.match(text, /Verdict:\s+no-differences/);
  assert.match(err.join(''), /Scanning the published files/, 'progress comes from the real pipeline');
});

test('CLI: --json prints a report that satisfies the contract', async () => {
  const { out, options } = cliIo(scenario());
  assert.equal(await run(['watch', 'demo-pkg', '--since', '0.9.0', '--once', '--json'], options), 0);
  const body = out.join('');
  const report = JSON.parse(body.slice(body.indexOf('{')));
  assert.deepEqual(validateReport(report), []);
});

test('CLI: no update and no-op, bad interval and bad name exit with clear codes', async () => {
  const quiet = cliIo(scenario());
  assert.equal(await run(['watch', 'demo-pkg', '--since', '1.0.0', '--once'], quiet.options), 0);
  assert.match(quiet.out.join(''), /1\.0\.0 is still the latest/);
  assert.doesNotMatch(quiet.out.join(''), /Audyssey report/);

  const interval = cliIo(scenario());
  assert.equal(await run(['watch', 'demo-pkg', '--interval', '5'], interval.options), 2);
  assert.match(interval.err.join(''), /--interval/);

  const bad = cliIo(scenario());
  assert.equal(await run(['watch', 'bad name!', '--once'], bad.options), 2);

  const offline = cliIo(scenario(), { fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.equal(await run(['watch', 'demo-pkg', '--once'], offline.options), 1);
  assert.match(offline.err.join(''), /check failed/);
});

test('CLI: the watch loop stops on a shutdown signal and says so', async () => {
  const controller = new AbortController();
  const { out, options } = cliIo(scenario(), { signal: controller.signal, watchSleep: async () => controller.abort() });
  assert.equal(await run(['watch', 'demo-pkg', '--interval', '60'], options), 0);
  assert.match(out.join(''), /Latest is 1\.0\.0/);
  assert.match(out.join(''), /Stopped after 1 check/);
});
