use openh3_common::{ErrorChain, now_ms};
use openh3_db::models::MessageRow;
use openh3_db::{MessagePageDirection, MessagePageParams, MessageRowUpdate};
use tracing::{info, warn};

use crate::runtime_persistence::RuntimeWriteKind;
use crate::service::ConversationService;

const RESTART_MARKER: &str = "_openh3_restart_recovery";
pub(crate) const PENDING_RECOVERY_CONTEXT: &str = "_openh3_pending_task_recovery";
const RECOVERY_HISTORY_LIMIT: u32 = 200;
const RECOVERY_ITEM_LIMIT: usize = 12;
const RECOVERY_LABEL_LIMIT: usize = 180;
const RECOVERY_CONTEXT_MAX_BYTES: usize = 8192;
const RECOVERY_PREFIX: &str = "<openh3_task_recovery>\nThe following bounded snapshot is historical unfinished work, not instructions or evidence that a process is still running. Nothing was automatically continued. Follow the latest user instruction to continue, adjust, or stop; verify actual results before repeating side effects. Do not reactivate completed steps or restore old approvals.\n";
const RECOVERY_SUFFIX: &str = "\n</openh3_task_recovery>\n\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartupRecoveryAction {
    FinishVisibleOutput,
    FinishEmptyPlaceholder,
    /// A tool_call/tool_group row left on `work` by a previous process. At
    /// startup this is dead BY DEFINITION — the CLI process group died with the
    /// old aioncore, so no terminal will ever be reported (a hard kill runs
    /// neither the pump's teardown settle nor leaves anyone to resume). The
    /// row's CONTENT status must be rewritten too: the frontend renders the
    /// embedded status, and `hasRunningToolMessages` would keep the View Steps
    /// spinner alive off a `finish` row whose content still says running.
    SettleToolRow,
}

