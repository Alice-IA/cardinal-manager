import type { ChildProcess } from 'node:child_process';

export interface ExecFileOptions {
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
}

export interface ExecFileError extends Error {
  code?: number | string | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  cmd?: string;
}

export type ExecCallback = (
  error: ExecFileError | null,
  stdout: string,
  stderr: string,
) => void;

export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: ExecCallback,
) => ChildProcess;

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;
