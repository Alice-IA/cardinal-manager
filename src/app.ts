import { execFile as nodeExecFile } from 'node:child_process';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from 'fastify';
import type { Logger } from 'pino';
import type { Env } from './config/env';
import { createInternalAuth } from './auth/internal-token';
import { createCallback } from './jobs/callback';
import { createRunner } from './jobs/runner';
import { JobStore } from './jobs/store';
import { createLogger } from './observability/logger';
import { registerHealthRoutes } from './routes/health';
import { registerProvisionRoutes } from './routes/provision';
import type { ExecFileFn, FetchLike } from './types';

export interface AppDeps {
  execFile?: ExecFileFn;
  fetchImpl?: FetchLike;
  logger?: Logger;
  store?: JobStore;
  callbackBackoffMs?: number[];
  callbackTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface BuildAppOptions {
  env: Env;
  deps?: AppDeps;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function buildApp({ env, deps = {} }: BuildAppOptions): FastifyInstance {
  const logger = deps.logger ?? createLogger(env);
  const store = deps.store ?? new JobStore();
  const execFile = deps.execFile ?? (nodeExecFile as unknown as ExecFileFn);
  const fetchImpl: FetchLike = deps.fetchImpl ?? globalThis.fetch;
  const callbackBackoffMs = deps.callbackBackoffMs ?? [1000, 4000, 16000];
  const callbackTimeoutMs = deps.callbackTimeoutMs ?? 10_000;
  const sleep = deps.sleep ?? defaultSleep;

  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
  });

  const auth = createInternalAuth(env.INTERNAL_TOKEN);
  const callback = createCallback({
    fetchImpl,
    logger,
    backendUrl: env.BACKEND_URL,
    internalToken: env.INTERNAL_TOKEN,
    backoffMs: callbackBackoffMs,
    sleep,
    timeoutMs: callbackTimeoutMs,
  });
  const runner = createRunner({ execFile, logger, env, store, callback });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.statusCode === 400 || error.statusCode === 415) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR' } });
    }
    request.log.error({ err: error }, 'unhandled_error');
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR' } });
  });

  registerHealthRoutes(app, { execFile, logger });
  registerProvisionRoutes(app, {
    env,
    store,
    runner,
    execFile,
    logger,
    auth,
  });

  store.startSweeper();
  app.addHook('onClose', async () => {
    store.stop();
  });

  return app;
}
