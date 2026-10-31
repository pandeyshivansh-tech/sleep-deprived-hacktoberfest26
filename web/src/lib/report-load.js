import { SCHEMA_VERSION, validateReport } from '../../../server/src/report/schema.js';

// Turns text the user opened into a report the dashboard may render, or into a
// described failure. The validator is the backend's own (server/src/report/schema.js):
// it is imported, not copied, so the dashboard can never accept a report the
// contract rejects. Nothing here evals, fetches or renders the text.

export const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_PROBLEMS_SHOWN = 12;

const failure = (kind, message, problems = []) => ({
  ok: false,
  kind,
  message,
  problems: problems.slice(0, MAX_PROBLEMS_SHOWN),
  moreProblems: Math.max(0, problems.length - MAX_PROBLEMS_SHOWN),
});

export function parseReportText(text) {
  if (typeof text !== 'string' || text.trim() === '') return failure('empty', 'The file is empty.');
  if (text.length > MAX_REPORT_BYTES) {
    return failure('too-large', `The file is larger than ${MAX_REPORT_BYTES / (1024 * 1024)} MB, which is more than any Audyssey report.`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return failure('not-json', `The file is not valid JSON (${error.message}).`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return failure('not-a-report', 'The file is valid JSON but not an Audyssey report object.');
  }
  if (value.tool?.name !== 'audyssey' && value.schemaVersion === undefined) {
    return failure('not-a-report', 'The file is JSON but does not look like an Audyssey report (no schemaVersion).');
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    return failure('wrong-version', `This dashboard reads report schema ${SCHEMA_VERSION}; the file declares ${JSON.stringify(value.schemaVersion)}.`);
  }
  return acceptReport(value);
}

// For reports that are already objects (the bundled examples): same contract check.
export function acceptReport(value) {
  const problems = validateReport(value);
  if (problems.length > 0) {
    return failure('invalid', `The report breaks the report contract in ${problems.length} place(s), so it is not shown.`, problems);
  }
  return { ok: true, report: value };
}
