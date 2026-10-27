import type { TMessage } from '@/common/chat/chatLib';
import type {
  ComfyGenerationJob,
  ComfyInstallPreparation,
  ComfyOperation,
} from '@/common/chat/document/creation/comfy';
import { toolResultRecords } from '@/common/chat/document/creation/toolResults';
import { useSyncExternalStore } from 'react';

export type WorkStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'waiting' | 'cancelled';
export type WorkKind = 'plan' | 'task' | 'subagent' | 'background' | 'workflow' | 'install' | 'generation';
export type WorkTask = {
  id: string;
  title: string;
  kind: WorkKind;
  status: WorkStatus;
  detail?: string;
  children?: WorkTask[];
  operationId?: string;
  preparing?: boolean;
  diagnosis?: 'deviceInsufficient' | 'detectionIncomplete';
};
export type WorkSnapshot = { tasks: WorkTask[]; isProcessing: boolean; pendingConfirmations: number };
export type WorkRuntime = {
  isProcessing: boolean;
  pendingConfirmations: number;
  hydrated: boolean;
  activeTurnId?: string | null;
};
const EMPTY: WorkSnapshot = { tasks: [], isProcessing: false, pendingConfirmations: 0 };
const snapshots = new Map<string, WorkSnapshot>();
const listeners = new Set<() => void>();

/** Publishes only display state; the durable source remains the persisted conversation messages. */
export function publishWorkProgress(conversationId: string, snapshot: WorkSnapshot): void {
  snapshots.set(conversationId, snapshot);
  if (snapshots.size > 100) {
    const oldest = snapshots.keys().next().value;
    if (oldest) snapshots.delete(oldest);
  }
  for (const listener of listeners) listener();
}
export function useWorkProgress(conversationId?: string | null): WorkSnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => (conversationId ? (snapshots.get(conversationId) ?? EMPTY) : EMPTY),
    () => EMPTY
  );
}
export function resetWorkProgressForTest(): void {
  snapshots.clear();
  for (const listener of listeners) listener();
}
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function workComfyIds(messages: TMessage[]): { operations: string[]; jobs: string[] } {
  const records = messages.flatMap(toolResultRecords);
  return {
    operations: [...new Set(records.map((item) => item.comfyOperationId).filter(uuid))],
    jobs: [...new Set(records.map((item) => item.comfyJobId).filter(uuid))],
  };
}

function status(value: string | undefined): WorkStatus {
  if (['completed', 'Success', 'succeeded'].includes(value ?? '')) return 'completed';
  if (['error', 'Error', 'failed'].includes(value ?? '')) return 'failed';
  if (['cancelled', 'canceled', 'Canceled'].includes(value ?? '')) return 'cancelled';
  if (['Confirming', 'awaiting-consent'].includes(value ?? '')) return 'waiting';
  if (['running', 'in_progress', 'Executing'].includes(value ?? '')) return 'running';
  return 'pending';
}
function kind(name: string, description: string, input: Record<string, unknown>): WorkKind {
  if (/workflow/i.test(name)) return 'workflow';
  if (/^(Task|Agent)$|spawn_agent|delegate/i.test(name) || description.includes(' · subagent ')) return 'subagent';
  if (
    /bash|exec|shell|terminal/i.test(name) ||
    description.includes(' · bg task ') ||
    input.run_in_background ||
    input.type === 'commandExecution' ||
    detachedExec(input)
  )
    return 'background';
  return 'task';
}
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
// Same provenance predicate as core session_agent::is_detached_exec_call. The
// codex adapter passes the entire commandExecution item through as tool input.
const detachedExec = (input: Record<string, unknown>): boolean =>
  typeof input.source === 'string' && input.source.startsWith('unifiedExec');
function aggregateStatus(children: WorkTask[]): WorkStatus {
  for (const candidate of ['failed', 'waiting', 'running', 'interrupted', 'pending', 'cancelled'] as const) {
    if (children.some((child) => child.status === candidate)) return candidate;
  }
  return 'completed';
}

