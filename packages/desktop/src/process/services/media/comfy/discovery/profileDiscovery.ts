import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  comfyFamilyKind,
  comfyFamilySchema,
  comfyProfileSchema,
  type ComfyProfile,
} from '@/common/chat/document/creation/comfy';
import { discoverComfyEnvironmentCandidates, type ComfyEnvironmentCandidate } from './environment';
import { inspectComfyServiceIdentity, type ComfyServiceIdentity } from '../workflowEngine';
import { loadComfyInstallCatalog } from '../planning/catalog';
import { configuredModelDirectories, indexComfyModelFiles } from './modelPaths';

type JsonRecord = Record<string, unknown>;
type CachedRoot = { signature: string; profiles: ComfyProfile[] };
type DiscoveryCatalog = { candidates: JsonRecord[]; baselines: JsonRecord[] };
export type ComfyProfileDiscoveryOptions = {
  cacheFile: string;
  workflowDirectory: string;
  resourcesRoot?: string;
  roots?: () => string[];
  legacyProfiles?: () => ComfyProfile[];
  endpoints?: () => string[];
  fetchImpl?: typeof fetch;
  inspectIdentity?: (baseUrl: string, stats: JsonRecord, python?: string) => Promise<ComfyServiceIdentity | undefined>;
  loadCatalog?: () => DiscoveryCatalog;
  now?: () => number;
  /** Network discovery is cached; file metadata remains cheap and incremental. */
  endpointRefreshMs?: number;
};

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record) : [];
}
function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function fileState(file: string): string {
  try {
    const stats = fs.statSync(file);
    return `${file}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.isFile()}`;
  } catch {
    return `${file}:missing`;
  }
}
function samePath(first: string, second: string): boolean {
  return process.platform === 'win32'
    ? path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase()
    : path.resolve(first) === path.resolve(second);
}
function modelRoot(profile: ComfyProfile): string {
  const args = profile.environment.launchArgs ?? [];
  const index = args.indexOf('--models-directory');
  return (
    (index >= 0 ? args[index + 1] : undefined) ??
    args.find((arg) => arg.startsWith('--models-directory='))?.slice('--models-directory='.length) ??
    path.join(profile.environment.root, 'models')
  );
}
function safeFilename(value: string): boolean {
  return Boolean(value) && path.basename(value) === value && !['.', '..'].includes(value) && !/[\\/]/.test(value);
}
function componentFile(root: string, item: JsonRecord): string | undefined {
  const directory = text(item.directory);
  const name = text(item.name);
  return safeFilename(directory) && safeFilename(name) ? path.join(root, directory, name) : undefined;
}

function findComponents(
  candidate: JsonRecord,
  models: string,
  indexedFiles: Map<string, string[]>
): ComfyProfile['components'] | undefined {
  const components = records(candidate.components).map((item) => {
    const direct = componentFile(models, item);
    const file = [direct, ...(indexedFiles.get(text(item.name)) ?? [])].find((candidate) => {
      if (!candidate) return false;
      try {
        return fs.statSync(candidate).size === item.sizeBytes;
      } catch {
        return false;
      }
    });
    if (!file) return undefined;
    try {
      const stats = fs.statSync(file);
      if (!stats.isFile() || stats.size !== item.sizeBytes) return undefined;
    } catch {
      return undefined;
    }
    const transports = records(item.transports)
      .map((transport) => text(transport.url))
      .filter(Boolean);
    return {
      role: text(item.role),
      name: text(item.name),
      path: file,
      version: text(item.revision),
      precision: text(item.precision),
      sizeBytes: Number(item.sizeBytes),
      sha256: text(item.sha256),
      ...(item.url ? { url: text(item.url) } : {}),
      ...(transports.length ? { sourceUrls: transports } : {}),
    };
  });
  if (!components.length || components.some((component) => !component)) return undefined;
  return components as ComfyProfile['components'];
}

function discoveredId(
  candidate: JsonRecord,
  baseline: JsonRecord,
  environment: ComfyProfile['environment'],
  components: ComfyProfile['components']
): string {
  const recipe = {
    environment,
    components,
    workflowSha256: baseline.graphSha256,
    nodes: baseline.requiredNodes,
    bindings: baseline.bindings,
    defaults: baseline.defaults,
    capabilities: baseline.capabilities,
  };
  return `found-${text(candidate.id).replace(/-discovery$/, '')}-${digest(JSON.stringify(recipe)).slice(0, 12)}`;
}

