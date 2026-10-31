import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/cli.js';
import { validateReport } from '../src/report/schema.js';
import { formatSummary } from '../src/report/summary.js';
import { analyzeNpmPackage } from '../src/analyze.js';
import { makeNpmTarball } from '../test-support/tar-builder.js';
import { FIXED_NOW, makeScenario, manifest } from '../test-support/scenario.js';

function io(scenario, extra = {}) {
  const out = [];
  const err = [];
  const written = {};
  return {
    out,
    err,
    written,
    options: {
      stdout: { write: (text) => out.push(text) },
      stderr: { write: (text) => err.push(text) },
      fetchImpl: scenario?.fetchImpl,
      writeFile: async (path, text) => {
        written[path] = text;
      },
      now: FIXED_NOW,
      ...extra,
    },
  };
}

const scenario = () =>
  makeScenario({
    packageFiles: { 'package.json': manifest({ gitHead: 'x' }), 'dist/a.js': 'a', 'README.md': 'r' },
    sourceFiles: { 'package.json': manifest(), 'src/a.ts': 'a', 'README.md': 'r' },
  });

test('prints a text summary and exits 0', async () => {
  const { out, err, options } = io(scenario());
  assert.equal(await run(['analyze', 'demo-pkg@1.0.0'], options), 0);
  const text = out.join('');
  assert.match(text, /Audyssey report for demo-pkg@1\.0\.0/);
  assert.match(text, /Integrity:  verified/);
  assert.match(text, /exact commit recorded by npm/);
  assert.match(text, /1 identical, 1 modified, 1 package-only, 1 source-only/);
  assert.match(text, /package-only\s+dist\/a\.js/);
  assert.match(text, /Scan:\s+3 file\(s\) scanned, 0 skipped/);
  assert.match(text, /Findings:   none/);
  assert.match(text, /Risk score: 0\/100 \(audyssey-risk-v1/);
  assert.match(text, /Verdict:    needs-review/);
  assert.match(text, /a low score does not mean a package is safe/);
  assert.match(err.join(''), /Fetching npm metadata/);
});

test('--json prints only the report, which satisfies the contract', async () => {
  const { out, options } = io(scenario());
  assert.equal(await run(['analyze', 'demo-pkg@1.0.0', '--json'], options), 0);
  const report = JSON.parse(out.join(''));
  assert.deepEqual(validateReport(report), []);
  assert.equal(report.generatedAt, '2026-11-01T00:00:00.000Z');
});

test('--out writes the JSON report to the given file', async () => {
  const { written, out, options } = io(scenario());
  assert.equal(await run(['analyze', 'demo-pkg@1.0.0', '--out', 'report.json'], options), 0);
  assert.deepEqual(validateReport(JSON.parse(written['report.json'])), []);
  assert.match(out.join(''), /Audyssey report/);
});

test('usage errors exit 2 and make no request', async () => {
  for (const argv of [[], ['analyze'], ['frobnicate', 'a@1.0.0'], ['analyze', 'a@1.0.0', 'extra'], ['analyze', 'a@1.0.0', '--bogus']]) {
    const { err, options } = io(scenario());
    const code = await run(argv, options);
    assert.equal(code, 2, argv.join(' '));
    assert.match(err.join(''), /Usage:|Unknown option/);
  }
  const s = scenario();
  await run(['analyze'], io(s).options);
  assert.equal(s.calls.length, 0);
});

test('--help prints usage to stdout and exits 0', async () => {
  const { out, options } = io(scenario());
  assert.equal(await run(['--help'], options), 0);
  assert.match(out.join(''), /Usage:/);
});

test('invalid specs and unknown versions exit 2 with a clear message', async () => {
  for (const spec of ['demo-pkg', 'demo-pkg@^1.0.0', 'demo-pkg@latest', '../x@1.0.0']) {
    const { err, options } = io(scenario());
    assert.equal(await run(['analyze', spec], options), 2, spec);
    assert.match(err.join(''), /^Error: /);
  }
  const { err, options } = io(scenario());
  assert.equal(await run(['analyze', 'demo-pkg@9.9.9'], options), 2);
  assert.match(err.join(''), /was not found on the npm registry/);
});

test('network failures exit 1', async () => {
  const { err, options } = io(null, {
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  assert.equal(await run(['analyze', 'demo-pkg@1.0.0'], options), 1);
  assert.match(err.join(''), /Error: Request to registry\.npmjs\.org failed/);
});

test('--tarball analyzes a local file without downloading the package', async () => {
  const s = scenario();
  const tarball = makeNpmTarball({ 'package.json': manifest(), 'dist/a.js': 'a', 'extra.js': 'new' });
  const { out, options } = io(s, {
    statFile: async () => ({ size: tarball.length }),
    readFile: async (path) => {
      assert.equal(path, 'tampered.tgz');
      return tarball;
    },
  });
  assert.equal(await run(['analyze', '--tarball', 'tampered.tgz', '--json'], options), 0);
  const report = JSON.parse(out.join(''));
  assert.equal(report.input.source, 'tarball');
  assert.equal(report.package.integrity.verified, false);
  assert.ok(!s.urls().includes(s.tarballUrl));
});

test('--tarball reports unreadable or oversized files as input errors', async () => {
  const missing = io(scenario(), {
    statFile: async () => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    },
  });
  assert.equal(await run(['analyze', '--tarball', 'nope.tgz'], missing.options), 2);
  assert.match(missing.err.join(''), /cannot read nope\.tgz \(ENOENT\)/);

  const huge = io(scenario(), { statFile: async () => ({ size: 10 ** 12 }) });
  assert.equal(await run(['analyze', '--tarball', 'huge.tgz'], huge.options), 2);
  assert.match(huge.err.join(''), /larger than/);
});

test('summary: lists modified, then package-only, then source-only files, and caps long lists', async () => {
  const packageFiles = { 'package.json': manifest({ gitHead: 'x' }), 'z-built.js': 'z' };
  const sourceFiles = { 'package.json': manifest() };
  for (let index = 0; index < 50; index += 1) sourceFiles[`a-source-${String(index).padStart(2, '0')}.ts`] = 's';
  const s = makeScenario({ packageFiles, sourceFiles });
  const { report } = await analyzeNpmPackage({ name: 'demo-pkg', version: '1.0.0', fetchImpl: s.fetchImpl, now: FIXED_NOW });
  const lines = formatSummary(report).split('\n');
  const listed = lines.filter((line) => /^ {2}(modified|package-only|source-only)/.test(line));
  assert.match(listed[0], /^ {2}modified\s+package\.json$/);
  assert.match(listed[1], /^ {2}package-only\s+z-built\.js$/);
  assert.match(listed[2], /^ {2}source-only\s+a-source-00\.ts$/);
  assert.equal(listed.length, 40);
  assert.ok(lines.includes('  … and 12 more (see the JSON report)'));
});

test('summary: an unresolved source is stated plainly and nothing is called clean', async () => {
  const s = makeScenario({ gitHead: null, packageFiles: { 'package.json': manifest(), 'a.js': 'a' }, sourceFiles: null });
  const { report } = await analyzeNpmPackage({ name: 'demo-pkg', version: '1.0.0', fetchImpl: s.fetchImpl, now: FIXED_NOW });
  const text = formatSummary(report);
  assert.match(text, /Source:     UNRESOLVED/);
  assert.match(text, /none could be compared/);
  assert.match(text, /not compared \(No source snapshot/);
  assert.match(text, /Risk score: 0\/100 \(audyssey-risk-v1; based on the package alone, because the source could not be compared/);
  // The summary never claims the package is fine; its only use of "safe" is the disclaimer.
  assert.doesNotMatch(text.replace(/a low score does not mean a package is safe\./, ''), /\b(clean|safe|malicious|trusted)\b/i);
});

test('summary: a failed integrity check is called out, as a finding', async () => {
  const s = makeScenario({
    packageFiles: { 'package.json': manifest() },
    sourceFiles: { 'package.json': manifest() },
    integrity: 'sha512-AAAA',
  });
  const { report } = await analyzeNpmPackage({ name: 'demo-pkg', version: '1.0.0', fetchImpl: s.fetchImpl, now: FIXED_NOW });
  const text = formatSummary(report);
  assert.match(text, /NOT VERIFIED/);
  assert.match(text, /\[high\] integrity-mismatch package/);
  assert.match(text, /downloaded tarball does not match the registry checksum/);
});

test('summary: findings list their rule, place and title, strongest first', async () => {
  const s = makeScenario({
    packageFiles: { 'package.json': manifest({ scripts: { postinstall: 'node x.js' } }), 'x.js': 'eval(atob("YQ=="))' },
    sourceFiles: { 'package.json': manifest(), 'src/index.js': 'ok' },
  });
  const { report } = await analyzeNpmPackage({ name: 'demo-pkg', version: '1.0.0', fetchImpl: s.fetchImpl, now: FIXED_NOW });
  const lines = formatSummary(report).split('\n');
  const listed = lines.filter((line) => /^ {2}\[(high|medium|low|info|critical)\]/.test(line));
  assert.match(listed[0], /^ {2}\[high\] /);
  assert.ok(listed.some((line) => /decoded-code-execution x\.js:1/.test(line)));
  assert.ok(listed.some((line) => /install-script-added package\.json:\d+/.test(line)));
  assert.match(lines.join('\n'), /Findings:   \d+ \(\d+ high/);
});

test('summary: names and messages from the package cannot inject terminal control sequences', async () => {
  const esc = String.fromCodePoint(0x1b);
  const rlo = String.fromCodePoint(0x202e);
  const hostile = makeNpmTarball({ 'package.json': manifest(), [`lib/${esc}[2Jevil${rlo}.js`]: 'eval(x)' });
  const s = makeScenario({ packageFiles: { 'package.json': manifest() }, sourceFiles: { 'package.json': manifest() } });
  const { report } = await analyzeNpmPackage({ tarballBytes: hostile, fetchImpl: s.fetchImpl, now: FIXED_NOW });
  const text = formatSummary(report);
  assert.ok(text.includes('dynamic-code-execution'), 'the hostile file is still reported');
  assert.ok(!text.includes(esc) && !text.includes(rlo), 'no raw control characters in the output');
  assert.match(text, /\\u\{1b\}/);
});