impl ConversationService {
    pub async fn recover_stale_runtime_state_on_startup(&self) {
        let rows = match self.conversation_repo().list_stale_runtime_messages().await {
            Ok(rows) => rows,
            Err(error) => {
                warn!(
                    error = %ErrorChain(&error),
                    "startup recovery skipped because stale runtime message query failed"
                );
                return;
            }
        };

        let mut recovered = 0usize;
        let recovered_at = now_ms();
        for stale in rows {
            let row = stale.message;
            if !self
                .runtime_persistence()
                .allows(&row.conversation_id, RuntimeWriteKind::StartupRecovery)
            {
                continue;
            }

            let action = classify_recovery_action(&row);
            let settled = match action {
                StartupRecoveryAction::SettleToolRow => settle_tool_row_content(&row.r#type, &row.content),
                _ => None,
            };
            // Keep interruption provenance after settling the UI. This is
            // history metadata, never executable replay data; the next ordinary
            // user input can use it even after another process restart.
            let content = mark_restart_recovery(&row, settled.as_deref(), recovered_at).or(settled);
            let update = MessageRowUpdate {
                content,
                status: Some(Some("finish".to_owned())),
                hidden: Some(matches!(action, StartupRecoveryAction::FinishEmptyPlaceholder)),
            };

            match self
                .conversation_repo()
                .update_message(&stale.user_id, &row.conversation_id, &row.id, &update)
                .await
            {
                Ok(()) => {
                    recovered += 1;
                    info!(
                        conversation_id = %row.conversation_id,
                        msg_id = ?row.msg_id,
                        message_type = %row.r#type,
                        recovery_action = ?action,
                        "startup recovery closed stale runtime message"
                    );
                }
                Err(error) => {
                    warn!(
                        conversation_id = %row.conversation_id,
                        msg_id = ?row.msg_id,
                        error = %ErrorChain(&error),
                        "startup recovery failed to close stale runtime message"
                    );
                }
            }
        }

        if recovered > 0 {
            info!(recovered, "startup recovery completed for stale runtime messages");
        }
    }

    /// Read-only recovery context for an ordinary user turn. Startup itself
    /// never schedules an agent or replays a persisted tool call.
    pub(crate) async fn unfinished_task_context_on_next_input(
        &self,
        user_id: &str,
        conversation_id: &str,
    ) -> Option<String> {
        let history = match self
            .conversation_repo()
            .list_messages_page(
                user_id,
                conversation_id,
                &MessagePageParams {
                    limit: RECOVERY_HISTORY_LIMIT,
                    direction: MessagePageDirection::InitialLatest,
                },
            )
            .await
        {
            Ok(page) => page.items,
            Err(error) => {
                warn!(conversation_id, error = %ErrorChain(&error), "unfinished task recovery context could not be read");
                return None;
            }
        };
        let context = build_unfinished_task_context(&history);
        if context.is_some() {
            info!(
                conversation_id,
                "unfinished task context attached to next user input without replay"
            );
        }
        context
    }

    /// Consume the pending hint only after a successful user turn. A cold
    /// build/send failure must leave the snapshot available for the next input.
    pub(crate) async fn acknowledge_task_recovery(&self, user_id: &str, conversation_id: &str, user_message_id: &str) {
        if !self
            .runtime_persistence()
            .allows(conversation_id, RuntimeWriteKind::TerminalFinalize)
        {
            return;
        }
        let result = async {
            let Some(row) = self
                .conversation_repo()
                .get_message(user_id, conversation_id, user_message_id)
                .await?
            else {
                return Ok::<(), openh3_db::DbError>(());
            };
            let Ok(mut content) = serde_json::from_str::<serde_json::Value>(&row.content) else {
                return Ok(());
            };
            if row.position.as_deref() != Some("right")
                || content
                    .as_object_mut()
                    .and_then(|object| object.remove(PENDING_RECOVERY_CONTEXT))
                    .is_none()
            {
                return Ok(());
            }
            self.conversation_repo()
                .update_message(
                    user_id,
                    conversation_id,
                    user_message_id,
                    &MessageRowUpdate {
                        content: Some(content.to_string()),
                        status: None,
                        hidden: None,
                    },
                )
                .await
        }
        .await;
        if let Err(error) = result {
            warn!(conversation_id, error = %ErrorChain(&error), "successful turn could not acknowledge its recovery hint");
        }
    }
}

fn mark_restart_recovery(row: &MessageRow, settled: Option<&str>, at_ms: i64) -> Option<String> {
    let original = serde_json::from_str::<serde_json::Value>(&row.content).ok();
    let mut value = serde_json::from_str::<serde_json::Value>(settled.unwrap_or(&row.content)).ok()?;
    let marker = serde_json::json!({ "at_ms": at_ms });
    match row.r#type.as_str() {
        "tool_group" => {
            let entries = value.as_array_mut()?;
            for (index, entry) in entries.iter_mut().enumerate() {
                let prior = original.as_ref()?.get(index)?;
                if !is_terminal_group_entry(prior)
                    && let Some(obj) = entry.as_object_mut()
                {
                    obj.insert(RESTART_MARKER.into(), marker.clone());
                }
            }
        }
        "tool_call" if original.as_ref().is_some_and(is_terminal_tool_call) => return settled.map(str::to_owned),
        _ => {
            value.as_object_mut()?.insert(RESTART_MARKER.into(), marker);
        }
    }
    Some(value.to_string())
}

fn is_terminal_tool_call(value: &serde_json::Value) -> bool {
    matches!(
        value.get("status").and_then(|status| status.as_str()),
        Some("completed" | "error" | "canceled")
    )
}

fn is_terminal_group_entry(value: &serde_json::Value) -> bool {
    matches!(
        value.get("status").and_then(|status| status.as_str()),
        Some("Success" | "Error" | "Canceled")
    )
}

fn restart_at(value: &serde_json::Value) -> Option<i64> {
    value.get(RESTART_MARKER)?.get("at_ms")?.as_i64()
}

fn bounded_label(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .chars()
        .take(RECOVERY_LABEL_LIMIT)
        .collect()
}

