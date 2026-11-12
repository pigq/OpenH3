---
name: cron
description: Scheduled task management - create, query, update scheduled tasks to automatically execute operations at specified times.
---

# Scheduled Task Skill

Manage scheduled tasks for the current conversation with the bundled
agent-facing config CLI.

## Rules

1. Each conversation can have at most one scheduled task.
2. Always query existing tasks before creating or updating.
3. Do not ask for extra confirmation after the user has already requested the scheduling change.
4. Never pass, inline, export, echo, or set any `OPENH3_...` environment variable.
5. Commands must directly call `"$OPENH3_HELPER_BIN" config cron current ...` in POSIX shells, or `& $env:OPENH3_HELPER_BIN config cron current ...` in PowerShell.
6. Pass create and update payloads through stdin: a POSIX heredoc or the UTF-8 PowerShell pattern below. Do not write payload JSON files to disk.
7. Put `job_id` in the update JSON payload, not in a command flag.
8. After a successful create or update, send one short final confirmation that a normal user can understand. Include the task name and schedule description. Do not show internal ids such as `cron_...`.
9. If the CLI fails, report the failure from stderr/stdout in normal prose and do not claim the task was created.

## Workflow

Examples marked `bash` require a POSIX shell. In PowerShell, use `& $env:OPENH3_HELPER_BIN` with the same subcommands; query with `& $env:OPENH3_HELPER_BIN config cron current list`. Reading the helper path for invocation is allowed; never print or change runtime environment values. For JSON stdin on Windows PowerShell 5.1 or PowerShell 7, keep the payload in memory and temporarily use UTF-8 (without a BOM). Do not save a command containing secrets to a script or payload file.

```powershell
$openh3Payload = @'
{"name":"喝水提醒","schedule":"0 9 * * *","schedule_description":"每天 9:00","message":"回复：记得喝水。"}
'@
$previousOutputEncoding = $OutputEncoding
try {
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $openh3Payload | & $env:OPENH3_HELPER_BIN config cron current create
    if ($LASTEXITCODE -ne 0) { throw "OpenH3 helper failed with exit code $LASTEXITCODE" }
} finally { $OutputEncoding = $previousOutputEncoding }
```

Apply the same stdin pattern to `update`, using the returned `job_id`. Run it only after the query and authorization rules above are satisfied.

1. Run `"$OPENH3_HELPER_BIN" config cron current list`.
2. If the returned `data` array is empty, create the task with `"$OPENH3_HELPER_BIN" config cron current create <<'JSON'`.
3. If one task exists and the user wants to change it, update that task with `"$OPENH3_HELPER_BIN" config cron current update <<'JSON'`.
4. If a task already exists and the user is asking for a different additional task, ask how they want to handle the existing task.
5. Report success or failure from the CLI output in normal prose, following the final confirmation rule above.

## Payload

Create payload:

- `name`: Short descriptive name.
- `schedule`: Standard 5-field cron expression.
- `schedule_description`: Human-readable schedule.
- `message`: Complete, self-contained instruction sent to the AI when the task runs.

Update payload uses the same fields and also requires:

- `job_id`: The id from the existing task returned by the list command.

The `message` must tell the AI exactly what to do when the task fires. It should
not merely restate the user's scheduling request.

| User says                         | Bad message              | Good message                                                                                 |
| --------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------- |
| "Send me hello every day at 10am" | Send me hello            | Reply with exactly: Hello!                                                                   |
| "Remind me to drink water daily"  | Remind me to drink water | Reply with a friendly reminder to drink water.                                               |
| "Summarize AI news every Monday"  | Summarize AI news        | Search for the latest AI news from this week and produce a concise bullet-point summary.     |

## Examples

Examples use English sample text. For real tasks, write the task name,
schedule description, and message in the user's language.

Query:

```bash
"$OPENH3_HELPER_BIN" config cron current list
```

Create:

```bash
"$OPENH3_HELPER_BIN" config cron current create <<'JSON'
{
  "name": "Weekly Meeting Reminder",
  "schedule": "0 9 * * MON",
  "schedule_description": "Every Monday at 9:00 AM",
  "message": "Reply with a short weekly meeting reminder that includes the current date and time."
}
JSON
```

Update:

```bash
"$OPENH3_HELPER_BIN" config cron current update <<'JSON'
{
  "job_id": "cron_123",
  "name": "Daily Summary",
  "schedule": "0 18 * * MON-FRI",
  "schedule_description": "Weekdays at 6:00 PM",
  "message": "Review today's conversation context and produce a concise end-of-day summary."
}
JSON
```

Multiline message example:

```json
{
  "name": "Daily Summary",
  "schedule": "0 9 * * *",
  "schedule_description": "Every day at 9:00 AM",
  "message": "First paragraph.\nSecond paragraph.\nThird paragraph."
}
```

## Cron Expression

Format: `minute hour day-of-month month day-of-week`.

Example: `0 9 * * MON-FRI` means weekdays at 9:00 AM.

Use only standard cron fields and ranges supported by the backend parser. Do
not use Quartz-style extensions such as `L`, `L-N`, `W`, `LW`, `#`, or `?`.
