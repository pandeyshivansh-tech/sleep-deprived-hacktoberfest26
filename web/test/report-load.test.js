import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_REPORT_BYTES, acceptReport, parseReportText } from '../src/lib/report-load.js';
import { BUNDLED_REPORTS } from '../src/lib/examples.js';

const clone = (value) => structuredClone(value);
const tampered = () => clone(BUNDLED_REPORTS.find((entry) => entry.id === 'tampered').report);

test('every bundled example is a real report and passes the backend contract', () => {
  assert.equal(BUNDLED_REPORTS.length, 3);
  for (const { id, report } of BUNDLED_REPORTS) {
    assert.equal(report.$comment, undefined, `${id} is tool output, not a hand-written sample`);
    const result = parseReportText(JSON.stringify(report));
    assert.equal(result.ok, true, id);
    assert.equal(acceptReport(report).ok, true, id);
  }
});

test('describes each way a file can fail to be a report', () => {
  assert.equal(parseReportText('').kind, 'empty');
  assert.equal(parseReportText('   \n').kind, 'empty');
  assert.equal(parseReportText(undefined).kind, 'empty');
  assert.equal(parseReportText('{not json').kind, 'not-json');
  assert.equal(parseReportText('[]').kind, 'not-a-report');
  assert.equal(parseReportText('null').kind, 'not-a-report');
  assert.equal(parseReportText('42').kind, 'not-a-report');
  assert.equal(parseReportText('{"hello":"world"}').kind, 'not-a-report');
  assert.equal(parseReportText(`"${'x'.repeat(MAX_REPORT_BYTES)}"`).kind, 'too-large');
});

test('a different schema version is rejected with a clear message, not half-rendered', () => {
  const report = tampered();
  report.schemaVersion = '0.2.0';
  const result = parseReportText(JSON.stringify(report));
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'wrong-version');
  assert.match(result.message, /0\.3\.0.*"0\.2\.0"/);
});

test('contract violations are listed, capped, and block rendering', () => {
  const report = tampered();
  report.summary.verdict = 'expected-differences';
  const result = parseReportText(JSON.stringify(report));
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'invalid');
  assert.ok(result.problems.length > 0);

  const broken = tampered();
  broken.files = broken.files.map((file) => ({ ...file, status: 'bogus' }));
  const many = parseReportText(JSON.stringify(broken));
  assert.equal(many.ok, false);
  assert.ok(many.problems.length <= 12);
  assert.equal(many.problems.length + many.moreProblems >= many.problems.length, true);
});

test('a report with a forged score or an invented finding reference does not validate', () => {
  const forged = tampered();
  forged.summary.riskScore = 0;
  assert.equal(parseReportText(JSON.stringify(forged)).ok, false, 'score must match summary.scoring');

  const dangling = tampered();
  dangling.ai.classifications.push({ fileId: 'f999', label: 'expected-artifact', rationale: 'invented' });
  assert.equal(parseReportText(JSON.stringify(dangling)).ok, false, 'AI entries may only reference real files');
});

test('hostile JSON keys do not pollute prototypes or throw', () => {
  const result = parseReportText('{"__proto__":{"polluted":true},"schemaVersion":"0.3.0"}');
  assert.equal(result.ok, false);
  assert.equal({}.polluted, undefined);
});
