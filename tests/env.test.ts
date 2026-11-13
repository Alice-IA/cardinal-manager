import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EnvValidationError, parseEnv } from '../src/config/env';

let opsDir: string;
let emptyDir: string;

beforeAll(() => {
  opsDir = mkdtempSync(path.join(tmpdir(), 'cm-ops-'));
  mkdirSync(path.join(opsDir, 'scripts'));
  writeFileSync(
    path.join(opsDir, 'scripts', 'deploy.sh'),
    '#!/usr/bin/env bash\nexit 0\n',
  );
  emptyDir = mkdtempSync(path.join(tmpdir(), 'cm-empty-'));
});

afterAll(() => {
  rmSync(opsDir, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

function raw(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    INTERNAL_TOKEN: 'x'.repeat(32),
    ALICE_OPS_DIR: opsDir,
    LETTA_TAG: '0.34.39',
    LITELLM_BASE_URL: 'http://litellm:4000',
    ...overrides,
  };
}

describe('parseEnv', () => {
  it('aplica los defaults documentados y resuelve ALICE_OPS_DIR', () => {
    const env = parseEnv(raw());

    expect(env.MANAGER_PORT).toBe(8090);
    expect(env.BACKEND_URL).toBe('http://backend:3000');
    expect(env.ALICE_NODE).toBe('local');
    expect(env.PROVISION_TIMEOUT_MS).toBe(180000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.NODE_ENV).toBe('development');
    expect(env.ALICE_OPS_DIR).toBe(path.resolve(opsDir));
    expect(env.LITELLM_API_KEY).toBeUndefined();
  });

  it('sin INTERNAL_TOKEN falla', () => {
    expect(() => parseEnv(raw({ INTERNAL_TOKEN: undefined }))).toThrow(
      EnvValidationError,
    );
  });

  it('INTERNAL_TOKEN con menos de 32 caracteres falla', () => {
    expect(() => parseEnv(raw({ INTERNAL_TOKEN: 'x'.repeat(31) }))).toThrow(
      EnvValidationError,
    );
  });

  it('sin ALICE_OPS_DIR falla', () => {
    expect(() => parseEnv(raw({ ALICE_OPS_DIR: undefined }))).toThrow(
      EnvValidationError,
    );
  });

  it('ALICE_OPS_DIR relativo falla', () => {
    expect(() =>
      parseEnv(raw({ ALICE_OPS_DIR: 'alice-ops' })),
    ).toThrow(EnvValidationError);
  });

  it('ALICE_OPS_DIR sin scripts/deploy.sh falla', () => {
    expect(() => parseEnv(raw({ ALICE_OPS_DIR: emptyDir }))).toThrow(
      EnvValidationError,
    );
  });

  it('sin LETTA_TAG falla', () => {
    expect(() => parseEnv(raw({ LETTA_TAG: undefined }))).toThrow(
      EnvValidationError,
    );
  });

  it('LETTA_TAG=latest falla', () => {
    expect(() => parseEnv(raw({ LETTA_TAG: 'latest' }))).toThrow(
      EnvValidationError,
    );
    expect(() => parseEnv(raw({ LETTA_TAG: 'LATEST' }))).toThrow(
      EnvValidationError,
    );
  });

  it('sin LITELLM_BASE_URL falla', () => {
    expect(() => parseEnv(raw({ LITELLM_BASE_URL: undefined }))).toThrow(
      EnvValidationError,
    );
  });

  it('LITELLM_BASE_URL invalida falla', () => {
    expect(() =>
      parseEnv(raw({ LITELLM_BASE_URL: 'no-es-url' })),
    ).toThrow(EnvValidationError);
  });

  it('LITELLM_API_KEY es opcional y se conserva si viene', () => {
    const env = parseEnv(raw({ LITELLM_API_KEY: 'sk-pruebas' }));
    expect(env.LITELLM_API_KEY).toBe('sk-pruebas');
  });
});
