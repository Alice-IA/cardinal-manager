import type { Logger } from 'pino';
import type { FetchLike } from '../types';
import type { Job, JobOutcome } from './store';

export interface CallbackDeps {
  fetchImpl: FetchLike;
  logger: Logger;
  backendUrl: string;
  internalToken: string;
  backoffMs: readonly number[];
  sleep: (ms: number) => Promise<void>;
  timeoutMs: number;
}

export interface Callback {
  deliver(job: Job, outcome: JobOutcome): Promise<boolean>;
}

export function createCallback(deps: CallbackDeps): Callback {
  const url = `${deps.backendUrl.replace(/\/+$/, '')}/internal/provision/ready`;
  const attempts = deps.backoffMs.length + 1;

  return {
    async deliver(job: Job, outcome: JobOutcome): Promise<boolean> {
      const body = JSON.stringify(buildPayload(job, outcome));

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) {
          const delay = deps.backoffMs[attempt - 1] ?? 0;
          if (delay > 0) await deps.sleep(delay);
        }

        try {
          const response = await deps.fetchImpl(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-internal-token': deps.internalToken,
            },
            body,
            signal: AbortSignal.timeout(deps.timeoutMs),
          });

          if (response.ok) {
            deps.logger.info(
              { jobId: job.jobId, attempt: attempt + 1 },
              'CALLBACK_DELIVERED',
            );
            return true;
          }

          deps.logger.warn(
            { jobId: job.jobId, attempt: attempt + 1, status: response.status },
            'CALLBACK_FAILED',
          );
        } catch (error) {
          deps.logger.warn(
            {
              jobId: job.jobId,
              attempt: attempt + 1,
              err: error instanceof Error ? error.message : String(error),
            },
            'CALLBACK_FAILED',
          );
        }
      }

      deps.logger.error(
        { jobId: job.jobId, attempts },
        'CALLBACK_FAILED',
      );
      return false;
    },
  };
}

function buildPayload(
  job: Job,
  outcome: JobOutcome,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    jobId: job.jobId,
    ok: outcome.ok,
  };

  const fields = [
    'containerName',
    'internalHost',
    'port',
    'transport',
    'containerId',
    'code',
    'message',
  ] as const;

  for (const field of fields) {
    const value = outcome[field];
    if (value !== undefined) payload[field] = value;
  }

  return payload;
}
