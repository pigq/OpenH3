import fs from 'node:fs';
import path from 'node:path';
import type { ComfyProfile } from '@/common/chat/document/creation/comfy';
import {
  validateComfyWorkflow,
  type ComfyGraph,
  type ComfyRegistry,
} from '@/process/services/runtime/h3WorkflowPreflight';
import {
  discoverComfyEnvironmentCandidates,
  type ComfyEnvironmentCandidate,
  type ComfyEnvironmentReport,
} from '../discovery/environment';
import { inspectComfyServiceIdentity } from '../workflowEngine';
import { record, records, stringValue, type CatalogRecord } from './catalog';
import { discoverApplicationComfyEnvironments } from '../discovery/applicationPaths';

export const sameEnvironmentPath = (a: string, b: string): boolean =>
  process.platform === 'win32'
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);

/** Include listeners even when no model profile has been registered yet. */
export async function installationEnvironments(
  roots: string[],
  profiles: readonly ComfyProfile[],
  fetcher: typeof fetch,
  endpoints: string[] = [],
  applicationRoots: string[] = []
): Promise<ComfyEnvironmentCandidate[]> {
  const result: ComfyEnvironmentCandidate[] = profiles.map(({ environment }) => ({
    ...environment,
    root: environment.root,
    reason: 'configured',
  }));
  const running: ComfyEnvironmentCandidate[] = [];
  for (const baseUrl of new Set([
    ...endpoints,
    ...profiles.map((p) => p.environment.baseUrl),
    'http://127.0.0.1:8188',
  ])) {
    try {
      const url = new URL(baseUrl);
      if (
        url.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        url.username ||
        url.password
      )
        continue;
      const response = await fetcher(`${url.origin}/system_stats`, {
        signal: AbortSignal.timeout(3000),
        redirect: 'error',
      });
      if (!response.ok) continue;
      const identity = await inspectComfyServiceIdentity(url.origin, record(await response.json()));
      if (
        identity &&
        path.isAbsolute(identity.root) &&
        path.isAbsolute(identity.executable) &&
        fs.existsSync(path.join(identity.root, 'main.py'))
      )
        running.push({ root: identity.root, python: identity.executable, baseUrl: url.origin, reason: 'configured' });
    } catch {
      /* A stopped listener must not hide filesystem installations. */
    }
  }
  result.unshift(...running);
  result.push(...(await discoverApplicationComfyEnvironments(applicationRoots)));
  result.push(...discoverComfyEnvironmentCandidates({ roots, maxCandidates: 32 }));
  return result.filter(
    (entry, index) =>
      result.findIndex((other) => sameEnvironmentPath(other.root, entry.root) && other.python === entry.python) ===
      index
  );
}

export type RuntimeCompatibility = {
  status: 'compatible' | 'incompatible' | 'unknown';
  reason: string;
  revision?: string;
};

/** Validate the actual loader schema. Only filenames of planned assets may be absent before installation. */
export function validateInstallationSchema(
  baseline: CatalogRecord,
  candidate: CatalogRecord,
  registry: ComfyRegistry
): void {
  const graph = structuredClone(record(baseline.graph)) as ComfyGraph;
  const adjusted = structuredClone(registry);
  const filenames = new Set(records(candidate.components).map((item) => stringValue(item.name)));
  const imageBindings = ['image', 'images', 'imagePaths', 'inputImage'].flatMap((key) =>
    records(record(baseline.bindings)[key])
  );
  for (const [id, node] of Object.entries(graph)) {
    const inputs = adjusted[node.class_type ?? '']?.input;
    for (const [key, value] of Object.entries(node.inputs ?? {})) {
      const definition = inputs?.required?.[key] ?? inputs?.optional?.[key];
      if (
        definition &&
        typeof value === 'string' &&
        (filenames.has(value) || imageBindings.some((b) => b.nodeId === id && b.input === key)) &&
        (Array.isArray(definition[0]) || definition[0] === 'COMBO')
      )
        definition[0] = 'STRING';
    }
  }
  validateComfyWorkflow(graph, adjusted);
}

export async function runtimeCompatibility(
  environment: ComfyEnvironmentCandidate,
  report: ComfyEnvironmentReport,
  baseline: CatalogRecord,
  candidate: CatalogRecord,
  expected: string,
  fetcher: typeof fetch
): Promise<RuntimeCompatibility> {
  if (
    report.comfy.status !== 'installed' ||
    report.runtime.status !== 'available' ||
    report.runtime.accelerator !== 'cuda'
  )
    return { status: 'unknown', reason: 'EXISTING_RUNTIME_PROBE_INCOMPLETE' };
  if (report.comfy.revision === expected && report.comfy.service !== 'online')
    return { status: 'compatible', reason: 'EXACT_CORE_REVISION', revision: expected };
  if (!environment.baseUrl || report.comfy.service !== 'online')
    return report.comfy.revision
      ? { status: 'compatible', reason: 'SCHEMA_PENDING_AUTHORIZED_START', revision: report.comfy.revision }
      : { status: 'unknown', reason: 'EXISTING_RUNTIME_REVISION_UNCONFIRMED' };
  try {
    const stats = record(report.comfy.systemStats);
    const identity = await inspectComfyServiceIdentity(environment.baseUrl, stats, environment.python);
    if (
      !identity ||
      !sameEnvironmentPath(identity.root, environment.root) ||
      !environment.python ||
      !sameEnvironmentPath(identity.executable, environment.python)
    )
      return { status: 'unknown', reason: 'EXISTING_RUNTIME_IDENTITY_UNCONFIRMED' };
    const response = await fetcher(`${new URL(environment.baseUrl).origin}/object_info`, {
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (!response.ok) return { status: 'unknown', reason: 'EXISTING_RUNTIME_SCHEMA_UNAVAILABLE' };
    const registry = record(await response.json()) as ComfyRegistry;
    if (!Object.keys(registry).length) return { status: 'unknown', reason: 'EXISTING_RUNTIME_SCHEMA_EMPTY' };
    try {
      validateInstallationSchema(baseline, candidate, registry);
    } catch {
      return { status: 'incompatible', reason: 'WORKFLOW_NODE_OR_INPUT_UNSUPPORTED' };
    }
    const revision = report.comfy.revision;
    if (!revision) return { status: 'unknown', reason: 'EXISTING_RUNTIME_REVISION_UNCONFIRMED' };
    return { status: 'compatible', reason: 'LIVE_WORKFLOW_SCHEMA', revision };
  } catch {
    return { status: 'unknown', reason: 'EXISTING_RUNTIME_SCHEMA_PROBE_FAILED' };
  }
}
