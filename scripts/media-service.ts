import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { H3SetupTask } from '../packages/desktop/src/process/services/runtime/H3SetupTask';
import { inspectH3DownloadSpace } from '../packages/desktop/src/process/services/runtime/h3DownloadPlan';
import { probeSetupHardware } from '../packages/desktop/src/process/services/runtime/h3SetupHardware';
import { inspectSetupCapabilities } from '../packages/desktop/src/process/services/runtime/h3SetupCapabilities';
import type { H3DownloadProgress } from '../packages/desktop/src/common/chat/document/h3Setup';
import { BetterSqlite3Driver } from '../packages/desktop/src/process/services/database/drivers/BetterSqlite3Driver';
import {
  initSchema,
  CURRENT_DB_VERSION,
  getDatabaseVersion,
  setDatabaseVersion,
} from '../packages/desktop/src/process/services/database/schema';
import { runMigrations } from '../packages/desktop/src/process/services/database/migrations';
import { MediaJobStore } from '../packages/desktop/src/process/services/media/MediaJobStore';
import { MediaJobRunner } from '../packages/desktop/src/process/services/media/MediaJobRunner';
import { JsonMediaJobStore } from '../packages/desktop/src/process/services/media/JsonMediaJobStore';
import { mediaJobSpecSchema } from '../packages/desktop/src/common/chat/document/mediaJob';
import { h3GenerationSpecSchema, type H3Job, type H3Version } from '../packages/desktop/src/common/chat/document/h3Job';
import { FileH3JobStore } from '../packages/desktop/src/process/services/runtime/H3JobStore';
import { H3JobRunner } from '../packages/desktop/src/process/services/runtime/H3JobRunner';
import { H3ComfyClient } from '../packages/desktop/src/process/services/runtime/H3ComfyClient';
import { H3RuntimeManager } from '../packages/desktop/src/process/services/runtime/H3RuntimeManager';
import { H3VersionStore } from '../packages/desktop/src/process/services/runtime/H3VersionStore';
import { H3ReferencePreflight } from '../packages/desktop/src/process/services/runtime/H3ReferencePreflight';
import {
  persistH3BundleRoot,
  resolveH3BundleRoot,
} from '../packages/desktop/src/process/services/runtime/h3BundlePath';