function makeProfile(
  candidate: JsonRecord,
  baseline: JsonRecord,
  environment: ComfyProfile['environment'],
  models: string,
  workflowDirectory: string,
  indexedFiles: Map<string, string[]>
): ComfyProfile | undefined {
  const family = comfyFamilySchema.safeParse(candidate.family);
  if (!family.success) return undefined;
  const components = findComponents(candidate, models, indexedFiles);
  if (!components) return undefined;
  const graph = record(baseline.graph);
  const serialization = `${JSON.stringify(graph, null, 2)}\n`;
  const graphHash = digest(serialization);
  if (!Object.keys(graph).length || graphHash !== baseline.graphSha256) return undefined;
  const id = discoveredId(candidate, baseline, environment, components);
  if (!/^[a-zA-Z0-9][\w.-]{0,99}$/.test(id)) return undefined;
  const workflowPath = path.join(workflowDirectory, `${id}.json`);
  fs.mkdirSync(workflowDirectory, { recursive: true });
  // Materialize the packaged baseline only in application-owned cache storage.
  // Never overwrite the user's workflow or a modified discovered baseline.
  if (!fs.existsSync(workflowPath)) fs.writeFileSync(workflowPath, serialization, { flag: 'wx' });
  if (!fs.lstatSync(workflowPath).isFile() || fs.statSync(workflowPath).size !== Buffer.byteLength(serialization))
    return undefined;
  if (digest(fs.readFileSync(workflowPath, 'utf8')) !== graphHash) return undefined;
  const parsed = comfyProfileSchema.safeParse({
    id,
    family: family.data,
    name: `${family.data} ${text(candidate.quantization) || 'mixed'}`,
    kind: comfyFamilyKind(family.data),
    version: text(record(candidate.workflow).revision) || text(records(candidate.components)[0]?.revision),
    quantization: text(candidate.quantization) || 'mixed',
    capabilities: baseline.capabilities,
    state: 'downloaded',
    environment,
    components,
    nodes: baseline.requiredNodes,
    workflowPath,
    workflowSha256: graphHash,
    bindings: baseline.bindings,
    defaults: baseline.defaults,
  });
  return parsed.success ? parsed.data : undefined;
}

