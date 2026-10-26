import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net, { type AddressInfo, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket, { WebSocketServer } from 'ws';
import { startStaticServer, type StaticServerHandle } from './static-server.js';

async function mkRendererFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-static-'));
  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>root</title>');
  await fs.mkdir(path.join(dir, 'assets'));
  await fs.writeFile(path.join(dir, 'assets', 'main.js'), 'console.log("hi")');
  return dir;
}

async function startMockBackend(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const WS_KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const WS_RESPONSE =
  'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
  `Sec-WebSocket-Accept: ${createHash('sha1').update(`${WS_KEY}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')}\r\n\r\n`;
const CONTENT_REQUEST = 'GET /api/content-catalog/catalog HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n';
const execFileAsync = promisify(execFile);

function wsRequest(route: string, extraHeaders = ''): string {
  return (
    `GET ${route} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: keep-alive, Upgrade\r\n` +
    `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${WS_KEY}\r\n${extraHeaders}\r\n`
  );
}

async function startRawBackend(onConnection: (socket: Socket) => void): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const clients = new Set<Socket>();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      for (const client of clients) client.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function rawExchange(port: number, send: (socket: Socket) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => send(socket));
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => socket.destroy(new Error('timeout waiting for connection close')), 2500);
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
  });
}

describe('static-server', () => {
  let handle: StaticServerHandle | null = null;
  let stopBackend: (() => Promise<void>) | null = null;
  let staticDir = '';

  beforeEach(async () => {
    staticDir = await mkRendererFixture();
  });

  afterEach(async () => {
    if (handle) {
      await handle.stop();
      handle = null;
    }
    if (stopBackend) {
      await stopBackend();
      stopBackend = null;
    }
    await fs.rm(staticDir, { recursive: true, force: true });
  });

  it('serves static index.html at /', async () => {
    const backend = await startMockBackend((_req, res) => res.end('nope'));
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
    const r = await fetch(`${handle.localUrl}/`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('<title>root</title>');
  });

  it('SPA fallback: /chat/123 returns index.html', async () => {
    const backend = await startMockBackend((_req, res) => res.end('nope'));
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
    const r = await fetch(`${handle.localUrl}/chat/123`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('<title>root</title>');
  });

  it('static asset /assets/main.js served', async () => {
    const backend = await startMockBackend((_req, res) => res.end('nope'));
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
    const r = await fetch(`${handle.localUrl}/assets/main.js`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('hi');
  });

  it('/api/* reverse-proxies to backend', async () => {
    const backend = await startMockBackend((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, method: req.method }));
    });
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
    const r = await fetch(`${handle.localUrl}/api/anything`);
    expect(r.status).toBe(200);
    const json = (await r.json()) as { path: string };
    expect(json.path).toBe('/api/anything');
  });
  it('overwrites the embedded-WebUI marker so browsers cannot inherit desktop authentication', async () => {
    const backend = await startMockBackend((req, res) => res.end(String(req.headers['x-openh3-webui-request'])));
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
    expect(
      await (
        await fetch(`${handle.localUrl}/api/content-catalog/catalog`, { headers: { 'x-openh3-webui-request': '0' } })
      ).text()
    ).toBe('1');
  });

  describe.each(['/ws', '/api/stt/stream'])('%s TCP upgrade boundary', (route) => {
    it('does not give a non-upgrade GET pipeline an unmarked connection to Core', async () => {
      const contentMarkers: unknown[] = [];
      const backend = await startMockBackend((req, res) => {
        if (req.url === '/api/content-catalog/catalog') {
          contentMarkers.push(req.headers['x-openh3-webui-request']);
          res.end(req.headers['x-openh3-webui-request'] === '1' ? 'WEBUI_AUTH_REQUIRED' : 'DESKTOP_CONTENT');
        } else {
          res.writeHead(400).end('upgrade required');
        }
      });
      stopBackend = backend.close;
      handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
      const response = await rawExchange(handle.port, (socket) => {
        socket.write(`GET ${route} HTTP/1.1\r\nHost: localhost\r\n\r\n${CONTENT_REQUEST}`);
      });
      expect(response.toString()).not.toContain('DESKTOP_CONTENT');
      expect(contentMarkers.every((marker) => marker === '1')).toBe(true);
    });

    it('isolates a rejected handshake from a same-packet HTTP pipeline', async () => {
      let received = '';
      const backend = await startRawBackend((socket) => {
        socket.on('data', (chunk) => {
          received += chunk.toString();
          if (received.includes('\r\n\r\n')) {
            // Keep-alive refusal: the proxy must close without sending the next request.
            socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 6\r\nConnection: keep-alive\r\n\r\ndenied');
          }
        });
      });
      stopBackend = backend.close;
      handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
      const response = await rawExchange(handle.port, (socket) => socket.write(wsRequest(route) + CONTENT_REQUEST));
      expect(received).toBe(wsRequest(route));
      expect(response.toString()).toContain('401 Unauthorized');
      expect(response.toString()).toContain('denied');
    });

    it('discards bytes arriving while the backend handshake is still pending', async () => {
      let received = '';
      let sendDelayedBytes: (() => void) | undefined;
      const backend = await startRawBackend((socket) => {
        socket.on('data', (chunk) => {
          received += chunk.toString();
          if (!received.includes('\r\n\r\n')) return;
          sendDelayedBytes?.();
          sendDelayedBytes = undefined;
          setTimeout(() => {
            socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 6\r\n\r\nden');
            setTimeout(() => socket.write('ied'), 10);
          }, 50);
        });
      });
      stopBackend = backend.close;
      handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
      const response = await rawExchange(handle.port, (socket) => {
        sendDelayedBytes = () => socket.write(CONTENT_REQUEST);
        socket.write(wsRequest(route));
      });
      expect(received).toBe(wsRequest(route));
      expect(response.toString()).toContain('denied');
    });

    it('waits for a segmented complete request header before contacting Core', async () => {
      let receivedBeforeHeaderEnd = false;
      let requestComplete = false;
      let received = '';
      const backend = await startRawBackend((socket) => {
        if (!requestComplete) receivedBeforeHeaderEnd = true;
        socket.on('data', (chunk) => {
          received += chunk.toString();
          if (received.includes('\r\n\r\n')) socket.end(WS_RESPONSE);
        });
      });
      stopBackend = backend.close;
      handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
      const request = wsRequest(`${route}?lang=en`);
      const response = await rawExchange(handle.port, (socket) => {
        socket.write(request.slice(0, -1));
        setTimeout(() => {
          requestComplete = true;
          socket.write(request.slice(-1));
        }, 40);
      });
      expect(receivedBeforeHeaderEnd).toBe(false);
      expect(received).toBe(request);
      expect(response.toString()).toContain('101 Switching Protocols');
    });

    it('does not replay pre-101 bytes after a segmented successful handshake', async () => {
      const clientFrame = Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x6e, 0x69]); // Masked "ok".
      const serverFrame = Buffer.from([0x81, 2, 0x6f, 0x6b]);
      let received = Buffer.alloc(0);
      let sendEarlyBytes: (() => void) | undefined;
      let awaitingHeader = true;
      const backend = await startRawBackend((socket) => {
        socket.on('data', (chunk) => {
          received = Buffer.concat([received, chunk]);
          if (awaitingHeader && received.includes('\r\n\r\n')) {
            awaitingHeader = false;
            sendEarlyBytes?.();
            setTimeout(() => {
              socket.write(WS_RESPONSE.slice(0, -1));
              setTimeout(() => socket.write(WS_RESPONSE.slice(-1)), 20);
            }, 40);
          } else if (received.subarray(-clientFrame.length).equals(clientFrame)) {
            socket.end(serverFrame);
          }
        });
      });
      stopBackend = backend.close;
      handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
      const response = await rawExchange(handle.port, (socket) => {
        let handshake = '';
        let sentFrame = false;
        socket.on('data', (chunk) => {
          handshake += chunk.toString();
          if (!sentFrame && handshake.includes('\r\n\r\n')) {
            sentFrame = true;
            socket.write(clientFrame);
          }
        });
        sendEarlyBytes = () => socket.write(CONTENT_REQUEST);
        socket.write(wsRequest(route) + CONTENT_REQUEST);
      });
      expect(received).toEqual(Buffer.concat([Buffer.from(wsRequest(route)), clientFrame]));
      expect(response.subarray(-serverFrame.length)).toEqual(serverFrame);
    });

    it.each([
      'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n',
      'HTTP/1.1 204 No Content\r\n\r\n',
      'HTTP/1.1 403 Forbidden\r\nTransfer-Encoding: chunked\r\n\r\n6;test=yes\r\ndenied\r\n0\r\nX-End: yes\r\n\r\n',
    ])('closes exactly after one failed HTTP response: %s', async (reply) => {
      let received = '';
      const backend = await startRawBackend((socket) => {
        socket.on('data', (chunk) => {
          received += chunk.toString();
          if (!received.includes('\r\n\r\n')) return;
          let offset = 0;
          const writeNext = (): void => {
            if (socket.destroyed || offset === reply.length) return;
            socket.write(reply.slice(offset, ++offset));
            setTimeout(writeNext, 1);
          };
          writeNext();
        });
      });
      stopBackend = backend.close;
      handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
      const response = await rawExchange(handle.port, (socket) => socket.write(wsRequest(route) + CONTENT_REQUEST));
      expect(response.toString()).toBe(reply);
      expect(received).toBe(wsRequest(route));
    });

    it.each([
      WS_RESPONSE.replace('101 Switching Protocols', '101'),
      WS_RESPONSE.replace('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'invalid'),
      WS_RESPONSE.replace('Upgrade: websocket', 'Upgrade: h2c'),
      WS_RESPONSE.replace('Connection: Upgrade', 'Connection: keep-alive'),
      `HTTP/1.1 401 Unauthorized\r\nX-Padding: ${'a'.repeat(16 * 1024)}\r\n\r\n`,
    ])('does not turn an invalid backend handshake into a tunnel: %#', async (reply) => {
      let received = '';
      const backend = await startRawBackend((socket) => {
        socket.on('data', (chunk) => {
          received += chunk.toString();
          socket.write(reply);
        });
      });
      stopBackend = backend.close;
      handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
      await rawExchange(handle.port, (socket) => socket.write(wsRequest(route) + CONTENT_REQUEST));
      expect(received).toBe(wsRequest(route));
    });

    it.each(['Content-Length: 1\r\n', 'Transfer-Encoding: chunked\r\n'])(
      'rejects handshake body framing: %s',
      async (headers) => {
        let contactedCore = false;
        const backend = await startRawBackend((socket) => {
          contactedCore = true;
          socket.on('data', () => socket.end(WS_RESPONSE));
        });
        stopBackend = backend.close;
        handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
        const response = await rawExchange(handle.port, (socket) =>
          socket.write(wsRequest(route, headers) + CONTENT_REQUEST)
        );
        expect(contactedCore).toBe(false);
        expect(response.toString()).toMatch(/^HTTP\/1\.1 400/);
      }
    );

    it('keeps native WebSocket frames bidirectional after a real 101', async () => {
      const server = http.createServer();
      const wss = new WebSocketServer({ server });
      wss.on('connection', (socket) => {
        socket.send('server-ready');
        socket.on('message', (message) => socket.send(`echo:${message.toString()}`));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      stopBackend = async () => {
        for (const client of wss.clients) client.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      };
      handle = await startStaticServer({ staticDir, backendPort: (server.address() as AddressInfo).port, port: 0 });
      const messages = await new Promise<string[]>((resolve, reject) => {
        const client = new WebSocket(`ws://127.0.0.1:${handle?.port}${route}`);
        const received: string[] = [];
        const timer = setTimeout(() => client.terminate(), 2000);
        client.on('error', reject);
        client.on('open', () => client.send('client-ready'));
        client.on('message', (message) => {
          received.push(message.toString());
          if (received.length === 2) client.close();
        });
        client.on('close', () => {
          clearTimeout(timer);
          resolve(received);
        });
      });
      expect(messages).toEqual(['server-ready', 'echo:client-ready']);
    });
  });

  it.each([
    ['an invalid version', wsRequest('/ws').replace('Version: 13', 'Version: 12'), 400],
    ['a duplicate header', wsRequest('/ws', 'Host: duplicate\r\n'), 400],
    ['an oversized header', wsRequest('/ws', `X-Padding: ${'a'.repeat(16 * 1024)}\r\n`), 431],
  ])('keeps the host alive when a client resets after rejecting %s', async (_label, request, status) => {
    // Use a separate host process: a global uncaughtException handler would
    // hide an unhandled Socket error and let this regression pass falsely.
    const sourceUrl = new URL('./static-server.ts', import.meta.url).href;
    const script = `
      import assert from 'node:assert/strict';
      import net from 'node:net';
      import { startStaticServer } from ${JSON.stringify(sourceUrl)};
      const handle = await startStaticServer({ staticDir: '.', backendPort: 9, port: 0 });
      try {
        await new Promise((resolve, reject) => {
          const client = net.connect({ host: '127.0.0.1', port: handle.port }, () => client.write(${JSON.stringify(request)}));
          client.once('data', chunk => {
            assert.match(chunk.toString(), /^HTTP\\/1\\.1 ${status} /);
            client.resetAndDestroy();
          });
          client.on('error', reject);
          client.once('close', resolve);
        });
        await new Promise(resolve => setTimeout(resolve, 100));
      } finally {
        await handle.stop();
      }
      console.log('HOST_SURVIVED_REJECTED_HANDSHAKE_RESET');
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      [...(process.versions.bun ? [] : ['--import', 'tsx']), '--input-type=module', '--eval', script],
      { timeout: 5000 }
    );
    expect(stdout).toContain('HOST_SURVIVED_REJECTED_HANDSHAKE_RESET');
  });

  it('rejects a WebSocket header beyond the bounded peek size', async () => {
    let contactedCore = false;
    const backend = await startRawBackend((socket) => {
      contactedCore = true;
      socket.on('data', () => socket.end(WS_RESPONSE));
    });
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
    const response = await rawExchange(handle.port, (socket) => {
      socket.write(wsRequest('/ws', `X-Padding: ${'a'.repeat(16 * 1024)}\r\n`));
    });
    expect(contactedCore).toBe(false);
    expect(response.toString()).toMatch(/^HTTP\/1\.1 431/);
  });

  it('accepts a complete WebSocket header exactly at the bounded peek size', async () => {
    let received = '';
    const backend = await startRawBackend((socket) => {
      socket.on('data', (chunk) => {
        received += chunk.toString();
        if (received.includes('\r\n\r\n')) socket.end(WS_RESPONSE);
      });
    });
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });
    const paddingLength = 16 * 1024 - Buffer.byteLength(wsRequest('/ws', 'Content-Length: 0\r\nX-Padding: \r\n'));
    const request = wsRequest('/ws', `Content-Length: 0\r\nX-Padding: ${'a'.repeat(paddingLength)}\r\n`);
    const response = await rawExchange(handle.port, (socket) => socket.write(request));
    expect(Buffer.byteLength(request)).toBe(16 * 1024);
    expect(received).toBe(request);
    expect(response.toString()).toBe(WS_RESPONSE);
  });

  it('/login reverse-proxies to backend (no local handler)', async () => {
    const backend = await startMockBackend((req, res) => {
      if (req.url === '/login' && req.method === 'POST') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'aionui-session=backend-token; Path=/; HttpOnly',
        });
        res.end(JSON.stringify({ success: true, proxied: true }));
        return;
      }
      res.writeHead(404).end();
    });
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });

    const r = await fetch(`${handle.localUrl}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'anything' }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/aionui-session=backend-token/);
    const json = (await r.json()) as { proxied: boolean };
    expect(json.proxied).toBe(true);
  });

  it('/api/auth/user reverse-proxies to backend (no local handler)', async () => {
    const backend = await startMockBackend((req, res) => {
      if (req.url === '/api/auth/user' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, user: { username: 'from-backend', id: 'from-backend' } }));
        return;
      }
      res.writeHead(404).end();
    });
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });

    const r = await fetch(`${handle.localUrl}/api/auth/user`);
    expect(r.status).toBe(200);
    const json = (await r.json()) as { user: { username: string } };
    expect(json.user.username).toBe('from-backend');
  });

  it('/logout reverse-proxies to backend (no local handler)', async () => {
    const backend = await startMockBackend((req, res) => {
      if (req.url === '/logout' && req.method === 'POST') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'aionui-session=; Path=/; Max-Age=0',
        });
        res.end(JSON.stringify({ success: true, proxied: true }));
        return;
      }
      res.writeHead(404).end();
    });
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });

    const r = await fetch(`${handle.localUrl}/logout`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });

  it('/api proxy returns 502 when backend unreachable', async () => {
    // allocate a port then free it
    const placeholder = await startMockBackend((_req, res) => res.end());
    const freePort = placeholder.port;
    await placeholder.close();

    handle = await startStaticServer({ staticDir, backendPort: freePort, port: 0 });
    const r = await fetch(`${handle.localUrl}/api/anything`);
    expect(r.status).toBe(502);
  });

  it('/ws WebSocket upgrade is spliced to backend and 101 is relayed', async () => {
    // Mock backend that accepts any WebSocket upgrade and replies with 101.
    // We don't run a real ws protocol — just verify the upgrade response makes
    // it back through the TCP-splice proxy. This is the exact regression path
    // that bun 1.3's http-compat upgrade handler broke.
    const httpMod = await import('node:http');
    const backendServer = httpMod.createServer();
    backendServer.on('upgrade', (req, socket) => {
      const wsKey = (req.headers['sec-websocket-key'] as string) || '';
      const accept = createHash('sha1')
        .update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      socket.write('Upgrade: websocket\r\n');
      socket.write('Connection: Upgrade\r\n');
      socket.write(`Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
      // Send a single 0-length WS text frame as a liveness marker then close.
      socket.write(Buffer.from([0x81, 0x00]));
      socket.end();
    });
    await new Promise<void>((r) => backendServer.listen(0, '127.0.0.1', () => r()));
    stopBackend = () => new Promise<void>((r) => backendServer.close(() => r()));
    const backendPort = (backendServer.address() as { port: number }).port;

    handle = await startStaticServer({ staticDir, backendPort, port: 0 });

    // Speak raw HTTP/1.1 upgrade over a TCP socket against the public listener.
    const { port: publicPort } = handle;
    const status: string = await new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: publicPort }, () => {
        sock.write(
          'GET /ws HTTP/1.1\r\n' +
            `Host: 127.0.0.1:${publicPort}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Version: 13\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            '\r\n'
        );
      });
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const headEnd = buf.indexOf('\r\n\r\n');
        if (headEnd >= 0) {
          const firstLine = buf.slice(0, buf.indexOf(0x0a)).toString('ascii');
          sock.destroy();
          resolve(firstLine.trim());
        }
      });
      sock.on('error', reject);
      setTimeout(() => {
        sock.destroy();
        reject(new Error('timeout waiting for 101'));
      }, 3000).unref();
    });
    expect(status).toMatch(/HTTP\/1\.1 101/i);
  });

  it('/api/stt/stream WebSocket upgrade is spliced to backend and 101 is relayed', async () => {
    // Same as /ws test but for STT streaming endpoint.
    const httpMod = await import('node:http');
    const backendServer = httpMod.createServer();
    backendServer.on('upgrade', (req, socket) => {
      const wsKey = (req.headers['sec-websocket-key'] as string) || '';
      const accept = createHash('sha1')
        .update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      socket.write('Upgrade: websocket\r\n');
      socket.write('Connection: Upgrade\r\n');
      socket.write(`Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.write(Buffer.from([0x81, 0x00]));
      socket.end();
    });
    await new Promise<void>((r) => backendServer.listen(0, '127.0.0.1', () => r()));
    stopBackend = () => new Promise<void>((r) => backendServer.close(() => r()));
    const backendPort = (backendServer.address() as { port: number }).port;

    handle = await startStaticServer({ staticDir, backendPort, port: 0 });

    const { port: publicPort } = handle;
    const status: string = await new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: publicPort }, () => {
        sock.write(
          'GET /api/stt/stream HTTP/1.1\r\n' +
            `Host: 127.0.0.1:${publicPort}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Version: 13\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            '\r\n'
        );
      });
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const headEnd = buf.indexOf('\r\n\r\n');
        if (headEnd >= 0) {
          const firstLine = buf.slice(0, buf.indexOf(0x0a)).toString('ascii');
          sock.destroy();
          resolve(firstLine.trim());
        }
      });
      sock.on('error', reject);
      setTimeout(() => {
        sock.destroy();
        reject(new Error('timeout waiting for 101'));
      }, 3000).unref();
    });
    expect(status).toMatch(/HTTP\/1\.1 101/i);
  });

  it('/api/stt/stream with query params is spliced to backend', async () => {
    const httpMod = await import('node:http');
    const backendServer = httpMod.createServer();
    backendServer.on('upgrade', (req, socket) => {
      const wsKey = (req.headers['sec-websocket-key'] as string) || '';
      const accept = createHash('sha1')
        .update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      socket.write('Upgrade: websocket\r\n');
      socket.write('Connection: Upgrade\r\n');
      socket.write(`Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.write(Buffer.from([0x81, 0x00]));
      socket.end();
    });
    await new Promise<void>((r) => backendServer.listen(0, '127.0.0.1', () => r()));
    stopBackend = () => new Promise<void>((r) => backendServer.close(() => r()));
    const backendPort = (backendServer.address() as { port: number }).port;

    handle = await startStaticServer({ staticDir, backendPort, port: 0 });

    const { port: publicPort } = handle;
    const status: string = await new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: publicPort }, () => {
        sock.write(
          'GET /api/stt/stream?lang=en&model=default HTTP/1.1\r\n' +
            `Host: 127.0.0.1:${publicPort}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            'Sec-WebSocket-Version: 13\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
            '\r\n'
        );
      });
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const headEnd = buf.indexOf('\r\n\r\n');
        if (headEnd >= 0) {
          const firstLine = buf.slice(0, buf.indexOf(0x0a)).toString('ascii');
          sock.destroy();
          resolve(firstLine.trim());
        }
      });
      sock.on('error', reject);
      setTimeout(() => {
        sock.destroy();
        reject(new Error('timeout waiting for 101'));
      }, 3000).unref();
    });
    expect(status).toMatch(/HTTP\/1\.1 101/i);
  });

  it('POST body with a large payload is fully forwarded to backend (no byte drop during splice)', async () => {
    // Regression for #4058: WebUI uploads hang forever at 100%. When the routing
    // decision fired on the first chunk, the pre-router removed its 'data'
    // listener but left the socket in flowing mode; body bytes arriving before
    // the async `client.pipe(upstream)` was wired had no consumer and were
    // silently dropped. The backend then waited forever for the missing bytes,
    // so the browser upload sat at 100% and never returned. A body large enough
    // to span multiple TCP segments reproduces the race deterministically.
    const BODY_LEN = 512 * 1024; // 512 KB — spans several TCP segments

    const backend = await startMockBackend((req, res) => {
      let received = 0;
      req.on('data', (chunk: Buffer) => {
        received += chunk.length;
      });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ received }));
      });
    });
    stopBackend = backend.close;
    handle = await startStaticServer({ staticDir, backendPort: backend.port, port: 0 });

    const { port: publicPort } = handle;
    const body = Buffer.alloc(BODY_LEN, 0x61); // 512 KB of 'a'

    const received: number = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: publicPort,
          method: 'POST',
          path: '/api/fs/upload',
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': BODY_LEN,
          },
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            raw += c;
          });
          res.on('end', () => {
            try {
              resolve((JSON.parse(raw) as { received: number }).received);
            } catch (e) {
              reject(e as Error);
            }
          });
        }
      );
      request.on('error', reject);
      request.setTimeout(5000, () => {
        request.destroy(new Error('timeout: backend never received the full body (bytes dropped in splice)'));
      });
      request.end(body);
    });

    expect(received).toBe(BODY_LEN);
  });

  it('network URL populated only when allowRemote=true', async () => {
    const backend = await startMockBackend((_req, res) => res.end('nope'));
    stopBackend = backend.close;
    const h1 = await startStaticServer({
      staticDir,
      backendPort: backend.port,
      port: 0,
      allowRemote: false,
    });
    expect(h1.networkUrl).toBeUndefined();
    await h1.stop();

    const h2 = await startStaticServer({
      staticDir,
      backendPort: backend.port,
      port: 0,
      allowRemote: true,
    });
    // may still be undefined on CI machines without a LAN interface
    expect(typeof h2.networkUrl === 'string' || h2.networkUrl === undefined).toBe(true);
    await h2.stop();
  });
});
