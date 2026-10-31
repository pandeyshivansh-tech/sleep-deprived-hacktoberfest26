import { randomBytes } from 'node:crypto';
import { AudysseyError } from '../errors.js';
import { validateReport } from '../report/schema.js';

// In-memory analysis jobs. Deliberately ephemeral: no database, no queue service,
// nothing written to disk. Jobs (and their reports) vanish when the server restarts
// or after `ttlMs`. The uploaded archive is held in memory only until its analysis
// ends, then released.

export const JOB_ID_PATTERN = /^[0-9a-f]{32}$/;
const MAX_PROGRESS = 40;
const MAX_ERROR_CHARS = 400;

export class CapacityError extends Error {
  constructor() {
    super('The server is busy with other analyses. Try again shortly.');
    this.name = 'CapacityError';
  }
}

// What a client may see about a failure. Authored messages from the pipeline
// (bad archive, package not on npm, network refused) are passed on; anything
// unexpected becomes a generic message and is only logged on the server.
export function publicError(error) {
  if (error instanceof AudysseyError) {
    return { code: error.code ?? 'analysis-failed', message: String(error.message).slice(0, MAX_ERROR_CHARS) };
  }
  return { code: 'analysis-failed', message: 'The analysis failed unexpectedly. Details are in the server log.' };
}

export function createJobManager({
  analyze,
  maxRunning = 1,
  maxQueued = 2,
  maxRetained = 50,
  ttlMs = 60 * 60 * 1000,
  now = () => Date.now(),
  newId = () => randomBytes(16).toString('hex'),
  logError = (error) => console.error(error),
}) {
  const jobs = new Map();
  const queue = [];
  let running = 0;

  const view = (job) => ({
    id: job.id,
    state: job.state,
    filename: job.filename,
    ai: job.ai,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
    queuePosition: job.state === 'queued' ? queue.indexOf(job) + 1 : null,
    progress: job.progress,
    error: job.error,
    reportUrl: job.state === 'completed' ? `/api/jobs/${job.id}/report` : null,
  });

  const touch = (job) => {
    job.updatedAt = now();
  };

  function evict() {
    const cutoff = now() - ttlMs;
    for (const job of [...jobs.values()]) {
      if ((job.state === 'completed' || job.state === 'failed') && job.updatedAt < cutoff) jobs.delete(job.id);
    }
    // Over the cap: drop the oldest finished jobs first, never one in progress.
    for (const job of [...jobs.values()]) {
      if (jobs.size <= maxRetained) break;
      if (job.state === 'completed' || job.state === 'failed') jobs.delete(job.id);
    }
  }

  async function run(job) {
    job.state = 'running';
    job.progress.push({ at: new Date(now()).toISOString(), message: 'Analysis started' });
    touch(job);
    try {
      const bytes = job.bytes;
      const report = await analyze({
        bytes,
        ai: job.ai,
        onProgress: (message) => {
          if (job.progress.length < MAX_PROGRESS) job.progress.push({ at: new Date(now()).toISOString(), message: String(message).slice(0, 200) });
          touch(job);
        },
      });
      // Nothing unvalidated is ever stored or returned.
      const problems = validateReport(report);
      if (problems.length > 0) {
        logError(new Error(`Report failed its own contract: ${problems.slice(0, 5).join('; ')}`));
        job.error = { code: 'invalid-report', message: 'The analysis produced a report that failed validation, so it was discarded.' };
        job.state = 'failed';
      } else {
        job.report = report;
        job.state = 'completed';
      }
    } catch (error) {
      if (!(error instanceof AudysseyError)) logError(error);
      job.error = publicError(error);
      job.state = 'failed';
    } finally {
      job.bytes = null;
      touch(job);
      running -= 1;
      pump();
    }
  }

  function pump() {
    while (running < maxRunning && queue.length > 0) {
      const job = queue.shift();
      running += 1;
      void run(job);
    }
  }

  return {
    hasCapacity: () => running + queue.length < maxRunning + maxQueued,
    submit({ bytes, filename, ai }) {
      evict();
      if (running + queue.length >= maxRunning + maxQueued) throw new CapacityError();
      const job = { id: newId(), state: 'queued', filename, ai: Boolean(ai), createdAt: now(), updatedAt: now(), progress: [], error: null, report: null, bytes };
      jobs.set(job.id, job);
      queue.push(job);
      const snapshot = view(job);
      pump();
      return snapshot;
    },
    get(id) {
      evict();
      const job = jobs.get(id);
      return job ? view(job) : null;
    },
    report(id) {
      const job = jobs.get(id);
      return job ? { state: job.state, report: job.state === 'completed' ? job.report : null } : null;
    },
    stats: () => ({ running, queued: queue.length, retained: jobs.size }),
  };
}
