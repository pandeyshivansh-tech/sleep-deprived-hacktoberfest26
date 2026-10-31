// Enumerations and consistency checks for the report contract described in
// docs/report-schema.md.

export const SCHEMA_VERSION = '0.3.0';

export const FILE_STATUSES = Object.freeze(['identical', 'modified', 'package-only', 'source-only']);
export const FILE_ENTRY_TYPES = Object.freeze(['file', 'symlink', 'hardlink']);
export const EXPLANATION_CATEGORIES = Object.freeze([
  'identical',
  'generated-artifact',
  'publish-normalization',
  'not-published',
  'unexplained',
  // The difference is reported by hash only: no explainer or scanner has judged it.
  'unclassified',
]);
export const MANIFEST_CHANGES = Object.freeze(['added', 'removed', 'changed']);
export const SEVERITIES = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);
export const CONFIDENCES = Object.freeze(['high', 'medium', 'low']);
export const VERDICTS = Object.freeze(['no-differences', 'expected-differences', 'needs-review', 'suspicious', 'inconclusive']);
export const FINDING_SCOPES = Object.freeze(['file', 'package']);
export const SKIP_REASONS = Object.freeze(['too-large', 'over-budget', 'binary', 'unreadable']);
export const SOURCE_CONFIDENCES = Object.freeze(['exact-commit', 'tag', 'unresolved']);
export const SOURCE_REF_TYPES = Object.freeze(['gitHead', 'tag', 'none']);
export const INPUT_SOURCES = Object.freeze(['registry', 'tarball']);
export const AI_STATUSES = Object.freeze(['completed', 'partial', 'unavailable', 'skipped', 'failed']);
export const AI_STAGES = Object.freeze(['classification', 'investigation']);
export const AI_LABELS = Object.freeze(['expected-artifact', 'suspicious', 'needs-investigation']);

// The risk score is a sum capped here; the contract fixes the cap, the producer's
// documented model supplies the weights.
export const SCORE_CAP = 100;
export const MAX_SNIPPET_CHARS = 400;
export const MAX_SKIPPED_LISTED = 500;

const SEVERITY_RANK = Object.freeze(Object.fromEntries(SEVERITIES.map((severity, rank) => [severity, rank])));
const RULE_ID_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
// A difference counts as explained only with these categories (set by the
// explainer, never by the scanner).
const EXPLAINED_CATEGORIES = Object.freeze(['generated-artifact', 'publish-normalization']);

const STATUS_COUNT_KEYS = Object.freeze({
  identical: 'identical',
  modified: 'modified',
  'package-only': 'packageOnly',
  'source-only': 'sourceOnly',
});

const round2 = (value) => Math.round(value * 100) / 100;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;
const isFactor = (value) => typeof value === 'number' && value > 0 && value <= 1;

function checkEnum(errors, where, value, allowed) {
  if (!allowed.includes(value)) {
    errors.push(`${where} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`);
  }
}

