import express from 'express';
import { getHealth } from './health.js';

export const VERSION = '0.1.0';

export function createApp({ ollamaBaseUrl, fetchImpl = fetch }) {
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
