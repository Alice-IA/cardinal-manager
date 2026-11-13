import type { Logger } from 'pino';
import type { ExecFileFn } from '../types';

export interface DockerContainer {
  name: string;
  containerId: string;
  labels: string;
  status: string;
}

export interface DockerDeps {
  execFile: ExecFileFn;
  logger: Logger;
}

interface RunOptions extends DockerDeps {
  timeoutMs: number;
}

const READYZ_TIMEOUT_MS = 2_500;
const ORPHANS_TIMEOUT_MS = 5_000;
const MAX_BUFFER = 1024 * 1024;

export async function dockerVersion(deps: DockerDeps): Promise<boolean> {
  try {
    await runDocker(['version'], {
      ...deps,
      timeoutMs: READYZ_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    deps.logger.debug(
      { err: error instanceof Error ? error.message : String(error) },
      'docker_version_failed',
    );
    return false;
  }
}

export async function listJobContainers(
  deps: DockerDeps,
): Promise<DockerContainer[]> {
  const { stdout } = await runDocker(
    [
      'ps',
      '-a',
      '--filter',
      'label=alice.jobId',
      '--format',
      '{{json .}}',
    ],
    { ...deps, timeoutMs: ORPHANS_TIMEOUT_MS },
  );

  return parseDockerPs(stdout);
}

export function labelValue(
  labels: string,
  key: string,
): string | undefined {
  for (const part of labels.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator) === key) {
      return part.slice(separator + 1);
    }
  }
  return undefined;
}

function runDocker(
  args: string[],
  options: RunOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    options.execFile(
      'docker',
      args,
      { timeout: options.timeoutMs, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

function parseDockerPs(stdout: string): DockerContainer[] {
  const containers: DockerContainer[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      continue;
    }

    const record = parsed as Record<string, unknown>;
    const name = typeof record.Names === 'string' ? record.Names : '';
    const containerId = typeof record.ID === 'string' ? record.ID : '';

    if (!name && !containerId) continue;

    containers.push({
      name,
      containerId,
      labels: typeof record.Labels === 'string' ? record.Labels : '',
      status: typeof record.Status === 'string' ? record.Status : '',
    });
  }

  return containers;
}
