import { afterEach, describe, expect, it } from 'vitest';
import {
  authHeaders,
  createCapturingLogger,
  createTestApp,
  TEST_API_KEY,
  TEST_HASH,
  TEST_JOB_ID,
  TEST_SANDBOX_ID,
  TEST_TOKEN,
  TEST_USER_ID,
  waitFor,
  waitForJob,
  type TestApp,
  type TestAppOptions,
} from './helpers/app';
import {
  makeExecFileError,
  successDeploy,
  withDelay,
  type ExecResponder,
} from './helpers/fake-exec-file';
import {
  startFakeBackend,
  type FakeBackend,
  type FakeBackendOptions,
} from './helpers/fake-backend';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function start(options: TestAppOptions = {}): Promise<TestApp> {
  const ctx = await createTestApp(options);
  cleanups.push(ctx.close);
  return ctx;
}

async function startBackend(
  options: FakeBackendOptions = {},
): Promise<FakeBackend> {
  const backend = await startFakeBackend(options);
  cleanups.push(backend.close);
  return backend;
}

function payload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    jobId: TEST_JOB_ID,
    sandboxId: TEST_SANDBOX_ID,
    userId: TEST_USER_ID,
    tokenSha256: TEST_HASH,
    apiKey: TEST_API_KEY,
    ...overrides,
  };
}

function post(
  ctx: TestApp,
  body: Record<string, unknown> = payload(),
  headers: Record<string, string> = authHeaders,
) {
  return ctx.app.inject({
    method: 'POST',
    url: '/provision',
    headers,
    payload: body,
  });
}

function getJob(ctx: TestApp, jobId: string = TEST_JOB_ID) {
  return ctx.app.inject({
    method: 'GET',
    url: `/provision/${jobId}`,
    headers: authHeaders,
  });
}

function getOrphans(ctx: TestApp) {
  return ctx.app.inject({
    method: 'GET',
    url: '/provision/orphans',
    headers: authHeaders,
  });
}

