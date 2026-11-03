import { creationOperationIds } from '@/common/chat/document/creation/toolResults';

/** Place one installation card after the assistant turn that created it. */
export function creationTurnResults(
  items: Array<{ id: string; type: string; position?: string; messages?: Array<{ type: string; content: unknown }> }>,
  extractIds = creationOperationIds
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const seen = new Set<string>();
  let ids: string[] = [];
  let anchor: string | undefined;
  const flush = () => {
    if (anchor && ids.length) groups.set(anchor, ids);
    ids = [];
    anchor = undefined;
  };
  for (const item of items) {
    if (item.position === 'right') {
      flush();
      continue;
    }
    anchor = item.id;
    for (const id of extractIds(item.messages ?? []))
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
  }
  flush();
  return groups;
}
