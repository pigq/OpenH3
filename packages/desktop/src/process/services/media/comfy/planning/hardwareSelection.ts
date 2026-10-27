import type { ComfyEnvironmentReport, ComfyCommandRunner } from '../discovery/environment';
import { runComfyCommand } from '../discovery/environment';
import { records, record, stringValue, type CatalogRecord } from './catalog';

export type ComfyKernelEvidence = { bf16: boolean; attention: boolean; fp8: boolean; error?: string };

/** Execute small tensors on the actual CUDA device, rather than inferring execution from package names. */
export async function probePlanningKernels(
  python: string,
  run: ComfyCommandRunner = runComfyCommand
): Promise<ComfyKernelEvidence> {
  try {
    const output = await run(
      python,
      [
        '-c',
        `import json,torch
import torch.nn.functional as F
r={"bf16":False,"attention":False,"fp8":False}
try:
 a=torch.ones((1,1,32,32),device='cuda',dtype=torch.bfloat16)
 (a@a.transpose(-1,-2)).sum().item();r['bf16']=True
 F.scaled_dot_product_attention(a,a,a).sum().item();r['attention']=True
 a.to(torch.float8_e4m3fn).to(torch.bfloat16).sum().item();r['fp8']=True
 torch.cuda.synchronize()
except Exception as e:r['error']=type(e).__name__
print(json.dumps(r))`,
      ],
      { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 }
    );
    const result = record(JSON.parse(output.trim().split(/\r?\n/).at(-1) ?? ''));
    return {
      bf16: result.bf16 === true,
      attention: result.attention === true,
      fp8: result.fp8 === true,
      ...(result.error ? { error: stringValue(result.error) } : {}),
    };
  } catch {
    return { bf16: false, attention: false, fp8: false, error: 'KERNEL_PROBE_FAILED' };
  }
}

export function assertPlanningHardware(report: ComfyEnvironmentReport): void {
  const missing: string[] = [];
  if (report.machine.gpuStatus !== 'available') missing.push('GPU_PROBE');
  if (!report.machine.disk) missing.push('FREE_DISK');
  if (!(report.machine.totalMemoryBytes > 0) || !(report.machine.freeMemoryBytes > 0)) missing.push('RAM');
  const gpu = report.machine.gpus.find((entry) => entry.vendor === 'nvidia');
  if (gpu && (!gpu.driver || !gpu.computeCapability || !gpu.totalMemoryBytes || gpu.freeMemoryBytes === undefined))
    missing.push('CUDA_DRIVER_ARCHITECTURE_OR_MEMORY');
  if (missing.length) throw new Error(`COMFY_DETECTION_INCOMPLETE:${missing.join(',')}`);
  if (!gpu) throw new Error('COMFY_DEVICE_CONDITIONS_INSUFFICIENT:PINNED_CUDA_RECIPE_REQUIRES_NVIDIA');
  if (!['win32', 'linux'].includes(report.machine.os) || report.machine.arch !== 'x64')
    throw new Error(`COMFY_DETECTION_INCOMPLETE:PLATFORM_RECIPE:${report.machine.os}:${report.machine.arch}`);
  if (Number(gpu.computeCapability) < 8)
    throw new Error('COMFY_DEVICE_CONDITIONS_INSUFFICIENT:PINNED_BF16_RECIPE_REQUIRES_COMPUTE_80');
}

/**
 * Rank whole recipes using their actual component sizes and measured capacity.
 * A planning budget is not a generation capability claim: the executor must
 * still validate the loader, executing kernels and generated media.
 */
export function selectComfyCandidate(
  candidates: CatalogRecord[],
  report: ComfyEnvironmentReport,
  kernels?: ComfyKernelEvidence,
  requestedId?: string
): CatalogRecord {
  assertPlanningHardware(report);
  const gpu = report.machine.gpus.find((entry) => entry.vendor === 'nvidia')!;
  const blackwell = ['10.0', '10.3', '12.0', '12.1'].includes(gpu.computeCapability!);
  const considered = requestedId ? candidates.filter((entry) => entry.id === requestedId) : candidates;
  if (!considered.length) throw new Error(`COMFY_PROFILE_CANDIDATE_NOT_FOUND:${requestedId ?? 'family'}`);
  const failures: string[] = [];
  const eligible: Array<{ candidate: CatalogRecord; fitsGpu: boolean; bytes: number }> = [];
  for (const candidate of considered) {
    const components = records(candidate.components);
    const precision = [candidate.quantization, ...components.map((entry) => entry.precision)].join(' ');
    if (
      !stringValue(candidate.apiBaselineId) ||
      !components.length ||
      components.some(
        (entry) => !stringValue(entry.sha256) || !(Number(entry.sizeBytes) > 0) || !stringValue(entry.revision)
      )
    ) {
      failures.push(`incomplete:${candidate.id}:FIXED_COMPONENT_OR_API_BASELINE`);
      continue;
    }
    if ((record(candidate.hardware).blackwellOnly || /NVFP4/i.test(precision)) && !blackwell) {
      failures.push(`insufficient:${candidate.id}:NVFP4_REQUIRES_BLACKWELL`);
      continue;
    }
    // These loaders need an additional native backend. Package presence alone
    // is not proof that its quantized kernel can execute on this GPU.
    if (/ConvRot|NVFP4|W4A8|GPTQ/i.test(precision)) {
      failures.push(`incomplete:${candidate.id}:NATIVE_QUANTIZATION_KERNEL_EVIDENCE_REQUIRED`);
      continue;
    }
    if (kernels && (!kernels.bf16 || !kernels.attention || (/FP8/i.test(precision) && !kernels.fp8))) {
      failures.push(`incomplete:${candidate.id}:EXECUTING_BF16_ATTENTION_OR_FP8_KERNEL`);
      continue;
    }
    const bytes = components.reduce((sum, entry) => sum + Number(entry.sizeBytes), 0);
    const largest = Math.max(...components.map((entry) => Number(entry.sizeBytes)));
    const reserve = Math.max(2 * 2 ** 30, Math.ceil(largest * 0.15));
    // CPU offload keeps complete weights across host/device; temporary memory
    // is reserved explicitly, without assigning a family to a VRAM threshold.
    if (bytes + reserve > report.machine.freeMemoryBytes + (gpu.freeMemoryBytes ?? 0)) {
      failures.push(`insufficient:${candidate.id}:AVAILABLE_RAM_AND_VRAM:${bytes + reserve}`);
      continue;
    }
    if (bytes + Math.max(4 * 2 ** 30, Math.ceil(bytes * 0.1)) > report.machine.disk!.freeBytes) {
      failures.push(`insufficient:${candidate.id}:FREE_DISK:${bytes}`);
      continue;
    }
    eligible.push({ candidate, bytes, fitsGpu: bytes + reserve <= (gpu.freeMemoryBytes ?? 0) });
  }
  eligible.sort((a, b) => Number(b.fitsGpu) - Number(a.fitsGpu) || a.bytes - b.bytes);
  if (eligible.length) return eligible[0].candidate;
  const incomplete = failures.some((failure) => failure.startsWith('incomplete:'));
  throw new Error(
    `COMFY_${incomplete ? 'DETECTION_INCOMPLETE' : 'DEVICE_CONDITIONS_INSUFFICIENT'}:${failures.join(';')}`
  );
}
