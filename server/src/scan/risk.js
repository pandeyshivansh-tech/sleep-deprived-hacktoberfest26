import { SCORE_CAP, SEVERITIES } from '../report/schema.js';
import { BASE_POINTS, CONFIDENCE_FACTOR, INTRODUCED_FACTOR, MODEL, THRESHOLDS, repeatFactor } from './weights.js';

const round2 = (value) => Math.round(value * 100) / 100;
const rankOf = (severity) => SEVERITIES.indexOf(severity);
const idNumber = (id) => Number.parseInt(id.slice(1), 10);

// Scores numbered findings. Every finding contributes exactly once:
//   points = base(severity) x confidence x introduced x repeat
// where `repeat` discounts the 2nd, 3rd, ... finding of the same rule so that
// repetition cannot inflate a score. Returns the breakdown the contract requires,
// so the score can be recomputed from the report alone.
export function scoreFindings(findings) {
  const unrepeated = new Map(
    findings.map((finding) => [
      finding.id,
      BASE_POINTS[finding.severity] * CONFIDENCE_FACTOR[finding.confidence] * INTRODUCED_FACTOR[String(finding.introducedInPackage)],
    ]),
  );

  const byRule = new Map();
  for (const finding of findings) byRule.set(finding.ruleId, [...(byRule.get(finding.ruleId) ?? []), finding]);
  const repeatOf = new Map();
  for (const group of byRule.values()) {
    group
      .sort((a, b) => unrepeated.get(b.id) - unrepeated.get(a.id) || idNumber(a.id) - idNumber(b.id))
      .forEach((finding, rank) => repeatOf.set(finding.id, repeatFactor(rank)));
  }

  const contributions = findings.map((finding) => {
    const base = BASE_POINTS[finding.severity];
    const confidenceFactor = CONFIDENCE_FACTOR[finding.confidence];
    const introducedFactor = INTRODUCED_FACTOR[String(finding.introducedInPackage)];
    const repeat = repeatOf.get(finding.id);
    return {
      findingId: finding.id,
      ruleId: finding.ruleId,
      base,
      confidenceFactor,
      introducedFactor,
      repeatFactor: repeat,
      points: round2(base * confidenceFactor * introducedFactor * repeat),
    };
  });
  const rawTotal = round2(contributions.reduce((sum, item) => sum + item.points, 0));
  return {
    riskScore: Math.min(SCORE_CAP, Math.round(rawTotal)),
    scoring: { model: MODEL, cap: SCORE_CAP, rawTotal, contributions },
  };
}

// The verdict is a decision table, not a threshold on the score. It never claims
// more than the contract allows (see validateReport): `suspicious` needs two
// distinct strong rules, and the "nothing to see" verdicts need a resolved source.
//
// Until the build-artifact explainer exists, differences between the package and
// the source are unexplained, so they cannot be called expected.
export function decideVerdict({ findings, riskScore, counts, sourceResolved }) {
  const strongest = findings.reduce((max, finding) => Math.max(max, rankOf(finding.severity)), -1);
  const strongRules = new Set(findings.filter((finding) => rankOf(finding.severity) >= rankOf('high')).map((finding) => finding.ruleId));

  if (strongRules.size >= 2 && riskScore >= THRESHOLDS.suspicious) return 'suspicious';
  if (strongest >= rankOf('medium') || riskScore >= THRESHOLDS.needsReview) return 'needs-review';
  if (!sourceResolved) return 'inconclusive';
  if (counts.modified + counts.packageOnly > 0) return 'needs-review';
  if (strongest >= rankOf('low')) return 'needs-review';
  return 'no-differences';
}