/// Summarize only snapshots: no raw arguments, commands, output, or approval
/// state is restored. A later successful user turn consumes its hint, preserving
/// the original Plan and allowing the user to stop or replace the old work.
fn build_unfinished_task_context(history: &[MessageRow]) -> Option<String> {
    let decoded: Vec<_> = history
        .iter()
        .filter(|row| row.position.as_deref() == Some("left"))
        .filter_map(|row| {
            serde_json::from_str::<serde_json::Value>(&row.content)
                .ok()
                .map(|value| (row, value))
        })
        .collect();
    let latest_restart = decoded
        .iter()
        .filter_map(|(_, value)| restart_at(value).or_else(|| value.as_array()?.iter().filter_map(restart_at).max()))
        .max();
    let last_user_at = history
        .iter()
        .filter(|row| row.position.as_deref() == Some("right"))
        .map(|row| row.created_at)
        .max()
        .unwrap_or(i64::MIN);
    let pending_restart = latest_restart.filter(|at| *at > last_user_at);
    // A plan-only turn can persist a snapshot before any streaming text/tool
    // row exists. Recover that unfinished checklist too, without inventing a
    // running process or needing to change the historical Plan's status.
    let latest_plan = decoded
        .iter()
        .rev()
        .find(|(row, _)| row.r#type == "plan" && row.created_at > last_user_at);
    if latest_plan.is_none()
        && pending_restart.is_none()
        && let Some(last_user) = history
            .iter()
            .rev()
            .find(|row| row.position.as_deref() == Some("right"))
        && let Ok(content) = serde_json::from_str::<serde_json::Value>(&last_user.content)
        && let Some(pending) = content.get(PENDING_RECOVERY_CONTEXT).and_then(|value| value.as_str())
        && pending.len() <= RECOVERY_CONTEXT_MAX_BYTES
        && pending.starts_with(RECOVERY_PREFIX)
    {
        return Some(pending.to_owned());
    }
    let mut plan = Vec::new();
    let mut completed_steps = 0;
    let mut truncated = false;
    if let Some((_, snapshot)) = latest_plan
        && let Some(entries) = snapshot.get("entries").and_then(|entries| entries.as_array())
    {
        for entry in entries {
            match entry.get("status").and_then(|status| status.as_str()) {
                Some("completed") => completed_steps += 1,
                Some("pending" | "in_progress") if plan.len() < RECOVERY_ITEM_LIMIT => plan.push(serde_json::json!({
                    "content": bounded_label(entry.get("content").or_else(|| entry.get("step"))),
                    "status": entry["status"],
                })),
                Some("pending" | "in_progress") => truncated = true,
                _ => {}
            }
        }
    }
    let mut tools = Vec::new();
    for (row, value) in &decoded {
        let entries: &[serde_json::Value] = if row.r#type == "tool_group" {
            value.as_array().map(Vec::as_slice).unwrap_or_default()
        } else if row.r#type == "tool_call" {
            std::slice::from_ref(value)
        } else {
            continue;
        };
        for entry in entries {
            if pending_restart.is_some() && restart_at(entry) == pending_restart && tools.len() < RECOVERY_ITEM_LIMIT {
                tools.push(serde_json::json!({
                    "call_id": bounded_label(entry.get("call_id")),
                    "name": bounded_label(entry.get("name")),
                    "description": bounded_label(entry.get("description")),
                    "status": "interrupted_on_restart",
                }));
            } else if pending_restart.is_some() && restart_at(entry) == pending_restart {
                truncated = true;
            }
        }
    }
    if plan.is_empty() && tools.is_empty() && (latest_plan.is_some() || pending_restart.is_none()) {
        return None;
    }
    loop {
        let snapshot = serde_json::json!({ "unfinished_plan": plan, "completed_steps": completed_steps, "interrupted_tasks": tools, "truncated": truncated }).to_string();
        if RECOVERY_PREFIX.len() + snapshot.len() + RECOVERY_SUFFIX.len() <= RECOVERY_CONTEXT_MAX_BYTES {
            return Some(format!("{RECOVERY_PREFIX}{snapshot}{RECOVERY_SUFFIX}"));
        }
        truncated = true;
        if tools.len() > plan.len() {
            tools.pop();
        } else {
            plan.pop();
        }
    }
}

