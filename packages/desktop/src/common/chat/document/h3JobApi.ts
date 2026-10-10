import type { H3ComfyDiagnosis, H3GenerationSpec, H3Job, H3Version } from './h3Job';
import type { H3SetupState, H3SetupPlan, H3HardwareAssessment } from './h3Setup';

export class H3ServiceError extends Error {
  constructor(
    message: string,
    readonly diagnosis?: H3ComfyDiagnosis
  ) {
    super(message);
    this.name = 'H3ServiceError';
  }
}

export type H3RuntimeStatus = {
  ready: boolean;
  install: {
    bundleRoot: string;
    runtimeRoot: string;
    modelsDirectory: string;
    bundleVerified: boolean;
    runtimePresent: boolean;
    missingAssets: string[];
    missingCustomNodes: string[];
  };
  acceleration?: {
    mode: 'auto' | 'dense' | 'sla';
    backend: 'dense' | 'sla';
    available: boolean;
    root?: string;
    tritonPresent: boolean;
    pythonDevPresent: boolean;
    reason: string;
  };
  error?: string;
  readiness?: 'ready' | 'needs-download' | 'needs-extract' | 'incomplete';
};

export type H3JobApiClient = {
  create(spec: H3GenerationSpec): Promise<H3Job>;
  get(id: string): Promise<H3Job>;
  cancel(id: string): Promise<H3Job>;
  status(): Promise<H3RuntimeStatus>;
  configureBundleRoot(bundleRoot: string): Promise<H3RuntimeStatus>;
  setup(): Promise<H3SetupState>;
  install(options?: {
    download: boolean;
    acceptModelTerms: boolean;
    acceptExperimentalHardware?: boolean;
  }): Promise<H3SetupState>;
  setupHardware(): Promise<H3HardwareAssessment>;
  setupCapabilities(): Promise<{
    nodesAvailable: boolean;
    modelsAvailable: boolean;
    missingModels: string[];
    generationVerified: false;
    modes: Array<{ mode: string; missingNodes: string[]; nodesAvailable: boolean }>;
  }>;
  startRuntime(): Promise<{ connected: boolean; generationVerified: false }>;
  setupPlan(): Promise<H3SetupPlan>;
  pauseSetup(): Promise<H3SetupState>;
  events(id: string, onJob: (job: H3Job) => void): EventSource;
  resourceUrl(resourcePath: string): string;
  versions(): Promise<H3Version[]>;
  selectVersion(id: string): Promise<H3Version[]>;
  deriveVersion(
    id: string,
    patch: Partial<Pick<H3GenerationSpec, 'prompt' | 'durationSeconds' | 'megapixels' | 'seed'>>
  ): Promise<H3Job>;
};

function baseUrl(): string {
  const configured =
    typeof window !== 'undefined' ? (window as Window & { __mediaServicePort?: number }).__mediaServicePort : undefined;
  return `http://127.0.0.1:${configured ?? 33002}`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl()}${url}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(url === '/api/h3/setup/start' ? 300_000 : 45_000),
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const payload = (await response.json()) as T & { error?: string; diagnosis?: H3ComfyDiagnosis };
  if (!response.ok) throw new H3ServiceError(payload.error ?? `H3_SERVICE_HTTP_${response.status}`, payload.diagnosis);
  return payload;
}

export const h3JobApi: H3JobApiClient = {
  setup: () => request<H3SetupState>('/api/h3/setup'),
  setupHardware: () => request<H3HardwareAssessment>('/api/h3/setup/hardware'),
  setupCapabilities: () => request('/api/h3/setup/capabilities'),
  startRuntime: () => request('/api/h3/setup/start', { method: 'POST', body: '{}' }),
  install: (options) =>
    request<H3SetupState>('/api/h3/setup/install', { method: 'POST', body: JSON.stringify(options ?? {}) }),
  setupPlan: () => request<H3SetupPlan>('/api/h3/setup/plan'),
  pauseSetup: () => request<H3SetupState>('/api/h3/setup/pause', { method: 'POST', body: '{}' }),
  create: (spec) => request<H3Job>('/api/h3/jobs', { method: 'POST', body: JSON.stringify(spec) }),
  get: (id) => request<H3Job>(`/api/h3/jobs/${encodeURIComponent(id)}`),
  cancel: (id) => request<H3Job>(`/api/h3/jobs/${encodeURIComponent(id)}?action=cancel`, { method: 'POST' }),
  status: async () => {
    const response = await fetch(`${baseUrl()}/api/h3/status`, { signal: AbortSignal.timeout(15_000) });
    const payload = (await response.json()) as H3RuntimeStatus;
    return payload;
  },
  configureBundleRoot: (bundleRoot) =>
    request<H3RuntimeStatus>('/api/h3/setup/configure', { method: 'POST', body: JSON.stringify({ bundleRoot }) }),
  events: (id, onJob) => {
    const source = new EventSource(`${baseUrl()}/api/h3/jobs/${encodeURIComponent(id)}/events`);
    source.addEventListener('progress', (event) => onJob(JSON.parse((event as MessageEvent).data) as H3Job));
    return source;
  },
  resourceUrl: (resourcePath) => `${baseUrl()}${resourcePath}`,
  versions: () => request<H3Version[]>('/api/h3/versions'),
  selectVersion: (id) =>
    request<H3Version[]>('/api/h3/versions/select', { method: 'POST', body: JSON.stringify({ id }) }),
  deriveVersion: (id, patch) =>
    request<H3Job>(`/api/h3/versions/${encodeURIComponent(id)}/derive`, {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
};
