import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/app';
import { makeExecFileError } from './helpers/fake-exec-file';

const apps: TestApp[] = [];

afterEach(async () => {
  while (apps.length > 0) {
    await apps.pop()?.close();
  }
});

async function start(): Promise<TestApp> {
  const ctx = await createTestApp();
  apps.push(ctx);
  return ctx;
}

describe('GET /readyz', () => {
  it('34. 200 si docker version responde, sin token', async () => {
    const ctx = await start();
    // El fake responde a cualquier execFile con exito.
    const res = await ctx.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('34b. 503 si docker version falla', async () => {
    const ctx = await createTestApp({ responder: { code: 1, stderr: 'Cannot connect' } });
    apps.push(ctx);
    const res = await ctx.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false });
  });

  it('34c. 503 si docker version no responde (timeout)', async () => {
    const ctx = await createTestApp({
      responder: {
        error: makeExecFileError({
          message: 'Command failed: timed out',
          code: 'ETIMEDOUT',
          killed: true,
          signal: 'SIGTERM',
        }),
      },
    });
    apps.push(ctx);
    const res = await ctx.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
  });
});