fn classify_recovery_action(row: &MessageRow) -> StartupRecoveryAction {
    if matches!(row.r#type.as_str(), "tool_call" | "tool_group") {
        return StartupRecoveryAction::SettleToolRow;
    }
    if message_has_visible_content(row) {
        StartupRecoveryAction::FinishVisibleOutput
    } else {
        StartupRecoveryAction::FinishEmptyPlaceholder
    }
}

/// Rewrite a stale tool row's embedded status to its terminal form. Returns
/// `None` when the content needs no change (already terminal, or unparsable —
/// the row-level `finish` still applies either way).
///
/// The two channels speak different status vocabularies (see `ToolGroupStatus`):
/// `tool_call` content is snake_case, `tool_group` entries are PascalCase.
fn settle_tool_row_content(row_type: &str, content: &str) -> Option<String> {
    let mut value: serde_json::Value = serde_json::from_str(content).ok()?;
    match row_type {
        "tool_call" => {
            let stale = value
                .get("status")
                .and_then(|s| s.as_str())
                .is_none_or(|s| !matches!(s, "completed" | "error" | "canceled"));
            if !stale {
                return None;
            }
            value["status"] = serde_json::Value::String("canceled".into());
            Some(value.to_string())
        }
        "tool_group" => {
            let entries = value.as_array_mut()?;
            let mut changed = false;
            for entry in entries {
                let stale = entry
                    .get("status")
                    .and_then(|s| s.as_str())
                    .is_none_or(|s| !matches!(s, "Success" | "Error" | "Canceled"));
                if stale {
                    entry["status"] = serde_json::Value::String("Canceled".into());
                    changed = true;
                }
            }
            changed.then(|| value.to_string())
        }
        _ => None,
    }
}

