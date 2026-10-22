import Fastify, { type FastifyServerOptions } from 'fastify';

export function buildApp(options: FastifyServerOptions = {}) {
  const app = Fastify(options);

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'paypal-delight-ai',
  }));

  return app;
}
