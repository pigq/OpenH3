/** Read JSON tool payloads from both native and ACP tool transports. */
export function toolResultRecords(message: { type: string; content: unknown }): Record<string, unknown>[] {
  if (!['tool_call', 'acp_tool_call', 'tool_group'].includes(message.type)) return [];
  const records: Record<string, unknown>[] = [];
  let remaining = 1000;
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 10 || --remaining < 0) return;
    if (typeof value === 'string') {
      if (value.length > 1_000_000) return;
      try {
        visit(JSON.parse(value), depth + 1);
      } catch {
        /* Incomplete and plain-text outputs have no payload. */
      }
    } else if (Array.isArray(value)) value.forEach((item) => visit(item, depth + 1));
    else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      records.push(record);
      for (const [key, child] of Object.entries(record))
        if (!['args', 'input', 'raw_input', 'rawInput'].includes(key)) visit(child, depth + 1);
    }
  };
  visit(message.content);
  return records;
}

export function creationOperationIds(messages: Array<{ type: string; content: unknown }>): string[] {
  return [
    ...new Set(
      messages
        .flatMap(toolResultRecords)
        .map((record) => record.creationOperationId)
        .filter(
          (id): id is string =>
            typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
        )
    ),
  ];
}

/** Extract submitted H3 jobs from MCP/native/ACP results, never from tool arguments. */
export function h3ToolJobIds(messages: Array<{ type: string; content: unknown }>): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    const native = message.type === 'tool_call';
    const content = message.content as { name?: unknown; output?: unknown } | null;
    if (
      native &&
      (typeof content?.name !== 'string' ||
        !['openh3_h3_generate_video', 'openh3_h3_job_status'].includes(content.name.replace(/^aionui_/, 'openh3_')))
    )
      continue;
    const outputs = toolResultRecords(native ? { type: 'tool_call', content: content?.output } : message);
    for (const output of outputs) {
      if (
        typeof output.id === 'string' &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(output.id) &&
        (native ||
          (output.spec &&
            ['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(output.status)) &&
            Array.isArray(output.artifacts)))
      )
        ids.add(output.id);
    }
  }
  return [...ids];
}
