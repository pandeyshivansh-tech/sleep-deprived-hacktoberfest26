import { REQUIRED_MODELS } from '../config.js';
import { SEVERITIES } from '../report/schema.js';
import { escapeUnsafe } from '../scan/text.js';
import { chat, extractJsonArray } from './ollama.js';
import { CLASSIFY_SYSTEM, classifyUser } from './prompts.js';

// Stage 1, gemma4:e4b: a first pass over the files that differ from the source.
// The model only labels files by their report ID; it is shown what the
// deterministic scanner found, and its answer is advisory.

export const MODEL = REQUIRED_MODELS.find((model) => model.role === 'classification').name;
export const LABELS = Object.freeze(['expected-artifact', 'suspicious', 'needs-investigation']);
const BATCH_SIZE = 8;
const MAX_FILES = 24;
const MAX_RATIONALE_CHARS = 280;
const EXCERPT_CHARS = 600;

const rank = (severity) => SEVERITIES.indexOf(severity);

// Which files get classified: the ones that differ from the source, those with
// scanner findings first, then by path. Bounded, and the report says when files
// were left out.
export function classificationCandidates(report, analysis) {
  const findingsOf = new Map();
  for (const finding of report.findings) {
    if (finding.fileId) findingsOf.set(finding.fileId, [...(findingsOf.get(finding.fileId) ?? []), finding]);
  }
  const strongest = (id) => Math.max(-1, ...(findingsOf.get(id) ?? []).map((finding) => rank(finding.severity)));

  const files = report.files
    .filter((file) => file.status === 'modified' || file.status === 'package-only')
    .sort((a, b) => strongest(b.id) - strongest(a.id) || (a.path < b.path ? -1 : 1))
    .map((file) => {
      const record = analysis.packageInventory?.files.get(file.path);
      const text = record?.data ? record.data.toString('utf8') : null;
      const findings = findingsOf.get(file.id) ?? [];
      return {
        id: file.id,
        path: file.path,
        status: file.status,
        size: file.package?.size ?? 0,
        scanner: findings.length > 0 ? findings.map((f) => `${f.id}:${f.ruleId}(${f.severity})`).join(',') : 'none',
        excerpt: text === null ? '(contents not read: binary, link or over the size limit)' : text.slice(0, EXCERPT_CHARS),
        findings,
      };
    });
  return { selected: files.slice(0, MAX_FILES), total: files.length };
}

function cleanRationale(text) {
  const clean = escapeUnsafe(String(text)).replace(/\s+/g, ' ').trim();
  return clean.length > MAX_RATIONALE_CHARS ? `${clean.slice(0, MAX_RATIONALE_CHARS - 3)}...` : clean;
}

// Keeps only entries that name a file we sent, use a known label and say
// something, once per file. Anything else (invented ids, bad labels, repeats) is
// dropped. A model cannot clear a file that the scanner flagged: for a file with
// a finding of medium severity or above, "expected-artifact" is replaced by
// "needs-investigation" and the rationale says why.
export function validateClassifications(parsed, sent) {
  const known = new Map(sent.map((file) => [file.id, file]));
  const seen = new Set();
  const accepted = [];
  let dropped = 0;
  for (const item of parsed) {
    const file = known.get(item?.fileId);
    if (!file || seen.has(item.fileId) || !LABELS.includes(item.label) || typeof item.rationale !== 'string' || item.rationale.trim() === '') {
      dropped += 1;
      continue;
    }
    seen.add(item.fileId);
    let { label } = item;
    let rationale = cleanRationale(item.rationale);
    const flagged = file.findings.filter((finding) => rank(finding.severity) >= rank('medium'));
    if (label === 'expected-artifact' && flagged.length > 0) {
      label = 'needs-investigation';
      rationale = cleanRationale(`The scanner reported ${flagged.map((f) => f.id).join(', ')} for this file, so it is not cleared as an expected artifact. The model said: ${rationale}`);
    }
    accepted.push({ fileId: item.fileId, label, rationale });
  }
  return { accepted, dropped };
}

// Runs the stage. Returns { classifications, status, durationMs, notes } where
// `notes` are non-fatal problems for the report's errors list.
export async function classifyFiles({ report, analysis, ollama, onProgress = () => {} }) {
  const { selected, total } = classificationCandidates(report, analysis);
  const classifications = [];
  const notes = [];
  let durationMs = 0;
  let failed = 0;

  if (total > selected.length) notes.push(`Classified ${selected.length} of ${total} differing files (limit ${MAX_FILES}); the rest were not sent to the model.`);

  for (let from = 0; from < selected.length; from += BATCH_SIZE) {
    const batch = selected.slice(from, from + BATCH_SIZE);
    onProgress(`Classifying ${batch.length} file(s) with ${MODEL} (${Math.floor(from / BATCH_SIZE) + 1}/${Math.ceil(selected.length / BATCH_SIZE)})`);
    try {
      const result = await chat({
        ...ollama,
        model: MODEL,
        system: CLASSIFY_SYSTEM,
        user: classifyUser(batch),
        // Gemma 4 spends its whole budget thinking when this is left on, and a
        // JSON-schema `format` makes it stall, so it is prompted for plain JSON.
        think: false,
        numPredict: 120 * batch.length + 100,
      });
      durationMs += result.durationMs;
      const parsed = extractJsonArray(result.content);
      if (!parsed) {
        failed += 1;
        notes.push(`${MODEL} returned no usable JSON for a batch of ${batch.length} file(s)${result.truncated ? ' (its answer was cut off)' : ''}.`);
        continue;
      }
      const { accepted, dropped } = validateClassifications(parsed, batch);
      classifications.push(...accepted);
      if (dropped > 0) notes.push(`${dropped} classification(s) from ${MODEL} were discarded (unknown file, bad label or empty).`);
      if (accepted.length === 0) failed += 1;
    } catch (error) {
      failed += 1;
      notes.push(`${MODEL}: ${error.message}`);
    }
  }

  const batches = Math.ceil(selected.length / BATCH_SIZE);
  return { classifications, status: failed === 0 ? 'completed' : 'failed', durationMs, notes, batches, sent: selected.length };
}
