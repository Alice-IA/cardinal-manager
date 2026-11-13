export type JobStatus = 'pending' | 'running' | 'ready' | 'failed';

export type Transport = 'ws' | 'wss';

export interface JobResult {
  containerName?: string;
  internalHost?: string;
  port?: number;
  transport?: Transport;
  containerId?: string;
  code?: string;
  message?: string;
  callbackDelivered?: boolean;
}

export interface JobInput {
  jobId: string;
  sandboxId: string;
  userId: string;
  tokenSha256: string;
}

export interface Job extends JobInput {
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  result: JobResult;
}

export interface JobOutcome extends Omit<JobResult, 'callbackDelivered'> {
  ok: boolean;
}

export interface PublicJob {
  jobId: string;
  status: JobStatus;
  containerName?: string;
  internalHost?: string;
  port?: number;
  transport?: Transport;
  containerId?: string;
  code?: string;
  message?: string;
}

export interface StoreOptions {
  ttlMs?: number;
  sweepIntervalMs?: number;
  now?: () => number;
}

export const DEFAULT_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export class JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly ttlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: StoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Devuelve null si el jobId ya existe (activo o terminal) y no expiro.
   * No se reutiliza un jobId: un retry del backend debe traer uno nuevo.
   */
  create(input: JobInput): Job | null {
    this.pruneExpired();
    if (this.jobs.has(input.jobId)) return null;

    const timestamp = this.now();
    const job: Job = {
      ...input,
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: timestamp + this.ttlMs,
      result: {},
    };

    this.jobs.set(job.jobId, job);
    return job;
  }

  get(jobId: string): Job | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (this.isExpired(job)) {
      this.jobs.delete(jobId);
      return null;
    }
    return job;
  }

  markRunning(jobId: string): Job | null {
    const job = this.get(jobId);
    if (!job) return null;
    if (job.status === 'pending') {
      job.status = 'running';
      job.updatedAt = this.now();
    }
    return job;
  }

  complete(jobId: string, outcome: JobOutcome): Job | null {
    const job = this.get(jobId);
    if (!job) return null;

    const { ok, ...result } = outcome;
    job.status = ok ? 'ready' : 'failed';
    job.result = { ...job.result, ...result };
    job.updatedAt = this.now();
    return job;
  }

  setCallbackDelivered(jobId: string, delivered: boolean): Job | null {
    const job = this.get(jobId);
    if (!job) return null;
    job.result = { ...job.result, callbackDelivered: delivered };
    job.updatedAt = this.now();
    return job;
  }

  all(): Job[] {
    this.pruneExpired();
    return [...this.jobs.values()];
  }

  sweep(): number {
    const timestamp = this.now();
    let removed = 0;
    for (const [jobId, job] of this.jobs) {
      if (timestamp > job.expiresAt) {
        this.jobs.delete(jobId);
        removed += 1;
      }
    }
    return removed;
  }

  startSweeper(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sweep();
    }, this.sweepIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private isExpired(job: Job): boolean {
    return this.now() > job.expiresAt;
  }

  private pruneExpired(): void {
    const timestamp = this.now();
    for (const [jobId, job] of this.jobs) {
      if (timestamp > job.expiresAt) this.jobs.delete(jobId);
    }
  }
}

/** Respuesta publica: nunca incluye tokenSha256, userId ni callbackDelivered. */
export function toPublicJob(job: Job): PublicJob {
  const publicJob: PublicJob = {
    jobId: job.jobId,
    status: job.status,
  };

  if (job.result.containerName !== undefined) {
    publicJob.containerName = job.result.containerName;
  }
  if (job.result.internalHost !== undefined) {
    publicJob.internalHost = job.result.internalHost;
  }
  if (job.result.port !== undefined) {
    publicJob.port = job.result.port;
  }
  if (job.result.transport !== undefined) {
    publicJob.transport = job.result.transport;
  }
  if (job.result.containerId !== undefined) {
    publicJob.containerId = job.result.containerId;
  }
  if (job.result.code !== undefined) {
    publicJob.code = job.result.code;
  }
  if (job.result.message !== undefined) {
    publicJob.message = job.result.message;
  }

  return publicJob;
}
