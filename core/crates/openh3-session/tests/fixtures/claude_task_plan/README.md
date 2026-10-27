# Claude task-plan capture

`2.1.307.ndjson` contains tool-call/result frames recorded from the installed
Claude Code **2.1.307** on 2026-10-27. It is a real capture, not a mock.
Only tool content, role, parent attribution and structured tool results are
retained; session IDs, paths, usage, signatures and unrelated frames are omitted.

The controlled print-mode request exposed only `TaskCreate,TaskUpdate,TaskList`,
allowed those tools, disabled skills/hooks and MCP configuration, and requested
two tasks, then a pending → in_progress → completed transition for the first.
`--no-session-persistence --output-format stream-json --verbose` were enabled.
No filesystem, shell or messaging tools were exposed. The call ran outside the
repository. Both creates and both updates succeeded. The provider rejected a
later request before TaskList ran, so this capture proves no TaskList behavior.

The observed top-level `tool_use_result` agrees with the first-party
`@anthropic-ai/claude-agent-sdk` **0.2.141** `sdk-tools.d.ts` interfaces
`TaskCreateInput`, `TaskUpdateInput`, `TaskCreateOutput`, `TaskUpdateOutput`,
and the `SDKUserMessage.tool_use_result` field in `sdk.d.ts`.
Each captured user frame contains exactly one tool-result block, whose
`tool_use_id` links the structured result to its request. Ambiguous multi-result
frames are deliberately not projected.

Tests derive fault/replay/parent-attribution variants from this fixture to test
OpenH3's defensive policy; those variants are not claims of captured CLI output.
