import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MAX_SKIPPED_LISTED, SCHEMA_VERSION, validateReport } from '../src/report/schema.js';

const sampleUrl = new URL('../../docs/report.sample.json', import.meta.url);
const loadSample = async () => JSON.parse(await readFile(sampleUrl, 'utf8'));

const has = (errors, text) => errors.some((error) => error.includes(text));
const SEVERITY_ZERO = () => ({ info: 0, low: 0, medium: 0, high: 0, critical: 0 });
const BASE = { info: 0, low: 4, medium: 12, high: 30, critical: 55 };
const round2 = (value) => Math.round(value * 100) / 100;

// A report where the scanner did not run: what the M1 pipeline emits.
function unscanned(report) {
  report.findings = [];
  for (const file of report.files) file.findingIds = [];
  report.summary.findingsBySeverity = SEVERITY_ZERO();
  report.summary.riskScore = null;
  report.summary.scoring = null;
  report.summary.verdict = 'inconclusive';
  report.scan = {
    performed: false,
    rulesVersion: null,
    rules: [],
    filesScanned: 0,
    filesNotApplicable: 0,
    filesSkipped: [],
    filesSkippedCount: 0,
    capabilityDifferential: { available: false, basis: null },
  };
  report.ai.investigations = [];
  return report;
}

// Recomputes counts, links and the score breakdown from `report.findings`, with
// every factor 1, so tests can build consistent scored reports by hand.
function rescore(report) {
  report.summary.findingsBySeverity = SEVERITY_ZERO();
  for (const finding of report.findings) report.summary.findingsBySeverity[finding.severity] += 1;
  for (const file of report.files) file.findingIds = report.findings.filter((f) => f.fileId === file.id).map((f) => f.id);
  const contributions = report.findings.map((finding) => ({
    findingId: finding.id,
    ruleId: finding.ruleId,
    base: BASE[finding.severity],
    confidenceFactor: 1,
    introducedFactor: 1,
    repeatFactor: 1,
    points: BASE[finding.severity],
  }));
  const rawTotal = round2(contributions.reduce((sum, item) => sum + item.points, 0));
  report.summary.scoring = { model: 'test-model', cap: 100, rawTotal, contributions };
  report.summary.riskScore = Math.min(100, Math.round(rawTotal));
  return report;
}

const finding = (id, ruleId, severity, fileId, path) => ({
  id,
  ruleId,
  severity,
  confidence: 'high',
  scope: 'file',
  title: 'title',
  description: 'description',
  fileId,
  introducedInPackage: true,
  evidence: [{ path, line: 1, snippet: 'x' }],
});

const integrityFinding = (id = 'F9') => ({
  id,
  ruleId: 'integrity-mismatch',
  severity: 'high',
  confidence: 'high',
  scope: 'package',
  title: 'Tarball does not match the registry checksum',
  description: 'The analyzed bytes differ from the checksum the registry publishes.',
  fileId: null,
  introducedInPackage: null,
  evidence: [{ path: null, line: null, snippet: 'expected sha512-AAA, got sha512-BBB' }],
});

// A small, valid report in which every published file matches the source.
async function cleanReport() {
  const report = await loadSample();
  report.files = [report.files[0], report.files[5]];
  report.summary.counts = { identical: 1, modified: 0, packageOnly: 0, sourceOnly: 1 };
  report.summary.verdict = 'no-differences';
  report.findings = [];
  report.manifest = { compared: true, reason: null, changes: [], installScripts: { package: {}, source: {} } };
  report.ai = { status: 'skipped', runs: [], classifications: [], investigations: [] };
  report.scan.rules = [{ id: 'dynamic-code-execution', version: 1 }];
  report.scan.filesScanned = 0;
  report.scan.filesNotApplicable = 1;
  return rescore(report);
}

