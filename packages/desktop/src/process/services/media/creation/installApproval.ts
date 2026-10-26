import { z } from 'zod';
import type { ComfyApprovalDecision } from '@/common/chat/document/creation/comfy';

const envelope = z.object({ success: z.literal(true), data: z.unknown() });
const conversationSchema = z.object({
  id: z.string(),
  type: z.string(),
  extra: z.object({
    agent_id: z.string().optional(),
    backend: z.string().optional(),
    agent_source: z.string().optional(),
  }),
  assistant: z.object({ backend: z.string() }).nullish(),
});
const runtimeSchema = z.object({
  config_options: z.array(
    z.object({
      id: z.string(),
      category: z.string().nullish(),
      option_type: z.string().optional(),
      type: z.string().optional(),
      current_value: z.string().nullish(),
      options: z.array(z.object({ value: z.string() })).default([]),
    })
  ),
});
const agentsSchema = z.array(
  z.object({
    id: z.string(),
    backend: z.string().nullish(),
    agent_source: z.string().optional(),
    yolo_id: z.string().nullish(),
  })
);

/** Resolve approval from the application's observed runtime and declared native YOLO mode. */
export function createComfyApprovalResolver(options: {
  backendPort?: number | (() => number | undefined);
  fetchImpl?: typeof fetch;
}) {
  return async (conversationId: string): Promise<ComfyApprovalDecision> => {
    const backendPort = typeof options.backendPort === 'function' ? options.backendPort() : options.backendPort;
    if (!Number.isInteger(backendPort) || !backendPort || backendPort < 1 || backendPort > 65535)
      throw new Error('COMFY_APPROVAL_BACKEND_UNAVAILABLE');
    const request = async (route: string, method = 'GET'): Promise<unknown> => {
      const response = await (options.fetchImpl ?? fetch)(`http://127.0.0.1:${backendPort}${route}`, {
        method,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('COMFY_APPROVAL_BACKEND_UNAVAILABLE');
      return envelope.parse(await response.json()).data;
    };
    const route = `/api/conversations/${encodeURIComponent(conversationId)}`;
    // runtime/ensure returns observed config_options without sending a model turn.
    // The old GET config-options route has been removed from Core.
    const [conversationData, runtimeData] = await Promise.all([
      request(route),
      request(`${route}/runtime/ensure`, 'POST'),
    ]);
    const conversation = conversationSchema.parse(conversationData);
    if (conversation.id !== conversationId) throw new Error('COMFY_APPROVAL_CONVERSATION_MISMATCH');
    const runtime = runtimeSchema.parse(runtimeData);
    const mode =
      runtime.config_options.find((option) => option.category === 'mode') ??
      runtime.config_options.find((option) => option.id === 'mode');
    const runtimeMode = mode?.current_value ?? undefined;
    const manual: ComfyApprovalDecision = { mode: 'manual', runtimeMode };
    if (
      !mode ||
      (mode.option_type ?? mode.type) !== 'select' ||
      !runtimeMode ||
      !mode.options.some((option) => option.value === runtimeMode)
    )
      return manual;
    if (conversation.type === 'aionrs') return { mode: runtimeMode === 'yolo' ? 'automatic' : 'manual', runtimeMode };
    const agents = agentsSchema.parse(await request('/api/agents/management'));
    const backend = conversation.extra.backend ?? conversation.assistant?.backend ?? conversation.type;
    const matches = agents.filter((agent) =>
      conversation.extra.agent_id
        ? agent.id === conversation.extra.agent_id
        : agent.backend === backend && agent.agent_source === (conversation.extra.agent_source ?? 'builtin')
    );
    if (matches.length !== 1 || !matches[0].yolo_id) return manual;
    const agent = matches[0];
    if (agent.backend && agent.backend !== backend) return manual;
    const nativeMode = agent.yolo_id;
    if (!nativeMode) return manual;
    // Keep Codex's two observed full-access ids aligned with Core's mode_normalize.rs.
    const automatic =
      nativeMode === runtimeMode ||
      (agent.backend === 'codex' &&
        ['agent-full-access', 'full-access'].includes(nativeMode) &&
        ['agent-full-access', 'full-access'].includes(runtimeMode));
    return { mode: automatic ? 'automatic' : 'manual', runtimeMode };
  };
}