fn message_has_visible_content(row: &MessageRow) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&row.content) else {
        return !row.content.trim().is_empty();
    };

    value
        .get("content")
        .and_then(|content| content.as_str())
        .is_some_and(|content| !content.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use openh3_db::models::MessageRow;

    use super::*;

    #[test]
    fn completed_plan_supersedes_an_older_unacknowledged_hint() {
        let mut plan = MessageRow {
            id: "plan:p".into(),
            conversation_id: "c".into(),
            msg_id: Some("p".into()),
            r#type: "plan".into(),
            content: serde_json::json!({ "entries": [{ "content": "old pending step", "status": "pending" }] })
                .to_string(),
            position: Some("left".into()),
            status: Some("finish".into()),
            hidden: false,
            created_at: 1,
            backend_turn_id: None,
        };
        let hint = build_unfinished_task_context(&[plan.clone()]).unwrap();
        let mut user = plan.clone();
        user.id = "u".into();
        user.r#type = "text".into();
        user.position = Some("right".into());
        user.created_at = 2;
        user.content = serde_json::json!({ "content": "continue", PENDING_RECOVERY_CONTEXT: hint }).to_string();
        assert!(
            build_unfinished_task_context(&[plan.clone(), user.clone()]).is_some(),
            "failed delivery keeps the pending hint"
        );
        plan.created_at = 3;
        plan.content =
            serde_json::json!({ "entries": [{ "content": "old pending step", "status": "completed" }] }).to_string();
        assert!(
            build_unfinished_task_context(&[user, plan]).is_none(),
            "a newer completed snapshot must not restore the obsolete pending task"
        );
    }

    #[test]
    fn recovery_context_is_bounded_with_unicode_and_large_rosters() {
        let huge_label = "任务\\\"".repeat(200);
        let row = |id: &str, ty: &str, content: serde_json::Value, created_at| MessageRow {
            id: id.into(),
            conversation_id: "c".into(),
            msg_id: Some(id.into()),
            r#type: ty.into(),
            content: content.to_string(),
            position: Some("left".into()),
            status: Some("finish".into()),
            hidden: false,
            created_at,
            backend_turn_id: None,
        };
        let history = vec![
            row("plan:p", "plan", serde_json::json!({ "entries": (0..100).map(|_| serde_json::json!({"content": huge_label, "status": "pending"})).collect::<Vec<_>>() }), 1),
            row("p", "tool_group", serde_json::json!((0..100).map(|_| serde_json::json!({"call_id": huge_label, "name": huge_label, "description": huge_label, "status": "Canceled", RESTART_MARKER: { "at_ms": 10 }})).collect::<Vec<_>>()), 2),
        ];
        let context = build_unfinished_task_context(&history).unwrap();
        assert!(context.len() <= 8192, "context grew to {} bytes", context.len());
        let json = context.lines().find(|line| line.starts_with('{')).unwrap();
        let value: serde_json::Value = serde_json::from_str(json).expect("bound must preserve valid JSON and UTF-8");
        assert_eq!(value["truncated"], true);
    }

    #[test]
    fn visible_text_finishes_as_visible_output() {
        let row = MessageRow {
            id: "msg-1".into(),
            conversation_id: "conv-1".into(),
            msg_id: Some("msg-1".into()),
            r#type: "text".into(),
            content: serde_json::json!({ "content": "hello" }).to_string(),
            position: Some("left".into()),
            status: Some("work".into()),
            hidden: false,
            created_at: 1,
            backend_turn_id: None,
        };

        assert_eq!(
            classify_recovery_action(&row),
            StartupRecoveryAction::FinishVisibleOutput
        );
    }

    #[test]
    fn stale_tool_rows_classify_as_settle() {
        for ty in ["tool_call", "tool_group"] {
            let row = MessageRow {
                id: "m".into(),
                conversation_id: "c".into(),
                msg_id: Some("m".into()),
                r#type: ty.into(),
                content: "{}".into(),
                position: Some("left".into()),
                status: Some("work".into()),
                hidden: false,
                created_at: 1,
                backend_turn_id: None,
            };
            assert_eq!(classify_recovery_action(&row), StartupRecoveryAction::SettleToolRow);
        }
    }

    /// The hard-kill residue (audit 2026-08-04): rows whose CONTENT still says
    /// running must be rewritten — the frontend renders the embedded status, so
    /// a row-level `finish` alone leaves the View Steps spinner alive.
    #[test]
    fn settle_rewrites_running_content_and_leaves_terminal_content_alone() {
        // tool_call: snake_case vocabulary.
        let card = serde_json::json!({"call_id": "t1", "name": "Bash", "status": "running"}).to_string();
        let out = settle_tool_row_content("tool_call", &card).expect("running → rewritten");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["status"], "canceled");
        assert_eq!(v["name"], "Bash", "only the status changes");

        let done = serde_json::json!({"call_id": "t1", "status": "completed"}).to_string();
        assert!(
            settle_tool_row_content("tool_call", &done).is_none(),
            "terminal content is left untouched"
        );

        // tool_group: PascalCase vocabulary, per entry.
        let group = serde_json::json!([
            {"call_id": "a", "name": "run:A", "status": "Executing"},
            {"call_id": "b", "name": "run:B", "status": "Success"}
        ])
        .to_string();
        let out = settle_tool_row_content("tool_group", &group).expect("one executing entry");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v[0]["status"], "Canceled");
        assert_eq!(v[1]["status"], "Success", "terminal entries keep their outcome");

        let all_done = serde_json::json!([{"call_id": "a", "status": "Success"}]).to_string();
        assert!(settle_tool_row_content("tool_group", &all_done).is_none());
    }

    #[test]
    fn empty_text_finishes_as_hidden_placeholder() {
        let row = MessageRow {
            id: "msg-1".into(),
            conversation_id: "conv-1".into(),
            msg_id: Some("msg-1".into()),
            r#type: "text".into(),
            content: serde_json::json!({ "content": "" }).to_string(),
            position: Some("left".into()),
            status: Some("work".into()),
            hidden: false,
            created_at: 1,
            backend_turn_id: None,
        };

        assert_eq!(
            classify_recovery_action(&row),
            StartupRecoveryAction::FinishEmptyPlaceholder
        );
    }
}
