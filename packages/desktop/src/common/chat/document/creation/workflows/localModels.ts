import type { ComfyInventory, ComfyProfile } from '../comfy';

export type LocalModelInstallContext = {
  candidateId?: string;
  checkedAt: string;
  installDirectory: string;
};

export type LocalDeviceSnapshot = {
  checkedAt: string;
  os: string;
  osRelease: string;
  arch: string;
  cpu: string;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  gpuStatus: 'available' | 'unknown';
  gpus: Array<{
    vendor: 'nvidia' | 'amd' | 'apple' | 'unknown';
    name: string;
    totalMemoryBytes?: number;
    freeMemoryBytes?: number;
    driver?: string;
    computeCapability?: string;
    sharedMemory?: boolean;
  }>;
  installDirectory: string;
  disk?: { path: string; totalBytes: number; freeBytes: number };
};

export type LocalModelPurpose = 'image-generation' | 'image-edit' | 'video';
export type LocalModelCompatibility = 'verified' | 'compatible' | 'unknown' | 'insufficient';
/** Stable reason codes are localized by the renderer. */
export type LocalModelReason =
  | 'verified-workflow'
  | 'component-metadata-missing'
  | 'workflow-missing'
  | 'hardware-unknown'
  | 'platform-unknown'
  | 'gpu-architecture-insufficient'
  | 'native-kernel-unverified'
  | 'runtime-unverified'
  | 'memory-insufficient'
  | 'disk-insufficient'
  | 'disk-unknown'
  | 'temporary-memory-pressure'
  | 'offload-required'
  | 'capacity-compatible';

export type LocalModelRecommendation = {
  id: string;
  family: string;
  name: string;
  kind: 'image' | 'video';
  candidateId?: string;
  quantization?: string;
  purposes: LocalModelPurpose[];
  status: LocalModelCompatibility;
  reasons: LocalModelReason[];
  installed: boolean;
  modelSetId?: string;
  profiles: ComfyProfile[];
  /** A route whose saved verification matches the currently observed device and files. */
  verifiedProfileId?: string;
  workflowCount: number;
  totalBytes?: number;
  downloadBytes?: number;
  reusedBytes: number;
  requiredMemoryBytes?: number;
  selectedGpuIndex?: number;
  activity?: { conversationId: string; state: string };
  installContext: LocalModelInstallContext;
};

export type LocalModelCenterSnapshot = {
  checkedAt: string;
  device: LocalDeviceSnapshot;
  inventory: ComfyInventory;
  recommendations: LocalModelRecommendation[];
  models: LocalModelRecommendation[];
};
