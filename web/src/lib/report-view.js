// View-model helpers for the report dashboard: pure functions over a report that
// already passed validateReport. Nothing here changes a report, scores anything
// or decides a verdict; it only arranges what the deterministic pipeline said.

export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_RANK = Object.fromEntries(SEVERITY_ORDER.map((name, index) => [name, SEVERITY_ORDER.length - index]));
export const STATUS_ORDER = ['modified', 'package-only', 'source-only', 'identical'];
export const CATEGORY_ORDER = ['unexplained', 'unclassified', 'generated-artifact', 'publish-normalization', 'not-published', 'identical'];
const EXPLAINED = new Set(['generated-artifact', 'publish-normalization']);

export const STATUS_LABELS = {
  identical: 'Identical',
  modified: 'Modified',
  'package-only': 'Package only',
  'source-only': 'Source only',
};
export const CATEGORY_LABELS = {
  identical: 'Identical',
  'generated-artifact': 'Generated artifact',
  'publish-normalization': 'Publish metadata',
  'not-published': 'Not published',
  unexplained: 'Unexplained',
  unclassified: 'Not judged',
};
export const AI_LABEL_TEXT = {
  'expected-artifact': 'Model: looks like build output',
  suspicious: 'Model: looks suspicious',
  'needs-investigation': 'Model: needs investigation',
};

const VERDICTS = {
  'no-differences': {
    label: 'No differences',
    tone: 'ok',
    headline: 'Every published file matches the source.',
    detail: 'Nothing of low severity or above was found. That describes this comparison and these scanner patterns; it is not a guarantee that the code is safe.',
  },
  'expected-differences': {
    label: 'Expected differences',
    tone: 'info',
    headline: 'Every difference is explained from evidence.',
    detail: 'Each file that differs is tied to the repository by the explainer (for example a source map that embeds the repository source), and the scanner found nothing of low severity or above. Explanations show where a file came from, not that it is harmless.',
  },
  'needs-review': {
    label: 'Needs review',
    tone: 'warn',
    headline: 'A person should look at this release.',
    detail: 'There are findings or differences that no evidence explains. This is not a finding of malice: review the unexplained files and the findings listed below.',
  },
  suspicious: {
    label: 'Suspicious',
    tone: 'danger',
    headline: 'Several independent rules found strong indicators.',
    detail: 'At least two distinct high or critical rules matched. These are indicators with evidence, not proof of intent. Verify them against the source before using this version.',
  },
  inconclusive: {
    label: 'Inconclusive',
    tone: 'neutral',
    headline: 'No conclusion can be drawn.',
    detail: 'The source could not be resolved or the package could not be fully assessed. Inconclusive is never a clean result.',
  },
};
export const describeVerdict = (verdict) => VERDICTS[verdict] ?? { label: String(verdict), tone: 'neutral', headline: '', detail: '' };

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const shortHash = (hash, length = 12) => (typeof hash === 'string' ? hash.slice(0, length) : '—');

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// Only an https GitHub URL becomes a link: the value comes from package metadata.
export function safeRepositoryUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com' ? parsed.href : null;
  } catch {
    return null;
  }
}

export const isDifferent = (file) => file.status === 'modified' || file.status === 'package-only';
export const isUnexplained = (file) => isDifferent(file) && !EXPLAINED.has(file.explanation.category);

