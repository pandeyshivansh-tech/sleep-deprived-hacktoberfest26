import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { analyzeNpmPackage } from '../src/analyze.js';
import { InputError } from '../src/errors.js';
import { validateReport } from '../src/report/schema.js';
import { buildTar, gz, makeNpmTarball, tarEntry } from '../test-support/tar-builder.js';
import { COMMIT, FIXED_NOW, makeScenario, manifest } from '../test-support/scenario.js';

const run = (scenario, options = {}) =>
  analyzeNpmPackage({ name: 'demo-pkg', version: '1.0.0', fetchImpl: scenario.fetchImpl, now: FIXED_NOW, ...options });

const byPath = (report) => Object.fromEntries(report.files.map((file) => [file.path, file]));

// A typical built package: compiled output, a source map, a normalized
// package.json, and source files that are not published.
const legitimate = () =>
  makeScenario({
    packageFiles: {
      'package.json': manifest({ main: 'dist/index.js', gitHead: COMMIT }),
      'README.md': '# demo\n',
      'dist/index.js': 'module.exports = 1;\n',
      'dist/index.js.map': '{}',
    },
    sourceFiles: {
      'package.json': manifest({ main: 'dist/index.js' }),
      'README.md': '# demo\n',
      'src/index.ts': 'export default 1;\n',
      'test/index.test.ts': 'test()',
    },
  });

test('compares a published package with its exact-commit source and reports every difference', async () => {
  const scenario = legitimate();
  const { report } = await run(scenario);

  assert.deepEqual(validateReport(report), []);
  assert.equal(report.input.source, 'registry');
  assert.equal(report.package.integrity.verified, true);
  assert.equal(report.package.tarballUrl, scenario.tarballUrl);
  assert.equal(report.source.resolved, true);
  assert.equal(report.source.confidence, 'exact-commit');
  assert.equal(report.source.ref.commit, COMMIT);
  assert.deepEqual(report.summary.counts, { identical: 1, modified: 1, packageOnly: 2, sourceOnly: 2 });

  const files = byPath(report);
  assert.equal(files['README.md'].status, 'identical');
  assert.equal(files['README.md'].explanation.category, 'identical');
  assert.equal(files['package.json'].status, 'modified');
  assert.equal(files['dist/index.js'].status, 'package-only');
  assert.equal(files['src/index.ts'].status, 'source-only');
  assert.equal(files['dist/index.js'].package.type, 'file');
  assert.equal(files['dist/index.js'].source, null);
  assert.match(files['dist/index.js'].package.sha256, /^[0-9a-f]{64}$/);

  assert.deepEqual(report.manifest.changes.map((c) => c.field), ['gitHead']);
  assert.match(files['package.json'].explanation.evidence.join(' '), /differs in 1 field\(s\): gitHead/);
});

test('scans the published files but does not explain or classify differences', async () => {
  const { report } = await run(legitimate());
  assert.equal(report.scan.performed, true);
  assert.ok(Number.isInteger(report.summary.riskScore));
  assert.equal(report.summary.scoring.model, 'audyssey-risk-v1');
  assert.deepEqual(report.findings.filter((f) => f.severity !== 'info'), [], 'an ordinary built package has nothing to report');
  assert.equal(report.summary.verdict, 'needs-review', 'differences exist and nothing can explain them yet');
  assert.deepEqual(report.ai, { status: 'skipped', runs: [], classifications: [], investigations: [] });
  for (const file of report.files.filter((f) => f.status !== 'identical')) {
    assert.equal(file.explanation.category, 'unclassified', file.path);
    assert.equal(file.explanation.confidence, 'low');
    assert.match(file.explanation.evidence.join(' '), /No build-artifact analysis has judged this difference/);
  }
});

test('a package that matches its source and has nothing to report has no differences', async () => {
  const same = { 'package.json': manifest(), 'index.js': 'module.exports = 1;\n', 'README.md': '# demo\n' };
  const { report } = await run(makeScenario({ packageFiles: same, sourceFiles: { ...same, 'test/a.test.js': 'test()' } }));
  assert.equal(report.summary.verdict, 'no-differences');
  assert.equal(report.summary.riskScore, 0);
  assert.deepEqual(report.findings, []);
  assert.equal(report.scan.filesSkippedCount, 0);
  assert.equal(report.scan.capabilityDifferential.available, true);
});

