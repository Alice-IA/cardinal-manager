import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

export const NODE_ENVS = ['development', 'test', 'production'] as const;

const envSchema = z.object({
  MANAGER_PORT: z.coerce.number().int().min(1).max(65535).default(8090),
  INTERNAL_TOKEN: z
    .string()
    .min(32, 'INTERNAL_TOKEN debe tener al menos 32 caracteres'),
  BACKEND_URL: z.string().url().default('http://backend:3000'),
  ALICE_OPS_DIR: z.string().min(1, 'ALICE_OPS_DIR es obligatorio'),
  ALICE_NODE: z.string().min(1).default('local'),
  PROVISION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(180_000),
  LETTA_TAG: z
    .string()
    .min(1, 'LETTA_TAG es obligatorio')
    .refine(
      (value) => value.toLowerCase() !== 'latest',
      'LETTA_TAG no puede ser latest (sin rollback)',
    ),
  LITELLM_BASE_URL: z
    .string()
    .url('LITELLM_BASE_URL debe ser una URL valida'),
  LITELLM_API_KEY: z
    .string()
    .min(1, 'LITELLM_API_KEY no puede estar vacia')
    .optional(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

export function parseEnv(raw: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const key = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${key}: ${issue.message}`;
    });
    throw new EnvValidationError(
      `Configuracion invalida:\n${issues.join('\n')}`,
      issues,
    );
  }

  const env = parsed.data;

  if (!path.isAbsolute(env.ALICE_OPS_DIR)) {
    throw new EnvValidationError(
      `ALICE_OPS_DIR debe ser una ruta absoluta (recibido: ${env.ALICE_OPS_DIR})`,
    );
  }

  const resolved = path.resolve(env.ALICE_OPS_DIR);
  const deployScript = path.join(resolved, 'scripts', 'deploy.sh');

  let stats: fs.Stats;
  try {
    stats = fs.statSync(deployScript);
  } catch {
    throw new EnvValidationError(
      `ALICE_OPS_DIR no contiene scripts/deploy.sh: ${resolved}`,
    );
  }

  if (!stats.isFile()) {
    throw new EnvValidationError(
      `ALICE_OPS_DIR/scripts/deploy.sh no es un archivo: ${deployScript}`,
    );
  }

  return { ...env, ALICE_OPS_DIR: resolved };
}
