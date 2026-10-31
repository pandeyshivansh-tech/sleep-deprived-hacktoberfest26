import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { validateReport } from '../src/report/schema.js';

// The committed examples are the product's proof that it works, so they must
// stay valid, tool-generated and tied to the inputs committed beside them.
const examplesUrl = new URL('../../examples/', import.meta.url);

async function exampleDirectories() {
  const entries = await readdir(examplesUrl, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

const read = (directory, file) => readFile(new URL(`${directory}/${file}`, examplesUrl));

test('there are at least a registry example and a local-tarball example', async () => {
  const sources = new Set();
  for (const directory of await exampleDirectories()) {
    sources.add(JSON.parse(await read(directory, 'report.json')).input.source);
  }
  assert.deepEqual([...sources].sort(), ['registry', 'tarball']);
});

test('every example has an input, a README and a report that satisfies the contract', async () => {
  for (const directory of await exampleDirectories()) {
    const report = JSON.parse(await read(directory, 'report.json'));
    assert.deepEqual(validateReport(report), [], directory);
    assert.equal(report.tool.name, 'audyssey', directory);
    assert.equal(report.$comment, undefined, `${directory} must be tool output, not a hand-written sample`);
    JSON.parse(await read(directory, 'input.json'));
    assert.match((await read(directory, 'README.md')).toString(), /^# /, directory);
    assert.match((await read(directory, 'report.txt')).toString(), /^Audyssey report for /, directory);
  }
});

test('examples claim only what the product does today', async () => {
  for (const directory of await exampleDirectories()) {
    const report = JSON.parse(await read(directory, 'report.json'));
    // The scanner ran, but nothing explains differences or calls a model yet.
    assert.equal(report.scan.performed, true, directory);
    // The models are advisory and only run when there is something to interpret.
    // Whatever ran must be one of the two named models: never anything else.
    assert.ok(['skipped', 'completed'].includes(report.ai.status), `${directory}: ${report.ai.status}`);
    for (const run of report.ai.runs) {
      assert.ok(['gemma4:e4b', 'deepseek-r1:8b'].includes(run.model), `${directory}: unexpected model ${run.model}`);
      assert.equal(run.status, 'completed', directory);
      assert.match(run.digest, /^[0-9a-f]{64}$/, `${directory}: the model digest is recorded`);
      assert.ok(run.durationMs > 0, directory);
    }
    assert.equal(report.ai.runs.length === 0, report.ai.status === 'skipped', directory);
    assert.ok(report.summary.scoring !== null && Number.isInteger(report.summary.riskScore), directory);
    assert.ok(!['expected-differences'].includes(report.summary.verdict), `${directory}: no explainer exists, so differences cannot be "expected"`);
    for (const file of report.files.filter((f) => f.status !== 'identical')) {
      assert.equal(file.explanation.category, 'unclassified', `${directory}/${file.path}`);
    }
  }
});

test('examples produced with the local models have real, validated model output', async () => {
  const mitt = JSON.parse(await read('mitt@3.0.1', 'report.json'));
  assert.deepEqual(mitt.ai.runs.map((r) => r.model), ['gemma4:e4b'], 'no findings, so only the classification stage had work');
  assert.equal(mitt.ai.classifications.length, mitt.summary.counts.packageOnly + mitt.summary.counts.modified);

  const tampered = JSON.parse(await read('tampered-demo', 'report.json'));
  assert.deepEqual(tampered.ai.runs.map((r) => r.model), ['gemma4:e4b', 'deepseek-r1:8b'], 'both models, in order');
  assert.ok(tampered.ai.classifications.length >= 1 && tampered.ai.investigations.length >= 1);
  const ids = new Set(tampered.findings.map((f) => f.id));
  assert.ok(tampered.ai.investigations.every((i) => ids.has(i.findingId)), 'the model explains only findings the scanner made');
  assert.equal(tampered.summary.riskScore, 68, 'and the score is the deterministic one');

  const debug = JSON.parse(await read('debug@4.4.1', 'report.json'));
  assert.equal(debug.ai.status, 'skipped', 'nothing to interpret, so no model was called');
});

test('each example demonstrates what its README says', async () => {
  const verdicts = {};
  for (const directory of await exampleDirectories()) verdicts[directory] = JSON.parse(await read(directory, 'report.json'));

  const debug = verdicts['debug@4.4.1'];
  assert.equal(debug.summary.verdict, 'no-differences');
  assert.equal(debug.summary.riskScore, 0);
  assert.deepEqual(debug.findings.filter((f) => f.severity !== 'info'), [], 'a benign package has nothing to review');

  const mitt = verdicts['mitt@3.0.1'];
  assert.equal(mitt.summary.verdict, 'needs-review', 'build output exists and nothing can explain it yet');
  assert.equal(mitt.summary.riskScore, 0, 'but nothing in it matched a security rule');
  assert.deepEqual(mitt.findings, []);

  const tampered = verdicts['tampered-demo'];
  assert.equal(tampered.summary.verdict, 'suspicious');
  assert.ok(tampered.summary.riskScore >= 60);
  const rules = tampered.findings.map((f) => f.ruleId);
  for (const rule of ['install-script-added', 'integrity-mismatch', 'install-script-runs-unsourced-file']) assert.ok(rules.includes(rule), rule);
  const strong = new Set(tampered.findings.filter((f) => ['high', 'critical'].includes(f.severity)).map((f) => f.ruleId));
  assert.ok(strong.size >= 2, 'suspicious needs two distinct strong rules');
});

test('the tampered example matches the tarball committed beside it', async () => {
  const report = JSON.parse(await read('tampered-demo', 'report.json'));
  const tarball = await read('tampered-demo', 'debug-4.4.1-tampered.tgz');
  assert.equal(report.package.integrity.actual, `sha512-${createHash('sha512').update(tarball).digest('base64')}`);
  assert.equal(report.package.integrity.verified, false);

  const files = Object.fromEntries(report.files.map((file) => [file.path, file.status]));
  assert.equal(files['lib/telemetry.min.js'], 'package-only');
  assert.equal(files['package.json'], 'modified');
  assert.equal(files['src/node.js'], 'modified');
  assert.deepEqual(report.manifest.installScripts.package, { postinstall: 'node lib/telemetry.min.js' });
  assert.deepEqual(report.manifest.installScripts.source, {});
  assert.ok(report.manifest.changes.some((c) => c.field === 'scripts.postinstall' && c.change === 'added'));
  const integrity = report.findings.find((f) => f.ruleId === 'integrity-mismatch');
  assert.equal(integrity.scope, 'package');
  assert.match(integrity.evidence[0].snippet, new RegExp(report.package.integrity.actual.slice(0, 30)));
});

test('the registry examples were verified against the registry checksum and resolved to an exact commit', async () => {
  for (const directory of await exampleDirectories()) {
    const report = JSON.parse(await read(directory, 'report.json'));
    if (report.input.source !== 'registry') continue;
    assert.equal(report.package.integrity.verified, true, directory);
    assert.equal(report.source.confidence, 'exact-commit', directory);
    assert.match(report.source.ref.commit, /^[0-9a-f]{40}$/, directory);
  }
});
