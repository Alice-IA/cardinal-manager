import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedCallback {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  rawBody: string;
}

export interface FakeBackendOptions {
  status?: number | ((attempt: number, body: unknown) => number);
  body?: unknown | ((attempt: number, body: unknown) => unknown);
}

export interface FakeBackend {
  url: string;
  requests: ReceivedCallback[];
  close: () => Promise<void>;
}

export async function startFakeBackend(
  options: FakeBackendOptions = {},
): Promise<FakeBackend> {
  const requests: ReceivedCallback[] = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      let body: unknown = undefined;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }

      const attempt = requests.length;
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
        rawBody: raw,
      });

      const status =
        typeof options.status === 'function'
          ? options.status(attempt, body)
          : (options.status ?? 200);
      const responseBody =
        typeof options.body === 'function'
          ? options.body(attempt, body)
          : (options.body ?? { ok: true });

      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(responseBody));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeIdleConnections();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