describe('POST /provision', () => {
  it('17. sin X-Internal-Token o con token incorrecto -> 401', async () => {
    const ctx = await start({ responder: successDeploy() });

    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/provision',
      payload: payload(),
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({
      error: { code: 'INTERNAL_UNAUTHORIZED' },
    });

    const wrong = await post(ctx, payload(), {
      'x-internal-token': 'x'.repeat(TEST_TOKEN.length),
    });
    expect(wrong.statusCode).toBe(401);

    const getWithoutToken = await ctx.app.inject({
      method: 'GET',
      url: `/provision/${TEST_JOB_ID}`,
    });
    expect(getWithoutToken.statusCode).toBe(401);

    const orphansWithoutToken = await ctx.app.inject({
      method: 'GET',
      url: '/provision/orphans',
    });
    expect(orphansWithoutToken.statusCode).toBe(401);
  });

  it('18. body incompleto (sin tokenSha256) -> 400 VALIDATION_ERROR', async () => {
    const ctx = await start({ responder: successDeploy() });
    const body = payload();
    delete body.tokenSha256;

    const res = await post(ctx, body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('19. tokenSha256 no-hex -> 400; en MAYUSCULAS se acepta y normaliza', async () => {
    const ctx = await start({ responder: successDeploy() });

    const bad = await post(ctx, payload({ tokenSha256: 'z'.repeat(64) }));
    expect(bad.statusCode).toBe(400);

    const upper = await post(
      ctx,
      payload({ tokenSha256: TEST_HASH.toUpperCase() }),
    );
    expect(upper.statusCode).toBe(202);
    await waitForJob(ctx.store, TEST_JOB_ID, (job) => job.status === 'ready');
    expect(ctx.exec.calls[0]?.options.env?.WS_TOKEN_SHA256).toBe(TEST_HASH);
  });

  it('20. valido -> 202 {jobId} en <100ms y pending antes de que el fake responda', async () => {
    const ctx = await start({
      responder: withDelay(successDeploy(), 300),
    });

    const startedAt = performance.now();
    const res = await post(ctx);
    const elapsedMs = performance.now() - startedAt;

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ jobId: TEST_JOB_ID });
    expect(elapsedMs).toBeLessThan(100);

    const get = await getJob(ctx);
    expect(get.statusCode).toBe(200);
    expect(get.json().status).toBe('pending');

    await waitForJob(ctx.store, TEST_JOB_ID, (job) => job.status === 'ready');
  });

  it('21. el hash va por env, nunca por argv', async () => {
    const ctx = await start({ responder: successDeploy() });
    expect((await post(ctx)).statusCode).toBe(202);

    const call = await waitFor(() => ctx.exec.calls[0], {
      label: 'llamada a deploy.sh',
    });

    expect(call.args).toEqual(['--json', '--node', 'local']);
    expect(call.args.join(' ')).not.toContain(TEST_HASH);
    expect(call.args.join(' ')).not.toContain(TEST_API_KEY);
    expect(call.options.env?.WS_TOKEN_SHA256).toBe(TEST_HASH);
    expect(call.options.env?.LITELLM_API_KEY).toBe(TEST_API_KEY);
    expect(call.options.env?.LITELLM_BASE_URL).toBe('http://litellm:4000');
    expect(call.options.env?.LETTA_TAG).toBe('0.34.39');
    expect(call.options.env?.ALICE_JOB_ID).toBe(TEST_JOB_ID);
    expect(call.options.env?.ALICE_USER_ID).toBe(TEST_USER_ID);
    expect(call.options.env?.ALICE_SANDBOX_ID).toBe(TEST_SANDBOX_ID);
    expect(call.options.env?.INTERNAL_TOKEN).toBeUndefined();

    await waitForJob(ctx.store, TEST_JOB_ID, (job) => job.status === 'ready');
  });

  it('22. exit 2 -> failed con code INVALID_INPUT', async () => {
    const ctx = await start({
      responder: {
        code: 2,
        stdout: JSON.stringify({
          ok: false,
          code: 'INVALID_INPUT',
          message: 'falta LETTA_TAG',
        }),
      },
    });

    expect((await post(ctx)).statusCode).toBe(202);
    await waitForJob(
      ctx.store,
      TEST_JOB_ID,
      (job) => job.status === 'failed',
    );

    const body = (await getJob(ctx)).json();
    expect(body.status).toBe('failed');
    expect(body.code).toBe('INVALID_INPUT');
  });

  it('23. exit 1 lee el item de results[] y no el code superior', async () => {
    const ctx = await start({
      responder: {
        code: 1,
        stdout: JSON.stringify({
          ok: false,
          code: 'TOP_LEVEL_SHOULD_NOT_WIN',
          results: [
            {
              ok: false,
              sandboxId: TEST_SANDBOX_ID,
              containerId: 'cid-1',
              code: 'READY_TIMEOUT',
              message: 'sin respuesta en /readyz tras 90s',
            },
          ],
        }),
      },
    });

    expect((await post(ctx)).statusCode).toBe(202);
    await waitForJob(
      ctx.store,
      TEST_JOB_ID,
      (job) => job.status === 'failed',
    );

    const body = (await getJob(ctx)).json();
    expect(body.code).toBe('READY_TIMEOUT');
    expect(body.code).not.toBe('TOP_LEVEL_SHOULD_NOT_WIN');
  });

  it('24. stdout no-JSON -> BAD_MANAGER_OUTPUT sin crash', async () => {
    const ctx = await start({
      responder: { code: 1, stdout: 'esto no es json', stderr: 'boom' },
    });

    expect((await post(ctx)).statusCode).toBe(202);
    await waitForJob(
      ctx.store,
      TEST_JOB_ID,
      (job) => job.status === 'failed',
    );

    const body = (await getJob(ctx)).json();
    expect(body.code).toBe('BAD_MANAGER_OUTPUT');
    expect(body.message).toContain('esto no es json');
    expect(body.message.length).toBeLessThanOrEqual(500);
  });

  it('24b. BAD_MANAGER_OUTPUT filtra cadenas largas del message', async () => {
    const secret = 'A'.repeat(40);
    const ctx = await start({
      responder: { code: 1, stdout: `no json ${secret}`, stderr: '' },
    });

    expect((await post(ctx)).statusCode).toBe(202);
    await waitForJob(
      ctx.store,
      TEST_JOB_ID,
      (job) => job.status === 'failed',
    );

    const body = (await getJob(ctx)).json();
    expect(body.code).toBe('BAD_MANAGER_OUTPUT');
    expect(body.message).not.toContain(secret);
    expect(body.message).toContain('[REDACTED]');
  });

  it('30. mismo jobId pending/running -> 409; tras ready no se reusa', async () => {
    const ctx = await start({
      responder: withDelay(successDeploy(), 200),
    });

    expect((await post(ctx)).statusCode).toBe(202);

    const duplicate = await post(ctx);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: { code: 'JOB_EXISTS' } });

    await waitForJob(ctx.store, TEST_JOB_ID, (job) => job.status === 'ready');

    const reuse = await post(ctx);
    expect(reuse.statusCode).toBe(409);

    const secondJobId = '33333333-3333-4333-8333-333333333333';
    const fresh = await post(ctx, payload({ jobId: secondJobId }));
    expect(fresh.statusCode).toBe(202);
    await waitForJob(ctx.store, secondJobId, (job) => job.status === 'ready');
  });

  it('31. apiKey del body gana; si falta, usa LITELLM_API_KEY del .env', async () => {
    const ctx = await start({
      env: { LITELLM_API_KEY: 'sk-env-fallback' },
      responder: successDeploy(),
    });
    const withoutKey = payload();
    delete withoutKey.apiKey;

    expect((await post(ctx, withoutKey)).statusCode).toBe(202);
    await waitForJob(ctx.store, TEST_JOB_ID, (job) => job.status === 'ready');
    expect(ctx.exec.calls[0]?.options.env?.LITELLM_API_KEY).toBe(
      'sk-env-fallback',
    );

    const ctx2 = await start({
      env: { LITELLM_API_KEY: 'sk-env-fallback' },
      responder: successDeploy(),
    });
    expect((await post(ctx2)).statusCode).toBe(202);
    await waitForJob(ctx2.store, TEST_JOB_ID, (job) => job.status === 'ready');
    expect(ctx2.exec.calls[0]?.options.env?.LITELLM_API_KEY).toBe(TEST_API_KEY);
  });

  it('32. sin apiKey en el body ni en el .env -> 400 y no ejecuta deploy.sh', async () => {
    const ctx = await start({ responder: successDeploy() });
    const body = payload();
    delete body.apiKey;

    const res = await post(ctx, body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'VALIDATION_ERROR' } });
    expect(ctx.exec.calls).toHaveLength(0);
  });

  it('33. la apiKey no sale en GET, callback ni logs', async () => {
    const backend = await startBackend();
    const capture = createCapturingLogger();
    const ctx = await start({
      env: { BACKEND_URL: backend.url },
      responder: successDeploy(),
      deps: { logger: capture.logger },
    });

    expect((await post(ctx)).statusCode).toBe(202);
    await waitForJob(
      ctx.store,
      TEST_JOB_ID,
      (job) => job.status === 'ready' && job.result.callbackDelivered === true,
    );

    const get = await getJob(ctx);
    expect(JSON.stringify(get.json())).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(get.json())).not.toContain(TEST_HASH);

    await waitFor(() => (backend.requests.length >= 1 ? true : undefined), {
      label: 'callback',
    });
    expect(JSON.stringify(backend.requests[0]?.body)).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(backend.requests[0]?.body)).not.toContain(TEST_HASH);
    expect(capture.lines.join('\n')).not.toContain(TEST_API_KEY);
  });
});

