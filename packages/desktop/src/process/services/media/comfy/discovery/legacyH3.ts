import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  matlowaiCompleteOfflineBundle,
  MATLOWAI_CUSTOM_NODE_ARCHIVES,
  MATLOWAI_RUNTIME_DEPENDENCIES,
} from '@/process/services/runtime/h3OfflineBundle';
import {
  H3_MATLOWAI_COMFY_INT8_5080_PROFILE,
  H3_MATLOWAI_COMFY_MODEL_MANIFEST,
} from '@/process/services/runtime/h3Profiles';
import type { H3PortableInstallStatus } from '@/process/services/runtime/H3PortableInstaller';
import type { ComfyProfile } from '@/common/chat/document/creation/comfy';

/** Import existing local files as unverified profiles, preserving weights, workflows and historical jobs. */
export function importLegacyH3(install: H3PortableInstallStatus, baseUrl: string): ComfyProfile[] {
  if (!install.runtimePresent || install.missingAssets.length) return [];
  const manifest = matlowaiCompleteOfflineBundle();
  const components: ComfyProfile['components'] = manifest.files
    .filter((file) => file.relativePath.startsWith('models/'))
    .map((file) => {
      const dependency = MATLOWAI_RUNTIME_DEPENDENCIES.find((entry) => entry.relativePath === file.relativePath);
      const name = path.basename(file.relativePath),
        role = name.includes('qwen')
          ? 'encoder'
          : name.includes('audio_vae')
            ? 'audio-vae'
            : name.includes('video_vae')
              ? 'video-vae'
              : 'diffusion';
      const precision = role === 'encoder' ? 'NVFP4-AWQ' : role === 'audio-vae' ? 'FP32' : 'INT8-ConvRot';
      const url =
        dependency?.source && !dependency.source.startsWith('https:')
          ? `https://huggingface.co/${dependency.source}/resolve/${dependency.revision}/${file.relativePath.replace(/^models\//, '')}`
          : H3_MATLOWAI_COMFY_MODEL_MANIFEST.url;
      return {
        role,
        name,
        path: path.join(install.bundleRoot, file.relativePath),
        version: dependency?.revision ?? manifest.modelRevision,
        precision,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        url,
      };
    });
  const candidates = [
    {
      suffix: 't2v',
      filename: '01_reference_4step_sla_lowvram.api.json',
      capabilities: ['text-to-video', 'native-audio'],
    },
    {
      suffix: 'i2v',
      filename: '04_i2v_fl2v_4step_sla_lowvram.api.json',
      capabilities: ['image-to-video', 'native-audio'],
    },
    {
      suffix: 'reference',
      filename: '05_ref2va_4step_sla_lowvram.api.json',
      capabilities: ['image-to-video', 'reference-to-video', 'native-audio'],
    },
  ];
  return candidates.flatMap((candidate) => {
    const workflowPath = path.join(install.bundleRoot, 'workflows', 'lowvram', candidate.filename);
    if (!fs.existsSync(workflowPath)) return [];
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(workflowPath)).digest('hex');
    const pinned = manifest.files.find((file) => file.relativePath.endsWith(candidate.filename));
    const bindings: ComfyProfile['bindings'] = {
      prompt: [{ nodeId: '1', input: 'value' }],
      durationSeconds: [{ nodeId: '133', input: 'value' }],
      seed: [{ nodeId: '129', input: 'noise_seed' }],
      megapixels: [{ nodeId: '115', input: 'megapixels' }],
    };
    if (candidate.suffix !== 't2v') bindings.image = [{ nodeId: '901', input: 'image' }];
    const id = `legacy-h3-${candidate.suffix}-${crypto.createHash('sha256').update(install.bundleRoot).digest('hex').slice(0, 12)}`;
    const profile: ComfyProfile = {
      id,
      family: 'h3',
      kind: 'video',
      name: `H3 INT8 / NVFP4 (${candidate.suffix})`,
      version: H3_MATLOWAI_COMFY_INT8_5080_PROFILE.modelRevision,
      quantization: 'INT8 diffusion + NVFP4-AWQ encoder + INT8 video VAE + FP32 audio VAE',
      capabilities: candidate.capabilities,
      state: actualHash === pinned?.sha256 ? 'downloaded' : 'invalid',
      environment: {
        root: path.join(install.runtimeRoot, 'ComfyUI'),
        python: path.join(install.runtimeRoot, 'python_embeded', 'python.exe'),
        baseUrl,
        launchArgs: [
          '--windows-standalone-build',
          '--disable-auto-launch',
          '--models-directory',
          install.modelsDirectory,
        ],
      },
      components,
      nodes: [
        { id: 'ComfyUI', version: 'v0.35.0' },
        ...MATLOWAI_CUSTOM_NODE_ARCHIVES.map((node) => ({ id: node.targetDirectory, version: node.revision })),
      ],
      workflowPath,
      workflowSha256: pinned?.sha256,
      bindings,
      defaults: { durationSeconds: 4, megapixels: 0.2, seed: 42 },
      validation: {
        fingerprint: '',
        checkedAt: new Date().toISOString(),
        error: actualHash === pinned?.sha256 ? 'COMFY_LEGACY_REVALIDATION_REQUIRED' : 'COMFY_WORKFLOW_HASH_MISMATCH',
      },
    };
    return [profile];
  });
}