test('is deterministic: the same inputs give the same report', async () => {
  const first = await run(legitimate());
  const second = await run(legitimate());
  assert.equal(JSON.stringify(first.report), JSON.stringify(second.report));
});

test('requests only the registry metadata, the tarball and the source archive', async () => {
  const scenario = legitimate();
  await run(scenario);
  assert.deepEqual(scenario.urls(), [
    'https://registry.npmjs.org/demo-pkg/1.0.0',
    'https://registry.npmjs.org/demo-pkg/-/demo-pkg-1.0.0.tgz',
    `https://codeload.github.com/acme/demo-pkg/tar.gz/${COMMIT}`,
  ]);
});

test('surfaces a tampered release: an added install script that runs a file with no source counterpart', async () => {
  const scenario = makeScenario({
    packageFiles: {
      'package.json': manifest({ scripts: { test: 'jest', postinstall: 'node lib/x.min.js' } }),
      'index.js': 'module.exports = 1;\n',
      'lib/x.min.js': 'var _0x1=["\\x68\\x74\\x74\\x70"];',
    },
    sourceFiles: { 'package.json': manifest({ scripts: { test: 'jest' } }), 'index.js': 'module.exports = 1;\n' },
  });
  const { report } = await run(scenario);
  const files = byPath(report);

  assert.equal(files['lib/x.min.js'].status, 'package-only');
  assert.equal(files['index.js'].status, 'identical');
  assert.deepEqual(report.manifest.changes, [
    { field: 'scripts.postinstall', change: 'added', packageValue: 'node lib/x.min.js', sourceValue: null },
  ]);
  assert.deepEqual(report.manifest.installScripts, { package: { postinstall: 'node lib/x.min.js' }, source: {} });

  const byRule = Object.fromEntries(report.findings.map((f) => [f.ruleId, f]));
  assert.equal(byRule['install-script-added'].severity, 'high');
  assert.equal(byRule['install-script-added'].fileId, files['package.json'].id);
  assert.equal(byRule['install-script-runs-unsourced-file'].severity, 'medium');
  assert.deepEqual(files['package.json'].findingIds, report.findings.map((f) => f.id), 'findings are linked to the file');
  assert.match(files['package.json'].explanation.evidence.join('\n'), /install-time script "postinstall"/);
  assert.equal(report.summary.verdict, 'needs-review', 'one strong rule is never enough for suspicious');
  assert.equal(report.summary.riskScore, 38, 'high 30 + medium 12 x 0.7 confidence = 38.4');
});

test('a release that adds an install script AND does not match its checksum is suspicious', async () => {
  const good = makeNpmTarball({ 'package.json': manifest(), 'index.js': 'ok' });
  const tampered = makeNpmTarball({ 'package.json': manifest({ scripts: { postinstall: 'node lib/setup.js' } }), 'index.js': 'ok', 'lib/setup.js': 'x' });
  const scenario = makeScenario({
    packageTarball: good,
    sourceFiles: { 'package.json': manifest(), 'index.js': 'ok' },
  });
  const { report } = await analyzeNpmPackage({ tarballBytes: tampered, fetchImpl: scenario.fetchImpl, now: FIXED_NOW });
  const rules = report.findings.map((f) => f.ruleId);
  assert.ok(rules.includes('integrity-mismatch') && rules.includes('install-script-added'));
  assert.equal(report.summary.verdict, 'suspicious');
  assert.ok(report.summary.riskScore >= 60);
  assert.deepEqual(validateReport(report), []);
});

test('findings are numbered strongest first, and the order does not depend on the scan order', async () => {
  const { report } = await run(
    makeScenario({
      packageFiles: { 'package.json': manifest(), 'a.js': 'eval(x)', 'b.js': 'const t=process.env.NPM_TOKEN; fetch("https://x.test")' },
      sourceFiles: { 'package.json': manifest(), 'src/index.js': 'ok' },
    }),
  );
  assert.deepEqual(report.findings.map((f) => f.id), report.findings.map((_, i) => `F${i + 1}`));
  const severities = ['critical', 'high', 'medium', 'low', 'info'];
  const ranks = report.findings.map((f) => severities.indexOf(f.severity));
  assert.deepEqual([...ranks].sort((a, b) => a - b), ranks);
  assert.equal(report.findings[0].ruleId, 'credential-network-combination');
});