function validateScan({ errors, report, filePaths }) {
  const { scan } = report;
  if (typeof scan.performed !== 'boolean') {
    errors.push('scan.performed must be a boolean');
    return;
  }
  const performed = scan.performed;

  if (performed) {
    if (typeof scan.rulesVersion !== 'string' || scan.rulesVersion === '') errors.push('scan.rulesVersion must be a non-empty string when the scan was performed');
  } else if (scan.rulesVersion !== null) {
    errors.push('scan.rulesVersion must be null when the scan was not performed');
  }

  if (!Array.isArray(scan.rules)) {
    errors.push('scan.rules must be an array');
  } else {
    if (performed && scan.rules.length === 0) errors.push('scan.rules must list the rules that ran');
    if (!performed && scan.rules.length > 0) errors.push('scan.rules must be empty when the scan was not performed');
    for (const [index, rule] of scan.rules.entries()) {
      if (typeof rule?.id !== 'string' || !RULE_ID_RE.test(rule.id)) errors.push(`scan.rules[${index}].id must be a kebab-case rule id`);
      if (!Number.isInteger(rule?.version) || rule.version < 1) errors.push(`scan.rules[${index}].version must be a positive integer`);
    }
  }

  for (const key of ['filesScanned', 'filesNotApplicable', 'filesSkippedCount']) {
    if (!isCount(scan[key])) errors.push(`scan.${key} must be a non-negative integer`);
  }
  if (!Array.isArray(scan.filesSkipped)) {
    errors.push('scan.filesSkipped must be an array');
  } else {
    if (scan.filesSkipped.length > MAX_SKIPPED_LISTED) errors.push(`scan.filesSkipped lists more than ${MAX_SKIPPED_LISTED} files`);
    if (isCount(scan.filesSkippedCount) && scan.filesSkippedCount < scan.filesSkipped.length) {
      errors.push('scan.filesSkippedCount is smaller than the number of listed skipped files');
    }
    for (const [index, skipped] of scan.filesSkipped.entries()) {
      if (!filePaths.has(skipped?.path)) errors.push(`scan.filesSkipped[${index}].path does not match any file`);
      checkEnum(errors, `scan.filesSkipped[${index}].reason`, skipped?.reason, SKIP_REASONS);
    }
  }
  if (!performed && (scan.filesScanned !== 0 || scan.filesNotApplicable !== 0 || scan.filesSkippedCount !== 0 || scan.filesSkipped?.length > 0)) {
    errors.push('scan file counts must be zero when the scan was not performed');
  }

  const differential = scan.capabilityDifferential;
  if (!isObject(differential) || typeof differential.available !== 'boolean') {
    errors.push('scan.capabilityDifferential.available must be a boolean');
  } else if (performed) {
    if (typeof differential.basis !== 'string' || differential.basis === '') {
      errors.push('scan.capabilityDifferential.basis must say what was compared, or why no comparison was possible');
    }
    if (differential.available && !report.source.resolved) {
      errors.push('scan.capabilityDifferential cannot be available without a resolved source');
    }
  } else if (differential.available || differential.basis !== null) {
    errors.push('scan.capabilityDifferential must be { available: false, basis: null } when the scan was not performed');
  }
}

function validateEvidence({ errors, where, finding, filePaths }) {
  if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) {
    errors.push(`${where} must include at least one evidence item`);
    return;
  }
  for (const [index, item] of finding.evidence.entries()) {
    const at = `${where}.evidence[${index}]`;
    if (typeof item?.snippet !== 'string' || item.snippet.length > MAX_SNIPPET_CHARS) {
      errors.push(`${at}.snippet must be a string of at most ${MAX_SNIPPET_CHARS} characters`);
    }
    if (item?.path === null) {
      if (finding.scope === 'file') errors.push(`${at}.path may be null only for package-scope findings`);
      if (item.line !== null) errors.push(`${at}.line must be null when path is null`);
    } else {
      if (!filePaths.has(item?.path)) errors.push(`${at}.path does not match any file`);
      if (!Number.isInteger(item?.line) || item.line < 1) errors.push(`${at}.line must be a positive integer`);
    }
    if (item?.column !== undefined && (!Number.isInteger(item.column) || item.column < 1)) {
      errors.push(`${at}.column must be a positive integer when present`);
    }
    if (item?.indicator !== undefined && (typeof item.indicator !== 'string' || item.indicator === '' || item.indicator.length > 64)) {
      errors.push(`${at}.indicator must be a non-empty string of at most 64 characters when present`);
    }
  }
}

