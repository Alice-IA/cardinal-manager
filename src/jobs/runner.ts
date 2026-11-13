import path from 'node:path';
import type { Logger } from 'pino';
import type { Env } from '../config/env';
import type { ExecFileError, ExecFileFn, ExecFileOptions } from '../types';
import type { Job, JobOutcome, JobStore, Transport } from './store';

export interface ExecRawResult {
  error: ExecFileError | null;
  stdout: string;
  stderr: string;
}

export interface CallbackDeliverer {
  deliver(job: Job, outcome: JobOutcome): Promise<boolean>;
}

export interface RunnerDeps {
  execFile: ExecFileFn;
  logger: Logger;
  env: Env;
  store: JobStore;
  callback: CallbackDeliverer;
}

export interface Runner {
  run(job: Job, apiKey: string): Promise<void>;
}

export function createRunner(deps: RunnerDeps): Runner {
  return {
    async run(job: Job, apiKey: string): Promise<void> {
      const startedAt = Date.now();
      const running = deps.store.markRunning(job.jobId);
      if (!running) return;

      let outcome: JobOutcome;
      try {
        const raw = await execDeploy(deps, job, apiKey);
        outcome = interpretDeploy(job, raw, apiKey, deps.env.INTERNAL_TOKEN);
      } catch (error) {
        outcome = {
          ok: false,
          code: 'BAD_MANAGER_OUTPUT',
          message: sanitizeMessage(errorMessage(error), job.tokenSha256, [
            apiKey,
            deps.env.INTERNAL_TOKEN,
          ]),
        };
      }

      deps.store.complete(job.jobId, outcome);

      deps.logger.info(
        {
          jobId: job.jobId,
          sandboxId: job.sandboxId,
          status: outcome.ok ? 'ready' : 'failed',
          code: outcome.code,
          durationMs: Date.now() - startedAt,
        },
        'provision_finished',
      );

      let delivered = false;
      try {
        delivered = await deps.callback.deliver(job, outcome);
      } catch (error) {
        deps.logger.error(
          {
            jobId: job.jobId,
            err: sanitizeMessage(errorMessage(error), job.tokenSha256, [
              apiKey,
              deps.env.INTERNAL_TOKEN,
            ]),
          },
          'CALLBACK_FAILED',
        );
        delivered = false;
      }

      deps.store.setCallbackDelivered(job.jobId, delivered);
    },
  };
}

/**
 * El hash y la apiKey viajan por env. Se borra INTERNAL_TOKEN del entorno
 * heredado: deploy.sh no lo necesita y no debe poder imprimirlo.
 */
function buildDeployEnv(job: Job, apiKey: string, env: Env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };

  delete childEnv.INTERNAL_TOKEN;
  delete childEnv.LITELLM_API_KEY;
  delete childEnv.WS_TOKEN_SHA256;
  delete childEnv.ALICE_JOB_ID;
  delete childEnv.ALICE_USER_ID;
  delete childEnv.ALICE_SANDBOX_ID;

  return {
    ...childEnv,
    ALICE_JOB_ID: job.jobId,
    ALICE_USER_ID: job.userId,
    ALICE_SANDBOX_ID: job.sandboxId,
    WS_TOKEN_SHA256: job.tokenSha256,
    LETTA_TAG: env.LETTA_TAG,
    LITELLM_BASE_URL: env.LITELLM_BASE_URL,
    LITELLM_API_KEY: apiKey,
  };
}

function execDeploy(
  deps: RunnerDeps,
  job: Job,
  apiKey: string,
): Promise<ExecRawResult> {
  const script = path.join(deps.env.ALICE_OPS_DIR, 'scripts', 'deploy.sh');
  const options: ExecFileOptions = {
    env: buildDeployEnv(job, apiKey, deps.env),
    timeout: deps.env.PROVISION_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  };

  return new Promise((resolve) => {
    try {
      deps.execFile(
        script,
        ['--json', '--node', deps.env.ALICE_NODE],
        options,
        (error, stdout, stderr) => {
          resolve({
            error: error ?? null,
            stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
            stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
          });
        },
      );
    } catch (error) {
      resolve({ error: asExecError(error), stdout: '', stderr: '' });
    }
  });
}

