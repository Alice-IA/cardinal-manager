import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  labelValue,
  listJobContainers,
  type DockerContainer,
} from '../docker/docker';
import type { Env } from '../config/env';
import type { InternalAuth } from '../auth/internal-token';
import type { Runner } from '../jobs/runner';
import { toPublicJob, type JobStore } from '../jobs/store';
import type { ExecFileFn } from '../types';

export interface ProvisionRouteDeps {
  env: Env;
  store: JobStore;
  runner: Runner;
  execFile: ExecFileFn;
  logger: Logger;
  auth: InternalAuth;
}

const provisionBodySchema = z.object({
  jobId: z.string().uuid(),
  sandboxId: z.string().min(1),
  userId: z.string().uuid(),
  tokenSha256: z
    .string()
    .transform((value) => value.toLowerCase())
    .pipe(z.string().regex(/^[0-9a-f]{64}$/)),
  apiKey: z.string().min(1).optional(),
});

export function registerProvisionRoutes(
  app: FastifyInstance,
  deps: ProvisionRouteDeps,
): void {
  app.post(
    '/provision',
    { preHandler: deps.auth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = provisionBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: { code: 'VALIDATION_ERROR' } });
      }

      const apiKey = parsed.data.apiKey ?? deps.env.LITELLM_API_KEY;
      if (!apiKey) {
        return reply.code(400).send({ error: { code: 'VALIDATION_ERROR' } });
      }

      const job = deps.store.create({
        jobId: parsed.data.jobId,
        sandboxId: parsed.data.sandboxId,
        userId: parsed.data.userId,
        tokenSha256: parsed.data.tokenSha256,
      });

      if (!job) {
        return reply.code(409).send({ error: { code: 'JOB_EXISTS' } });
      }

      reply.code(202).send({ jobId: job.jobId });

      const start = (): void => {
        void deps.runner.run(job, apiKey).catch((error: unknown) => {
          deps.logger.error(
            {
              jobId: job.jobId,
              err: error instanceof Error ? error.message : String(error),
            },
            'RUNNER_FAILED',
          );
        });
      };

      setImmediate(start);

      return reply;    },
  );

  app.get(
    '/provision/orphans',
    { preHandler: deps.auth },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      let containers: DockerContainer[];
      try {
        containers = await listJobContainers({
          execFile: deps.execFile,
          logger: deps.logger,
        });
      } catch (error) {
        deps.logger.error(
          {
            err: error instanceof Error ? error.message : String(error),
          },
          'docker_ps_failed',
        );
        return reply.code(503).send({ error: { code: 'DOCKER_UNAVAILABLE' } });
      }

      const orphans = containers.filter((container) => {
        const jobId = labelValue(container.labels, 'alice.jobId');
        if (!jobId) return true;
        return deps.store.get(jobId) === null;
      });

      return reply.code(200).send({ containers: orphans });
    },
  );

  app.get(
    '/provision/:jobId',
    { preHandler: deps.auth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { jobId } = request.params as { jobId: string };
      const job = deps.store.get(jobId);
      if (!job) {
        return reply.code(404).send({ error: { code: 'JOB_NOT_FOUND' } });
      }
      return reply.code(200).send(toPublicJob(job));
    },
  );
}