const port = Number(process.env.AIONUI_MEDIA_PORT ?? 33002);
const dataDir = process.env.AIONUI_DATA_DIR ?? path.resolve('.runtime/dev-data');
fs.mkdirSync(dataDir, { recursive: true });
let db: BetterSqlite3Driver | undefined;
let store: MediaJobStore | JsonMediaJobStore;
try {
  db = new BetterSqlite3Driver(path.join(dataDir, 'aionui.db'));
  initSchema(db);
  const version = getDatabaseVersion(db);
  if (version < CURRENT_DB_VERSION) {
    runMigrations(db, version, CURRENT_DB_VERSION);
    setDatabaseVersion(db, CURRENT_DB_VERSION);
  }
  store = new MediaJobStore(db);
  console.log('[media-service] persistence=sqlite');
} catch (error) {
  console.warn(
    `[media-service] SQLite unavailable, using JSON fallback: ${error instanceof Error ? error.message : String(error)}`
  );
  db?.close();
  store = new JsonMediaJobStore(path.join(dataDir, 'media-jobs.json'));
}
const runner = new MediaJobRunner(store);
runner.recover();
const h3Store = new FileH3JobStore(path.join(dataDir, 'h3-jobs.json'));
const versionStore = new H3VersionStore(path.join(dataDir, 'h3-versions.json'));
const configuredH3WaitMs = Number(process.env.AIONUI_H3_MAX_WAIT_MS);
const h3Client = new H3ComfyClient({
  bundleRoot: () => h3Runtime.installStatus().bundleRoot,
  attentionBackend: () => h3Runtime.accelerationStatus().backend,
  maxWaitMs: Number.isFinite(configuredH3WaitMs) && configuredH3WaitMs > 0 ? configuredH3WaitMs : undefined,
});
const h3Runtime = new H3RuntimeManager(h3Client, {
  bundleRoot: resolveH3BundleRoot(dataDir),
  external: h3Client.getBaseUrl() !== 'http://127.0.0.1:8188',
  acceleration: {
    mode: process.env.AIONUI_H3_ACCEL_MODE as 'auto' | 'dense' | 'sla' | undefined,
    root: process.env.AIONUI_H3_ACCEL_ROOT,
    pythonDevRoot: process.env.AIONUI_PYTHON_DEV_ROOT,
  },
});
const h3Runner = new H3JobRunner(
  h3Store,
  {
    generate: async (spec, signal, onProgress, onSubmitted, context) => {
      if (h3Setup.busy()) throw new Error('H3_SETUP_BUSY');
      await h3Runtime.ensureStarted();
      return h3Client.generate(spec, signal, onProgress, onSubmitted, context);
    },
    resume: (promptId, signal, onProgress, events, context) =>
      h3Client.resume(promptId, signal, onProgress, events, context),
    cancel: (promptId, requireKnown) => h3Client.cancel(promptId, requireKnown),
    confirmStopped: (promptId, requireKnown) => h3Client.confirmStopped(promptId, requireKnown),
    confirmIdle: () => h3Client.confirmIdle(),
  },
  new H3ReferencePreflight()
);
const h3Setup = new H3SetupTask(
  path.join(dataDir, 'h3-setup.json'),
  (bundleRoot, progress, download, signal) =>
    new Promise<void>((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'h3-install-worker.js'), { workerData: { bundleRoot, download } });
      let done = false;
      let settled = false;
      let failure: string | undefined;
      const pause = () => worker.postMessage({ pause: true });
      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', pause);
        callback();
      };
      signal.addEventListener('abort', pause, { once: true });
      if (signal.aborted) pause();
      worker.on(
        'message',
        (event: {
          phase?: 'downloading' | 'verifying' | 'extracting' | 'installing-acceleration';
          detail?: H3DownloadProgress;
          done?: boolean;
          error?: string;
        }) => {
          if (settled) return;
          try {
            if (event.phase) progress(event.phase, event.detail);
          } catch (error) {
            failure = 'H3_SETUP_STATE_WRITE_FAILED';
            void worker.terminate().then(
              () => settle(() => reject(error)),
              () => settle(() => reject(error))
            );
            return;
          }
          if (event.done) done = true;
          if (event.error) failure = event.error;
        }
      );
      worker.once('error', (error) => settle(() => reject(error)));
      worker.once('exit', (code) => {
        settle(() => {
          code === 0 && done ? resolve() : reject(new Error(failure ?? `H3_INSTALL_WORKER_EXITED:${code}`));
        });
      });
    })
);
const active = new Map<string, Promise<unknown>>();
const subscribers = new Map<string, Set<http.ServerResponse>>();
const h3Active = new Map<string, Promise<unknown>>();
const h3Subscribers = new Map<string, Set<http.ServerResponse>>();
const lastH3Event = new Map<string, string>();
let runtimeStarting = false;
let h3Dispatching = false;
function pumpH3Jobs(): void {
  if (h3Dispatching || h3Runner.blocked()) return;
  const queued = h3Store.listActive().filter((job) => job.status === 'queued');
  const next = queued.find((job) => job.promptId) ?? queued[0];
  if (!next) return;
  h3Dispatching = true;
  const task = h3Runner
    .run(next.id, publishH3)
    .catch(() => undefined)
    .finally(() => {
      h3Active.delete(next.id);
      h3Dispatching = false;
      pumpH3Jobs();
    });
  h3Active.set(next.id, task);
}
function startH3Job(job: H3Job): void {
  if (job.status !== 'queued' || h3Active.has(job.id)) return;
  pumpH3Jobs();
}
for (const job of h3Runner.recover()) startH3Job(job);
let reconciling = false;
const reconcileTimer = setInterval(() => {
  if (reconciling || !h3Runner.blocked()) return;
  reconciling = true;
  void h3Runner
    .reconcile(publishH3)
    .then(pumpH3Jobs)
    .catch(() => undefined)
    .finally(() => {
      reconciling = false;
    });
}, 30_000);
reconcileTimer.unref();