function validateScoring({ errors, report }) {
  const { riskScore, scoring } = report.summary;
  if (riskScore === null) {
    if (scoring !== null) errors.push('summary.scoring must be null when riskScore is null');
    return;
  }
  if (!isObject(scoring)) {
    errors.push('summary.scoring must describe how riskScore was computed');
    return;
  }
  if (typeof scoring.model !== 'string' || scoring.model === '') errors.push('summary.scoring.model must be a non-empty string');
  if (scoring.cap !== SCORE_CAP) errors.push(`summary.scoring.cap must be ${SCORE_CAP}`);
  if (!Array.isArray(scoring.contributions)) {
    errors.push('summary.scoring.contributions must be an array');
    return;
  }

  const ruleOf = new Map(report.findings.map((finding) => [finding.id, finding.ruleId]));
  const seen = new Set();
  let sum = 0;
  for (const [index, item] of scoring.contributions.entries()) {
    const at = `summary.scoring.contributions[${index}]`;
    if (!ruleOf.has(item?.findingId)) {
      errors.push(`${at}.findingId does not match any finding`);
      continue;
    }
    if (seen.has(item.findingId)) errors.push(`${at}.findingId ${JSON.stringify(item.findingId)} is listed twice`);
    seen.add(item.findingId);
    if (item.ruleId !== ruleOf.get(item.findingId)) errors.push(`${at}.ruleId does not match the finding's ruleId`);
    if (typeof item.base !== 'number' || !(item.base >= 0)) errors.push(`${at}.base must be a non-negative number`);
    for (const key of ['confidenceFactor', 'introducedFactor', 'repeatFactor']) {
      if (!isFactor(item[key])) errors.push(`${at}.${key} must be a number above 0 and at most 1`);
    }
    const expected = round2(item.base * item.confidenceFactor * item.introducedFactor * item.repeatFactor);
    if (!(Math.abs(item.points - expected) <= 0.0101)) {
      errors.push(`${at}.points is ${item.points} but base x confidenceFactor x introducedFactor x repeatFactor is ${expected}`);
    }
    sum += Number.isFinite(item.points) ? item.points : 0;
  }
  for (const finding of report.findings) {
    if (!seen.has(finding.id)) errors.push(`summary.scoring.contributions has no entry for finding ${finding.id}`);
  }
  if (!(Math.abs(scoring.rawTotal - round2(sum)) <= 0.0101)) {
    errors.push(`summary.scoring.rawTotal is ${scoring.rawTotal} but the contributions add up to ${round2(sum)}`);
  }
  if (riskScore !== Math.min(SCORE_CAP, Math.round(scoring.rawTotal))) {
    errors.push(`summary.riskScore ${riskScore} does not equal min(${SCORE_CAP}, round(rawTotal ${scoring.rawTotal}))`);
  }
}

// What each verdict is allowed to mean. These are the rules that keep a verdict
// from claiming more than the evidence supports.
function validateVerdict({ errors, report }) {
  const { verdict } = report.summary;
  const ranks = report.findings.map((finding) => SEVERITY_RANK[finding.severity] ?? -1);
  const strongest = ranks.length > 0 ? Math.max(...ranks) : -1;
  const sourceResolved = report.source.resolved === true;

  if (verdict === 'suspicious') {
    const strongRules = new Set(report.findings.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK.high).map((f) => f.ruleId));
    if (strongRules.size < 2) {
      errors.push('summary.verdict suspicious requires findings of high or critical severity from at least two distinct rules');
    }
  }
  if (verdict === 'no-differences') {
    if (!sourceResolved) errors.push('summary.verdict no-differences requires a resolved source');
    if (report.summary.counts?.modified !== 0 || report.summary.counts?.packageOnly !== 0) {
      errors.push('summary.verdict no-differences requires no modified or package-only files');
    }
    if (strongest >= SEVERITY_RANK.low) errors.push('summary.verdict no-differences requires no findings of low severity or above');
  }
  if (verdict === 'expected-differences') {
    if (!sourceResolved) errors.push('summary.verdict expected-differences requires a resolved source');
    for (const file of report.files) {
      if ((file.status === 'modified' || file.status === 'package-only') && !EXPLAINED_CATEGORIES.includes(file.explanation?.category)) {
        errors.push(`summary.verdict expected-differences requires every difference to be explained (${file.path} is ${file.explanation?.category})`);
        break;
      }
    }
    if (strongest >= SEVERITY_RANK.medium) errors.push('summary.verdict expected-differences requires no findings of medium severity or above');
  }
  if (verdict === 'inconclusive' && strongest >= SEVERITY_RANK.medium) {
    errors.push('summary.verdict inconclusive is not allowed with findings of medium severity or above');
  }
}