/** A deterministic projection of existing persisted tool/plan records, never a second execution queue. */
export function projectWorkProgress(
  messages: TMessage[],
  runtime: WorkRuntime,
  operations: ComfyOperation[] = [],
  jobs: ComfyGenerationJob[] = [],
  unavailableIds: string[] = [],
  preparations: ComfyInstallPreparation[] = []
): WorkSnapshot {
  const tasks = new Map<string, WorkTask>();
  const latestPlan = messages.findLast((message) => message.type === 'plan');
  const stale = (value: WorkStatus): WorkStatus => {
    if (value !== 'running') return value;
    if (runtime.pendingConfirmations > 0) return 'waiting';
    return runtime.hydrated && !runtime.isProcessing ? 'interrupted' : value;
  };
  if (latestPlan?.type === 'plan' && latestPlan.content.entries.length > 1) {
    const entries = latestPlan.content.entries;
    const belongsToOlderTurn = Boolean(
      latestPlan.content.turn_id && runtime.activeTurnId && latestPlan.content.turn_id !== runtime.activeTurnId
    );
    const following = messages.slice(messages.indexOf(latestPlan) + 1);
    const nextUser = following.findIndex((message) => message.position === 'right');
    const failed = (nextUser < 0 ? following : following.slice(0, nextUser)).some(
      (message) => message.type === 'tips' && message.content.type === 'error'
    );
    const unfinishedStatus = failed ? 'failed' : belongsToOlderTurn ? 'interrupted' : stale('running');
    tasks.set('plan', {
      id: `plan:${latestPlan.id}`,
      title: '',
      kind: 'plan',
      status: entries.every((entry) => entry.status === 'completed') ? 'completed' : unfinishedStatus,
      children: entries.map((entry, index) => ({
        id: `plan:${index}`,
        title: entry.content,
        kind: 'task',
        status: entry.status === 'pending' ? 'pending' : entry.status === 'completed' ? 'completed' : unfinishedStatus,
      })),
    });
  }
  const ids = workComfyIds(messages);
  let lastUser = -1;
  messages.forEach((message, index) => {
    if (message.position === 'right') lastUser = index;
  });
  const recentTools = messages
    .slice(lastUser + 1)
    .filter((message) => ['tool_call', 'acp_tool_call'].includes(message.type));
  for (const [index, message] of messages.entries()) {
    if (message.type === 'tool_group') {
      if (!message.content.length) continue;
      // Workflow roster entries are namespaced by their container call id in
      // core workflow_progress.rs. A single finished ordinary tool is not a plan.
      if (
        message.content.length === 1 &&
        !message.content[0].call_id.includes(':') &&
        ['Success', 'Canceled'].includes(message.content[0].status)
      )
        continue;
      const children = message.content.map((entry) => ({
        id: entry.call_id,
        title: entry.name,
        detail: entry.description,
        kind: 'task' as const,
        status: stale(status(entry.status)),
      }));
      tasks.set(message.id, {
        id: message.id,
        title: '',
        kind: 'workflow',
        status: aggregateStatus(children),
        children,
      });
      continue;
    }
    if (message.type === 'acp_terminal_output') {
      const exit = message.content.exit_status;
      tasks.set(message.content.terminal_id, {
        id: message.content.terminal_id,
        title: message.content.command,
        kind: 'background',
        status: exit ? (exit.exit_code === 0 ? 'completed' : 'failed') : stale('running'),
      });
      continue;
    }
    if (message.type !== 'tool_call' && message.type !== 'acp_tool_call') continue;
    if (toolResultRecords(message).some((record) => uuid(record.comfyOperationId) || uuid(record.comfyJobId))) continue;
    const native = message.type === 'tool_call' ? message.content : undefined;
    const acp = message.type === 'acp_tool_call' ? message.content.update : undefined;
    const name = native?.name ?? acp?.title ?? '';
    if (/TodoWrite|TaskCreate|TaskUpdate|update_plan/i.test(name)) continue;
    const input = native?.input ?? native?.args ?? acp?.rawInput ?? {};
    const description = native?.description ?? text(input.description) ?? name;
    const toolKind = kind(name, description, input);
    if (toolKind === 'task' && (index <= lastUser || recentTools.length < 2)) continue;
    const detached =
      / · (?:bg task|subagent) /.test(description) ||
      input.run_in_background === true ||
      detachedExec(input) ||
      detachedExec(native?.args ?? {});
    const toolStatus = status(native?.status ?? acp?.status);
    if (
      toolKind === 'background' &&
      !detached &&
      toolStatus === 'completed' &&
      (index <= lastUser || recentTools.length < 2)
    )
      continue;
    const id = native?.call_id ?? acp?.tool_call_id ?? message.id;
    tasks.set(id, {
      id,
      title: description,
      kind: toolKind,
      status: detached ? toolStatus : stale(toolStatus),
      detail: native?.error,
    });
  }
  // A workflow's launch tool and its roster share the container call id. Keep
  // one tree rather than counting the launch card as an extra completed task.
  for (const task of tasks.values()) {
    const firstChild = task.children?.[0];
    if (task.kind !== 'workflow' || !firstChild) continue;
    const parentId = firstChild.id.slice(0, firstChild.id.lastIndexOf(':'));
    const parent = tasks.get(parentId);
    if (!parent || parent.kind !== 'workflow' || parent.id === task.id) continue;
    tasks.set(parentId, { ...parent, status: task.status, children: task.children });
    tasks.delete(task.id);
  }
  for (const id of new Set([...ids.operations, ...operations.map((item) => item.id)])) {
    const operation = operations.find((item) => item.id === id);
    tasks.set(id, {
      id,
      title: operation?.plan.name ?? '',
      kind: 'install',
      status: unavailableIds.includes(id)
        ? 'interrupted'
        : operation?.state === 'paused'
          ? 'interrupted'
          : status(operation?.state),
      detail:
        [operation?.progress, operation?.error, operation?.diagnosis?.action].filter(Boolean).join('\n') || undefined,
      operationId: id,
    });
  }
  for (const id of new Set([...ids.jobs, ...jobs.map((item) => item.id)])) {
    const job = jobs.find((item) => item.id === id);
    tasks.set(id, {
      id,
      title: job?.profileId ?? '',
      kind: 'generation',
      status: unavailableIds.includes(id) || job?.submissionUncertain ? 'interrupted' : status(job?.status),
      detail: [job?.error, job?.diagnosis?.action].filter(Boolean).join('\n') || undefined,
    });
  }
  for (const preparation of preparations) {
    tasks.set(`prepare:${preparation.requestId}`, {
      id: `prepare:${preparation.requestId}`,
      title: preparation.family,
      kind: 'install',
      status:
        preparation.status === 'detecting' ? 'running' : preparation.status === 'failed' ? 'failed' : 'interrupted',
      preparing: preparation.status === 'detecting',
      detail: preparation.error,
      diagnosis: preparation.error?.includes('COMFY_DEVICE_CONDITIONS_INSUFFICIENT')
        ? 'deviceInsufficient'
        : preparation.error?.includes('DETECTION_INCOMPLETE')
          ? 'detectionIncomplete'
          : undefined,
    });
  }
  return {
    tasks: [...tasks.values()],
    isProcessing: runtime.isProcessing,
    pendingConfirmations: runtime.pendingConfirmations,
  };
}
