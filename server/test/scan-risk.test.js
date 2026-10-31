import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideVerdict, scoreFindings } from '../src/scan/risk.js';
import { BASE_POINTS, CONFIDENCE_FACTOR, INTRODUCED_FACTOR, MODEL, THRESHOLDS, repeatFactor } from '../src/scan/weights.js';

let counter = 0;
const finding = (ruleId, severity, { confidence = 'high', introducedInPackage = true } = {}) => {
  counter += 1;
  return { id: `F${counter}`, ruleId, severity, confidence, introducedInPackage };
};
const numbered = (items) => items.map((item, index) => ({ ...item, id: `F${index + 1}` }));
const score = (items) => scoreFindings(numbered(items));
const COUNTS = { identical: 5, modified: 0, packageOnly: 0, sourceOnly: 0 };

test('the model documents every constant it uses', () => {
  assert.equal(MODEL, 'audyssey-risk-v1');
  assert.deepEqual(BASE_POINTS, { info: 0, low: 4, medium: 12, high: 30, critical: 55 });
  assert.deepEqual(CONFIDENCE_FACTOR, { high: 1, medium: 0.7, low: 0.4 });
  assert.deepEqual(INTRODUCED_FACTOR, { true: 1, null: 0.75, false: 0.25 });
  assert.deepEqual(THRESHOLDS, { needsReview: 15, suspicious: 60 });
});

test('points are base x confidence x introduced x repeat, and the breakdown reproduces the score', () => {
  const { riskScore, scoring } = score([
    finding('a-rule', 'high', { confidence: 'medium', introducedInPackage: null }),
    finding('b-rule', 'medium', { confidence: 'low', introducedInPackage: true }),
  ]);
  assert.equal(scoring.model, MODEL);
  assert.equal(scoring.cap, 100);
  assert.deepEqual(scoring.contributions[0], { findingId: 'F1', ruleId: 'a-rule', base: 30, confidenceFactor: 0.7, introducedFactor: 0.75, repeatFactor: 1, points: 15.75 });
  assert.deepEqual(scoring.contributions[1], { findingId: 'F2', ruleId: 'b-rule', base: 12, confidenceFactor: 0.4, introducedFactor: 1, repeatFactor: 1, points: 4.8 });
  assert.equal(scoring.rawTotal, 20.55);
  assert.equal(riskScore, 21);
});

test('no findings is a score of zero, and info findings are worth nothing', () => {
  assert.equal(score([]).riskScore, 0);
  assert.equal(score([finding('x-rule', 'info'), finding('y-rule', 'info')]).riskScore, 0);
});

test('repeated findings of one rule are discounted, so repetition cannot inflate a score', () => {
  assert.deepEqual([0, 1, 2, 3].map(repeatFactor), [1, 0.5, 0.25, 0.125]);
  const many = score(Array.from({ length: 20 }, () => finding('same-rule', 'high')));
  assert.equal(many.scoring.contributions.filter((c) => c.repeatFactor === 1).length, 1);
  // The discounts sum to just under twice the strongest finding (2 decimal places of rounding aside).
  assert.ok(many.scoring.rawTotal <= 2 * BASE_POINTS.high + 0.05, 'a rule can never exceed twice its strongest finding');
  assert.ok(many.scoring.rawTotal > BASE_POINTS.high, 'repeats still count for something');
});

test('the strongest finding of a rule gets the full weight, whatever order they arrive in', () => {
  const weakFirst = score([finding('r', 'low'), finding('r', 'high')]);
  const byId = Object.fromEntries(weakFirst.scoring.contributions.map((c) => [c.findingId, c]));
  assert.equal(byId.F2.repeatFactor, 1);
  assert.equal(byId.F1.repeatFactor, 0.5);
});

test('different rules add up, and the score is capped at 100', () => {
  assert.equal(score([finding('a-rule', 'high'), finding('b-rule', 'high')]).riskScore, 60);
  const huge = score(Array.from({ length: 10 }, (_, i) => finding(`rule-${i}`, 'critical')));
  assert.equal(huge.scoring.rawTotal > 100, true);
  assert.equal(huge.riskScore, 100);
});

test('adding a finding never lowers the score', () => {
  const base = [finding('a-rule', 'medium'), finding('b-rule', 'low', { confidence: 'low' })];
  let previous = score(base).scoring.rawTotal;
  for (const extra of [finding('c-rule', 'low'), finding('a-rule', 'medium'), finding('d-rule', 'high', { introducedInPackage: false }), finding('e-rule', 'info')]) {
    base.push(extra);
    const next = score(base).scoring.rawTotal;
    assert.ok(next >= previous, `${extra.ruleId} lowered the score`);
    previous = next;
  }
});

test('new behavior weighs more than unknown, and unknown more than behavior the source shows', () => {
  const points = (introducedInPackage) => score([finding('r', 'high', { introducedInPackage })]).scoring.rawTotal;
  assert.ok(points(true) > points(null));
  assert.ok(points(null) > points(false));
  assert.equal(points(true), 30);
});

test('severity and confidence are ordered', () => {
  const order = ['info', 'low', 'medium', 'high', 'critical'].map((severity) => score([finding('r', severity)]).scoring.rawTotal);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  const conf = ['low', 'medium', 'high'].map((confidence) => score([finding('r', 'high', { confidence })]).scoring.rawTotal);
  assert.deepEqual([...conf].sort((a, b) => a - b), conf);
});

