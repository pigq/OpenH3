import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

// Only caller-provided bytes are served. No arbitrary filesystem/static server.
export async function createFixtureFeed({ manifestText, installerBytes, fileName, mode = 'normal' }) {
  if (!/^OpenH3-3\.0\.1-win-x64\.exe$/.test(fileName) || !['normal', 'slow', 'disconnect', 'corrupt'].includes(mode))
    throw Error('Unsupported fixture mode/name');
  const requests = [];
  const sockets = new Set();
  const original = Buffer.from(installerBytes);
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const trace = {
      at: new Date().toISOString(),
      method: request.method,
      pathname,
      range: request.headers.range,
      mode,
      payloadSize: original.length,
      bytesWritten: 0,
      finished: false,
      disconnected: false,
    };
    requests.push(trace);
    response.on('finish', () => {
      trace.finished = true;
    });
    if (request.method !== 'GET' || (pathname !== '/latest.yml' && pathname !== `/${fileName}`)) {
      response.writeHead(404).end();
      return;
    }
    if (pathname === '/latest.yml') {
      response
        .writeHead(200, { 'Content-Type': 'text/yaml', 'Content-Length': Buffer.byteLength(manifestText) })
        .end(manifestText);
      return;
    }
    // Deliberately full-package HTTP 200; no fake differential/Range success.
    const bytes = Buffer.from(original);
    if (mode === 'corrupt' && bytes.length) bytes[0] ^= 255;
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
    if (mode === 'disconnect') {
      const part = bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2)));
      trace.bytesWritten = part.length;
      response.write(part);
      setTimeout(() => {
        trace.disconnected = true;
        response.destroy();
      }, 25);
      return;
    }
    if (mode !== 'slow') {
      trace.bytesWritten = bytes.length;
      response.end(bytes);
      return;
    }
    for (let offset = 0; offset < bytes.length && !response.destroyed; offset += 64 * 1024) {
      const part = bytes.subarray(offset, offset + 64 * 1024);
      response.write(part);
      trace.bytesWritten += part.length;
      await sleep(100);
    }
    if (!response.destroyed) response.end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
