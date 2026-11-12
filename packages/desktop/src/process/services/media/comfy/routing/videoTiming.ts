import fs from 'node:fs';
import type { ComfyProfile } from '@/common/chat/document/creation/comfy';
import type { ComfyGraph } from '@/process/services/runtime/h3WorkflowPreflight';

/** Read the pinned graph's supported seconds-to-frame transform; never execute graph expressions. */
export function graphAlignedVideoDuration(profile: ComfyProfile, seconds: number): number | undefined {
  const bindings = profile.bindings.durationSeconds;
  if (bindings?.length !== 1 || !fs.existsSync(profile.workflowPath)) return undefined;
  const graph = JSON.parse(fs.readFileSync(profile.workflowPath, 'utf8')) as ComfyGraph;
  const binding = bindings[0];
  if (graph[binding.nodeId]?.class_type !== 'PrimitiveFloat' || binding.input !== 'value') return undefined;
  const aligned: number[] = [];
  for (const [id, node] of Object.entries(graph)) {
    if (node.class_type !== 'ComfyMathExpression' || typeof node.inputs.expression !== 'string') continue;
    const source = node.inputs['values.a'];
    if (!Array.isArray(source) || source[0] !== binding.nodeId || source[1] !== 0) continue;
    // Round to frame count, then align to the graph's declared offset and multiple.
    const match = /^max\((\d+),round\(a\*(\d+)\)\)\+\((\d+)-\(max\((\d+),round\(a\*(\d+)\)\)%(\d+)\)\)%(\d+)$/.exec(
      node.inputs.expression.replace(/\s/g, '')
    );
    if (!match) continue;
    const [minimum, fps, offset, repeatedMinimum, repeatedFps, multiple, repeatedMultiple] = match.slice(1).map(Number);
    if (
      minimum !== repeatedMinimum ||
      fps !== repeatedFps ||
      multiple !== repeatedMultiple ||
      fps <= 0 ||
      multiple <= 0 ||
      offset >= multiple
    )
      continue;
    const consumers = Object.values(graph).filter(
      (item) => Array.isArray(item.inputs.length) && item.inputs.length[0] === id && item.inputs.length[1] === 1
    );
    const outputs = Object.values(graph).filter((item) => item.class_type === 'CreateVideo');
    if (!consumers.length || !outputs.length || outputs.some((output) => output.inputs.fps !== fps)) continue;
    const frames = Math.max(minimum, Math.round(seconds * fps));
    aligned.push((frames + ((((offset - (frames % multiple)) % multiple) + multiple) % multiple)) / fps);
  }
  return aligned.length === 1 ? aligned[0] : undefined;
}
