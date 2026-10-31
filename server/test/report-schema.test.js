import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateReport } from '../src/report/schema.js';

const sampleUrl = new URL('../../docs/report.sample.json', import.meta.url);
const loadSample = async () => JSON.parse(await readFile(sampleUrl, 'utf8'));

test('the documented sample report satisfies the contract', async () => {
  assert.deepEqual(validateReport(await loadSample()), []);
});

test('rejects findings without evidence or pointing at unknown files', async () => {
  const report = await loadSample();
  report.findings[0].evidence = [];
  report.findings[1].fileId = 'f999';
  const errors = validateReport(report);
  assert.ok(errors.some((e) => e.includes('findings[0] must include at least one evidence item')));
  assert.ok(errors.some((e) => e.includes('findings[1].fileId "f999" does not match any file')));
});

test('rejects AI output that refers to files or findings that do not exist', async () => {
  const report = await loadSample();
  report.ai.classifications.push({ fileId: 'invented-file', label: 'expected-artifact', rationale: 'x' });
  report.ai.investigations.push({ findingId: 'F42', explanation: 'x', implications: 'x', uncertainty: 'x' });
  const errors = validateReport(report);
  assert.ok(errors.some((e) => e.includes('"invented-file" does not match any file')));
  assert.ok(errors.some((e) => e.includes('"F42" does not match any finding')));
});

test('rejects summary counts that disagree with the file list', async () => {
  const report = await loadSample();
  report.summary.counts.packageOnly = 0;
  report.summary.findingsBySeverity.high = 0;
  const errors = validateReport(report);
  assert.ok(errors.some((e) => e.startsWith('summary.counts.packageOnly')));
  assert.ok(errors.some((e) => e.startsWith('summary.findingsBySeverity.high')));
});

test('rejects inconsistent hashes and statuses', async () => {
  const report = await loadSample();
  report.files[0].source.sha256 = 'different';
  report.files[1].status = 'unknown-status';
  const errors = validateReport(report);
  assert.ok(errors.some((e) => e.includes('files[0] is identical but its hashes differ')));
  assert.ok(errors.some((e) => e.includes('files[1].status must be one of')));
});

test('a null riskScore is valid only for an inconclusive verdict', async () => {
  const report = await loadSample();
  report.summary.riskScore = null;
  assert.ok(validateReport(report).some((e) => e.includes('may be null only when summary.verdict is inconclusive')));

  report.summary.verdict = 'inconclusive';
  assert.deepEqual(validateReport(report), []);
});

test('still rejects out-of-range or non-integer risk scores', async () => {
  for (const bad of [-1, 101, 4.5, '80', undefined]) {
    const report = await loadSample();
    report.summary.riskScore = bad;
    assert.ok(validateReport(report).some((e) => e.includes('riskScore must be null or an integer')), String(bad));
  }
});

test('accepts the unclassified explanation category', async () => {
  const report = await loadSample();
  report.files[1].explanation.category = 'unclassified';
  assert.deepEqual(validateReport(report), []);
});

test('validates the manifest section', async () => {
  const report = await loadSample();
  report.manifest.compared = 'yes';
  report.manifest.changes[0].change = 'renamed';
  report.manifest.changes.push({ field: '', change: 'added' });
  report.manifest.installScripts.source = null;
  const errors = validateReport(report);
  assert.ok(errors.some((e) => e.includes('manifest.compared must be a boolean')));
  assert.ok(errors.some((e) => e.includes('manifest.changes[0].change must be one of added, removed, changed')));
  assert.ok(errors.some((e) => e.includes('manifest.changes[1].field must be a non-empty string')));
  assert.ok(errors.some((e) => e.includes('manifest.installScripts.source must be an object')));

  delete report.manifest;
  assert.ok(validateReport(report).includes('manifest must be an object'));
});

test('validates the optional file entry type', async () => {
  const report = await loadSample();
  report.files[0].package.type = 'symlink';
  assert.deepEqual(validateReport(report), []);
  report.files[0].package.type = 'socket';
  assert.ok(validateReport(report).some((e) => e.includes('files[0].package.type must be one of file, symlink, hardlink')));
});

test('rejects a report written for a different schema version', async () => {
  const report = await loadSample();
  report.schemaVersion = '0.1.0';
  assert.ok(validateReport(report).some((e) => e.startsWith('schemaVersion must be 0.2.0')));
});

test('rejects non-object input', () => {
  assert.deepEqual(validateReport(null), ['report must be an object']);
});