describe('GET /provision/:jobId', () => {
  it('25. jobId desconocido -> 404 JOB_NOT_FOUND', async () => {
    const ctx = await start({ responder: successDeploy() });
    const res = await getJob(
      ctx,
      '99999999-9999-4999-8999-999999999999',
    );

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'JOB_NOT_FOUND' } });
  });
});

describe('GET /provision/orphans', () => {
  it('26. lista solo contenedores con alice.jobId fuera del Map', async () => {
    const responder: ExecResponder = (file, args, options) => {
      if (args[0] === 'ps') {
        return {
          code: 0,
          stdout: [
            JSON.stringify({
              ID: 'c-orphan',
              Names: 'alice-orphan',
              Labels: 'alice.jobId=orphan-job,alice.sandboxId=o1',
              Status: 'Exited (1) 2 hours ago',
            }),
            JSON.stringify({
              ID: 'c-active',
              Names: 'alice-active',
              Labels: `alice.jobId=${TEST_JOB_ID},alice.sandboxId=${TEST_SANDBOX_ID}`,
              Status: 'Up 3 minutes',
            }),
          ].join('\n'),
        };
      }
      return successDeploy()(file, args, options);
    };

    const ctx = await start({ responder });
    expect((await post(ctx)).statusCode).toBe(202);
    await waitForJob(ctx.store, TEST_JOB_ID, (job) => job.status === 'ready');

    const res = await getOrphans(ctx);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      containers: [
        {
          name: 'alice-orphan',
          containerId: 'c-orphan',
          labels: 'alice.jobId=orphan-job,alice.sandboxId=o1',
          status: 'Exited (1) 2 hours ago',
        },
      ],
    });

    const psCall = ctx.exec.calls.find((call) => call.args[0] === 'ps');
    expect(psCall?.args).toEqual([
      'ps',
      '-a',
      '--filter',
      'label=alice.jobId',
      '--format',
      '{{json .}}',
    ]);
  });
});

