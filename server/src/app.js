import express from 'express';
import { createAnalysisRouter } from './api/analysis.js';
import { getHealth } from './health.js';
import { VERSION } from './version.js';

export { VERSION };

// `fetchImpl` talks to the local Ollama; `analysisFetchImpl` reaches the npm registry
// and GitHub (through the allowlisting fetch in the pipeline). Kept separate so each
// can be replaced in tests and neither can be confused with the other.
export function createApp({ ollamaBaseUrl, fetchImpl = fetch, analysisFetchImpl = fetch, analyzeImpl, analysis = {} }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/api/health', async (_req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.json(await getHealth({ ollamaBaseUrl, fetchImpl, version: VERSION }));
    } catch (error) {
      next(error);
    }
  });

  const { router, manager } = createAnalysisRouter({ ollamaBaseUrl, ollamaFetch: fetchImpl, analysisFetch: analysisFetchImpl, analyzeImpl, ...analysis });
  app.use('/api', router);
  app.locals.jobs = manager;

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Never echo internal error details to clients.
  app.use((error, _req, res, _next) => {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
