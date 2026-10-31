import { REQUIRED_MODELS } from '../config.js';
import { SEVERITIES } from '../report/schema.js';
import { escapeUnsafe } from '../scan/text.js';
import { chat, extractJsonArray } from './ollama.js';
import { INVESTIGATE_SYSTEM, investigateUser } from './prompts.js';

// Stage 2, deepseek-r1:8b: a deeper reading of the strongest deterministic
// findings, including obfuscated snippets. It explains; it cannot add, remove,
// re-rank or re-score a finding, and it is never shown as a finding itself.

export const MODEL = REQUIRED_MODELS.find((model) => model.role === 'investigation').name;
const MAX_FINDINGS = 4;
const MAX_FIELD_CHARS = 500;
const CONTEXT_CHARS = 600;

const rank = (severity) => SEVERITIES.indexOf(severity);

// Findings of low severity or above, strongest first. Info findings carry no
// risk (for example behavior the source also has), so they are not worth a
// reasoning model's time.
export function investigationCandidates(report) {
  const number = (id) => Number.parseInt(id.slice(1), 10);
  return report.findings
    .filter((finding) => rank(finding.severity) >= rank('low'))
    .sort((a, b) => rank(b.severity) - rank(a.severity) || number(a.id) - number(b.id));
}

// A short window of the file around a finding's first match (a minified file is
// a single long line, so the column matters).
function contextAround(text, line, column) {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = text.indexOf('\n', offset);
    if (next === -1) return null;
    offset = next + 1;
  }
  const at = offset + Math.max(0, (column ?? 1) - 1);
  return text.slice(Math.max(0, at - 150), at + CONTEXT_CHARS - 150);
}

function prepare(report, analysis, finding) {
  const first = finding.evidence[0];
  let context = null;
  if (first?.path) {
    const text = analysis.packageInventory?.files.get(first.path)?.data?.toString('utf8');
    if (text) context = contextAround(text, first.line, first.column);
  }
  return {
    id: finding.id,
    ruleId: finding.ruleId,
    severity: finding.severity,
    title: finding.title,
    context,
    evidence: finding.evidence.slice(0, 3).map((item) => ({
      location: item.path ? `${item.path}:${item.line}${item.column ? `:${item.column}` : ''}` : 'package',
      snippet: item.snippet,
    })),
  };
}

// Statements of proof a pattern scanner and a language model cannot back up.
const OVERCLAIM = /\b(?:confirmed|definitely|certainly|proven|proves)\b[^.]{0,60}\b(?:malicious|exfiltrat\w*|backdoor\w*)|\b(?:has|have|was|were)\s+(?:been\s+)?(?:successfully\s+)?exfiltrated\b|\bsuccessfully\s+exfiltrat/i;

function cleanField(text) {
  const clean = escapeUnsafe(String(text)).replace(/\s+/g, ' ').trim();
  return clean.length > MAX_FIELD_CHARS ? `${clean.slice(0, MAX_FIELD_CHARS - 3)}...` : clean;
}

// Keeps entries that refer to a finding we sent, once, with all three fields as
// non-empty text and no claim of proven theft or malice. Everything else is
// discarded and counted.
export function validateInvestigations(parsed, sent) {
  const known = new Set(sent.map((finding) => finding.id));
  const seen = new Set();
  const accepted = [];
  let dropped = 0;
  for (const item of parsed) {
    const fields = ['explanation', 'implications', 'uncertainty'];
    const valid =
      known.has(item?.findingId) &&
      !seen.has(item.findingId) &&
      fields.every((field) => typeof item[field] === 'string' && item[field].trim() !== '') &&
      !fields.some((field) => OVERCLAIM.test(item[field]));
    if (!valid) {
      dropped += 1;
      continue;
    }
    seen.add(item.findingId);
    accepted.push({
      findingId: item.findingId,
      explanation: cleanField(item.explanation),
      implications: cleanField(item.implications),
      uncertainty: cleanField(item.uncertainty),
    });
  }
  return { accepted, dropped };
}

export async function investigateFindings({ report, analysis, ollama, onProgress = () => {} }) {
  const all = investigationCandidates(report);
  const selected = all.slice(0, MAX_FINDINGS).map((finding) => prepare(report, analysis, finding));
  const notes = [];
  if (all.length > selected.length) notes.push(`Investigated the ${selected.length} strongest of ${all.length} findings; the rest were not sent to the model.`);

  onProgress(`Investigating ${selected.length} finding(s) with ${MODEL} (this can take a couple of minutes)`);
  try {
    const result = await chat({
      ...ollama,
      model: MODEL,
      system: INVESTIGATE_SYSTEM,
      user: investigateUser(`${report.input.name}@${report.input.version}`, selected),
      // The model reasons before it answers; the budget has to cover both.
      numPredict: 1400 + 700 * selected.length,
      timeoutMs: ollama.investigateTimeoutMs ?? 420_000,
    });
    const parsed = extractJsonArray(result.content);
    if (!parsed) {
      notes.push(`${MODEL} returned no usable JSON${result.truncated ? ' (it ran out of tokens while reasoning)' : ''}.`);
      return { investigations: [], status: 'failed', durationMs: result.durationMs, notes, sent: selected.length };
    }
    const { accepted, dropped } = validateInvestigations(parsed, selected);
    if (dropped > 0) notes.push(`${dropped} investigation(s) from ${MODEL} were discarded (unknown finding, missing field, or an unsupported claim).`);
    return { investigations: accepted, status: accepted.length > 0 ? 'completed' : 'failed', durationMs: result.durationMs, notes, sent: selected.length };
  } catch (error) {
    notes.push(`${MODEL}: ${error.message}`);
    return { investigations: [], status: 'failed', durationMs: 0, notes, sent: selected.length };
  }
}
