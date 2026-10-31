import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLED_REPORTS } from '../src/lib/examples.js';
import {
  DEFAULT_FILTERS, buildFileRows, countBy, describeIntegrity, describeVerdict, filterFiles, filterFindings,
  formatBytes, formatDuration, isUnexplained, modelFor, safeRepositoryUrl, shortHash, sortFindings, summarizeReport,
} from '../src/lib/report-view.js';

const report = (id) => BUNDLED_REPORTS.find((entry) => entry.id === id).report;
const rowsOf = (id) => buildFileRows(report(id));

test('every verdict the contract allows has display copy, and none claims safety', () => {
  for (const verdict of ['no-differences', 'expected-differences', 'needs-review', 'suspicious', 'inconclusive']) {
    const view = describeVerdict(verdict);
    assert.ok(view.label && view.headline && view.detail, verdict);
    const text = `${view.headline} ${view.detail}`;
    assert.doesNotMatch(text, /malicious/i, verdict);
    assert.doesNotMatch(text.replace(/not a guarantee that the code is safe/g, ''), /\bsafe\b/i, `${verdict} only mentions safety to deny it`);
  }
  assert.deepEqual(describeVerdict('something-new').tone, 'neutral', 'an unknown verdict degrades instead of crashing');
  assert.equal(describeVerdict('suspicious').tone, 'danger');
  assert.equal(describeVerdict('expected-differences').tone, 'info');
});

test('summaries come straight from the report, including a "not scored" report', () => {
  const tampered = summarizeReport(report('tampered'));
  assert.equal(tampered.score, 68);
  assert.equal(tampered.verdictId, 'suspicious');
  assert.equal(tampered.integrity.state, 'danger');
  assert.equal(tampered.inputKind, 'Local tarball');
  assert.equal(tampered.severities.find((s) => s.name === 'high').count, 2);
  assert.equal(tampered.unexplainedCount, 3);

  const mitt = summarizeReport(report('mitt'));
  assert.equal(mitt.verdictId, 'expected-differences');
  assert.equal(mitt.unexplainedCount, 0);
  assert.equal(mitt.explainedCount, mitt.differingCount);
  assert.equal(mitt.integrity.state, 'ok');

  const unscored = structuredClone(report('mitt'));
  unscored.summary.riskScore = null;
  assert.equal(summarizeReport(unscored).scored, false);
});

test('rows put what needs attention first and join findings and model opinions by id', () => {
  const rows = rowsOf('tampered');
  assert.ok(rows.slice(0, 3).every((row) => row.unexplained), 'unexplained differences lead');
  const withFinding = rows.find((row) => row.findings.length > 0);
  assert.ok(withFinding && withFinding.findings.every((f) => f.fileId === withFinding.id));
  const opinion = rows.find((row) => row.opinion);
  assert.ok(opinion && opinion.opinion.fileId === opinion.id);
  assert.ok(rows.every((row) => typeof row.unexplained === 'boolean'));
  assert.equal(rows.length, report('tampered').files.length, 'nothing is dropped');
});

test('"unexplained" means a difference that no evidence explains, never a missing or identical file', () => {
  const mitt = rowsOf('mitt');
  assert.equal(mitt.filter((r) => r.unexplained).length, 0);
  assert.ok(mitt.find((r) => r.path === 'dist/mitt.js').explanation.category === 'generated-artifact');
  const notPublished = mitt.find((r) => r.explanation.category === 'not-published');
  assert.equal(isUnexplained(notPublished), false, 'a source-only file is not a difference in the package');
  assert.equal(isUnexplained({ status: 'modified', explanation: { category: 'unclassified' } }), true);
  assert.equal(isUnexplained({ status: 'identical', explanation: { category: 'identical' } }), false);
});

