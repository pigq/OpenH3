---
name: session-message
description: Cross-session messaging - deliver a message to another one of this user's conversations, and reply to one you received.
---

# Cross-Session Message Skill

Deliver a message to another one of this user's conversations with the bundled
agent-facing CLI. Delivering is exactly like the user opening that conversation
and pressing send: the recipient starts a turn and decides for itself whether
to reply.

## Rules

1. Use this ONLY when the user selected a target conversation with `@@`, or
   explicitly asked you to communicate with another conversation. Never deliver
   a message on your own initiative.
2. `to` must be a conversation id. Names are not addresses, and there is no
   broadcast — one `send-message` call reaches exactly one conversation.
3. Never pass, inline, export, echo, or set any `OPENH3_...` environment variable.
4. Commands must directly call `"$OPENH3_HELPER_BIN" session ...` in POSIX shells, or `& $env:OPENH3_HELPER_BIN session ...` in PowerShell. Pass payloads
   through stdin heredocs or the UTF-8 PowerShell pattern below. Do not write payload JSON files to disk.
5. If the current conversation belongs to a team, do NOT use this skill. Use
   `team send-message` instead.
6. On `rate_limited`, STOP delivering and tell the user. It means the two
   conversations are spinning against each other. Do not retry.
7. Word results precisely. `queued` means "delivered; the other side is busy and
   will see it when it frees up" — it does NOT mean "they received it" or "they
   read it". Never claim a message was read.
8. If the CLI fails, report the failure from stderr/stdout in normal prose. Do
   not claim the message was delivered.

## Reading targets from the user's message

When the user typed `@@`, their message carries a block like:

```
[[AION_SESSIONS]]
To deliver to the conversations below, use the session-message skill (address by conversation id); if it is unavailable, run `"$OPENH3_HELPER_BIN" session capabilities` for the delivery contract.
重构-鉴权模块	conv_019f…	workspace: same
文档站改版	conv_01a0…	workspace: /Users/x/docs (differs from yours)
[[/AION_SESSIONS]]
```

The first line is a hint that this skill is how to deliver, with a fallback to
`session capabilities` when the skill is unavailable. Every following line is a
target: `name`, tab, `id`, tab, `workspace:`. Use the **id**.

## Delivering a message

Examples marked `bash` require a POSIX shell. In PowerShell, use `& $env:OPENH3_HELPER_BIN` with the same subcommands; query with `& $env:OPENH3_HELPER_BIN session list`. Reading the helper path for invocation is allowed; never print or change runtime environment values. For JSON stdin on Windows PowerShell 5.1 or PowerShell 7, keep the payload in memory and temporarily use UTF-8 (without a BOM). Do not save a command containing secrets to a script or payload file. The same target-selection and user-authorization rules apply.

```powershell
$openh3Payload = @'
{"to":"conv_019f…","message":"接口定完了吗？请回复第一行。\n再补充进度。"}
'@
$previousOutputEncoding = $OutputEncoding
try {
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $openh3Payload | & $env:OPENH3_HELPER_BIN session send-message
    if ($LASTEXITCODE -ne 0) { throw "OpenH3 helper failed with exit code $LASTEXITCODE" }
} finally { $OutputEncoding = $previousOutputEncoding }
```

Use this stdin pattern for the other JSON commands below, including `diagnose conversations get`.

```bash
"$OPENH3_HELPER_BIN" session send-message <<'JSON'
{
  "to": "conv_019f…",
  "message": "接口定完了吗？"
}
JSON
```

## Replying to a message you received

A delivered message arrives with this block at the top:

```
[[AION_SESSION_MESSAGE]]
from: 重构-鉴权模块	conv_019f…
workspace: same
reply_to: conv_019f…	(reply: session send-message, to=reply_to)
If the session-message skill is unavailable, run `"$OPENH3_HELPER_BIN" session capabilities` for the full delivery contract.
[[/AION_SESSION_MESSAGE]]
```

Reply by sending to `reply_to` with the same command:

```bash
"$OPENH3_HELPER_BIN" session send-message <<'JSON'
{
  "to": "conv_019f…",
  "message": "定完了，已经推到 main。"
}
JSON
```

Replying is optional. Decide for yourself whether a reply is useful — there is
no synchronous wait on the other side.

## Finding a target the user only described in prose

```bash
"$OPENH3_HELPER_BIN" session list
```

Optional stdin filters: `q` (name filter), `project_id`, `limit`, `cursor`.

## Cross-workspace rule

When `workspace` is not `same`, the other conversation runs in a different
directory:

- Do NOT use relative paths — they resolve against the recipient's workspace and
  will silently read a different file, or none.
- Do NOT assume the recipient can read your files. Cross-directory access may be
  blocked by its sandbox or permissions.
- To share file content, put the content itself into `message`.

## Getting more detail about a target conversation

For a target's workspace path, whether it is currently running a turn, or
stuck/waiting hints:

```bash
"$OPENH3_HELPER_BIN" diagnose conversations get <<'JSON'
{ "conversation_id": "conv_019f…" }
JSON
```

## Exact schemas

For enum values, error-code meanings, and full field tables:

```bash
"$OPENH3_HELPER_BIN" session capabilities
```