/** Create a single-flight, persistent discovery callback for ComfyService.refreshProfiles. */
export function createComfyProfileDiscovery(options: ComfyProfileDiscoveryOptions) {
  const cached = new Map<string, CachedRoot>();
  const modelIndexes = new Map<string, { signature: string; value: ReturnType<typeof indexComfyModelFiles> }>();
  try {
    const saved = record(JSON.parse(fs.readFileSync(options.cacheFile, 'utf8')));
    for (const [root, raw] of Object.entries(record(saved.roots)).slice(0, 32)) {
      const entry = record(raw);
      const profiles = records(entry.profiles).flatMap((value) => {
        const parsed = comfyProfileSchema.safeParse(value);
        return parsed.success && parsed.data.state === 'downloaded' ? [parsed.data] : [];
      });
      if (typeof entry.signature === 'string') cached.set(root, { signature: entry.signature, profiles });
    }
  } catch {
    // A missing or stale discovery cache does not invalidate registered models.
  }
  let endpointCheckedAt = -Infinity;
  let running: ComfyEnvironmentCandidate[] = [];
  let pending: Promise<ComfyProfile[]> | undefined;
  const discover = async (registered: ComfyProfile[]): Promise<ComfyProfile[]> => {
    const now = (options.now ?? Date.now)();
    if (now - endpointCheckedAt >= (options.endpointRefreshMs ?? 30_000)) {
      endpointCheckedAt = now;
      running = (
        await Promise.all(
          [
            ...new Set([
              ...(options.endpoints?.() ?? []),
              ...registered.map((profile) => profile.environment.baseUrl),
              'http://127.0.0.1:8188',
            ]),
          ]
            .slice(0, 8)
            .map(async (baseUrl): Promise<ComfyEnvironmentCandidate | undefined> => {
              try {
                const url = new URL(baseUrl);
                if (
                  url.protocol !== 'http:' ||
                  !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
                  url.username ||
                  url.password
                )
                  return undefined;
                const response = await (options.fetchImpl ?? fetch)(`${url.origin}/system_stats`, {
                  signal: AbortSignal.timeout(1500),
                });
                if (!response.ok) return undefined;
                const stats = record(await response.json());
                if (!Object.keys(record(stats.system)).length) return undefined;
                const selected = registered.find((profile) => {
                  try {
                    return new URL(profile.environment.baseUrl).origin === url.origin;
                  } catch {
                    return false;
                  }
                });
                const identity = await (options.inspectIdentity ?? inspectComfyServiceIdentity)(
                  url.origin,
                  stats,
                  selected?.environment.python
                );
                if (
                  !identity ||
                  !path.isAbsolute(identity.root) ||
                  !path.isAbsolute(identity.executable) ||
                  !fs.existsSync(path.join(identity.root, 'main.py'))
                )
                  return undefined;
                return { root: identity.root, python: identity.executable, baseUrl: url.origin, reason: 'configured' };
              } catch {
                return undefined;
              }
            })
        )
      ).filter((candidate): candidate is ComfyEnvironmentCandidate => Boolean(candidate));
    }
    const catalog = (options.loadCatalog ?? (() => loadComfyInstallCatalog(options.resourcesRoot)))();
    const candidates = discoverComfyEnvironmentCandidates({
      roots: [...registered.map((profile) => profile.environment.root), ...(options.roots?.() ?? []), ...cached.keys()],
      maxCandidates: 32,
    });
    const result = [...(options.legacyProfiles?.() ?? [])];
    const visited = new Set<string>();
    for (const candidate of [...running, ...candidates]) {
      const key = process.platform === 'win32' ? candidate.root.toLowerCase() : candidate.root;
      if (visited.has(key)) continue;
      visited.add(key);
      const existing = registered.find((profile) => samePath(profile.environment.root, candidate.root));
      const python = candidate.python ?? existing?.environment.python;
      if (!python) continue;
      const environment = {
        ...existing?.environment,
        root: candidate.root,
        python,
        baseUrl:
          (candidate.reason === 'configured' ? candidate.baseUrl : undefined) ??
          existing?.environment.baseUrl ??
          candidate.baseUrl ??
          'http://127.0.0.1:8188',
      };
      const models = existing ? modelRoot(existing) : path.join(candidate.root, 'models');
      const config = path.join(candidate.root, 'extra_model_paths.yaml');
      const components = catalog.candidates.flatMap((item) => records(item.components));
      const categories = [...new Set(components.map((item) => text(item.directory)).filter(safeFilename))];
      const names = new Set(components.map((item) => text(item.name)).filter(safeFilename));
      const configuredDirectories = configuredModelDirectories(candidate.root, models, categories);
      const priorIndex = modelIndexes.get(candidate.root);
      const directorySignature = digest(
        JSON.stringify([
          models,
          config,
          [...configuredDirectories, ...(priorIndex?.value.directories ?? [])].map(fileState),
          fileState(config),
        ])
      );
      const index =
        priorIndex?.signature === directorySignature
          ? priorIndex.value
          : indexComfyModelFiles(configuredDirectories, names);
      modelIndexes.set(candidate.root, {
        value: index,
        signature: digest(
          JSON.stringify([
            models,
            config,
            [...configuredDirectories, ...index.directories].map(fileState),
            fileState(config),
          ])
        ),
      });
      const workflowFiles = catalog.candidates.flatMap((item) => {
        const baseline = catalog.baselines.find((workflow) => workflow.candidateId === item.id);
        const components = findComponents(item, models, index.files);
        return baseline && components
          ? [path.join(options.workflowDirectory, `${discoveredId(item, baseline, environment, components)}.json`)]
          : [];
      });
      const watched = [
        path.join(candidate.root, 'main.py'),
        python,
        path.join(candidate.root, 'custom_nodes'),
        config,
        ...index.directories,
        ...[...index.files.values()].flat(),
        ...workflowFiles,
      ];
      for (const item of catalog.candidates)
        for (const component of records(item.components)) {
          const file = componentFile(models, component);
          if (file) watched.push(file);
        }
      const currentSignature = () => digest(JSON.stringify([environment, models, catalog, watched.map(fileState)]));
      const signature = currentSignature();
      let entry = cached.get(candidate.root);
      if (entry?.signature !== signature) {
        const profiles = catalog.candidates.flatMap((item) => {
          const baseline = catalog.baselines.find((workflow) => workflow.candidateId === item.id);
          if (!baseline) return [];
          const profile = makeProfile(item, baseline, environment, models, options.workflowDirectory, index.files);
          return profile ? [profile] : [];
        });
        entry = { signature: currentSignature(), profiles };
        cached.set(candidate.root, entry);
      }
      for (const profile of entry.profiles) {
        if (
          !result.some((item) => item.id === profile.id) &&
          !registered.some(
            (item) =>
              item.family === profile.family &&
              item.components.length === profile.components.length &&
              item.components.every((component) =>
                profile.components.some((other) => samePath(component.path, other.path))
              )
          )
        )
          result.push(profile);
      }
    }
    try {
      fs.mkdirSync(path.dirname(options.cacheFile), { recursive: true });
      const serialized = JSON.stringify({ roots: Object.fromEntries([...cached].slice(-32)) });
      if (!fs.existsSync(options.cacheFile) || fs.readFileSync(options.cacheFile, 'utf8') !== serialized)
        fs.writeFileSync(options.cacheFile, serialized, { mode: 0o600 });
    } catch {
      // Persistence is a performance optimization; discovery results remain valid.
    }
    return result;
  };
  return (registered: ComfyProfile[]): Promise<ComfyProfile[]> => {
    pending ??= discover(registered).finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
