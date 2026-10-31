import { SCAN_LIMITS } from '../limits.js';
import { excerpt, locate } from './text.js';

// Evidence items for matches of one indicator in a text file. Line and column are
// 1-based; the snippet is bounded and has control characters escaped.
export function evidenceFor(file, indicatorId, hits, max = SCAN_LIMITS.maxEvidencePerFinding) {
  return hits.slice(0, max).map((hit) => ({
    path: file.path,
    ...locate(file.lineStarts, hit.index),
    indicator: indicatorId,
    snippet: excerpt(file.text, hit.index, hit.index + hit.length),
  }));
}

export const byPosition = (a, b) => a.line - b.line || a.column - b.column;

// Whether a behavior is new in the published package, judged against the source:
//   false  the exact bytes are in the reviewed source, or the source has the behavior
//   true   the file differs from the source and the source never shows the behavior
//   null   unknown: no source snapshot, or the source could not be fully read
// `capability` is the behavior class; rules without one rely on the file alone.
export function introducedFor(ctx, file, capability) {
  if (!ctx.sourceResolved) return null;
  if (file?.status === 'identical') return false;
  if (capability) {
    if (!ctx.differential.available) return null;
    return !ctx.sourceCapabilities.has(capability);
  }
  return true;
}

// Behavior the reviewed source already shows (the file is identical to it, or the
// source has the same behavior elsewhere) was visible to whoever reviewed the
// source, so it is reported (nothing is hidden) but carries no severity. This is
// the line between "the package differs from the source" and "the source itself
// is bad": Audyssey checks the first, and cannot vouch for the second.
export function effectiveSeverity(severity, introduced) {
  return introduced === false ? 'info' : severity;
}

// A finding about one file. `capability` links it to the capability differential.
export function fileFinding(ctx, file, { ruleId, severity, confidence, title, description, evidence, capability = null, introduced }) {
  const introducedInPackage = introduced === undefined ? introducedFor(ctx, file, capability) : introduced;
  return {
    ruleId,
    severity: effectiveSeverity(severity, introducedInPackage),
    confidence,
    scope: 'file',
    title,
    description,
    path: file.path,
    introducedInPackage,
    evidence,
  };
}

// A finding about the package as a whole (no file).
export function packageFinding({ ruleId, severity, confidence, title, description, snippet }) {
  return {
    ruleId,
    severity,
    confidence,
    scope: 'package',
    title,
    description,
    path: null,
    introducedInPackage: true,
    evidence: [{ path: null, line: null, snippet }],
  };
}
