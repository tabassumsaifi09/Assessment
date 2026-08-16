import express from 'express';
import { resolve } from 'node:path';
import { config } from '../config/env';
import { createRouter } from './routes';
import { logger } from '../util/logger';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Small, dependency-free hardening: no framework fingerprint, no MIME
  // sniffing, no framing, and a CSP tight enough for the bundled client.
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('referrer-policy', 'same-origin');
    response.setHeader(
      'content-security-policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
    );
    next();
  });

  app.get('/api/health', (_request, response) => {
    response.json({ ok: true, provider: config.llm.provider, uptime: process.uptime() });
  });

  app.use('/api', createRouter());
  app.use(express.static(resolve(process.cwd(), 'public')));

  app.use((_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'no such endpoint' } });
  });

  return app;
}

const invokedDirectly = process.argv[1]?.includes('server');
if (invokedDirectly) {
  createApp().listen(config.api.port, () => {
    logger.info(`API listening on http://localhost:${config.api.port} (llm: ${config.llm.provider})`);
  });
}
