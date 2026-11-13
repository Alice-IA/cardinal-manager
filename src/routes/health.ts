import type { FastifyInstance } from 'fastify';
import { dockerVersion, type DockerDeps } from '../docker/docker';

export function registerHealthRoutes(
  app: FastifyInstance,
  deps: DockerDeps,
): void {
  app.get('/readyz', async (_request, reply) => {
    const ok = await dockerVersion(deps);
    return reply.code(ok ? 200 : 503).send({ ok });
  });
}