function safePath(value: string, root: string): boolean {
  const resolved = path.resolve(value);
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}
function publish(job: { id: string; status: string; progress: number }): void {
  for (const response of subscribers.get(job.id) ?? [])
    response.write(`event: progress\ndata: ${JSON.stringify(job)}\n\n`);
  if (['succeeded', 'failed', 'cancelled'].includes(job.status)) subscribers.delete(job.id);
}
function publishH3(job: H3Job): void {
  if (
    job.status === 'succeeded' &&
    job.artifacts[0]?.resourcePath &&
    !versionStore.list().some((version) => version.jobId === job.id)
  ) {
    const previous = job.parentVersionId
      ? versionStore.list().find((item) => item.id === job.parentVersionId)
      : versionStore.list().at(-1);
    const version: H3Version = {
      id: crypto.randomUUID(),
      parentId: previous?.id ?? null,
      label: `H3 ${versionStore.list().length + 1}`,
      jobId: job.id,
      createdAt: new Date().toISOString(),
      selected: true,
      artifactPath: job.artifacts[0].resourcePath,
    };
    versionStore.create(version);
    versionStore.select(version.id);
  }
  const serialized = JSON.stringify(job);
  if (lastH3Event.get(job.id) !== serialized) {
    lastH3Event.set(job.id, serialized);
    for (const response of h3Subscribers.get(job.id) ?? []) response.write(`event: progress\ndata: ${serialized}\n\n`);
  }
  if (['succeeded', 'failed', 'cancelled'].includes(job.status) && !job.remoteUncertain) {
    for (const response of h3Subscribers.get(job.id) ?? []) response.end();
    h3Subscribers.delete(job.id);
    lastH3Event.delete(job.id);
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': 'http://127.0.0.1:33001',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(body));
}
async function body(req: http.IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return JSON.parse(text || '{}');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (req.method === 'OPTIONS') return json(res, 204, null);
    if (req.method === 'POST' && url.pathname.startsWith('/api/h3/') && runtimeStarting)
      return json(res, 409, { error: 'H3_RUNTIME_STARTING' });
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok' });
    if (req.method === 'GET' && url.pathname === '/api/h3/setup') return json(res, 200, h3Setup.status());
    if (req.method === 'GET' && url.pathname === '/api/h3/setup/hardware')
      return json(res, 200, await probeSetupHardware());
    if (req.method === 'POST' && url.pathname === '/api/h3/setup/start') {
      if (h3Setup.busy() || h3Store.listActive().length) return json(res, 409, { error: 'H3_RUNTIME_BUSY' });
      if (h3Client.getBaseUrl() === 'http://127.0.0.1:8188' && h3Runtime.installReadiness() !== 'ready')
        return json(res, 400, { error: 'H3_INSTALL_REQUIRED' });
      runtimeStarting = true;
      try {
        if (h3Client.getBaseUrl() === 'http://127.0.0.1:8188') {
          const hw = await probeSetupHardware();
          if (hw.status === 'blocked') return json(res, 400, { error: 'H3_HARDWARE_UNSUPPORTED' });
        }
        await h3Runtime.ensureStarted();
        return json(res, 200, { connected: true, generationVerified: false });
      } finally {
        runtimeStarting = false;
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/h3/setup/capabilities') {
      await h3Client.systemStats();
      const response = await fetch(`${h3Client.getBaseUrl()}/object_info`, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`H3_CAPABILITY_HTTP_${response.status}`);
      const registry: unknown = await response.json();
      if (!registry || typeof registry !== 'object' || Array.isArray(registry))
        throw new Error('H3_CAPABILITY_RESPONSE_INVALID');
      return json(res, 200, inspectSetupCapabilities(registry as Record<string, unknown>));
    }
    if (req.method === 'POST' && url.pathname === '/api/h3/setup/pause') return json(res, 200, await h3Setup.pause());
    if (req.method === 'GET' && url.pathname === '/api/h3/setup/plan')
      return json(res, 200, inspectH3DownloadSpace(h3Runtime.installStatus().bundleRoot));
    if (req.method === 'POST' && url.pathname === '/api/h3/setup/install') {
      if (process.platform !== 'win32') return json(res, 400, { error: 'H3_SETUP_WINDOWS_ONLY' });
      if (h3Client.getBaseUrl() !== 'http://127.0.0.1:8188') return json(res, 409, { error: 'H3_EXTERNAL_RUNTIME' });
      if (h3Store.listActive().length || h3Runner.blocked()) return json(res, 409, { error: 'H3_JOBS_ACTIVE' });
      const payload = (await body(req)) as {
        download?: boolean;
        acceptModelTerms?: boolean;
        acceptExperimentalHardware?: boolean;
      };
      if (payload.download && payload.acceptModelTerms !== true)
        return json(res, 400, { error: 'H3_MODEL_TERMS_REQUIRED' });
      if (payload.download === true) {
        const hardware = await probeSetupHardware();
        if (hardware.status === 'blocked') return json(res, 400, { error: 'H3_HARDWARE_UNSUPPORTED', hardware });
        if (hardware.status === 'unverified' && payload.acceptExperimentalHardware !== true)
          return json(res, 400, { error: 'H3_HARDWARE_CONFIRMATION_REQUIRED', hardware });
        // Recheck after the asynchronous probe, before handing off to the worker.
        if (h3Store.listActive().length || h3Runner.blocked()) return json(res, 409, { error: 'H3_JOBS_ACTIVE' });
      }
      return json(res, 202, h3Setup.start(h3Runtime.installStatus().bundleRoot, payload.download === true));
    }
    if (req.method === 'GET' && url.pathname === '/api/h3/status') {
      const install = h3Runtime.installStatus();
      // Status is a fast, read-only probe. Full bundle hashing and portable
      // ComfyUI startup are deferred until the first generation request.
      try {
        return json(res, 200, {
          ready: true,
          install,
          blockedJobs: h3Store.listBlocked().map(({ id, error }) => ({ id, error })),
          readiness: h3Runtime.installReadiness(),
          acceleration: h3Runtime.accelerationStatus(),
          system: await h3Client.systemStats(),
        });
      } catch (error) {
        return json(res, 503, {
          ready: false,
          install,
          blockedJobs: h3Store.listBlocked().map(({ id, error }) => ({ id, error })),
          readiness: h3Runtime.installReadiness(),
          acceleration: h3Runtime.accelerationStatus(),
          error: 'H3_RUNTIME_NOT_RUNNING',
        });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/h3/setup/configure') {
      if (h3Setup.busy()) return json(res, 409, { error: 'H3_SETUP_BUSY' });
      if (process.env.AIONUI_H3_BUNDLE_ROOT) return json(res, 409, { error: 'H3_ENVIRONMENT_OVERRIDE_ACTIVE' });
      if (h3Store.listActive().length || h3Runner.blocked()) return json(res, 409, { error: 'H3_JOBS_ACTIVE' });
      const payload = (await body(req)) as { bundleRoot?: unknown };
      if (typeof payload.bundleRoot !== 'string' || !path.isAbsolute(payload.bundleRoot.trim()))
        return json(res, 400, { error: 'H3_BUNDLE_ROOT_MUST_BE_ABSOLUTE' });
      if (!fs.existsSync(payload.bundleRoot.trim()) || !fs.statSync(payload.bundleRoot.trim()).isDirectory())
        return json(res, 400, { error: 'H3_BUNDLE_DIRECTORY_NOT_FOUND' });
      const bundleRoot = persistH3BundleRoot(dataDir, payload.bundleRoot.trim());
      h3Runtime.stop();
      h3Runtime.setBundleRoot(bundleRoot);
      return json(res, 200, {
        ready: false,
        install: h3Runtime.installStatus(),
        readiness: h3Runtime.installReadiness(),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/h3/queue') return json(res, 200, await h3Client.queueStatus());
    if (req.method === 'POST' && url.pathname === '/api/h3/free-memory') {
      if (h3Store.listActive().length || h3Runner.blocked()) return json(res, 409, { error: 'H3_RUNTIME_BUSY' });
      await h3Client.confirmIdle();
      const payload = (await body(req)) as { unloadModels?: boolean };
      await h3Client.freeMemory(payload.unloadModels === true);
      return json(res, 200, { ok: true, unloadModels: payload.unloadModels === true });
    }
    if (req.method === 'POST' && url.pathname === '/api/h3/jobs') {
      if (h3Setup.busy()) return json(res, 409, { error: 'H3_SETUP_BUSY' });
      if (h3Runner.blocked()) return json(res, 409, { error: 'H3_REMOTE_STATE_UNCONFIRMED' });
      const spec = h3GenerationSpecSchema.parse(await body(req));
      const job = await h3Runner.enqueue(spec);
      startH3Job(job);
      return json(res, 201, job);
    }
    if (req.method === 'GET' && url.pathname === '/api/h3/versions') return json(res, 200, versionStore.list());
    if (req.method === 'POST' && url.pathname === '/api/h3/versions/select') {
      const payload = (await body(req)) as { id?: string };
      return json(res, 200, versionStore.select(payload.id ?? ''));
    }
    const deriveVersion = /^\/api\/h3\/versions\/([^/]+)\/derive$/.exec(url.pathname);
    if (deriveVersion && req.method === 'POST') {
      if (h3Setup.busy()) return json(res, 409, { error: 'H3_SETUP_BUSY' });
      if (h3Runner.blocked()) return json(res, 409, { error: 'H3_REMOTE_STATE_UNCONFIRMED' });
      const version = versionStore.list().find((item) => item.id === deriveVersion[1]);
      const parentJob = version && h3Store.get(version.jobId);
      if (!version || !parentJob) return json(res, 404, { error: 'H3_VERSION_NOT_FOUND' });
      const patch = (await body(req)) as Partial<{
        prompt: string;
        durationSeconds: number;
        megapixels: number;
        seed: number;
      }>;
      const spec = h3GenerationSpecSchema.parse({ ...parentJob.spec, ...patch });
      const job = await h3Runner.enqueue(spec);
      h3Store.update(job.id, { parentVersionId: version.id });
      startH3Job(job);
      return json(res, 201, job);
    }
    const h3Events = /^\/api\/h3\/jobs\/([^/]+)\/events$/.exec(url.pathname);
    if (h3Events && req.method === 'GET') {
      const found = h3Store.get(h3Events[1]);
      if (!found) return json(res, 404, { error: 'H3_JOB_NOT_FOUND' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': 'http://127.0.0.1:33001',
      });
      const set = h3Subscribers.get(h3Events[1]) ?? new Set<http.ServerResponse>();
      set.add(res);
      h3Subscribers.set(h3Events[1], set);
      const current = h3Store.get(h3Events[1]);
      if (current) res.write(`event: progress\ndata: ${JSON.stringify(current)}\n\n`);
      if (current && !['queued', 'running'].includes(current.status) && !current.remoteUncertain) {
        set.delete(res);
        if (!set.size) h3Subscribers.delete(current.id);
        res.end();
      }
      req.on('close', () => {
        set.delete(res);
        if (!set.size) h3Subscribers.delete(h3Events[1]);
      });
      return;
    }
    const h3Match = /^\/api\/h3\/jobs\/([^/]+)$/.exec(url.pathname);
    if (h3Match && req.method === 'GET') {
      const job = h3Store.get(h3Match[1]);
      return json(res, job ? 200 : 404, job ?? { error: 'H3_JOB_NOT_FOUND' });
    }
    if (h3Match && req.method === 'POST' && url.searchParams.get('action') === 'cancel') {
      const job = await h3Runner.cancel(h3Match[1]);
      publishH3(job);
      pumpH3Jobs();
      return json(res, 200, job);
    }
    if (req.method === 'POST' && url.pathname === '/api/media-jobs') {
      const spec = mediaJobSpecSchema.parse(await body(req));
      if (
        !fs.existsSync(spec.sourcePath) ||
        (spec.outputPath && !safePath(spec.outputPath, path.dirname(spec.sourcePath)))
      )
        throw new Error('MEDIA_PATH_OUTSIDE_SOURCE_DIR');
      const job = runner.enqueue(spec);
      if (job.status === 'queued' && !active.has(job.id))
        active.set(
          job.id,
          runner.run(job.id, publish).finally(() => active.delete(job.id))
        );
      return json(res, 201, job);
    }
    const events = /^\/api\/media-jobs\/([^/]+)\/events$/.exec(url.pathname);
    if (events && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'access-control-allow-origin': 'http://127.0.0.1:33001',
      });
      const set = subscribers.get(events[1]) ?? new Set<http.ServerResponse>();
      set.add(res);
      subscribers.set(events[1], set);
      const current = store.get(events[1]);
      if (current) res.write(`event: progress\ndata: ${JSON.stringify(current)}\n\n`);
      req.on('close', () => {
        set.delete(res);
        if (!set.size) subscribers.delete(events[1]);
      });
      return;
    }
    const match = /^\/api\/media-jobs\/([^/]+)$/.exec(url.pathname);
    if (match && req.method === 'GET') return json(res, 200, store.get(match[1]) ?? { error: 'MEDIA_JOB_NOT_FOUND' });
    if (match && req.method === 'POST' && url.searchParams.get('action') === 'cancel')
      return json(res, 200, runner.cancel(match[1]));
    const artifactMatch = /^\/api\/h3\/jobs\/([^/]+)\/artifacts\/(\d+)$/.exec(url.pathname);
    if (artifactMatch && req.method === 'GET') {
      const job = h3Store.get(artifactMatch[1]);
      const index = Number(artifactMatch[2]);
      const artifact = job?.artifacts[index];
      if (!job || job.status !== 'succeeded' || !artifact) return json(res, 404, { error: 'H3_ARTIFACT_NOT_FOUND' });
      const upstream = await h3Client.fetchArtifact(artifact);
      res.writeHead(200, {
        'content-type': artifact.mimeType,
        'cache-control': 'private, max-age=3600',
        'access-control-allow-origin': 'http://127.0.0.1:33001',
      });
      if (!upstream.body) return res.end();
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          if (!res.write(Buffer.from(chunk.value))) await new Promise<void>((resolve) => res.once('drain', resolve));
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      res.end();
      return;
    }
    json(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    const diagnosis =
      error && typeof error === 'object' && 'diagnosis' in error
        ? (error as { diagnosis?: unknown }).diagnosis
        : undefined;
    json(res, 400, {
      error: error instanceof Error ? error.message : String(error),
      ...(diagnosis ? { diagnosis } : {}),
    });
  }
});
server.listen(port, '127.0.0.1', () => console.log(`[media-service] listening on http://127.0.0.1:${port}`));
process.on('SIGINT', () => {
  db?.close();
  server.close();
});
process.on('SIGTERM', () => {
  db?.close();
  server.close();
});
