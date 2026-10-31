// The risk model's constants. They are the ONLY place weights live, and
// docs/risk-model.md explains why each value is what it is. Changing one changes
// the model: bump MODEL so reports say which model produced a score.

export const MODEL = 'audyssey-risk-v1';

// How much one finding is worth before it is adjusted, by severity. Chosen so
// that thresholds cannot be crossed by accident:
//   - one high finding (30) reaches needs-review (15) but not suspicious (60)
//   - four low findings cannot reach needs-review (they are also discounted)
//   - two distinct high rules (30 + 30) are exactly enough for suspicious
//   - critical (55) alone is still below suspicious
export const BASE_POINTS = Object.freeze({ info: 0, low: 4, medium: 12, high: 30, critical: 55 });

// How often the pattern fires on legitimate packages (measured on a corpus of
// popular packages, see docs/risk-model.md): high = structural and never seen
// in benign code, medium = seen occasionally, low = common.
export const CONFIDENCE_FACTOR = Object.freeze({ high: 1, medium: 0.7, low: 0.4 });

// How new the behavior is. It is 0.25, not 0, for behavior the source shows:
// the source itself can be the thing that was compromised.
export const INTRODUCED_FACTOR = Object.freeze({ true: 1, null: 0.75, false: 0.25 });

// The n-th finding of the same rule (strongest first) counts 1, 1/2, 1/4, ...,
// so a rule's total can never exceed twice its strongest finding.
export const repeatFactor = (rank) => 2 ** -rank;

export const THRESHOLDS = Object.freeze({
  needsReview: 15,
  suspicious: 60,
});
