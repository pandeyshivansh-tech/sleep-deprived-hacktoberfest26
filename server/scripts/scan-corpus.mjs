// Acceptance run for the scanner: analyzes a corpus of popular, benign packages
// with the full pipeline and prints what the scanner reported for each.
//
//   node server/scripts/scan-corpus.mjs                 # the default corpus
//   node server/scripts/scan-corpus.mjs lodash@4.17.21  # specific packages
//
// Needs network access (registry.npmjs.org, codeload.github.com). Nothing from
// any package is executed, installed or written to disk. This is not part of CI.
import { analyzeNpmPackage } from '../src/analyze.js';

export const BENIGN_CORPUS = [
  'lodash@4.17.21', 'express@4.21.2', 'axios@1.7.9', 'debug@4.4.1', 'chalk@5.6.0', 'uuid@11.1.0',
  'core-js@3.40.0', 'esbuild@0.25.0', 'husky@9.1.7', 'semver@7.6.3', 'react@19.0.0', 'moment@2.30.1',
  'yargs@17.7.2', 'request@2.88.2', 'node-fetch@3.3.2', 'rimraf@6.0.1', 'typescript@5.7.3', 'prettier@3.4.2',
  'mitt@3.0.1', 'puppeteer@24.2.0', 'sharp@0.33.5', 'ms@2.1.3', 'tiny-invariant@1.3.3', 'nanoid@5.1.5',
];

const specs = process.argv.length > 2 ? process.argv.slice(2) : BENIGN_CORPUS;
const rows = [];
let strong = 0;

for (const spec of specs) {
  const at = spec.lastIndexOf('@');
  const started = Date.now();
  try {
    const { report } = await analyzeNpmPackage({ name: spec.slice(0, at), version: spec.slice(at + 1) });
    const high = report.findings.filter((finding) => finding.severity === 'high' || finding.severity === 'critical');
    if (high.length > 0) strong += 1;
    rows.push({
      spec,
      verdict: report.summary.verdict,
      score: report.summary.riskScore,
      source: report.source.confidence,
      scanned: report.scan.filesScanned,
      skipped: report.scan.filesSkippedCount,
      findings: report.findings.filter((finding) => finding.severity !== 'info').map((finding) => `${finding.severity}:${finding.ruleId}@${finding.evidence[0]?.path ?? '-'}`),
      info: report.findings.filter((finding) => finding.severity === 'info').length,
      secs: ((Date.now() - started) / 1000).toFixed(1),
    });
  } catch (error) {
    rows.push({ spec, error: error.message.slice(0, 80) });
  }
}

for (const row of rows) console.log(JSON.stringify(row));
console.log(`\n${rows.length} packages, ${strong} with a high or critical finding`);
