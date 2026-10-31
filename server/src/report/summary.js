import { escapeUnsafe } from '../scan/text.js';

const MAX_LISTED_FILES = 40;
const MAX_LISTED_FINDINGS = 25;

function formatScan(report) {
  const { scan, findings } = report;
  const lines = [''];
  lines.push(`Scan:       ${scan.filesScanned} file(s) scanned, ${scan.filesSkippedCount} skipped, ${scan.filesNotApplicable} not applicable`);
  for (const skipped of scan.filesSkipped.slice(0, 10)) lines.push(`            - not scanned (${skipped.reason}): ${skipped.path}`);
  if (scan.filesSkippedCount > 10) lines.push(`            - ... and ${scan.filesSkippedCount - 10} more not scanned (see the JSON report)`);
  lines.push(`            - comparison with the source: ${scan.capabilityDifferential.basis}`);

  lines.push('');
  if (findings.length === 0) {
    lines.push('Findings:   none');
    return lines;
  }
  const bySeverity = report.summary.findingsBySeverity;
  const tally = ['critical', 'high', 'medium', 'low', 'info'].filter((severity) => bySeverity[severity] > 0).map((severity) => `${bySeverity[severity]} ${severity}`);
  lines.push(`Findings:   ${findings.length} (${tally.join(', ')})`);
  for (const finding of findings.slice(0, MAX_LISTED_FINDINGS)) {
    const evidence = finding.evidence[0];
    const place = evidence?.path ? `${evidence.path}:${evidence.line}` : 'package';
    lines.push(`  [${finding.severity}] ${finding.ruleId} ${place}`);
    lines.push(`      ${finding.title}`);
  }
  if (findings.length > MAX_LISTED_FINDINGS) lines.push(`  ... and ${findings.length - MAX_LISTED_FINDINGS} more (see the JSON report)`);
  return lines;
}

// A plain-text rendering of a report, for the CLI. It restates what the report
// contains and nothing more.
export function formatSummary(report) {
  const { input, package: pkg, source, summary, manifest } = report;
  const lines = [];
  lines.push(`Audyssey report for ${input.name}@${input.version} (${input.ecosystem}, ${input.source === 'tarball' ? 'supplied tarball' : 'registry download'})`);
  lines.push('');

  lines.push(
    pkg.integrity.verified
      ? `Integrity:  verified against the registry checksum (${pkg.integrity.actual.split('-')[0]})`
      : 'Integrity:  NOT VERIFIED against the registry checksum',
  );

  if (source.resolved) {
    const how = source.ref.type === 'gitHead' ? 'exact commit recorded by npm' : `tag ${source.ref.value}`;
    const commit = source.ref.commit ? ` @ ${source.ref.commit.slice(0, 12)}` : '';
    lines.push(`Source:     ${source.repository}${source.directory ? `/${source.directory}` : ''}${commit} (${how})`);
  } else {
    lines.push('Source:     UNRESOLVED. Nothing can be concluded about this package from this run.');
  }
  for (const note of source.notes) lines.push(`            - ${note}`);

  const { counts } = summary;
  lines.push('');
  lines.push(
    source.resolved
      ? `Files:      ${counts.identical} identical, ${counts.modified} modified, ${counts.packageOnly} package-only, ${counts.sourceOnly} source-only`
      : `Files:      ${pkg.fileCount} published files listed; none could be compared`,
  );

  if (source.resolved) {
    // Modified files first, then files only in the package, then source-only
    // ones (usually tests and tooling), so a capped list shows the most relevant.
    const order = { modified: 0, 'package-only': 1, 'source-only': 2 };
    const differing = report.files
      .filter((file) => file.status !== 'identical')
      .sort((a, b) => order[a.status] - order[b.status]);
    for (const file of differing.slice(0, MAX_LISTED_FILES)) lines.push(`  ${file.status.padEnd(13)} ${file.path}`);
    if (differing.length > MAX_LISTED_FILES) lines.push(`  … and ${differing.length - MAX_LISTED_FILES} more (see the JSON report)`);
  }

  lines.push('');
  if (manifest.compared) {
    lines.push(`package.json: ${manifest.changes.length} field(s) differ between the published package and the source`);
  } else {
    lines.push(`package.json: not compared (${manifest.reason})`);
  }
  const installScripts = Object.keys(manifest.installScripts.package);
  lines.push(`Install-time scripts in the published package: ${installScripts.length > 0 ? installScripts.join(', ') : 'none'}`);

  if (report.scan.performed) lines.push(...formatScan(report));

  for (const error of report.errors) lines.push(`Problem [${error.stage}]: ${error.message}`);

  lines.push('');
  if (report.scan.performed) {
    const basis = source.resolved ? '' : '; based on the package alone, because the source could not be compared';
    lines.push(`Risk score: ${summary.riskScore}/100 (${summary.scoring.model}${basis}; the breakdown is in the JSON report)`);
    lines.push(`Verdict:    ${summary.verdict}`);
    lines.push('The scan matches patterns in text. It can miss obfuscated or dynamically built code and can match code that never runs, so a low score does not mean a package is safe.');
  } else {
    lines.push(`Verdict:    ${summary.verdict}`);
    lines.push('Security assessment: not performed (the package could not be scanned).');
  }
  // File names, notes and messages come from the package: show control characters
  // (terminal escapes, bidirectional overrides) as visible text, never as themselves.
  return escapeUnsafe(lines.join('\n'));
}
