import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export type InternalAuth = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

/**
 * Mismo criterio que el backend: comparar longitudes antes de
 * timingSafeEqual para no filtrar el largo del token por tiempo.
 */
export function createInternalAuth(expectedToken: string): InternalAuth {
  const expected = Buffer.from(expectedToken, 'utf8');

  return async function internalAuth(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const header = request.headers['x-internal-token'];
    const provided = typeof header === 'string' ? header : '';
    const providedBuffer = Buffer.from(provided, 'utf8');

    const authorized =
      providedBuffer.length === expected.length &&
      timingSafeEqual(providedBuffer, expected);

    if (!authorized) {
      await reply
        .code(401)
        .send({ error: { code: 'INTERNAL_UNAUTHORIZED' } });
    }
  };
}
