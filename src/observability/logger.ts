import pino, { type Logger, type LoggerOptions } from 'pino';
import type { Env } from '../config/env';

/**
 * Logs en JSON. Nunca debe aparecer el token interno, el hash ni la apiKey
 * por usuario en un log: los paths de redact cubren los sitios habituales.
 */
export function createLogger(
  env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>,
): Logger {
  const options: LoggerOptions = {
    level: env.LOG_LEVEL,
    base: { service: 'cardinal-manager' },
    redact: {
      paths: [
        'req.headers["x-internal-token"]',
        'req.headers.authorization',
        'req.headers["ws_token_sha256"]',
        'x-internal-token',
        'authorization',
        'ws_token_sha256',
        'apiKey',
        '*.apiKey',
        'litellmApiKey',
        '*.litellmApiKey',
        'LITELLM_API_KEY',
        '*.LITELLM_API_KEY',
        'env.LITELLM_API_KEY',
      ],
      censor: '[REDACTED]',
    },
  };

  return pino(options);
}
