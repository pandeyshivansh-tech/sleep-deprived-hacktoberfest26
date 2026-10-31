import { encodePackageName, isExactVersion, validateSpec } from './ecosystems/npm/spec.js';
import { AudysseyError, FetchError, InputError } from './errors.js';
import { DEFAULT_LIMITS } from './limits.js';
import { safeFetchBuffer } from './net/safe-fetch.js';
import { analyzeNpmPackage } from './analyze.js';
import { escapeUnsafe } from './scan/text.js';

// Release watch: poll the npm registry for the newest published version of one
// package and run the normal analysis on each new version. It adds no analysis of
// its own: a new release goes through analyzeNpmPackage, so the report, limits and
// guarantees are exactly those of `audyssey analyze`. Nothing from a package is run.

export const MIN_INTERVAL_SECONDS = 60;
export const MAX_INTERVAL_SECONDS = 24 * 60 * 60;
export const DEFAULT_INTERVAL_SECONDS = 300;

export function resolveInterval(value) {
  if (value === undefined) return DEFAULT_INTERVAL_SECONDS;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) {
    throw new InputError(`--interval must be a whole number of seconds from ${MIN_INTERVAL_SECONDS} to ${MAX_INTERVAL_SECONDS} (it keeps the registry polite)`, 'bad-interval');
  }
  return seconds;
}

// The registry's own "latest" dist-tag, read as untrusted JSON.
export async function fetchLatestVersion({ name, fetchImpl = fetch, limits = DEFAULT_LIMITS }) {
  validateSpec({ name, version: '0.0.0' });
  let body;
  try {
    body = await safeFetchBuffer(`https://registry.npmjs.org/${encodePackageName(name)}/latest`, {
      fetchImpl,
      maxBytes: limits.network.maxMetadataBytes,
      timeoutMs: limits.network.timeoutMs,
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    if (error instanceof FetchError && error.code === 'http' && error.details.status === 404) {
      throw new InputError(`${name} was not found on the npm registry`, 'not-found');
    }
    throw error;
  }
  let metadata;
  try {
    metadata = JSON.parse(body.toString('utf8'));
  } catch {
    throw new FetchError('The npm registry returned metadata that is not valid JSON', 'bad-metadata');
  }
  if (metadata === null || typeof metadata !== 'object' || metadata.name !== name || !isExactVersion(metadata.version)) {
    throw new FetchError('The npm registry returned unexpected metadata for the latest version', 'bad-metadata');
  }
  return metadata.version;
}

// Semver precedence (build metadata ignored). Enough to tell "newer" from "older",
// so a moved dist-tag never triggers an analysis of an older version.
export function compareVersions(a, b) {
  const split = (version) => {
    const [core, pre] = version.split('+')[0].split(/-(.*)/s);
    return { nums: core.split('.').map(Number), pre: pre === undefined ? null : pre.split('.') };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i += 1) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (x.pre === null && y.pre === null) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    if (!pn && p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

const defaultSleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

// Emits events through `onEvent`:
//   { type: 'baseline', version }          first latest seen (nothing is analyzed for it)
//   { type: 'unchanged', version }         no newer version
//   { type: 'release', version, previous } a newer version was found; analysis starts
//   { type: 'report', version, report }    the standard Audyssey report for it
//   { type: 'error', stage, message }      a failed check or analysis; watching continues
// A version is analyzed once per session. After a failed analysis it is retried at
// the next poll, since no result was produced.
export async function watchPackage({
  name,
  since = null,
  intervalSeconds = DEFAULT_INTERVAL_SECONDS,
  once = false,
  fetchImpl = fetch,
  limits = DEFAULT_LIMITS,
  analyze = analyzeNpmPackage,
  ai = null,
  onEvent = () => {},
  onProgress = () => {},
  signal,
  sleep = defaultSleep,
  now,
}) {
  validateSpec({ name, version: since ?? '0.0.0' });
  const analyzed = new Set();
  let baseline = since;
  let failedChecks = 0;
  let checks = 0;

  while (!signal?.aborted) {
    checks += 1;
    try {
      const latest = await fetchLatestVersion({ name, fetchImpl, limits });
      failedChecks = 0;
      if (baseline === null) {
        baseline = latest;
        onEvent({ type: 'baseline', version: latest });
      } else if (compareVersions(latest, baseline) > 0 && !analyzed.has(latest)) {
        onEvent({ type: 'release', version: latest, previous: baseline });
        try {
          const { report } = await analyze({ name, version: latest, fetchImpl, limits, ai, onProgress, ...(now ? { now } : {}) });
          analyzed.add(latest);
          baseline = latest;
          onEvent({ type: 'report', version: latest, report });
        } catch (error) {
          if (error instanceof InputError && error.code === 'not-found') throw error;
          onEvent({ type: 'error', stage: 'analysis', message: describe(error) });
          failedChecks += 1;
        }
      } else {
        onEvent({ type: 'unchanged', version: latest });
      }
    } catch (error) {
      failedChecks += 1;
      onEvent({ type: 'error', stage: 'check', message: describe(error) });
      if (error instanceof InputError) return { checks, failed: true };
    }
    if (once) return { checks, failed: failedChecks > 0 };
    if (signal?.aborted) break;
    await sleep(intervalSeconds * 1000, signal);
  }
  return { checks, failed: false };
}

function describe(error) {
  return error instanceof AudysseyError ? escapeUnsafe(error.message) : 'Unexpected error while checking the registry.';
}
