import { describe, expect, it } from 'vitest';
import { JobStore, type JobInput } from '../src/jobs/store';
import { TEST_HASH, TEST_JOB_ID, TEST_SANDBOX_ID, TEST_USER_ID } from './helpers/app';

function input(overrides: Partial<JobInput> = {}): JobInput {
  return {
    jobId: TEST_JOB_ID,
    sandboxId: TEST_SANDBOX_ID,
    userId: TEST_USER_ID,
    tokenSha256: TEST_HASH,
    ...overrides,
  };
}

describe('JobStore', () => {
  it('crea un job pending y rechaza el mismo jobId', () => {
    const store = new JobStore();
    const job = store.create(input());

    expect(job?.status).toBe('pending');
    expect(job?.jobId).toBe(TEST_JOB_ID);
    expect(store.create(input())).toBeNull();
  });

  it('transiciona pending -> running -> ready', () => {
    const store = new JobStore();
    store.create(input());

    expect(store.markRunning(TEST_JOB_ID)?.status).toBe('running');

    const done = store.complete(TEST_JOB_ID, {
      ok: true,
      containerName: 'alice-sbx-1',
      internalHost: 'alice-sbx-1',
      port: 4500,
      transport: 'ws',
      containerId: 'cid-1',
    });

    expect(done?.status).toBe('ready');
    expect(done?.result.containerName).toBe('alice-sbx-1');
    expect(store.setCallbackDelivered(TEST_JOB_ID, false)?.result.callbackDelivered).toBe(
      false,
    );
  });

  it('un job terminado sigue en el Map pero no se reutiliza', () => {
    const store = new JobStore();
    store.create(input());
    store.complete(TEST_JOB_ID, { ok: false, code: 'INVALID_INPUT' });

    expect(store.get(TEST_JOB_ID)?.status).toBe('failed');
    expect(store.create(input())).toBeNull();
  });

  it('TTL de 1h: get devuelve null al expirar y sweep limpia', () => {
    let now = 1_000_000;
    const store = new JobStore({ now: () => now });
    store.create(input());

    now += 3_600_000;
    expect(store.get(TEST_JOB_ID)?.status).toBe('pending');

    now += 1;
    expect(store.get(TEST_JOB_ID)).toBeNull();

    store.create(input());
    now += 3_600_001;
    expect(store.sweep()).toBe(1);
    expect(store.all()).toHaveLength(0);
  });

  it('all solo devuelve jobs vigentes', () => {
    let now = 1_000_000;
    const store = new JobStore({ now: () => now });
    store.create(input());
    store.create(input({ jobId: '33333333-3333-4333-8333-333333333333' }));

    expect(store.all()).toHaveLength(2);
    now += 3_600_001;
    expect(store.all()).toHaveLength(0);
  });
});