test('filters: search, status, category and focus combine', () => {
  const rows = rowsOf('mitt');
  assert.equal(filterFiles(rows).length, rows.length, 'defaults show everything');
  assert.deepEqual(filterFiles(rows, { ...DEFAULT_FILTERS, query: 'DIST/MITT.JS' }).map((r) => r.path).sort(), ['dist/mitt.js', 'dist/mitt.js.map']);
  assert.ok(filterFiles(rows, { ...DEFAULT_FILTERS, status: 'package-only' }).every((r) => r.status === 'package-only'));
  assert.ok(filterFiles(rows, { ...DEFAULT_FILTERS, category: 'generated-artifact' }).every((r) => r.explanation.category === 'generated-artifact'));
  assert.equal(filterFiles(rows, { ...DEFAULT_FILTERS, focus: 'unexplained' }).length, 0);
  assert.equal(filterFiles(rows, { ...DEFAULT_FILTERS, status: 'identical', category: 'generated-artifact' }).length, 0, 'filters intersect');
  assert.equal(filterFiles(rows, { ...DEFAULT_FILTERS, query: 'no-such-file-anywhere' }).length, 0);
  assert.ok(filterFiles(rows, { ...DEFAULT_FILTERS, query: '  ' }).length === rows.length, 'blank search matches everything');

  const tampered = rowsOf('tampered');
  assert.equal(filterFiles(tampered, { ...DEFAULT_FILTERS, focus: 'unexplained' }).length, 3);
  assert.ok(filterFiles(tampered, { ...DEFAULT_FILTERS, focus: 'findings' }).every((r) => r.findings.length > 0));
  assert.ok(filterFiles(tampered, { ...DEFAULT_FILTERS, focus: 'ai-disagrees' }).every((r) => r.opinion.label !== 'expected-artifact'));
});

test('search matches a hash prefix on either side, and regex characters are plain text', () => {
  const rows = rowsOf('mitt');
  const target = rows.find((r) => r.package);
  assert.deepEqual(filterFiles(rows, { ...DEFAULT_FILTERS, query: target.package.sha256.slice(0, 10) }).map((r) => r.id).includes(target.id), true);
  assert.doesNotThrow(() => filterFiles(rows, { ...DEFAULT_FILTERS, query: '(((*[\\' }));
  assert.equal(filterFiles(rows, { ...DEFAULT_FILTERS, query: '.*' }).length, 0, '".*" is not a pattern');
});

test('facet counts add up', () => {
  const rows = rowsOf('tampered');
  const statuses = countBy(rows, 'status');
  assert.equal([...statuses.values()].reduce((a, b) => a + b, 0), rows.length);
  assert.equal(countBy(rows, 'category').get('unexplained'), 3);
});

test('findings are ordered strongest first and filtered by severity', () => {
  const findings = report('tampered').findings;
  const sorted = sortFindings(findings);
  const order = ['critical', 'high', 'medium', 'low', 'info'];
  assert.deepEqual(sorted.map((f) => order.indexOf(f.severity)), sorted.map((f) => order.indexOf(f.severity)).sort((a, b) => a - b));
  assert.equal(filterFindings(sorted, 'all').length, findings.length);
  assert.ok(filterFindings(sorted, 'high').every((f) => f.severity === 'high'));
  assert.equal(filterFindings(sorted, 'critical').length, 0);
  assert.notEqual(sorted, findings, 'the report is not mutated');
});

test('model lookup and an empty report render without special cases', () => {
  assert.equal(modelFor(report('tampered'), 'investigation').model, 'deepseek-r1:8b');
  assert.equal(modelFor(report('debug'), 'classification'), null, 'no model ran');

  const empty = structuredClone(report('debug'));
  empty.files = [];
  empty.findings = [];
  empty.ai.classifications = [];
  empty.ai.investigations = [];
  assert.deepEqual(buildFileRows(empty), []);
  assert.equal(summarizeReport(empty).unexplainedCount, 0);
});

test('formatting helpers handle junk', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 kB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(undefined), '—');
  assert.equal(formatBytes(-1), '—');
  assert.equal(shortHash('abcdef0123456789', 6), 'abcdef');
  assert.equal(shortHash(null), '—');
  assert.equal(formatDuration(850), '850 ms');
  assert.equal(formatDuration(9111), '9.1 s');
  assert.equal(formatDuration(NaN), '—');
  assert.equal(describeIntegrity({ verified: null }).state, 'neutral');
});

test('only https GitHub repositories become links', () => {
  assert.equal(safeRepositoryUrl('https://github.com/debug-js/debug'), 'https://github.com/debug-js/debug');
  for (const bad of ['javascript:alert(1)', 'http://github.com/a/b', 'https://github.com.evil.test/a/b', 'https://evil.test/github.com', 'data:text/html,<b>', '', null, undefined, 5]) {
    assert.equal(safeRepositoryUrl(bad), null, String(bad));
  }
});

test('package text is carried as data: nothing in a report is turned into markup', () => {
  const hostile = structuredClone(report('tampered'));
  hostile.findings[0].title = '<img src=x onerror=alert(1)>';
  const rows = buildFileRows(hostile);
  const title = rows.flatMap((r) => r.findings).find((f) => f.id === hostile.findings[0].id)?.title ?? hostile.findings[0].title;
  assert.equal(title, '<img src=x onerror=alert(1)>', 'kept verbatim; React renders it as text');
});