describe('resultado de deploy.sh', () => {
  it('27. results[] con 2 items resuelve solo el del sandbox propio', async () => {
    const ctx = await start({
      responder: {
        code: 1,
        stdout: JSON.stringify({
          ok: false,
          results: [
            {
              ok: true,
              sandboxId: TEST_SANDBOX_ID,
              containerName: 'alice-sbx-1',
              internalHost: 'alice-sbx-1',
              port: 4500,
              transport: 'ws',
              containerId: 'cid-1',
            },
            {
              ok: false,
              sandboxId: 'otro-sandbox',
              containerName: 'alice-otro',
              code: 'DEPLOY_FAILED',
              message: 'otro fallo',
              containerId: 'cid-2',
            },
          ],
        }),
      },
    });

    expect((await post(ctx)).statusCode).toBe(202);
    await waitForJob(ctx.store, TEST_JOB_ID, (job) => job.status === 'ready');

    const body = (await getJob(ctx)).json();
    expect(body.status).toBe('ready');
    expect(body.containerName).toBe('alice-sbx-1');
    expect(body.containerId).toBe('cid-1');
    expect(body.code).toBeUndefined();
    expect(body.message).toBeUndefined();
  });
});

describe('callback al backend', () => {
  it('28. callback con 500 siempre -> job ready y callbackDelivered=false', async () => {
    const backend = await startBackend({ status: 500 });
    const ctx = await start({
      env: { BACKEND_URL: backend.url },
      responder: successDeploy(),
    });

    expect((await post(ctx)).statusCode).toBe(202);
    const job = await waitForJob(
      ctx.store,
      TEST_JOB_ID,
      (candidate) =>
        candidate.status === 'ready' &&
        candidate.result.callbackDelivered === false,
    );

    expect(job.status).toBe('ready');
    expect(job.result.containerName).toBe('alice-sbx-1');

    await waitFor(
      () => (backend.requests.length >= 4 ? true : undefined),
      { label: '4 intentos de callback' },
    );
    expect(backend.requests).toHaveLength(4);

    for (const request of backend.requests) {
      expect(request.method).toBe('POST');
      expect(request.url).toBe('/internal/provision/ready');
      expect(request.headers['x-internal-token']).toBe(TEST_TOKEN);
      const body = request.body as Record<string, unknown>;
      expect(body.jobId).toBe(TEST_JOB_ID);
      expect(body.ok).toBe(true);
    }
  });

  it('29. timeout de execFile -> READY_TIMEOUT, no ETIMEDOUT crudo', async () => {
    const ctx = await start({
      responder: {
        error: makeExecFileError({
          message: 'Command failed: timeout',
          code: 'ETIMEDOUT',
          killed: true,
          signal: 'SIGTERM',
        }),
      },
    });

    expect((await post(ctx)).statusCode).toBe(202);
    await waitForJob(
      ctx.store,
      TEST_JOB_ID,
      (job) => job.status === 'failed',
    );

    const body = (await getJob(ctx)).json();
    expect(body.code).toBe('READY_TIMEOUT');
    expect(body.code).not.toBe('ETIMEDOUT');
  });
});
