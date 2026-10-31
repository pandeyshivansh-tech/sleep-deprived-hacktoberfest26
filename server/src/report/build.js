import { VERSION } from '../version.js';
import { SCHEMA_VERSION, SEVERITIES, validateReport } from './schema.js';

const NOT_JUDGED = 'No build-artifact analysis or security scan has judged this difference.';
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

function buildFiles({ comparison, sourceResolved, manifest }) {
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
    } else {
      evidence = [describeDifference(entry), NOT_JUDGED];
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
  errors,
  now = () => new Date(),
}) {
  const files = buildFiles({ comparison, sourceResolved: source.resolved, manifest });
  const counts = { identical: 0, modified: 0, packageOnly: 0, sourceOnly: 0 };
  const countKey = { identical: 'identical', modified: 'modified', 'package-only': 'packageOnly', 'source-only': 'sourceOnly' };
  for (const file of files) counts[countKey[file.status]] += 1;

  let totalBytes = 0;
  for (const record of packageInventory?.files.values() ?? []) if (record.type === 'file') totalBytes += record.size;

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
      // No scanner exists yet, so there is no security assessment: no score, and
      // the verdict is always "inconclusive".
      verdict: 'inconclusive',
      riskScore: null,
      counts,
      findingsBySeverity: Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])),
    },
    files,
    findings: [],
    manifest,
    ai: { status: 'skipped', runs: [], classifications: [], investigations: [] },
    errors,
  };

  const problems = validateReport(report);
  if (problems.length > 0) {
    throw new Error(`Internal error: the generated report violates the report contract:\n- ${problems.join('\n- ')}`);
  }
  return report;
}