export function interpretDeploy(
  job: Job,
  raw: ExecRawResult,
  apiKey: string,
  internalToken: string,
): JobOutcome {
  const secrets = [apiKey, internalToken];
  const { error, stdout, stderr } = raw;

  if (isTimeout(error)) {
    return {
      ok: false,
      code: 'READY_TIMEOUT',
      message: 'deploy.sh excedio el timeout de provision',
    };
  }

  const exitCode =
    error === null ? 0 : typeof error.code === 'number' ? error.code : null;
  const parsed = parseDeployJson(stdout);

  if (exitCode === 2) {
    const rawMessage =
      nonEmptyString(parsed?.message) ?? firstChars(stdout, stderr);
    const message =
      rawMessage.length > 0 ? rawMessage : errorMessage(error) || 'entrada invalida';
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: sanitizeMessage(message, job.tokenSha256, secrets),
    };
  }

  if (exitCode === 0 || exitCode === 1) {
    if (!parsed) {
      return badOutput(stdout, stderr, error, job.tokenSha256, secrets);
    }

    const item = findItem(parsed.results, job.sandboxId);
    if (!item) {
      return badOutput(stdout, stderr, error, job.tokenSha256, secrets);
    }

    if (item.ok === false) {
      return {
        ok: false,
        code: nonEmptyString(item.code) ?? 'DEPLOY_FAILED',
        message: sanitizeMessage(
          nonEmptyString(item.message) ?? '',
          job.tokenSha256,
          secrets,
        ),
      };
    }

    return { ok: true, ...extractFields(item) };
  }

  return badOutput(stdout, stderr, error, job.tokenSha256, secrets);
}

function badOutput(
  stdout: string,
  stderr: string,
  error: ExecFileError | null,
  allowedHash: string,
  secrets: readonly string[],
): JobOutcome {
  const raw =
    firstChars(stdout, stderr, errorMessage(error)) ||
    'deploy.sh no devolvio JSON parseable';
  return {
    ok: false,
    code: 'BAD_MANAGER_OUTPUT',
    message: sanitizeMessage(raw, allowedHash, secrets),
  };
}

function parseDeployJson(
  stdout: string,
): { results: unknown[]; message?: unknown } | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isRecord(value)) return null;

  return {
    results: Array.isArray(value.results) ? value.results : [],
    message: value.message,
  };
}

function findItem(
  results: unknown[],
  sandboxId: string,
): Record<string, unknown> | null {
  for (const item of results) {
    if (isRecord(item) && item.sandboxId === sandboxId) return item;
  }
  return null;
}

function extractFields(item: Record<string, unknown>): Omit<JobOutcome, 'ok'> {
  const portValue = item.port;
  const port =
    typeof portValue === 'number'
      ? portValue
      : typeof portValue === 'string'
        ? Number(portValue)
        : Number.NaN;

  const transportValue = item.transport;
  const transport: Transport | undefined =
    transportValue === 'ws' || transportValue === 'wss'
      ? transportValue
      : undefined;

  return {
    containerName:
      typeof item.containerName === 'string' ? item.containerName : undefined,
    internalHost:
      typeof item.internalHost === 'string' ? item.internalHost : undefined,
    port: Number.isInteger(port) && port > 0 ? port : undefined,
    transport,
    containerId:
      typeof item.containerId === 'string' ? item.containerId : undefined,
  };
}

const LONG_ALNUM = /[A-Za-z0-9]{32,}/g;
const SK_TOKEN = /sk-[A-Za-z0-9_-]{8,}/g;

export function sanitizeMessage(
  input: string,
  allowedHash: string,
  secrets: readonly string[],
): string {
  let output = input.slice(0, 4000);

  for (const secret of secrets) {
    if (secret.length > 0) {
      output = output.split(secret).join('[REDACTED]');
    }
  }

  output = output.replace(SK_TOKEN, '[REDACTED]');
  output = output.replace(LONG_ALNUM, (match) =>
    match.toLowerCase() === allowedHash.toLowerCase() ? match : '[REDACTED]',
  );

  return output.slice(0, 500);
}

function isTimeout(error: ExecFileError | null): boolean {
  if (!error) return false;
  if (error.code === 'ETIMEDOUT') return true;
  return (
    error.killed === true &&
    (error.signal === 'SIGTERM' || error.signal === 'SIGKILL')
  );
}

function firstChars(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join('\n')
    .slice(0, 4000);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asExecError(error: unknown): ExecFileError {
  if (error instanceof Error) return error as ExecFileError;
  return Object.assign(new Error(String(error)), {}) as ExecFileError;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error === null || error === undefined) return '';
  return String(error);
}
