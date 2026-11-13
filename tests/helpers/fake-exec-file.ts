import type { ChildProcess } from 'node:child_process';
import type { ExecFileError, ExecFileFn, ExecFileOptions } from '../../src/types';

export interface ExecResult {
  code?: number;
  stdout?: string;
  stderr?: string;
  delayMs?: number;
  error?: ExecFileError;
}

export type ExecResponder = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
) => ExecResult | Promise<ExecResult>;

export interface ExecCall {
  file: string;
  args: string[];
  options: ExecFileOptions;
}

export interface FakeExecFile {
  execFile: ExecFileFn;
  calls: ExecCall[];
  callsFor: (needle: string) => ExecCall[];
}

export function makeExecFileError(
  partial: Partial<ExecFileError> & { message: string },
): ExecFileError {
  const error = new Error(partial.message) as ExecFileError;
  Object.assign(error, partial);
  return error;
}

export function createFakeExecFile(
  responder: ExecResponder | ExecResult = {},
): FakeExecFile {
  const calls: ExecCall[] = [];

  const execFile: ExecFileFn = (file, args, options, callback): ChildProcess => {
    calls.push({
      file,
      args: [...args],
      options: {
        ...options,
        env: options.env ? { ...options.env } : undefined,
      },
    });

    const run = async (): Promise<void> => {
      let result: ExecResult;
      try {
        result =
          typeof responder === 'function'
            ? await responder(file, args, options)
            : responder;
      } catch (error) {
        callback(error as ExecFileError, '', '');
        return;
      }

      if (result.delayMs && result.delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, result.delayMs));
      }

      const stdout = result.stdout ?? '';
      const stderr = result.stderr ?? '';

      if (result.error) {
        callback(result.error, stdout, stderr);
        return;
      }

      const code = result.code ?? 0;
      if (code !== 0) {
        callback(
          makeExecFileError({
            message: `Command failed with exit code ${code}`,
            code,
          }),
          stdout,
          stderr,
        );
        return;
      }

      callback(null, stdout, stderr);
    };

    void run();
    return {} as ChildProcess;
  };

  return {
    execFile,
    calls,
    callsFor: (needle) =>
      calls.filter(
        (call) =>
          call.file.includes(needle) ||
          call.args.some((arg) => arg.includes(needle)),
      ),
  };
}

/** Respuesta de deploy.sh correcta para el sandbox que venga en el env. */
export function successDeploy(
  overrides: Record<string, unknown> = {},
): ExecResponder {
  return (_file, _args, options) => {
    const sandboxId = options.env?.ALICE_SANDBOX_ID ?? 'sbx-1';
    return {
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        results: [
          {
            ok: true,
            sandboxId,
            containerName: `alice-${sandboxId}`,
            internalHost: `alice-${sandboxId}`,
            port: 4500,
            transport: 'ws',
            containerId: `cid-${sandboxId}`,
            ...overrides,
          },
        ],
      }),
    };
  };
}

export function withDelay(
  responder: ExecResponder,
  delayMs: number,
): ExecResponder {
  return (file, args, options) => ({
    ...(responder(file, args, options) as ExecResult),
    delayMs,
  });
}