test('the documented sample report satisfies the contract', async () => {
  const report = await loadSample();
  assert.equal(report.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(validateReport(report), []);
});

test('rejects a report written for a different schema version', async () => {
  const report = await loadSample();
  report.schemaVersion = '0.2.0';
  assert.ok(has(validateReport(report), `schemaVersion must be ${SCHEMA_VERSION}`));
});

test('rejects non-object input and a missing scan section', async () => {
  assert.deepEqual(validateReport(null), ['report must be an object']);
  const report = await loadSample();
  delete report.scan;
  assert.ok(validateReport(report).includes('scan must be an object'));
});

test('rejects findings without evidence or pointing at unknown files', async () => {
  const report = await loadSample();
  report.findings[0].evidence = [];
  report.findings[1].fileId = 'f999';
  const errors = validateReport(report);
  assert.ok(has(errors, 'findings[0] must include at least one evidence item'));
  assert.ok(has(errors, 'findings[1].fileId "f999" does not match any file'));
});

test('rejects AI output that refers to files or findings that do not exist', async () => {
  const report = await loadSample();
  report.ai.classifications.push({ fileId: 'invented-file', label: 'expected-artifact', rationale: 'x' });
  report.ai.investigations.push({ findingId: 'F42', explanation: 'x', implications: 'x', uncertainty: 'x' });
  const errors = validateReport(report);
  assert.ok(has(errors, '"invented-file" does not match any file'));
  assert.ok(has(errors, '"F42" does not match any finding'));
});

test('rejects summary counts that disagree with the file list or findings', async () => {
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
  assert.ok(has(errors, 'files[0] is identical but its hashes differ'));
  assert.ok(has(errors, 'files[1].status must be one of'));
});

test('accepts the unclassified explanation category and the optional file entry type', async () => {
  const report = await loadSample();
  report.files[1].explanation.category = 'unclassified';
  report.files[0].package.type = 'symlink';
  assert.deepEqual(validateReport(report), []);
  report.files[0].package.type = 'socket';
  assert.ok(has(validateReport(report), 'files[0].package.type must be one of file, symlink, hardlink'));
});

test('validates the manifest section', async () => {
  const report = await loadSample();
  report.manifest.compared = 'yes';
  report.manifest.changes[0].change = 'renamed';
  report.manifest.changes.push({ field: '', change: 'added' });
  report.manifest.installScripts.source = null;
  const errors = validateReport(report);
  assert.ok(has(errors, 'manifest.compared must be a boolean'));
  assert.ok(has(errors, 'manifest.changes[0].change must be one of added, removed, changed'));
  assert.ok(has(errors, 'manifest.changes[1].field must be a non-empty string'));
  assert.ok(has(errors, 'manifest.installScripts.source must be an object'));
  delete report.manifest;
  assert.ok(validateReport(report).includes('manifest must be an object'));
});

// ---- findings: scope, evidence and links ----

test('evidence must point at a real file, with a positive line and a bounded snippet', async () => {
  const report = await loadSample();
  Object.assign(report.findings[0].evidence[0], { path: 'not/in/report.js', line: 0, snippet: 'x'.repeat(401) });
  report.findings[1].evidence[0].column = 0;
  report.findings[1].evidence[1].indicator = '';
  const errors = validateReport(report);
  assert.ok(has(errors, 'findings[0].evidence[0].path does not match any file'));
  assert.ok(has(errors, 'findings[0].evidence[0].line must be a positive integer'));
  assert.ok(has(errors, 'findings[0].evidence[0].snippet must be a string of at most 400 characters'));
  assert.ok(has(errors, 'findings[1].evidence[0].column must be a positive integer when present'));
  assert.ok(has(errors, 'findings[1].evidence[1].indicator must be a non-empty string'));
});

test('a package-scope finding has no file and may have path-less evidence', async () => {
  const report = await loadSample();
  report.findings.push(integrityFinding());
  assert.deepEqual(validateReport(rescore(report)), []);
});

test('scope and fileId must agree, and path-less evidence is for package scope only', async () => {
  const report = await loadSample();
  report.findings.push({ ...integrityFinding(), fileId: 'f1' });
  assert.ok(has(validateReport(rescore(report)), 'fileId must be null for a package-scope finding'));

  const second = await loadSample();
  second.findings[0].evidence[0] = { path: null, line: null, snippet: 'x' };
  assert.ok(has(validateReport(second), 'path may be null only for package-scope findings'));

  const third = await loadSample();
  third.findings[0].scope = 'galaxy';
  assert.ok(has(validateReport(third), 'findings[0].scope must be one of file, package'));

  const fourth = await loadSample();
  fourth.findings.push({ ...integrityFinding(), evidence: [{ path: null, line: 3, snippet: 'x' }] });
  assert.ok(has(validateReport(rescore(fourth)), 'line must be null when path is null'));
});

test('introducedInPackage may be true, false or null (unknown), nothing else', async () => {
  for (const value of [true, false, null]) {
    const report = await loadSample();
    report.findings[0].introducedInPackage = value;
    assert.deepEqual(validateReport(report), [], String(value));
  }
  const report = await loadSample();
  report.findings[0].introducedInPackage = 'yes';
  assert.ok(has(validateReport(report), 'findings[0].introducedInPackage must be true, false or null'));
});

test('rule ids must be kebab-case', async () => {
  const report = await loadSample();
  report.findings[0].ruleId = 'Install Script';
  assert.ok(has(validateReport(report), 'findings[0].ruleId must be a kebab-case rule id'));
});

test('file and finding links must agree in both directions', async () => {
  const missing = await loadSample();
  missing.files.find((f) => f.id === 'f5').findingIds = ['F3'];
  assert.ok(has(validateReport(missing), 'does not list its finding F2'));

  const wrongFile = await loadSample();
  wrongFile.files.find((f) => f.id === 'f2').findingIds.push('F2');
  assert.ok(has(validateReport(wrongFile), 'lists F2, which belongs to a different file'));

  const unknown = await loadSample();
  unknown.files[0].findingIds = ['F404'];
  assert.ok(has(validateReport(unknown), 'references unknown finding "F404"'));
});

// ---- score breakdown ----

test('riskScore and scoring are null together, and only when no scan was performed', async () => {
  const report = await loadSample();
  report.summary.scoring = null;
  assert.ok(has(validateReport(report), 'summary.scoring must describe how riskScore was computed'));

  const other = unscanned(await loadSample());
  other.summary.scoring = { model: 'x', cap: 100, rawTotal: 0, contributions: [] };
  assert.ok(has(validateReport(other), 'summary.scoring must be null when riskScore is null'));
});

test('the score must be reproducible from the breakdown', async () => {
  const wrongPoints = await loadSample();
  wrongPoints.summary.scoring.contributions[2].points = 9;
  assert.ok(has(validateReport(wrongPoints), 'contributions[2].points is 9 but base x confidenceFactor x introducedFactor x repeatFactor is 8.4'));

  const wrongTotal = await loadSample();
  wrongTotal.summary.scoring.rawTotal = 70;
  assert.ok(has(validateReport(wrongTotal), 'summary.scoring.rawTotal is 70 but the contributions add up to 68.4'));

  const wrongScore = await loadSample();
  wrongScore.summary.riskScore = 90;
  assert.ok(has(validateReport(wrongScore), 'summary.riskScore 90 does not equal min(100, round(rawTotal 68.4))'));

  const wrongCap = await loadSample();
  wrongCap.summary.scoring.cap = 200;
  assert.ok(has(validateReport(wrongCap), 'summary.scoring.cap must be 100'));
});

test('every finding is scored exactly once, against its own rule', async () => {
  const missing = await loadSample();
  missing.summary.scoring.contributions.pop();
  assert.ok(has(validateReport(missing), 'contributions has no entry for finding F3'));

  const twice = await loadSample();
  twice.summary.scoring.contributions.push({ ...twice.summary.scoring.contributions[0] });
  assert.ok(has(validateReport(twice), 'is listed twice'));

  const unknown = await loadSample();
  unknown.summary.scoring.contributions[0].findingId = 'F77';
  assert.ok(has(validateReport(unknown), 'contributions[0].findingId does not match any finding'));

  const wrongRule = await loadSample();
  wrongRule.summary.scoring.contributions[0].ruleId = 'something-else';
  assert.ok(has(validateReport(wrongRule), "ruleId does not match the finding's ruleId"));
});

test('scoring factors must be above 0 and at most 1', async () => {
  for (const [key, value] of [['confidenceFactor', 0], ['introducedFactor', 1.5], ['repeatFactor', -1], ['repeatFactor', '1']]) {
    const report = await loadSample();
    report.summary.scoring.contributions[0][key] = value;
    assert.ok(has(validateReport(report), `${key} must be a number above 0 and at most 1`), `${key}=${value}`);
  }
});

test('a repeated finding can be discounted, and the discount is part of the arithmetic', async () => {
  const report = await loadSample();
  report.findings.push({ ...finding('F4', 'obfuscated-code', 'medium', 'f5', 'lib/telemetry.min.js') });
  rescore(report);
  report.summary.scoring.contributions[3].repeatFactor = 0.5;
  report.summary.scoring.contributions[3].points = 6;
  report.summary.scoring.rawTotal = round2(report.summary.scoring.contributions.reduce((s, c) => s + c.points, 0));
  report.summary.riskScore = Math.min(100, Math.round(report.summary.scoring.rawTotal));
  assert.deepEqual(validateReport(report), []);
});

test('the score never exceeds the cap', async () => {
  const report = await loadSample();
  for (let n = 4; n <= 6; n += 1) report.findings.push(finding(`F${n}`, `rule-${n}`, 'critical', 'f5', 'lib/telemetry.min.js'));
  rescore(report);
  assert.equal(report.summary.scoring.rawTotal > 100, true);
  assert.equal(report.summary.riskScore, 100);
  assert.deepEqual(validateReport(report), []);
});

test('riskScore must be an integer in range when a scan was performed', async () => {
  for (const bad of [null, -1, 101, 4.5, '80', undefined]) {
    const report = await loadSample();
    report.summary.riskScore = bad;
    assert.ok(has(validateReport(report), 'summary.riskScore must be an integer from 0 to 100 when the scan was performed'), String(bad));
  }
});

// ---- verdicts cannot claim more than the evidence ----

test('suspicious requires high or critical findings from at least two distinct rules', async () => {
  const report = await loadSample();
  assert.equal(report.summary.verdict, 'suspicious');
  assert.deepEqual(validateReport(report), []);

  // Two findings, but the same rule: one indicator repeated is still one indicator.
  report.findings[1].ruleId = report.findings[0].ruleId;
  report.summary.scoring.contributions[1].ruleId = report.findings[0].ruleId;
  assert.ok(has(validateReport(report), 'suspicious requires findings of high or critical severity from at least two distinct rules'));

  // A single critical finding is not enough either.
  const single = await loadSample();
  single.findings = [finding('F1', 'credential-network-combination', 'critical', 'f5', 'lib/telemetry.min.js')];
  single.ai.investigations = [];
  rescore(single);
  assert.ok(has(validateReport(single), 'suspicious requires'));
  single.summary.verdict = 'needs-review';
  assert.deepEqual(validateReport(single), []);
});

test('no-differences needs a resolved source, no modified or package-only files, and no findings of low or above', async () => {
  const clean = await cleanReport();
  assert.deepEqual(validateReport(clean), []);

  const modified = await cleanReport();
  modified.summary.counts = { identical: 0, modified: 1, packageOnly: 0, sourceOnly: 1 };
  modified.files[0].status = 'modified';
  modified.files[0].package.sha256 = 'a'.repeat(64);
  assert.ok(has(validateReport(modified), 'no-differences requires no modified or package-only files'));

  const unresolved = await cleanReport();
  unresolved.source.resolved = false;
  assert.ok(has(validateReport(unresolved), 'no-differences requires a resolved source'));

  const low = await cleanReport();
  low.findings = [finding('F1', 'network-access', 'low', 'f1', 'README.md')];
  rescore(low);
  assert.ok(has(validateReport(low), 'no-differences requires no findings of low severity or above'));

  const info = await cleanReport();
  info.findings = [finding('F1', 'network-access', 'info', 'f1', 'README.md')];
  rescore(info);
  assert.deepEqual(validateReport(info), []);
});

test('expected-differences needs every difference explained, a resolved source, and nothing of medium or above', async () => {
  const build = async () => {
    const report = await loadSample();
    report.findings = [];
    report.manifest.changes = [];
    report.manifest.installScripts.package = {};
    report.files = [report.files[0], report.files[2], report.files[3], report.files[5]];
    report.summary.counts = { identical: 1, modified: 0, packageOnly: 2, sourceOnly: 1 };
    report.summary.verdict = 'expected-differences';
    report.ai.classifications = [];
    report.ai.investigations = [];
    report.scan.rules = [{ id: 'dynamic-code-execution', version: 1 }];
    return rescore(report);
  };
  assert.deepEqual(validateReport(await build()), []);

  const unexplained = await build();
  unexplained.files[1].explanation.category = 'unclassified';
  assert.ok(has(validateReport(unexplained), 'expected-differences requires every difference to be explained'));

  const unresolved = await build();
  unresolved.source.resolved = false;
  assert.ok(has(validateReport(unresolved), 'expected-differences requires a resolved source'));

  const medium = await build();
  medium.findings = [finding('F1', 'sensitive-env-access', 'medium', 'f2', 'dist/index.js')];
  rescore(medium);
  assert.ok(has(validateReport(medium), 'expected-differences requires no findings of medium severity or above'));
});

test('inconclusive may carry low findings but never medium or above', async () => {
  const report = await cleanReport();
  report.source.resolved = false;
  report.scan.capabilityDifferential = { available: false, basis: 'No source snapshot was resolved.' };
  report.summary.verdict = 'inconclusive';
  report.findings = [finding('F1', 'process-execution', 'low', 'f1', 'README.md')];
  rescore(report);
  assert.deepEqual(validateReport(report), [], 'unresolved source with only low findings is inconclusive');

  report.findings = [finding('F1', 'sensitive-file-access', 'medium', 'f1', 'README.md')];
  rescore(report);
  assert.ok(has(validateReport(report), 'inconclusive is not allowed with findings of medium severity or above'));
  report.summary.verdict = 'needs-review';
  assert.deepEqual(validateReport(report), []);
});

// ---- scan coverage ----

test('a report without a scan is inconclusive, unscored and has no findings', async () => {
  assert.deepEqual(validateReport(unscanned(await loadSample())), []);

  const scored = unscanned(await loadSample());
  scored.summary.riskScore = 10;
  assert.ok(has(validateReport(scored), 'summary.riskScore must be null when scan.performed is false'));

  const verdict = unscanned(await loadSample());
  verdict.summary.verdict = 'needs-review';
  assert.ok(has(validateReport(verdict), 'summary.verdict must be inconclusive when scan.performed is false'));

  const findings = unscanned(await loadSample());
  findings.findings = [integrityFinding()];
  assert.ok(has(validateReport(findings), 'findings must be empty when scan.performed is false'));

  for (const mutate of [
    (r) => (r.scan.filesScanned = 3),
    (r) => (r.scan.filesNotApplicable = 1),
    (r) => (r.scan.filesSkippedCount = 1),
  ]) {
    const report = unscanned(await loadSample());
    mutate(report);
    assert.ok(has(validateReport(report), 'scan file counts must be zero when the scan was not performed'));
  }
  const rules = unscanned(await loadSample());
  rules.scan.rules = [{ id: 'x-rule', version: 1 }];
  rules.scan.rulesVersion = 'v1';
  const errors = validateReport(rules);
  assert.ok(has(errors, 'scan.rules must be empty when the scan was not performed'));
  assert.ok(has(errors, 'scan.rulesVersion must be null when the scan was not performed'));

  const differential = unscanned(await loadSample());
  differential.scan.capabilityDifferential = { available: true, basis: 'x' };
  assert.ok(has(validateReport(differential), 'must be { available: false, basis: null } when the scan was not performed'));
});

test('a performed scan names its rules and its version', async () => {
  const report = await loadSample();
  report.scan.rulesVersion = null;
  report.scan.rules = [];
  const errors = validateReport(report);
  assert.ok(has(errors, 'scan.rulesVersion must be a non-empty string when the scan was performed'));
  assert.ok(has(errors, 'scan.rules must list the rules that ran'));

  const bad = await loadSample();
  bad.scan.rules = [{ id: 'Bad Rule', version: 0 }];
  const badErrors = validateReport(bad);
  assert.ok(has(badErrors, 'scan.rules[0].id must be a kebab-case rule id'));
  assert.ok(has(badErrors, 'scan.rules[0].version must be a positive integer'));

  const performed = await loadSample();
  performed.scan.performed = 'yes';
  assert.ok(validateReport(performed).includes('scan.performed must be a boolean'));
});

test('skipped files are listed with a reason, and the count can exceed the listed entries', async () => {
  const report = await loadSample();
  report.scan.filesSkipped = [{ path: 'dist/index.js', reason: 'too-large' }, { path: 'lib/telemetry.min.js', reason: 'over-budget' }];
  report.scan.filesSkippedCount = 2;
  assert.deepEqual(validateReport(report), []);
  report.scan.filesSkippedCount = 40;
  assert.deepEqual(validateReport(report), [], 'the true count may exceed a truncated list');

  report.scan.filesSkippedCount = 1;
  assert.ok(has(validateReport(report), 'scan.filesSkippedCount is smaller than the number of listed skipped files'));

  report.scan.filesSkipped = [{ path: 'ghost.js', reason: 'because' }];
  report.scan.filesSkippedCount = 1;
  const errors = validateReport(report);
  assert.ok(has(errors, 'scan.filesSkipped[0].path does not match any file'));
  assert.ok(has(errors, 'scan.filesSkipped[0].reason must be one of too-large, over-budget, binary, unreadable'));

  report.scan.filesSkipped = Array.from({ length: MAX_SKIPPED_LISTED + 1 }, () => ({ path: 'dist/index.js', reason: 'binary' }));
  report.scan.filesSkippedCount = MAX_SKIPPED_LISTED + 1;
  assert.ok(has(validateReport(report), `scan.filesSkipped lists more than ${MAX_SKIPPED_LISTED} files`));
});

test('scan counts must be non-negative integers', async () => {
  for (const key of ['filesScanned', 'filesNotApplicable', 'filesSkippedCount']) {
    const report = await loadSample();
    report.scan[key] = -1;
    assert.ok(has(validateReport(report), `scan.${key} must be a non-negative integer`), key);
  }
});

test('the capability differential needs a resolved source and an explanation', async () => {
  const report = await loadSample();
  report.source.resolved = false;
  assert.ok(has(validateReport(report), 'scan.capabilityDifferential cannot be available without a resolved source'));

  const noBasis = await loadSample();
  noBasis.scan.capabilityDifferential = { available: false, basis: null };
  assert.ok(has(validateReport(noBasis), 'scan.capabilityDifferential.basis must say what was compared'));

  const unavailable = await loadSample();
  unavailable.scan.capabilityDifferential = { available: false, basis: 'No source snapshot was resolved.' };
  assert.deepEqual(validateReport(unavailable), []);
});
