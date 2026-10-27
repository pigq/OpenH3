import crypto from 'node:crypto';
import path from 'node:path';
import type { ComfyInstallPlan } from '@/common/chat/document/creation/comfy';
import { buildH3DownloadPlan } from '@/process/services/runtime/h3DownloadPlan';
import {
  MATLOWAI_CUSTOM_NODE_ARCHIVES,
  matlowaiCompleteOfflineBundle,
} from '@/process/services/runtime/h3OfflineBundle';
import embeddedWorkflows from '@/process/services/runtime/h3EmbeddedWorkflows.json';
import { records, stringValue, type CatalogRecord } from './catalog';
import type { ComfyEnvironmentReport } from '../discovery/environment';

export const H3_PORTABLE_INSTALL_EVIDENCE = 'installer:openh3-pinned-h3-portable-v1';

/** Build the exact legacy recipe, including its embedded API export, before authorization. */
export function createLegacyH3InstallPlan(
  bundleRoot: string,
  candidate: CatalogRecord,
  report: ComfyEnvironmentReport,
  baseUrl = 'http://127.0.0.1:8188'
): ComfyInstallPlan {
  if (report.machine.os !== 'win32')
    throw new Error('COMFY_DEVICE_CONDITIONS_INSUFFICIENT:H3_PORTABLE_WINDOWS_REQUIRED');
  const gpu = report.machine.gpus.find((entry) => entry.vendor === 'nvidia');
  if (!gpu?.computeCapability || !gpu.driver)
    throw new Error('COMFY_DETECTION_INCOMPLETE:H3_DRIVER_OR_GPU_ARCHITECTURE');
  if (!['10.0', '10.3', '12.0', '12.1'].includes(gpu.computeCapability))
    throw new Error('COMFY_DEVICE_CONDITIONS_INSUFFICIENT:H3_PINNED_NVFP4_RECIPE_REQUIRES_BLACKWELL');
  if (Number(gpu.driver.split('.')[0]) < 580)
    throw new Error('COMFY_DEVICE_CONDITIONS_INSUFFICIENT:H3_PINNED_CUDA13_DRIVER_580_REQUIRED');
  const manifest = matlowaiCompleteOfflineBundle();
  const relative = 'workflows/lowvram/01_reference_4step_sla_lowvram.api.json';
  const bytes = Buffer.from(embeddedWorkflows[relative], 'base64');
  if (
    crypto.createHash('sha256').update(bytes).digest('hex') !==
    manifest.files.find((file) => file.relativePath === relative)?.sha256
  )
    throw new Error('COMFY_TOOL_NOT_READY:H3_EMBEDDED_WORKFLOW_HASH');
  const runtimeRoot = path.join(bundleRoot, 'runtime', 'ComfyUI_windows_portable');
  const components = records(candidate.components).map((component) => ({
    role: stringValue(component.role),
    name: path.basename(stringValue(component.path)),
    path: path.join(bundleRoot, stringValue(component.path)),
    version: stringValue(component.revision),
    precision:
      component.role === 'text-encoder' ? 'NVFP4-AWQ' : component.role === 'audio-vae' ? 'FP32' : 'INT8-ConvRot',
    url: stringValue(component.url),
    sha256: stringValue(component.sha256),
    sizeBytes: Number(component.sizeBytes),
  }));
  const download = buildH3DownloadPlan();
  const weights = components.reduce((sum, item) => sum + item.sizeBytes, 0);
  const available = report.machine.freeMemoryBytes + (gpu.freeMemoryBytes ?? 0);
  if (weights + Math.ceil(weights * 0.15) > available)
    throw new Error(`COMFY_DEVICE_CONDITIONS_INSUFFICIENT:H3_AVAILABLE_RAM_AND_VRAM:${weights}`);
  if (!report.machine.disk) throw new Error('COMFY_DETECTION_INCOMPLETE:FREE_DISK');
  if (download.totalBytes + download.reserveBytes > report.machine.disk.freeBytes)
    throw new Error(`COMFY_DEVICE_CONDITIONS_INSUFFICIENT:FREE_DISK:${download.totalBytes + download.reserveBytes}`);
  return {
    id: `legacy-h3-t2v-${crypto.createHash('sha256').update(bundleRoot).digest('hex').slice(0, 12)}`,
    family: 'h3',
    kind: 'video',
    name: 'H3 INT8 / NVFP4 (t2v)',
    version: manifest.modelRevision,
    quantization: 'INT8 diffusion + NVFP4-AWQ encoder + INT8 video VAE + FP32 audio VAE',
    capabilities: ['text-to-video', 'native-audio'],
    environment: {
      root: path.join(runtimeRoot, 'ComfyUI'),
      python: path.join(runtimeRoot, 'python_embeded', 'python.exe'),
      baseUrl,
      launchArgs: [
        '--windows-standalone-build',
        '--disable-auto-launch',
        '--models-directory',
        path.join(bundleRoot, 'models'),
      ],
    },
    components,
    nodes: [
      { id: 'ComfyUI', version: 'v0.35.0' },
      ...MATLOWAI_CUSTOM_NODE_ARCHIVES.map((node) => ({ id: node.targetDirectory, version: node.revision })),
    ],
    workflowPath: path.join(bundleRoot, relative),
    bindings: {
      prompt: [{ nodeId: '1', input: 'value' }],
      durationSeconds: [{ nodeId: '133', input: 'value' }],
      seed: [{ nodeId: '129', input: 'noise_seed' }],
      megapixels: [{ nodeId: '115', input: 'megapixels' }],
    },
    defaults: { durationSeconds: 4, megapixels: 0.2, seed: 42 },
    targetRoot: bundleRoot,
    downloadBytes: download.totalBytes,
    requiredBytes: download.totalBytes + download.reserveBytes,
    reason: 'Pinned portable runtime, matching fused weights, custom nodes and embedded API workflow',
    evidence: [
      H3_PORTABLE_INSTALL_EVIDENCE,
      'h3-recipe:atomic-legacy-8a8dffaa',
      'kernel-validation:pending-real-smoke',
      `workflow-source-sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    ],
    workflow: JSON.parse(bytes.toString('utf8')) as ComfyInstallPlan['workflow'],
    workflowSource: bytes.toString('utf8'),
    workflowSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    commands: [],
    smokeInput: {
      prompt: 'A red ceramic cup on a wooden table in soft daylight, one continuous shot; quiet room tone.',
      durationSeconds: 4,
      seed: 42,
    },
    repair: false,
  };
}