test('a very large number of findings is capped, and the report says so', async () => {
  const packageFiles = { 'package.json': manifest() };
  for (let i = 0; i < 260; i += 1) packageFiles[`m${String(i).padStart(3, '0')}.js`] = `function f${i}(x) { return eval(x); }`;
  const { report } = await run(makeScenario({ packageFiles, sourceFiles: { 'package.json': manifest(), 'src/index.js': 'ok' } }));
  assert.equal(report.findings.length, 200);
  assert.ok(report.errors.some((e) => e.stage === 'scan' && /60 lower-ranked finding\(s\) were left out/.test(e.message)));
  assert.deepEqual(validateReport(report), []);
});

test('reports a tarball that does not match the registry checksum as a finding, and keeps analyzing', async () => {
  const good = makeNpmTarball({ 'package.json': manifest(), 'index.js': 'ok' });
  const scenario = makeScenario({
    packageTarball: makeNpmTarball({ 'package.json': manifest(), 'index.js': 'ok', 'evil.js': 'x' }),
    integrity: `sha512-${createHash('sha512').update(good).digest('base64')}`,
    sourceFiles: { 'package.json': manifest(), 'index.js': 'ok' },
  });
  const { report } = await run(scenario);
  assert.equal(report.package.integrity.verified, false);
  assert.notEqual(report.package.integrity.expected, report.package.integrity.actual);
  const finding = report.findings.find((f) => f.ruleId === 'integrity-mismatch');
  assert.equal(finding.scope, 'package');
  assert.equal(finding.fileId, null);
  assert.equal(finding.confidence, 'medium', 'for a registry download it may be a corrupt transfer');
  assert.deepEqual(report.errors, [], 'the same fact is not also listed as a problem');
  assert.equal(byPath(report)['evil.js'].status, 'package-only');
});

test('falls back to a version tag and says the source is less certain', async () => {
  const scenario = makeScenario({
    gitHead: null,
    packageFiles: { 'package.json': manifest(), 'a.js': 'a' },
    sourceFiles: { 'package.json': manifest(), 'a.js': 'a' },
  });
  const { report } = await run(scenario);
  assert.equal(report.source.confidence, 'tag');
  assert.equal(report.source.ref.type, 'tag');
  assert.equal(report.source.ref.value, 'v1.0.0');
  assert.match(report.source.notes.join(' '), /no gitHead/);
});

test('an unresolved source is inconclusive, and nothing is called identical', async () => {
  const scenario = makeScenario({ gitHead: null, packageFiles: { 'package.json': manifest(), 'x.js': 'x' }, sourceFiles: null });
  const { report } = await run(scenario);
  assert.equal(report.source.resolved, false);
  assert.equal(report.source.confidence, 'unresolved');
  assert.equal(report.summary.verdict, 'inconclusive');
  assert.equal(report.scan.performed, true, 'the files are still scanned');
  assert.equal(report.scan.capabilityDifferential.available, false);
  assert.deepEqual(report.summary.counts, { identical: 0, modified: 0, packageOnly: 2, sourceOnly: 0 });
  assert.ok(report.files.every((f) => f.explanation.category === 'unclassified'));
  assert.match(report.files[0].explanation.evidence[0], /could not be compared/);
  assert.equal(report.manifest.compared, false);
  assert.match(report.manifest.reason, /No source snapshot/);
});

test('an unresolved source with an install script is reviewed, with no claim that the script is new', async () => {
  const scenario = makeScenario({
    gitHead: null,
    packageFiles: { 'package.json': manifest({ scripts: { postinstall: 'node x.js' } }), 'x.js': 'x' },
    sourceFiles: null,
  });
  const { report } = await run(scenario);
  assert.equal(report.summary.verdict, 'needs-review');
  assert.deepEqual(report.manifest.installScripts.package, { postinstall: 'node x.js' });
  const finding = report.findings.find((f) => f.ruleId === 'install-script-present');
  assert.equal(finding.severity, 'medium');
  assert.equal(finding.introducedInPackage, null);
  assert.ok(!report.findings.some((f) => f.ruleId === 'install-script-added'));
});

test('a hostile published archive yields an inconclusive report with the reason, not a crash', async () => {
  const hostile = gz(buildTar([tarEntry({ name: 'package/../../etc/cron.d/evil' }, '* * * * * root x')]));
  const scenario = makeScenario({ packageTarball: hostile, sourceFiles: { 'package.json': manifest() } });
  const { report } = await run(scenario);
  assert.deepEqual(validateReport(report), []);
  assert.deepEqual(report.files, []);
  assert.equal(report.source.resolved, false);
  assert.ok(report.errors.some((e) => e.stage === 'package-archive' && /rejected: .*escapes its root/.test(e.message)));
  assert.ok(!scenario.urls().some((u) => u.includes('codeload')), 'no source lookup after a rejected archive');
});

