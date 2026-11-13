import { buildApp } from './app';
import { parseEnv, type Env } from './config/env';
import { createLogger } from './observability/logger';

async function main(): Promise<void> {
  let env: Env;
  try {
    env = parseEnv(process.env);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }

  const logger = createLogger(env);
  const app = buildApp({ env, deps: { logger } });
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting_down');
    void app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error({ err: error }, 'shutdown_failed');
        process.exit(1);
      },
    );
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await app.listen({ port: env.MANAGER_PORT, host: '0.0.0.0' });
    logger.info({ port: env.MANAGER_PORT }, 'manager_listening');
  } catch (error) {
    logger.error({ err: error }, 'listen_failed');
    process.exit(1);
  }
}

void main();
