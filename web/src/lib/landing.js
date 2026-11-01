// Everything the home page shows about a package comes from a real report: the
// bundled examples are tool output, so the "parity map" is the actual comparison,
// not an illustration. Pure functions so they are tested like the rest of src/lib.

const GLYPH = { identical: '✓', modified: '≠', 'package-only': '▲' };
const TONE = { identical: 'ok', modified: 'danger', 'package-only': 'danger' };

// Published files only (source-only files are not installed), differing files first.
export function parityRows(report, limit = 9) {
  const rows = report.files
    .filter((file) => file.status !== 'source-only')
    .map((file) => ({
      id: file.id,
      path: file.path,
      status: file.status,
      glyph: GLYPH[file.status] ?? '·',
      tone: TONE[file.status] ?? 'neutral',
      packageHash: file.package?.sha256?.slice(0, 8) ?? null,
      sourceHash: file.source?.sha256?.slice(0, 8) ?? null,
      explained: ['generated-artifact', 'publish-normalization'].includes(file.explanation.category),
      category: file.explanation.category,
    }));
  const rank = { 'package-only': 0, modified: 1, identical: 2 };
  rows.sort((a, b) => rank[a.status] - rank[b.status] || (a.path < b.path ? -1 : 1));
  return { rows: rows.slice(0, limit), total: rows.length };
}

export function parityStats(report) {
  const { counts } = report.summary;
  return {
    identical: counts.identical,
    differing: counts.modified + counts.packageOnly,
    notPublished: counts.sourceOnly,
    findings: report.findings.length,
    score: report.summary.riskScore,
    verdict: report.summary.verdict,
  };
}

// The first finding of a rule, with its first piece of evidence.
export function findingExample(report, ruleId) {
  const finding = report.findings.find((f) => f.ruleId === ruleId);
  if (!finding) return null;
  const evidence = finding.evidence[0] ?? null;
  return {
    ruleId: finding.ruleId,
    severity: finding.severity,
    title: finding.title,
    location: evidence ? `${evidence.path}${evidence.line ? `:${evidence.line}` : ''}` : null,
    snippet: evidence?.snippet ?? null,
  };
}

// What the pipeline really does, in order (see docs/risk-model.md).
export const PIPELINE = [
  { id: 'registry', title: 'Registry lookup', text: 'Fetches the version\'s metadata and checks the tarball against the checksum npm publishes.' },
  { id: 'read', title: 'Read in memory', text: 'Opens the archive under hard size, entry, depth and ratio limits. Nothing is extracted to disk or run.' },
  { id: 'source', title: 'Pin the source', text: 'Resolves the exact commit npm recorded (else a version tag) on GitHub and confirms the package name.' },
  { id: 'compare', title: 'Compare', text: 'SHA-256 per file, plus a field-by-field package.json diff and the install scripts.' },
  { id: 'explain', title: 'Explain and scan', text: 'Ties differences to evidence such as source maps, then scans every published file for risky patterns.' },
  { id: 'report', title: 'Report', text: 'Writes a validated report with a score breakdown. Optional local models add advisory text beside it.' },
];
