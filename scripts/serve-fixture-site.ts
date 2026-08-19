import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

/**
 * Static server for the local company sites in fixtures/sites.
 *
 *   npm run fixture:site -- --port 8099
 *
 * Used by the tests and by the sample batch cases, so the crawler can be
 * exercised end to end without touching the open internet.
 */
const ROOT = resolve(process.cwd(), 'fixtures/sites');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value && !value.startsWith('--') ? value : fallback;
}

export async function startFixtureServer(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const requested = decodeURIComponent(url.pathname);
      let filePath = resolve(join(ROOT, requested));

      // Never serve outside the fixture root.
      if (!filePath.startsWith(ROOT + sep) && filePath !== ROOT) {
        response.writeHead(403).end('forbidden');
        return;
      }

      const info = await stat(filePath).catch(() => null);
      if (info?.isDirectory()) filePath = join(filePath, 'index.html');

      const body = await readFile(filePath).catch(() => null);
      if (!body) {
        response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<html><body><h1>404</h1><p>Not found.</p></body></html>');
        return;
      }

      response.writeHead(200, {
        'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
        'content-length': body.byteLength,
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500).end((error as Error).message);
    }
  });

  await new Promise<void>((resolveListen) => server.listen(port, '127.0.0.1', resolveListen));
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${boundPort}`,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      ),
  };
}

const invokedDirectly = process.argv[1]?.includes('serve-fixture-site');
if (invokedDirectly) {
  const port = Number(argValue('port', '8099'));
  startFixtureServer(port).then(({ url }) => {
    console.log(`fixture sites served from ${url} (root: ${ROOT})`);
    console.log(`  ${url}/acme/      hiring page in a handbook`);
    console.log(`  ${url}/quietco/   no hiring page anywhere`);
    console.log(`  ${url}/deeporg/   hiring page three levels deep`);
  });
}
