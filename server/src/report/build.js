import { SCAN_LIMITS } from '../limits.js';
import { decideVerdict, scoreFindings } from '../scan/risk.js';
import { VERSION } from '../version.js';
import { SCHEMA_VERSION, SEVERITIES, validateReport } from './schema.js';

const MAX_LISTED_FIELDS = 10;

const side = (record) => (record ? { sha256: record.sha256, size: record.size, type: record.type } : null);

function describeDifference(entry) {
  const isLink = (entry.package ?? entry.source).type !== 'file';
  if (entry.status === 'modified') {
    return isLink
      ? 'The link type or target differs between the published package and the source.'
      : 'The SHA-256 of the published file differs from the source file.';
  }
  if (entry.status === 'package-only') return 'Present in the published package but not in the source snapshot.';
  return 'Present in the source snapshot but not in the published package.';
}

function manifestEvidence(manifest) {
  if (!manifest.compared || manifest.changes.length === 0) return [];
  const fields = manifest.changes.map((change) => change.field);
  const shown = fields.slice(0, MAX_LISTED_FIELDS).join(', ');
  const more = fields.length > MAX_LISTED_FIELDS ? `, and ${fields.length - MAX_LISTED_FIELDS} more` : '';
  const evidence = [`package.json differs in ${fields.length} field(s): ${shown}${more}.`];
  for (const [name, command] of Object.entries(manifest.installScripts.package)) {
    if (manifest.installScripts.source[name] !== command) {
      evidence.push(`The install-time script "${name}" in the published package is not the same as in the source.`);
    }
  }
  return evidence;
}

const EXPLAINED = new Set(['generated-artifact', 'publish-normalization']);

function buildFiles({ comparison, sourceResolved, manifest, explanations }) {
  return comparison.map((entry, index) => {
    let category = 'unclassified';
    let confidence = 'low';
    let evidence;
    if (!sourceResolved) {
      evidence = ['No source snapshot was resolved, so this file could not be compared.'];
    } else if (entry.status === 'identical') {
      category = 'identical';
      confidence = 'high';
      evidence = [entry.package.type === 'file' ? 'SHA-256 hashes match.' : 'Link type and target match.'];
    } else if (explanations.has(entry.path)) {
      // The explainer looked for evidence: the category says whether it found any.
      const explanation = explanations.get(entry.path);
      ({ category, confidence } = explanation);
      evidence = [describeDifference(entry), ...explanation.evidence];
    } else {
      evidence = [describeDifference(entry), 'No explanation was attempted for this difference.'];
    }
    if (entry.path === 'package.json') evidence.push(...manifestEvidence(manifest));
    if (entry.package?.linkEscapes) {
      evidence.push(`The ${entry.package.type} in the published package points outside the package root (target: ${JSON.stringify(entry.package.linkTarget)}).`);
    }
    return {
      id: `f${index + 1}`,
      path: entry.path,
      status: entry.status,
      package: side(entry.package),
      source: side(entry.source),
      explanation: { category, confidence, evidence },
      findingIds: [],
    };
  });
}

const UNSCANNED = Object.freeze({
  performed: false,
  rulesVersion: null,
  rules: [],
  filesScanned: 0,
  filesNotApplicable: 0,
  filesSkipped: [],
  filesSkippedCount: 0,
  capabilityDifferential: { available: false, basis: null },
});

// Strongest first, then by rule, file and position, so numbering never depends on
// the order the scanner happened to run in.
function sortFindings(findings) {
  const rank = (finding) => SEVERITIES.indexOf(finding.severity);
  return [...findings].sort(
    (a, b) =>
      rank(b) - rank(a) ||
      (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0) ||
      (a.path ?? '').localeCompare(b.path ?? '') ||
      (a.evidence[0]?.line ?? 0) - (b.evidence[0]?.line ?? 0) ||
      (a.evidence[0]?.column ?? 0) - (b.evidence[0]?.column ?? 0),
  );
}

