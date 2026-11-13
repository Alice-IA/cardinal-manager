import path from 'node:path';
import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../../src/app';
import type { Env } from '../../src/config/env';
import { JobStore } from '../../src/jobs/store';
import {
  createFakeExecFile,
  type ExecResponder,
  type ExecResult,
  type FakeExecFile,
} from './fake-exec-file';

export const TEST_TOKEN = 'test-internal-token-0123456789abcdef';
export const TEST_HASH = '0123456789abcdef'.repeat(4);
export const TEST_JOB_ID = '11111111-1111-4111-8111-111111111111';
export const TEST_USER_ID = '22222222-2222-4222-8222-222222222222';
export const TEST_SANDBOX_ID = 'sbx-1';
export const TEST_API_KEY = 'sk-test-user-key-abc123';

export const authHeaders = { 'x-internal-token': TEST_TOKEN };

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    MANAGER_PORT: 0,
    INTERNAL_TOKEN: TEST_TOKEN,
    BACKEND_URL: 'http://127.0.0.1:1',
    ALICE_OPS_DIR: path.resolve(process.cwd(), 'tests', 'fake-alice-ops'),
    ALICE_NODE: 'local',
    PROVISION_TIMEOUT_MS: 5_000,
    LETTA_TAG: '0.34.39',
    LITELLM_BASE_URL: 'http://litellm:4000',
    LITELLM_API_KEY: undefined,
    LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    ...overrides,
  };
}

export interface TestApp {
  app: FastifyInstance;
  store: JobStore;
  exec: FakeExecFile;
  env: Env;
  baseUrl: string;
  close: () => Promise<void>;
}

export interface TestAppOptions {
  env?: Partial<Env>;
  responder?: ExecResponder | ExecResult;
  deps?: Partial<AppDeps>;
  listen?: boolean;
}

export async function createTestApp(
  options: TestAppOptions = {},
): Promise<TestApp> {
  const env = makeEnv(options.env);
  const exec = createFakeExecFile(options.responder ?? {});
  const store = new JobStore();

  const app = buildApp({
    env,
    deps: {
      execFile: exec.execFile,
      store,
      logger: pino({ level: 'silent' }),
      callbackBackoffMs: [0, 0, 0],
      sleep: async () => {},
      ...options.deps,
    },
  });

  await app.ready();
  if (options.listen !== false) {
    await app.listen({ port: 0, host: '127.0.0.1' });
  }

  const address = app.server.address();
  const baseUrl =
    address && typeof address === 'object'
      ? `http://127.0.0.1:${address.port}`
      : '';

  return {
    app,
    store,
    exec,
    env,
    baseUrl,
    close: async () => {
      await app.close();
    },
  };
}

export interface CapturingLogger {
  logger: Logger;
  lines: string[];
}

export function createCapturingLogger(): CapturingLogger {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = pino({ level: 'info' }, stream);
  return { logger, lines };
}

export async function waitFor<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 3_000);
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, options.intervalMs ?? 5));
  }

  throw new Error(
    `waitFor: timeout${options.label ? ` (${options.label})` : ''}${
      lastError ? `: ${String(lastError)}` : ''
    }`,
  );
}

export async function waitForJob(
  store: JobStore,
  jobId: string,
  predicate: (job: NonNullable<ReturnType<JobStore['get']>>) => boolean,
) {
  return waitFor(
    () => {
      const job = store.get(jobId);
      return job && predicate(job) ? job : undefined;
    },
    { label: `job ${jobId}` },
  );
}