// One row per file: the file plus its findings and the model's opinion, joined by id.
export function buildFileRows(report) {
  const findingsById = new Map(report.findings.map((finding) => [finding.id, finding]));
  const opinions = new Map(report.ai.classifications.map((entry) => [entry.fileId, entry]));
  const rows = report.files.map((file) => {
    const findings = file.findingIds.map((id) => findingsById.get(id)).filter(Boolean);
    const strongest = findings.reduce((best, finding) => Math.max(best, SEVERITY_RANK[finding.severity] ?? 0), 0);
    return { ...file, findings, strongest, opinion: opinions.get(file.id) ?? null, unexplained: isUnexplained(file) };
  });
  const statusRank = Object.fromEntries(STATUS_ORDER.map((name, index) => [name, index]));
  return rows.sort(
    (a, b) =>
      Number(b.unexplained) - Number(a.unexplained) ||
      b.strongest - a.strongest ||
      statusRank[a.status] - statusRank[b.status] ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
}

export const DEFAULT_FILTERS = Object.freeze({ query: '', status: 'all', category: 'all', focus: 'all' });

// focus: 'all' | 'unexplained' | 'findings' | 'ai-disagrees'
export function filterFiles(rows, filters = DEFAULT_FILTERS) {
  const query = (filters.query ?? '').trim().toLowerCase();
  return rows.filter((row) => {
    if (filters.status !== 'all' && row.status !== filters.status) return false;
    if (filters.category !== 'all' && row.explanation.category !== filters.category) return false;
    if (filters.focus === 'unexplained' && !row.unexplained) return false;
    if (filters.focus === 'findings' && row.findings.length === 0) return false;
    if (filters.focus === 'ai-disagrees' && !(row.opinion && row.opinion.label !== 'expected-artifact')) return false;
    if (query === '') return true;
    return (
      row.path.toLowerCase().includes(query) ||
      [row.package?.sha256, row.source?.sha256].some((hash) => typeof hash === 'string' && hash.startsWith(query))
    );
  });
}

export function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = key === 'category' ? row.explanation.category : row[key];
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

export function sortFindings(findings) {
  return [...findings].sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) || (a.id < b.id ? -1 : 1));
}

export function filterFindings(findings, severity = 'all') {
  return severity === 'all' ? findings : findings.filter((finding) => finding.severity === severity);
}

export function modelFor(report, stage) {
  return report.ai.runs.find((run) => run.stage === stage) ?? null;
}

export function describeIntegrity(integrity) {
  if (integrity.verified === true) return { state: 'ok', label: 'Checksum verified', detail: 'The tarball matches the checksum npm publishes for this version.' };
  if (integrity.verified === false) return { state: 'danger', label: 'Checksum mismatch', detail: 'The tarball does not match the checksum npm publishes for this version.' };
  return { state: 'neutral', label: 'Not verified', detail: 'No registry checksum was available to compare.' };
}

const CONFIDENCE_TEXT = {
  'exact-commit': 'Exact commit recorded by npm',
  tag: 'Matched by version tag',
  unresolved: 'Source not resolved',
};

export function describeSource(source) {
  return {
    resolved: source.resolved,
    label: CONFIDENCE_TEXT[source.confidence] ?? source.confidence,
    state: source.confidence === 'exact-commit' ? 'ok' : source.confidence === 'tag' ? 'warn' : 'danger',
    repository: source.repository ?? null,
    repositoryUrl: safeRepositoryUrl(source.repository),
    directory: source.directory ?? null,
    commit: source.ref?.commit ?? null,
    notes: source.notes ?? [],
  };
}

export function summarizeReport(report) {
  const rows = buildFileRows(report);
  const differing = rows.filter(isDifferent);
  const unexplained = rows.filter((row) => row.unexplained);
  const { counts } = report.summary;
  return {
    name: report.package.name ?? report.input.name,
    version: report.package.version ?? report.input.version,
    verdict: describeVerdict(report.summary.verdict),
    verdictId: report.summary.verdict,
    score: report.summary.riskScore,
    scored: report.summary.riskScore !== null,
    severities: SEVERITY_ORDER.map((name) => ({ name, count: report.summary.findingsBySeverity[name] ?? 0 })),
    findingCount: report.findings.length,
    integrity: describeIntegrity(report.package.integrity),
    source: describeSource(report.source),
    counts,
    differingCount: differing.length,
    unexplainedCount: unexplained.length,
    explainedCount: differing.length - unexplained.length,
    inputKind: report.input.source === 'tarball' ? 'Local tarball' : 'npm registry',
    scan: {
      performed: report.scan.performed,
      scanned: report.scan.filesScanned,
      notApplicable: report.scan.filesNotApplicable,
      skipped: report.scan.filesSkippedCount,
      rulesVersion: report.scan.rulesVersion,
      ruleCount: report.scan.rules.length,
      differentialAvailable: report.scan.capabilityDifferential.available,
      differentialBasis: report.scan.capabilityDifferential.basis,
    },
    ai: {
      status: report.ai.status,
      runs: report.ai.runs,
      classifications: report.ai.classifications.length,
      investigations: report.ai.investigations.length,
    },
    errors: report.errors,
  };
}

export function describeAiStatus(status) {
  return (
    {
      completed: 'Local models ran',
      partial: 'Only one local model ran',
      unavailable: 'Local models were not available',
      failed: 'Local model run failed',
      skipped: 'Not requested or nothing to interpret',
    }[status] ?? status
  );
}