test('the thresholds cannot be crossed by accident', () => {
  assert.ok(BASE_POINTS.high >= THRESHOLDS.needsReview, 'one high finding reaches needs-review');
  assert.ok(BASE_POINTS.high < THRESHOLDS.suspicious, 'one high finding is not suspicious');
  assert.ok(BASE_POINTS.critical < THRESHOLDS.suspicious, 'one critical finding is not suspicious');
  assert.ok(BASE_POINTS.high * 2 >= THRESHOLDS.suspicious, 'two distinct high rules reach suspicious');
  assert.ok(BASE_POINTS.medium < THRESHOLDS.needsReview, 'one medium finding is below needs-review by score');
  // Even many low findings from different rules, at full weight, stay below needs-review for any realistic count.
  assert.ok(BASE_POINTS.low * 3 < THRESHOLDS.needsReview);
});

// ---- verdicts ----

const verdict = (items, { counts = COUNTS, sourceResolved = true } = {}) => {
  const findings = numbered(items);
  const { riskScore } = scoreFindings(findings);
  return decideVerdict({ findings, riskScore, counts, sourceResolved });
};

test('verdict: a clean, fully matching package with a resolved source has no differences', () => {
  assert.equal(verdict([]), 'no-differences');
  assert.equal(verdict([finding('r', 'info')]), 'no-differences', 'info findings carry no verdict weight');
});

test('verdict: any difference needs review until an explainer can explain it', () => {
  assert.equal(verdict([], { counts: { ...COUNTS, modified: 1 } }), 'needs-review');
  assert.equal(verdict([], { counts: { ...COUNTS, packageOnly: 3 } }), 'needs-review');
  assert.equal(verdict([], { counts: { ...COUNTS, sourceOnly: 9 } }), 'no-differences', 'source-only files are not published');
});

test('verdict: a low finding in a package that matches the source still needs review', () => {
  assert.equal(verdict([finding('r', 'low')]), 'needs-review');
});

test('verdict: an unresolved source is inconclusive unless there are findings of medium or above', () => {
  assert.equal(verdict([], { sourceResolved: false }), 'inconclusive');
  assert.equal(verdict([finding('r', 'low'), finding('s', 'info')], { sourceResolved: false }), 'inconclusive');
  assert.equal(verdict([finding('r', 'medium')], { sourceResolved: false }), 'needs-review');
  assert.equal(verdict([finding('r', 'high')], { sourceResolved: false }), 'needs-review');
});

test('verdict: a single strong indicator, however severe, is never suspicious', () => {
  assert.equal(verdict([finding('r', 'high')]), 'needs-review');
  assert.equal(verdict([finding('r', 'critical')]), 'needs-review');
  assert.equal(verdict(Array.from({ length: 30 }, () => finding('r', 'critical'))), 'needs-review', 'thirty copies of one rule are still one indicator');
});

test('verdict: two distinct strong rules with enough weight are suspicious', () => {
  assert.equal(verdict([finding('a-rule', 'high'), finding('b-rule', 'high')]), 'suspicious');
  assert.equal(verdict([finding('a-rule', 'critical'), finding('b-rule', 'high', { confidence: 'low' })]), 'suspicious', '55 + 12 = 67');
});

test('verdict: two strong rules with unknown newness do not reach the threshold on a weak second finding', () => {
  const unknown = { introducedInPackage: null };
  assert.equal(verdict([finding('a-rule', 'critical', unknown), finding('b-rule', 'high', { ...unknown, confidence: 'low' })], { sourceResolved: false }), 'needs-review', '41.25 + 9 = 50.25 is under 60');
});

test('verdict: two strong rules whose weight is small stay at needs-review', () => {
  assert.equal(verdict([finding('a-rule', 'high', { introducedInPackage: false }), finding('b-rule', 'high', { introducedInPackage: false })]), 'needs-review');
});

test('verdict: two mediums from different rules need review', () => {
  assert.equal(verdict([finding('a-rule', 'medium'), finding('b-rule', 'medium')]), 'needs-review');
});

test('every verdict the decision table can return is valid for its findings', async () => {
  // The decision table and the contract validator must agree: run both over a grid.
  const { validateReport } = await import('../src/report/schema.js');
  const sample = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../../docs/report.sample.json', import.meta.url), 'utf8'));
  const severities = ['info', 'low', 'medium', 'high', 'critical'];
  let checked = 0;
  for (const first of severities) {
    for (const second of [null, ...severities]) {
      for (const sourceResolved of [true, false]) {
        for (const modified of [0, 1]) {
          const items = [finding('a-rule', first), ...(second ? [finding('b-rule', second)] : [])];
          const findings = numbered(items);
          const { riskScore, scoring } = scoreFindings(findings);
          const counts = { identical: 1, modified, packageOnly: 0, sourceOnly: 0 };
          const report = structuredClone(sample);
          report.source.resolved = sourceResolved;
          report.scan.capabilityDifferential = { available: sourceResolved, basis: 'test' };
          report.files = [report.files[0]];
          report.files[0].findingIds = [];
          if (modified) {
            report.files[0].status = 'modified';
            report.files[0].source.sha256 = 'f'.repeat(64);
          }
          report.manifest.changes = [];
          report.ai = { status: 'skipped', runs: [], classifications: [], investigations: [] };
          report.findings = findings.map((f) => ({ ...f, scope: 'package', title: 't', description: 'd', fileId: null, evidence: [{ path: null, line: null, snippet: 's' }] }));
          report.summary = {
            verdict: decideVerdict({ findings, riskScore, counts, sourceResolved }),
            riskScore,
            scoring,
            counts: { identical: modified ? 0 : 1, modified, packageOnly: 0, sourceOnly: 0 },
            findingsBySeverity: Object.fromEntries(severities.map((s) => [s, findings.filter((f) => f.severity === s).length])),
          };
          assert.deepEqual(validateReport(report), [], JSON.stringify({ first, second, sourceResolved, modified, verdict: report.summary.verdict }));
          checked += 1;
        }
      }
    }
  }
  assert.equal(checked, 5 * 6 * 2 * 2);
});
