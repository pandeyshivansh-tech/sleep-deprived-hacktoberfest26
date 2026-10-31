// Enumerations and consistency checks for the report contract described in
// docs/report-schema.md.

export const SCHEMA_VERSION = '0.1.0';

export const FILE_STATUSES = Object.freeze(['identical', 'modified', 'package-only', 'source-only']);
export const EXPLANATION_CATEGORIES = Object.freeze([
  'identical',
  'generated-artifact',
  'publish-normalization',
  'not-published',
  'unexplained',
]);
export const SEVERITIES = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);
export const CONFIDENCES = Object.freeze(['high', 'medium', 'low']);
export const VERDICTS = Object.freeze(['no-differences', 'expected-differences', 'needs-review', 'suspicious', 'inconclusive']);
export const SOURCE_CONFIDENCES = Object.freeze(['exact-commit', 'tag', 'unresolved']);
export const SOURCE_REF_TYPES = Object.freeze(['gitHead', 'tag', 'none']);
export const INPUT_SOURCES = Object.freeze(['registry', 'tarball']);
export const AI_STATUSES = Object.freeze(['completed', 'partial', 'unavailable', 'skipped', 'failed']);
export const AI_STAGES = Object.freeze(['classification', 'investigation']);
export const AI_LABELS = Object.freeze(['expected-artifact', 'suspicious', 'needs-investigation']);

const STATUS_COUNT_KEYS = Object.freeze({
  identical: 'identical',
  modified: 'modified',
  'package-only': 'packageOnly',
  'source-only': 'sourceOnly',
});

function checkEnum(errors, where, value, allowed) {
  if (!allowed.includes(value)) {
    errors.push(`${where} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`);
  }
}

// Returns a list of problems; an empty list means the report is consistent.
// Beyond field values, this enforces the cross-references the dashboard relies
// on: findings point at real files, counts match entries, and AI output only
// refers to files and findings that deterministic analysis produced.
export function validateReport(report) {
  const errors = [];
  if (report === null || typeof report !== 'object') {
    return ['report must be an object'];
  }

  if (report.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION} (got ${JSON.stringify(report.schemaVersion)})`);
  }
  for (const key of ['tool', 'input', 'package', 'source', 'summary', 'ai']) {
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
  const score = report.summary.riskScore;
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    errors.push(`summary.riskScore must be an integer from 0 to 100 (got ${JSON.stringify(score)})`);
  }

  const fileIds = new Set();
  const statusCounts = { identical: 0, modified: 0, packageOnly: 0, sourceOnly: 0 };
  for (const [index, file] of report.files.entries()) {
    const where = `files[${index}]`;
    if (fileIds.has(file.id)) errors.push(`${where}.id ${JSON.stringify(file.id)} is duplicated`);
    fileIds.add(file.id);
    checkEnum(errors, `${where}.status`, file.status, FILE_STATUSES);
    checkEnum(errors, `${where}.explanation.category`, file.explanation?.category, EXPLANATION_CATEGORIES);
    checkEnum(errors, `${where}.explanation.confidence`, file.explanation?.confidence, CONFIDENCES);
    if (STATUS_COUNT_KEYS[file.status]) statusCounts[STATUS_COUNT_KEYS[file.status]] += 1;

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
  const severityCounts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const [index, finding] of report.findings.entries()) {
    const where = `findings[${index}]`;
    if (findingIds.has(finding.id)) errors.push(`${where}.id ${JSON.stringify(finding.id)} is duplicated`);
    findingIds.add(finding.id);
    checkEnum(errors, `${where}.severity`, finding.severity, SEVERITIES);
    checkEnum(errors, `${where}.confidence`, finding.confidence, CONFIDENCES);
    if (finding.severity in severityCounts) severityCounts[finding.severity] += 1;
    if (!fileIds.has(finding.fileId)) errors.push(`${where}.fileId ${JSON.stringify(finding.fileId)} does not match any file`);
    if (!Array.isArray(finding.evidence) || finding.evidence.length === 0) {
      errors.push(`${where} must include at least one evidence item`);
    }
  }
  for (const [severity, count] of Object.entries(severityCounts)) {
    if (report.summary.findingsBySeverity?.[severity] !== count) {
      errors.push(`summary.findingsBySeverity.${severity} is ${report.summary.findingsBySeverity?.[severity]} but findings contain ${count}`);
    }
  }

  for (const [index, file] of report.files.entries()) {
    for (const id of file.findingIds ?? []) {
      if (!findingIds.has(id)) errors.push(`files[${index}].findingIds references unknown finding ${JSON.stringify(id)}`);
    }
  }

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