test('flags a tarball whose package.json is for a different package or version', async () => {
  const scenario = makeScenario({
    packageFiles: { 'package.json': JSON.stringify({ name: 'other-pkg', version: '9.9.9' }) },
    sourceFiles: { 'package.json': manifest() },
  });
  const { report } = await run(scenario);
  const finding = report.findings.find((f) => f.ruleId === 'package-identity-mismatch');
  assert.equal(finding.scope, 'package');
  assert.equal(finding.severity, 'high');
  assert.match(finding.evidence[0].snippet, /requested demo-pkg@1\.0\.0, tarball says other-pkg@9\.9\.9/);
  assert.deepEqual(report.errors, []);
});

test('never executes code or install scripts from the package', async () => {
  const scenario = makeScenario({
    packageFiles: {
      'package.json': manifest({ main: 'index.js', scripts: { postinstall: 'node index.js' } }),
      'index.js': 'globalThis.__audysseyPwned = true; throw new Error("executed");',
    },
    sourceFiles: { 'package.json': manifest() },
  });
  await run(scenario);
  assert.equal(globalThis.__audysseyPwned, undefined);
});

test('rejects a version that is not exact before any request', async () => {
  const scenario = legitimate();
  await assert.rejects(run(scenario, { version: '^1.0.0' }), InputError);
  assert.equal(scenario.calls.length, 0);
});

test('an unknown version is an input error', async () => {
  const scenario = makeScenario({ packageFiles: { 'package.json': manifest() }, sourceFiles: { 'package.json': manifest() } });
  await assert.rejects(run(scenario, { version: '2.0.0' }), { code: 'not-found' });
});

test('reports progress through the callback', async () => {
  const messages = [];
  await run(legitimate(), { onProgress: (m) => messages.push(m) });
  assert.equal(messages.length, 6);
  assert.match(messages[0], /Fetching npm metadata/);
  assert.match(messages.at(-1), /Scanning the published files/);
});

test('local tarball: identifies itself, skips the registry download and flags a checksum mismatch', async () => {
  const scenario = makeScenario({
    packageFiles: { 'package.json': manifest(), 'index.js': 'original' },
    sourceFiles: { 'package.json': manifest(), 'index.js': 'original' },
  });
  const tampered = makeNpmTarball({ 'package.json': manifest(), 'index.js': 'original', 'backdoor.js': 'evil()' });
  const { report } = await analyzeNpmPackage({ tarballBytes: tampered, fetchImpl: scenario.fetchImpl, now: FIXED_NOW });

  assert.deepEqual(validateReport(report), []);
  assert.equal(report.input.source, 'tarball');
  assert.equal(report.input.name, 'demo-pkg');
  assert.equal(report.package.tarballUrl, null);
  assert.equal(report.package.integrity.verified, false);
  assert.equal(byPath(report)['backdoor.js'].status, 'package-only');
  assert.ok(!scenario.urls().includes(scenario.tarballUrl), 'the registry tarball is not downloaded');
});

test('local tarball: cannot be identified without a readable package.json, and hostile ones are reported', async () => {
  const empty = makeScenario({ packageFiles: { 'package.json': manifest() }, sourceFiles: { 'package.json': manifest() } });
  await assert.rejects(
    analyzeNpmPackage({ tarballBytes: makeNpmTarball({ 'index.js': 'x' }), fetchImpl: empty.fetchImpl }),
    { code: 'unidentifiable-tarball' },
  );
  await assert.rejects(analyzeNpmPackage({ tarballBytes: Buffer.from('not a tarball'), fetchImpl: empty.fetchImpl }), { code: 'unidentifiable-tarball' });

  const hostile = gz(buildTar([tarEntry({ name: '../x' }, 'x')]));
  const { report } = await analyzeNpmPackage({ name: 'demo-pkg', version: '1.0.0', tarballBytes: hostile, fetchImpl: empty.fetchImpl, now: FIXED_NOW });
  assert.ok(report.errors.some((e) => e.stage === 'package-archive' && /supplied tarball was rejected/.test(e.message)));
  assert.deepEqual(report.files, []);
});