// Returns a list of problems; an empty list means the report is consistent.
// Beyond field values, this enforces the cross-references the dashboard relies
// on: findings point at real files, counts match entries, scores are
// reproducible from their breakdown, verdicts do not claim more than the
// findings allow, and AI output only refers to files and findings that
// deterministic analysis produced.
export function validateReport(report) {
  const errors = [];
  if (report === null || typeof report !== 'object') {
    return ['report must be an object'];
  }

  if (report.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION} (got ${JSON.stringify(report.schemaVersion)})`);
  }
  for (const key of ['tool', 'input', 'package', 'source', 'summary', 'manifest', 'scan', 'ai']) {
    if (report[key] === null || typeof report[key] !== 'object') errors.push(`${key} must be an object`);
  }
  for (const key of ['files', 'findings', 'errors']) {
    if (!Array.isArray(report[key])) errors.push(`${key} must be an array`);
  }
  if (errors.length > 0) return errors;

  checkEnum(errors, 'input.source', report.input.source, INPUT_SOURCES);
  checkEnum(errors, 'source.confidence', report.source.confidence, SOURCE_CONFIDENCES);
  checkEnum(errors, 'source.ref.type', report.source.ref?.type, SOURCE_REF_TYPES);
  checkEnum(errors, 'summary.verdict', report.summary.verdict, VERDICTS);

  // A null score means "no security assessment was performed", which is exactly
  // the case where the scan did not run. A score is never invented, and an
  // unscanned report can only be inconclusive.
  const score = report.summary.riskScore;
  if (typeof report.scan.performed === 'boolean') {
    if (!report.scan.performed) {
      if (score !== null) errors.push('summary.riskScore must be null when scan.performed is false');
      if (report.summary.verdict !== 'inconclusive') errors.push('summary.verdict must be inconclusive when scan.performed is false');
      if (report.findings.length > 0) errors.push('findings must be empty when scan.performed is false');
    } else if (!Number.isInteger(score) || score < 0 || score > SCORE_CAP) {
      errors.push(`summary.riskScore must be an integer from 0 to ${SCORE_CAP} when the scan was performed (got ${JSON.stringify(score)})`);
    }
  }

  const { manifest } = report;
  if (typeof manifest.compared !== 'boolean') errors.push('manifest.compared must be a boolean');
  if (!Array.isArray(manifest.changes)) {
    errors.push('manifest.changes must be an array');
  } else {
    for (const [index, change] of manifest.changes.entries()) {
      if (typeof change?.field !== 'string' || change.field === '') errors.push(`manifest.changes[${index}].field must be a non-empty string`);
      checkEnum(errors, `manifest.changes[${index}].change`, change?.change, MANIFEST_CHANGES);
    }
  }
  for (const side of ['package', 'source']) {
    const scripts = manifest.installScripts?.[side];
    if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) {
      errors.push(`manifest.installScripts.${side} must be an object`);
    }
  }

  const fileIds = new Set();
  const filePaths = new Set();
  const fileById = new Map();
  const statusCounts = { identical: 0, modified: 0, packageOnly: 0, sourceOnly: 0 };
  for (const [index, file] of report.files.entries()) {
    const where = `files[${index}]`;
    if (fileIds.has(file.id)) errors.push(`${where}.id ${JSON.stringify(file.id)} is duplicated`);
    fileIds.add(file.id);
    filePaths.add(file.path);
    fileById.set(file.id, file);
    checkEnum(errors, `${where}.status`, file.status, FILE_STATUSES);
    checkEnum(errors, `${where}.explanation.category`, file.explanation?.category, EXPLANATION_CATEGORIES);
    checkEnum(errors, `${where}.explanation.confidence`, file.explanation?.confidence, CONFIDENCES);
    if (STATUS_COUNT_KEYS[file.status]) statusCounts[STATUS_COUNT_KEYS[file.status]] += 1;
    for (const side of ['package', 'source']) {
      if (file[side] && file[side].type !== undefined) {
        checkEnum(errors, `${where}.${side}.type`, file[side].type, FILE_ENTRY_TYPES);
      }
    }

    const hasPackage = file.package !== null;
    const hasSource = file.source !== null;
    const expectedSides = {
      identical: [true, true],
      modified: [true, true],
      'package-only': [true, false],
      'source-only': [false, true],
    }[file.status];
    if (expectedSides && (expectedSides[0] !== hasPackage || expectedSides[1] !== hasSource)) {
      errors.push(`${where} has status ${file.status} but package/source presence does not match`);
    }
    if (file.status === 'identical' && file.package?.sha256 !== file.source?.sha256) {
      errors.push(`${where} is identical but its hashes differ`);
    }
    if (file.status === 'modified' && file.package?.sha256 === file.source?.sha256) {
      errors.push(`${where} is modified but its hashes are equal`);
    }
  }
  for (const [key, count] of Object.entries(statusCounts)) {
    if (report.summary.counts?.[key] !== count) {
      errors.push(`summary.counts.${key} is ${report.summary.counts?.[key]} but files contain ${count}`);
    }
  }

  const findingIds = new Set();
  const findingById = new Map();
  const severityCounts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const [index, finding] of report.findings.entries()) {
    const where = `findings[${index}]`;
    if (findingIds.has(finding.id)) errors.push(`${where}.id ${JSON.stringify(finding.id)} is duplicated`);
    findingIds.add(finding.id);
    findingById.set(finding.id, finding);
    if (typeof finding.ruleId !== 'string' || !RULE_ID_RE.test(finding.ruleId)) errors.push(`${where}.ruleId must be a kebab-case rule id`);
    checkEnum(errors, `${where}.severity`, finding.severity, SEVERITIES);
    checkEnum(errors, `${where}.confidence`, finding.confidence, CONFIDENCES);
    checkEnum(errors, `${where}.scope`, finding.scope, FINDING_SCOPES);
    if (finding.severity in severityCounts) severityCounts[finding.severity] += 1;

    // null means "unknown": there is no source snapshot to compare against.
    if (finding.introducedInPackage !== true && finding.introducedInPackage !== false && finding.introducedInPackage !== null) {
      errors.push(`${where}.introducedInPackage must be true, false or null`);
    }
    if (finding.scope === 'package') {
      if (finding.fileId !== null) errors.push(`${where}.fileId must be null for a package-scope finding`);
    } else if (finding.scope === 'file' && !fileIds.has(finding.fileId)) {
      errors.push(`${where}.fileId ${JSON.stringify(finding.fileId)} does not match any file`);
    }
    validateEvidence({ errors, where, finding, filePaths });
  }
  for (const [severity, count] of Object.entries(severityCounts)) {
    if (report.summary.findingsBySeverity?.[severity] !== count) {
      errors.push(`summary.findingsBySeverity.${severity} is ${report.summary.findingsBySeverity?.[severity]} but findings contain ${count}`);
    }
  }

  // Links must agree in both directions: a file lists exactly the file-scope
  // findings that point at it.
  for (const [index, file] of report.files.entries()) {
    for (const id of file.findingIds ?? []) {
      const finding = findingById.get(id);
      if (!finding) errors.push(`files[${index}].findingIds references unknown finding ${JSON.stringify(id)}`);
      else if (finding.fileId !== file.id) errors.push(`files[${index}].findingIds lists ${id}, which belongs to a different file`);
    }
  }
  for (const finding of report.findings) {
    if (finding.scope === 'file' && fileById.has(finding.fileId) && !(fileById.get(finding.fileId).findingIds ?? []).includes(finding.id)) {
      errors.push(`files ${finding.fileId} does not list its finding ${finding.id}`);
    }
  }

  validateScan({ errors, report, filePaths });
  validateScoring({ errors, report });
  validateVerdict({ errors, report });

  const { ai } = report;
  checkEnum(errors, 'ai.status', ai.status, AI_STATUSES);
  for (const [index, run] of (ai.runs ?? []).entries()) {
    checkEnum(errors, `ai.runs[${index}].stage`, run.stage, AI_STAGES);
  }
  for (const [index, item] of (ai.classifications ?? []).entries()) {
    checkEnum(errors, `ai.classifications[${index}].label`, item.label, AI_LABELS);
    if (!fileIds.has(item.fileId)) errors.push(`ai.classifications[${index}].fileId ${JSON.stringify(item.fileId)} does not match any file`);
  }
  for (const [index, item] of (ai.investigations ?? []).entries()) {
    if (!findingIds.has(item.findingId)) {
      errors.push(`ai.investigations[${index}].findingId ${JSON.stringify(item.findingId)} does not match any finding`);
    }
  }

  return errors;
}
