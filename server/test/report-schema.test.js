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

test('rejects non-object input', () => {
  assert.deepEqual(validateReport(null), ['report must be an object']);
});
