import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLED_REPORTS } from '../src/lib/examples.js';
import { PIPELINE, findingExample, parityRows, parityStats } from '../src/lib/landing.js';

const report = (id) => BUNDLED_REPORTS.find((entry) => entry.id === id).report;

test('the parity map is the real comparison: differing files lead, hashes come from the report', () => {
  const { rows, total } = parityRows(report('tampered'));
  assert.equal(total, 8, 'published files only; source-only files are not installed');
  assert.deepEqual(rows.slice(0, 3).map((r) => r.status), ['package-only', 'modified', 'modified']);
  assert.equal(rows[0].path, 'lib/telemetry.min.js');
  assert.equal(rows[0].sourceHash, null);
  assert.match(rows[1].packageHash, /^[0-9a-f]{8}$/);
  assert.notEqual(rows[1].packageHash, rows[1].sourceHash);
  const identical = rows.filter((r) => r.status === 'identical');
  assert.ok(identical.length > 0 && identical.every((r) => r.packageHash === r.sourceHash));
  assert.ok(rows.every((r) => r.status !== 'source-only'));
});

test('limits and stats', () => {
  assert.equal(parityRows(report('tampered'), 3).rows.length, 3);
  const clean = parityStats(report('debug'));
  assert.deepEqual({ differing: clean.differing, score: clean.score, verdict: clean.verdict }, { differing: 0, score: 0, verdict: 'no-differences' });
  const bad = parityStats(report('tampered'));
  assert.deepEqual({ differing: bad.differing, score: bad.score, verdict: bad.verdict, findings: bad.findings }, { differing: 3, score: 68, verdict: 'suspicious', findings: 4 });
});

test('finding examples quote real evidence, and unknown rules are null', () => {
  const found = findingExample(report('tampered'), 'install-script-added');
  assert.equal(found.severity, 'high');
  assert.equal(found.location, 'package.json:32');
  assert.match(found.snippet, /postinstall/);
  assert.equal(findingExample(report('tampered'), 'no-such-rule'), null);
  assert.equal(findingExample(report('debug'), 'install-script-added'), null);
});

test('the pipeline description lists real stages and promises nothing the code does not do', () => {
  assert.equal(PIPELINE.length, 6);
  const text = PIPELINE.map((s) => s.text).join(' ');
  assert.doesNotMatch(text, /signed|attestation|AST|SLSA|in-toto|GPG/i);
});
