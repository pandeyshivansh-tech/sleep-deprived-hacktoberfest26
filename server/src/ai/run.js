import { validateReport } from '../report/schema.js';
import { classificationCandidates, classifyFiles, MODEL as CLASSIFY_MODEL } from './classify.js';
import { investigateFindings, investigationCandidates, MODEL as INVESTIGATE_MODEL } from './investigate.js';
import { listInstalledModels } from './ollama.js';

// Everything the deterministic analysis decides. Local models may add to `ai` and
// to the list of problems, and nothing else.
const DETERMINISTIC_SECTIONS = ['input', 'package', 'source', 'summary', 'files', 'findings', 'manifest', 'scan'];
const fingerprint = (report) => JSON.stringify(DETERMINISTIC_SECTIONS.map((section) => report[section]));

function overallStatus(runs) {
  const statuses = runs.map((run) => run.status);
  if (statuses.every((status) => status === 'completed')) return 'completed';
  if (statuses.every((status) => status === 'unavailable')) return 'unavailable';
  if (statuses.some((status) => status === 'completed')) return 'partial';
  return 'failed';
}

// Adds the two local-model stages to a finished deterministic report.
//
//   1. gemma4:e4b       first-pass classification of the files that differ
//   2. deepseek-r1:8b   deeper reading of the strongest scanner findings
//
// They run one after the other (each is unloaded after use), only through the
// local Ollama, and only when there is something to interpret. If Ollama or a
// model is unavailable the report keeps its deterministic content and says so.
// A model can never change a finding, a count, a score or a verdict: that is
// checked, not assumed.
export async function addLocalAnalysis({ report, analysis, ollama, onProgress = () => {} }) {
  const before = fingerprint(report);
  const classify = classificationCandidates(report, analysis).selected.length > 0;
  const investigate = investigationCandidates(report).length > 0;
  if (!classify && !investigate) return report; // nothing to interpret: ai stays "skipped"

  const runs = [];
  const notes = [];
  let classifications = [];
  let investigations = [];

  const tags = await listInstalledModels({ baseUrl: ollama.baseUrl, fetchImpl: ollama.fetchImpl });
  const stages = [
    { stage: 'classification', model: CLASSIFY_MODEL, wanted: classify },
    { stage: 'investigation', model: INVESTIGATE_MODEL, wanted: investigate },
  ].filter((entry) => entry.wanted);

  if (!tags.reachable) notes.push(`Local models were not used: ${tags.error}. Start Ollama to enable AI interpretation.`);

  for (const { stage, model } of stages) {
    const installed = tags.models.find((candidate) => candidate.name === model);
    if (!tags.reachable || !installed) {
      if (tags.reachable) notes.push(`${model} is not installed; run: ollama pull ${model}`);
      runs.push({ stage, model, digest: installed?.digest ?? null, durationMs: 0, status: 'unavailable' });
      continue;
    }
    const result =
      stage === 'classification'
        ? await classifyFiles({ report, analysis, ollama, onProgress })
        : await investigateFindings({ report, analysis, ollama, onProgress });
    if (stage === 'classification') classifications = result.classifications;
    else investigations = result.investigations;
    notes.push(...result.notes);
    runs.push({ stage, model, digest: installed.digest, durationMs: result.durationMs, status: result.status });
  }

  const updated = {
    ...report,
    ai: { status: overallStatus(runs), runs, classifications, investigations },
    errors: [...report.errors, ...notes.map((message) => ({ stage: 'ai', message }))],
  };

  if (fingerprint(updated) !== before) {
    throw new Error('Internal error: local AI analysis changed the deterministic part of the report');
  }
  const problems = validateReport(updated);
  if (problems.length > 0) throw new Error(`Internal error: the report with AI output violates the contract:\n- ${problems.join('\n- ')}`);
  return updated;
}