// Assembles the report from deterministic stage results and checks it against
// the contract before returning it. A report that fails validation is a bug in
// Audyssey, never something to hand to a user.
export function buildReport({
  input,
  metadata,
  tarballUrl,
  integrity,
  packageInventory,
  source,
  comparison,
  manifest,
  scanResult = null,
  explanations = new Map(),
  errors,
  now = () => new Date(),
}) {
  const files = buildFiles({ comparison, sourceResolved: source.resolved, manifest, explanations });
  const counts = { identical: 0, modified: 0, packageOnly: 0, sourceOnly: 0 };
  const countKey = { identical: 'identical', modified: 'modified', 'package-only': 'packageOnly', 'source-only': 'sourceOnly' };
  for (const file of files) counts[countKey[file.status]] += 1;

  let totalBytes = 0;
  for (const record of packageInventory?.files.values() ?? []) if (record.type === 'file') totalBytes += record.size;

  // Number the findings, link them to files, then score them. Without a scan there
  // is nothing to score: no score, and the verdict stays inconclusive.
  let findings = [];
  let summary = { verdict: 'inconclusive', riskScore: null, scoring: null };
  const reportErrors = [...errors];
  if (scanResult) {
    const idOfPath = new Map(files.map((file) => [file.path, file.id]));
    const sorted = sortFindings(scanResult.findings);
    const kept = sorted.slice(0, SCAN_LIMITS.maxFindings);
    if (sorted.length > kept.length) {
      reportErrors.push({
        stage: 'scan',
        message: `${sorted.length - kept.length} lower-ranked finding(s) were left out to keep the report bounded (limit ${SCAN_LIMITS.maxFindings}).`,
      });
    }
    findings = kept.map((finding, index) => ({
      id: `F${index + 1}`,
      ruleId: finding.ruleId,
      severity: finding.severity,
      confidence: finding.confidence,
      scope: finding.scope,
      title: finding.title,
      description: finding.description,
      fileId: finding.path === null ? null : idOfPath.get(finding.path),
      introducedInPackage: finding.introducedInPackage,
      evidence: finding.evidence,
    }));
    for (const file of files) file.findingIds = findings.filter((finding) => finding.fileId === file.id).map((finding) => finding.id);
    const { riskScore, scoring } = scoreFindings(findings);
    // A difference counts as unexplained unless the explainer found evidence for it.
    const unexplained = files.filter((file) => (file.status === 'modified' || file.status === 'package-only') && !EXPLAINED.has(file.explanation.category)).length;
    summary = { verdict: decideVerdict({ findings, riskScore, counts, sourceResolved: source.resolved, unexplained }), riskScore, scoring };
  }

  const report = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'audyssey', version: VERSION },
    generatedAt: now().toISOString(),
    input,
    package: {
      name: input.name,
      version: input.version,
      tarballUrl,
      integrity: { expected: integrity.expected, actual: integrity.actual, verified: integrity.verified },
      // Presence only: attestations are neither fetched nor verified.
      provenance: { attestationPresent: Boolean(metadata.dist?.attestations), claimedRepository: null, claimedCommit: null },
      fileCount: packageInventory?.files.size ?? 0,
      totalBytes,
    },
    source: {
      resolved: source.resolved,
      repository: source.repository,
      directory: source.directory,
      ref: source.ref,
      confidence: source.confidence,
      notes: source.notes,
    },
    summary: {
      ...summary,
      counts,
      findingsBySeverity: Object.fromEntries(SEVERITIES.map((severity) => [severity, findings.filter((finding) => finding.severity === severity).length])),
    },
    files,
    findings,
    manifest,
    // When no scan ran (the package archive was rejected) the report says so
    // outright rather than leave the reader to infer "clean" from no findings.
    scan: scanResult ? scanResult.coverage : { ...UNSCANNED },
    ai: { status: 'skipped', runs: [], classifications: [], investigations: [] },
    errors: reportErrors,
  };

  const problems = validateReport(report);
  if (problems.length > 0) {
    throw new Error(`Internal error: the generated report violates the report contract:\n- ${problems.join('\n- ')}`);
  }
  return report;
}
