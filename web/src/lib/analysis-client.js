import { acceptReport } from './report-load.js';

// Talks to the analysis API (docs: CLAUDE.md "API"). Everything here is real: it
// reports what the server says and nothing else. Network access is injected so
// tests never need a server.

// Must match MAX_UPLOAD_BYTES in server/src/api/analysis.js. The server is the
// authority; this only saves a doomed upload.
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const POLL_INTERVAL_MS = 1000;
export const MAX_CONSECUTIVE_NETWORK_ERRORS = 5;
const MAX_POLLS = 3600;

const ERROR_TEXT = {
  busy: 'The server is already running other analyses. Wait a moment and try again.',
  'too-large': 'The server refused the file as too large.',
  'not-gzip': 'This is not a gzip-compressed archive (.tgz).',
  'empty-upload': 'The file is empty.',
  'unsupported-media-type': 'The server did not accept the upload type.',
};

export function formatMegabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

// Cheap pre-checks. The extension is a hint for the user, not proof: the server
// judges the bytes.
export function checkUploadFile(file) {
  if (!file || typeof file.name !== 'string') return { ok: false, code: 'no-file', message: 'Choose a .tgz file first.' };
  if (!Number.isFinite(file.size) || file.size === 0) return { ok: false, code: 'empty', message: 'The file is empty.' };
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, code: 'too-large', message: `The file is ${formatMegabytes(file.size)}; the upload limit is ${formatMegabytes(MAX_UPLOAD_BYTES)}.` };
  }
  if (!/\.(tgz|tar\.gz)$/i.test(file.name)) {
    return { ok: false, code: 'wrong-extension', message: 'Expected an npm package archive ending in .tgz (or .tar.gz).' };
  }
  return { ok: true };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const networkFailure = () => ({ ok: false, kind: 'network', message: 'Cannot reach the Audyssey server. Is it running?' });

export async function submitAnalysis({ file, ai = false, fetchImpl = fetch, signal }) {
  const query = new URLSearchParams({ filename: file.name });
  if (ai) query.set('ai', '1');
  let response;
  try {
    response = await fetchImpl(`/api/analyze?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: file, signal });
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, kind: 'aborted', message: 'Stopped.' };
    return networkFailure();
  }
  const body = await readJson(response);
  if (response.status === 202 && body && typeof body.id === 'string') return { ok: true, job: body };
  const kind = response.status === 429 ? 'busy' : response.status === 413 ? 'too-large' : response.status >= 500 ? 'server' : 'rejected';
  return { ok: false, kind, message: body?.error ?? ERROR_TEXT[body?.code] ?? `The server answered HTTP ${response.status}.`, code: body?.code ?? null };
}

export async function getJob(id, { fetchImpl = fetch, signal } = {}) {
  let response;
  try {
    response = await fetchImpl(`/api/jobs/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' }, signal });
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, kind: 'aborted', message: 'Stopped.' };
    return networkFailure();
  }
  const body = await readJson(response);
  if (response.status === 200 && body && typeof body.state === 'string') return { ok: true, job: body };
  if (response.status === 404) return { ok: false, kind: 'lost', message: 'The server no longer knows this analysis. Jobs are kept in memory only, so a server restart discards them.' };
  return { ok: false, kind: 'server', message: `The server answered HTTP ${response.status}.` };
}

// The completed report goes through the same contract check as a file opened by hand.
export async function getReport(id, { fetchImpl = fetch, signal } = {}) {
  let response;
  try {
    response = await fetchImpl(`/api/jobs/${encodeURIComponent(id)}/report`, { headers: { Accept: 'application/json' }, signal });
  } catch {
    return networkFailure();
  }
  const body = await readJson(response);
  if (response.status !== 200 || body === null) return { ok: false, kind: 'server', message: body?.error ?? `The server answered HTTP ${response.status}.` };
  const accepted = acceptReport(body);
  return accepted.ok ? { ok: true, report: accepted.report } : { ok: false, kind: 'invalid-report', message: accepted.message, problems: accepted.problems };
}

const defaultSleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

// Submit, then poll until the job is finished. `onUpdate({ phase, job, message })`
// is called with exactly what the server reported. Resolves with
// { status: 'completed', report, job } | { status: 'failed', kind, message, job? } | { status: 'aborted' }.
export async function runAnalysis({ file, ai = false, fetchImpl = fetch, onUpdate = () => {}, signal, sleep = defaultSleep, intervalMs = POLL_INTERVAL_MS }) {
  const check = checkUploadFile(file);
  if (!check.ok) return { status: 'failed', kind: check.code, message: check.message };

  onUpdate({ phase: 'uploading', job: null, message: null });
  const submitted = await submitAnalysis({ file, ai, fetchImpl, signal });
  if (!submitted.ok) return submitted.kind === 'aborted' ? { status: 'aborted' } : { status: 'failed', kind: submitted.kind, message: submitted.message };

  let { job } = submitted;
  onUpdate({ phase: 'job', job, message: null });
  let networkErrors = 0;
  for (let polls = 0; polls < MAX_POLLS; polls += 1) {
    if (job.state === 'completed') {
      const fetched = await getReport(job.id, { fetchImpl, signal });
      if (fetched.ok) return { status: 'completed', report: fetched.report, job };
      return { status: 'failed', kind: fetched.kind, message: fetched.message, problems: fetched.problems, job };
    }
    if (job.state === 'failed') return { status: 'failed', kind: 'analysis-failed', message: job.error?.message ?? 'The analysis failed.', code: job.error?.code ?? null, job };

    await sleep(intervalMs, signal);
    if (signal?.aborted) return { status: 'aborted' };
    const next = await getJob(job.id, { fetchImpl, signal });
    if (next.ok) {
      networkErrors = 0;
      job = next.job;
      onUpdate({ phase: 'job', job, message: null });
    } else if (next.kind === 'aborted') {
      return { status: 'aborted' };
    } else if (next.kind === 'network' || next.kind === 'server') {
      networkErrors += 1;
      onUpdate({ phase: 'job', job, message: `${next.message} Retrying (${networkErrors}/${MAX_CONSECUTIVE_NETWORK_ERRORS})…` });
      if (networkErrors >= MAX_CONSECUTIVE_NETWORK_ERRORS) return { status: 'failed', kind: next.kind, message: `${next.message} Gave up after ${MAX_CONSECUTIVE_NETWORK_ERRORS} attempts; the analysis may still be running on the server.`, job };
    } else {
      return { status: 'failed', kind: next.kind, message: next.message, job };
    }
  }
  return { status: 'failed', kind: 'timeout', message: 'Stopped waiting: the analysis is taking unusually long.', job };
}
