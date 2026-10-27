import fs from 'node:fs';
import path from 'node:path';
import type { ComfyDiagnosis, ComfyGenerationInput, ComfyProfile } from '@/common/chat/document/creation/comfy';
import type { ComfyGenerationResult, ComfyWorkflowEngine } from './workflowEngine';
import {
  clearBoundComfyRuntime,
  comfyRuntimeSignature,
  sharedComfyRuntimeCoordinator,
  type ComfyCleanupReason,
  type ComfyRuntimeCoordinator,
} from './runtimeCoordinator';

export type ComfySmokeReceipt = {
  planHash: string;
  profile: ComfyProfile;
  snapshotDirectory: string;
  status: 'pending' | 'submitted' | 'succeeded' | 'retry-ready' | 'failed';
  promptId?: string;
  result?: ComfyGenerationResult;
  oomRetryCount?: number;
  error?: string;
  diagnosis?: ComfyDiagnosis;
};
export type ComfySmokeEngine = Pick<ComfyWorkflowEngine, 'generate'> &
  Partial<Pick<ComfyWorkflowEngine, 'resume' | 'clearMemory' | 'runtimeResourceKey'>>;

/** Resume a smoke prompt or reserve one durable OOM retry while holding its device lease. */
export async function runComfyInstallSmoke(
  saved: ComfySmokeReceipt,
  input: ComfyGenerationInput,
  signal: AbortSignal,
  options: {
    engine: ComfySmokeEngine;
    save: (receipt: ComfySmokeReceipt) => void;
    progress?: (value: number) => void;
    coordinator?: ComfyRuntimeCoordinator;
  }
): Promise<{ receipt: ComfySmokeReceipt; result: ComfyGenerationResult }> {
  let receipt = structuredClone(saved);
  if (receipt.status === 'failed')
    throw Object.assign(new Error(receipt.error ?? 'COMFY_SMOKE_FAILED'), { diagnosis: receipt.diagnosis });
  if (receipt.status === 'succeeded' && receipt.result) return { receipt, result: receipt.result };
  const coordinator = options.coordinator ?? sharedComfyRuntimeCoordinator;
  const taskId = `smoke:${receipt.profile.id}:${receipt.planHash}`;
  const binding = { kind: 'comfy' as const, profile: receipt.profile, outputRoot: receipt.snapshotDirectory };
  let uncertain = Boolean(receipt.promptId);
  const update = (patch: Partial<ComfySmokeReceipt>): void => {
    receipt = { ...receipt, ...patch };
    options.save(receipt);
  };
  const cleanup = async (reason: ComfyCleanupReason, previous?: unknown): Promise<void> => {
    if (!options.engine.clearMemory) throw new Error('COMFY_MEMORY_CLEAR_UNAVAILABLE');
    let confirmed = false;
    let failure: string | undefined;
    try {
      const prior = previous as typeof binding | undefined;
      const cleanupSignal = new AbortController().signal;
      if (
        !prior ||
        (prior.kind === 'comfy' && prior.profile?.environment.baseUrl === binding.profile.environment.baseUrl)
      )
        await options.engine.clearMemory(prior?.profile ?? binding.profile, reason, cleanupSignal);
      else
        await clearBoundComfyRuntime(previous, reason, cleanupSignal, () =>
          options.engine.clearMemory!(binding.profile, reason, cleanupSignal)
        );
      confirmed = true;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      try {
        fs.appendFileSync(
          path.join(receipt.snapshotDirectory, 'memory.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), reason, confirmed, error: failure }) + '\n'
        );
      } catch {
        /* Diagnostics must not change a confirmed cleanup or mask its original failure. */
      }
    }
  };
  const task = async (): Promise<ComfyGenerationResult> => {
    for (;;) {
      if (signal.aborted) throw new Error('COMFY_INSTALL_CANCELLED');
      if (receipt.status === 'retry-ready') {
        uncertain = false;
        try {
          await cleanup('oom', binding);
        } catch (cause) {
          throw new Error('COMFY_MEMORY_CLEAR_UNCONFIRMED', { cause });
        }
        if (signal.aborted) throw new Error('COMFY_INSTALL_CANCELLED');
        update({ status: 'pending', promptId: undefined });
      }
      try {
        let result: ComfyGenerationResult;
        if (receipt.promptId) {
          if (!options.engine.resume) throw new Error('COMFY_SMOKE_RESUME_UNAVAILABLE');
          result = await options.engine.resume(receipt.profile, receipt.promptId, signal, options.progress);
          if (result.promptId !== receipt.promptId) throw new Error('COMFY_SMOKE_RECEIPT_INVALID');
        } else {
          result = await options.engine.generate(
            structuredClone(receipt.profile),
            structuredClone(input),
            signal,
            options.progress,
            (promptId) => {
              uncertain = true;
              update({ status: 'submitted', promptId });
            },
            (promptId) => {
              uncertain = true;
              update({ status: 'pending', promptId });
            }
          );
        }
        uncertain = false;
        update({ status: 'submitted', promptId: result.promptId, error: undefined, diagnosis: undefined });
        return result;
      } catch (error) {
        const diagnosis = (error as { diagnosis?: ComfyDiagnosis } | undefined)?.diagnosis;
        if (diagnosis || (error as { remoteTerminal?: boolean } | undefined)?.remoteTerminal === true)
          uncertain = false;
        const message = error instanceof Error ? error.message : String(error);
        if (
          diagnosis?.category === 'OOM' &&
          !signal.aborted &&
          (receipt.oomRetryCount ?? 0) < 1 &&
          options.engine.clearMemory
        ) {
          update({
            status: 'retry-ready',
            oomRetryCount: 1,
            promptId: undefined,
            error: message,
            diagnosis,
          });
          continue;
        }
        if (diagnosis) update({ status: 'failed', error: message, diagnosis });
        throw error;
      }
    }
  };
  const result = options.engine.runtimeResourceKey
    ? await coordinator.run(
        await options.engine.runtimeResourceKey(receipt.profile).catch(() => 'machine'),
        comfyRuntimeSignature(receipt.profile),
        task,
        cleanup,
        signal,
        {
          taskId,
          recover: Boolean(receipt.promptId || receipt.status === 'retry-ready'),
          isUncertain: () => uncertain,
          context: binding,
        }
      )
    : await task();
  return { receipt, result };
}
