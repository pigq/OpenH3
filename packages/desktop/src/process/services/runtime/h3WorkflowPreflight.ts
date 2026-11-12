import { H3ComfyError } from './h3ComfyError';
export type ComfyGraph = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;
export type ComfyNodeInfo = {
  input?: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> };
  output?: string[];
  output_node?: boolean;
};
export type ComfyRegistry = Record<string, ComfyNodeInfo>;

/** Require used reference nodes to participate in an output path; this does not establish semantic fidelity. */
export function validateComfyReferenceOutputPaths(
  graph: ComfyGraph,
  registry: ComfyRegistry,
  referenceNodeIds: string[]
): void {
  if (!referenceNodeIds.length) return;
  const outputs = Object.entries(graph)
    .filter(([, node]) => registry[node.class_type ?? '']?.output_node === true)
    .map(([id]) => id);
  const fail = (code: string, nodeId?: string): never => {
    throw new H3ComfyError(code, {
      category: 'INVALID_INPUT',
      nodeId: nodeId && /^[\w:.-]{1,100}$/.test(nodeId) ? nodeId : undefined,
      retryable: false,
      action: 'CHECK_WORKFLOW_INPUTS',
    });
  };
  if (!outputs.length) fail('COMFY_REFERENCE_OUTPUT_UNCONFIRMED');
  const reachable = new Set<string>();
  const pending = [...outputs];
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id) || !Object.hasOwn(graph, id)) continue;
    reachable.add(id);
    for (const value of Object.values(graph[id].inputs ?? {})) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1]))
        pending.push(value[0]);
    }
  }
  for (const id of new Set(referenceNodeIds)) {
    if (!reachable.has(id)) fail('COMFY_REFERENCE_INPUT_DISCONNECTED', id);
  }
}

export function validateComfyWorkflow(graph: ComfyGraph, registry: ComfyRegistry): void {
  const fail = (nodeId: string, missing = false): never => {
    throw new H3ComfyError('H3_WORKFLOW_PREFLIGHT', {
      category: missing ? 'MISSING_NODE' : 'INVALID_INPUT',
      nodeId: /^[\w:.-]{1,100}$/.test(nodeId) ? nodeId : undefined,
      retryable: false,
      action: missing ? 'CHECK_NODE_MANIFEST' : 'CHECK_WORKFLOW_INPUTS',
    });
  };
  if (!graph || Array.isArray(graph) || typeof graph !== 'object' || !Object.keys(graph).length) fail('graph');
  const edges = new Map<string, string[]>();
  for (const [id, node] of Object.entries(graph)) {
    if (!node || typeof node.class_type !== 'string') fail(id);
    const meta = Object.hasOwn(registry, node.class_type) ? registry[node.class_type] : undefined;
    if (!meta) fail(id, true);
    const inputs = node.inputs ?? {};
    if (typeof inputs !== 'object' || Array.isArray(inputs)) fail(id);
    const definitions = { ...meta.input?.required, ...meta.input?.optional };
    for (const [key, definition] of Object.entries(definitions)) {
      if (definition[0] !== 'COMFY_AUTOGROW_V3') {
        if (Object.hasOwn(meta.input?.required ?? {}, key) && !Object.hasOwn(inputs, key)) fail(id);
        continue;
      }
      const template = (
        definition[1] as {
          template?: {
            input?: { required?: Record<string, unknown[]> };
            names?: string[];
            prefix?: string;
            min?: number;
            max?: number;
          };
        }
      )?.template;
      const fields = Object.keys(inputs).filter((name) => name.startsWith(`${key}.`));
      const inner = Object.values(template?.input?.required ?? {})[0];
      if (
        !template ||
        !inner ||
        fields.length < (template.min ?? 0) ||
        fields.length > (template.max ?? template.names?.length ?? Infinity)
      )
        fail(id);
      for (const name of fields) {
        const suffix = name.slice(key.length + 1);
        if (template.names) {
          if (!template.names.includes(suffix)) fail(id);
        } else if (template.prefix) {
          const index = suffix.slice(template.prefix.length);
          if (
            !suffix.startsWith(template.prefix) ||
            !/^\d+$/.test(index) ||
            Number(index) >= (template.max ?? Infinity)
          )
            fail(id);
        }
        definitions[name] = inner;
      }
    }
    edges.set(id, []);
    for (const [key, value] of Object.entries(inputs)) {
      let definition = definitions[key];
      if (!definition && node.class_type === 'MiniMaxH3ReferenceToVideo') {
        const match =
          /^(ref_images|ref_videos|ref_video_audios|ref_audios)\.ref_(image|video|video_audio|audio)_(\d+)$/.exec(key);
        const types: Record<string, [string, string, number]> = {
          ref_images: ['image', 'IMAGE', 9],
          ref_videos: ['video', 'IMAGE', 3],
          ref_video_audios: ['video_audio', 'AUDIO', 3],
          ref_audios: ['audio', 'AUDIO', 3],
        };
        if (match && definitions[match[1]] && types[match[1]][0] === match[2] && Number(match[3]) < types[match[1]][2])
          definition = [types[match[1]][1]];
        else if (/^ref_(images|videos|video_audios|audios)\./.test(key)) fail(id);
      }
      // Unknown extension widgets remain the backend's responsibility; all links still get structural checks.
      const expected = definition?.[0];
      if (Array.isArray(value)) {
        if (value.length !== 2 || typeof value[0] !== 'string' || !Number.isInteger(value[1]) || value[1] < 0) fail(id);
        const source = Object.hasOwn(graph, value[0]) ? graph[value[0]] : undefined;
        if (!source) fail(id);
        const outputs = registry[source.class_type ?? '']?.output;
        if (!outputs || value[1] >= outputs.length) fail(id);
        const actual = outputs[value[1]];
        if (typeof expected === 'string' && expected !== '*' && actual !== '*' && !expected.split(',').includes(actual))
          fail(id);
        edges.get(id)!.push(value[0]);
      } else if (Array.isArray(expected)) {
        if (!expected.includes(value)) fail(id);
      } else if (expected === 'COMBO') {
        const choices = (definition?.[1] as { options?: unknown[] } | undefined)?.options;
        if (Array.isArray(choices) && !choices.includes(value)) fail(id);
      } else if (expected === 'INT' || expected === 'FLOAT') {
        if (typeof value !== 'number' || !Number.isFinite(value) || (expected === 'INT' && !Number.isInteger(value)))
          fail(id);
        const limits = definition?.[1] as { min?: number; max?: number } | undefined;
        if (
          (typeof limits?.min === 'number' && (value as number) < limits.min) ||
          (typeof limits?.max === 'number' && (value as number) > limits.max)
        )
          fail(id);
      } else if (
        (expected === 'STRING' && typeof value !== 'string') ||
        (expected === 'BOOLEAN' && typeof value !== 'boolean')
      )
        fail(id);
    }
  }
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) fail(id);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const upstream of edges.get(id) ?? []) visit(upstream);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of edges.keys()) visit(id);
}
