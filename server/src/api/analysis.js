import express from 'express';
import { analyzeNpmPackage } from '../analyze.js';
import { CapacityError, JOB_ID_PATTERN, createJobManager } from '../jobs/manager.js';

// POST /api/analyze takes the .tgz itself as the request body (no multipart, no
// path, no URL): the client can only hand over bytes. They are read under a hard
// limit, kept in memory, parsed by the same bounded archive reader the CLI uses,
// and never written to disk.

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ACCEPTED_TYPES = ['application/gzip', 'application/x-gzip', 'application/octet-stream', 'application/x-tar', 'application/x-compressed-tar'];
const MAX_FILENAME_CHARS = 120;

// Display only: the name is never used to open, create or address anything.
export function sanitizeFilename(value) {
  if (typeof value !== 'string') return null;
  const base = value.split(/[\\/]/).pop() ?? '';
  const clean = [...base]
    .filter((char) => {
      const code = char.codePointAt(0);
      return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f) && !(code >= 0x200b && code <= 0x200f) && !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2066 && code <= 0x2069) && code !== 0xfeff;
    })
    .join('')
    .trim()
    .slice(0, MAX_FILENAME_CHARS);
  return clean === '' ? null : clean;
}

const fail = (res, status, code, error, extra = {}) => res.status(status).set('Cache-Control', 'no-store').json({ code, error, ...extra });

export function createAnalysisRouter({
  ollamaBaseUrl,
  ollamaFetch = fetch,
  analysisFetch = fetch,
  analyzeImpl = analyzeNpmPackage,
  maxUploadBytes = MAX_UPLOAD_BYTES,
  manager: managerOptions = {},
  now,
}) {
  const manager = createJobManager({
    analyze: async ({ bytes, ai, onProgress }) => {
      const { report } = await analyzeImpl({
        tarballBytes: bytes,
        fetchImpl: analysisFetch,
        ai: ai ? { baseUrl: ollamaBaseUrl, fetchImpl: ollamaFetch } : null,
        onProgress,
        ...(now ? { now } : {}),
      });
      return report;
    },
    ...managerOptions,
  });

  const router = express.Router();

  // Refuse before buffering anything when there is no room.
  const capacityGate = (_req, res, next) => (manager.hasCapacity() ? next() : fail(res, 429, 'busy', new CapacityError().message, { retryAfterSeconds: 10 }));

  const contentTypeGate = (req, res, next) => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    // A type browsers cannot send cross-site without a CORS preflight, so another
    // website cannot start analyses on this server.
    if (!ACCEPTED_TYPES.includes(type)) return fail(res, 415, 'unsupported-media-type', 'Send the .tgz as the request body with Content-Type: application/gzip.');
    return next();
  };

  router.post(
    '/analyze',
    capacityGate,
    contentTypeGate,
    // inflate:false: a Content-Encoding header must not make the server expand an upload.
    express.raw({ type: () => true, limit: maxUploadBytes, inflate: false }),
    (req, res) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) return fail(res, 400, 'empty-upload', 'The upload is empty.');
      if (body.length < 2 || body[0] !== 0x1f || body[1] !== 0x8b) {
        return fail(res, 400, 'not-gzip', 'The upload is not a gzip-compressed archive (.tgz). A file name or type is not accepted as proof.');
      }
      const ai = ['1', 'true'].includes(String(req.query.ai ?? ''));
      try {
        const job = manager.submit({ bytes: body, filename: sanitizeFilename(req.query.filename), ai });
        res.set('Cache-Control', 'no-store').set('Location', `/api/jobs/${job.id}`).status(202).json(job);
      } catch (error) {
        if (error instanceof CapacityError) return fail(res, 429, 'busy', error.message, { retryAfterSeconds: 10 });
        throw error;
      }
      return undefined;
    },
  );

  const withJob = (handler) => (req, res) => {
    const { id } = req.params;
    if (!JOB_ID_PATTERN.test(id)) return fail(res, 404, 'unknown-job', 'No such analysis job. Jobs disappear when the server restarts.');
    return handler(id, res);
  };

  router.get('/jobs/:id', withJob((id, res) => {
    const job = manager.get(id);
    if (!job) return fail(res, 404, 'unknown-job', 'No such analysis job. Jobs disappear when the server restarts.');
    return res.set('Cache-Control', 'no-store').json(job);
  }));

  router.get('/jobs/:id/report', withJob((id, res) => {
    const found = manager.report(id);
    if (!found) return fail(res, 404, 'unknown-job', 'No such analysis job. Jobs disappear when the server restarts.');
    if (found.state !== 'completed') return fail(res, 409, 'not-ready', `The analysis is ${found.state}; there is no report to return.`, { state: found.state });
    return res.set('Cache-Control', 'no-store').json(found.report);
  }));

  // Body-parser errors: size and malformed requests get precise, safe answers.
  router.use((error, _req, res, next) => {
    if (error?.type === 'entity.too.large') return fail(res, 413, 'too-large', `The upload is larger than the ${Math.round(maxUploadBytes / (1024 * 1024))} MB limit.`, { maxBytes: maxUploadBytes });
    if (error?.status >= 400 && error?.status < 500) return fail(res, 400, 'bad-request', 'The upload could not be read.');
    return next(error);
  });

  return { router, manager };
}
