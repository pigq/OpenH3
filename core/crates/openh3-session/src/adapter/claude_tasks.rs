//! Project confirmed Claude task mutations into the backend-neutral plan.
//!
//! Verified: tests/fixtures/claude_task_plan/2.1.307.ndjson and its README's
//! first-party SDK schema references. Raw tool calls/results remain untouched.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::event::{PlanEntry, PlanStatus};

#[derive(Default)]
pub(super) struct TaskPlan {
    tasks: Vec<Task>,
    pending: HashMap<String, Mutation>,
    // Call IDs identify operations, not tasks. Retain across turns so a replay
    // of an earlier in_progress result cannot rewind a now-completed task.
    seen_calls: HashSet<String>,
}

struct Task {
    id: String,
    entry: PlanEntry,
}

enum Mutation {
    Create,
    Update {
        task_id: String,
        subject: Option<String>,
        status: Option<String>,
    },
}

impl TaskPlan {
    pub(super) fn record_call(&mut self, call_id: &str, name: &str, input: &Value, parent: Option<&str>) {
        if parent.is_some() || call_id.is_empty() || self.seen_calls.contains(call_id) {
            return;
        }
        let mutation = match name {
            "TaskCreate" => Mutation::Create,
            "TaskUpdate" => {
                let Some(task_id) = nonempty_string(input.get("taskId")) else {
                    return;
                };
                Mutation::Update {
                    task_id: task_id.to_string(),
                    subject: nonempty_string(input.get("subject")).map(str::to_string),
                    status: input.get("status").and_then(Value::as_str).map(str::to_string),
                }
            }
            _ => return,
        };
        self.seen_calls.insert(call_id.to_string());
        self.pending.insert(call_id.to_string(), mutation);
    }

    pub(super) fn complete_call(
        &mut self,
        call_id: &str,
        output: Option<&Value>,
        is_error: bool,
        parent: Option<&str>,
    ) -> Option<Vec<PlanEntry>> {
        if parent.is_some() {
            return None;
        }
        let mutation = self.pending.remove(call_id)?;
        if is_error {
            return None;
        }
        let output = output?;
        let before = self.snapshot();
        match mutation {
            Mutation::Create => {
                let task = output.get("task")?;
                let id = nonempty_string(task.get("id"))?;
                let subject = nonempty_string(task.get("subject"))?;
                if self.tasks.iter().any(|task| task.id == id) {
                    return None;
                }
                self.tasks.push(Task {
                    id: id.to_string(),
                    entry: PlanEntry {
                        content: subject.to_string(),
                        // The captured first update confirms from:"pending".
                        status: PlanStatus::Pending,
                        priority: None,
                    },
                });
            }
            Mutation::Update {
                task_id,
                subject,
                status,
            } => {
                if output.get("success").and_then(Value::as_bool) != Some(true)
                    || output.get("taskId").and_then(Value::as_str) != Some(task_id.as_str())
                {
                    return None;
                }
                let updated = output.get("updatedFields").and_then(Value::as_array)?;
                let changed = |field| updated.iter().any(|value| value.as_str() == Some(field));
                let index = self.tasks.iter().position(|task| task.id == task_id)?;
                if changed("status") {
                    let status = status.as_deref()?;
                    // A supplied statusChange must agree with the requested
                    // mutation. Do not project a contradictory/unknown result.
                    if let Some(actual) = output.get("statusChange").and_then(|change| change.get("to"))
                        && actual.as_str() != Some(status)
                    {
                        return None;
                    }
                    if status == "deleted" {
                        self.tasks.remove(index);
                        return Some(self.snapshot());
                    }
                    self.tasks[index].entry.status = match status {
                        "pending" => PlanStatus::Pending,
                        "in_progress" => PlanStatus::InProgress,
                        "completed" => PlanStatus::Completed,
                        _ => return None,
                    };
                }
                if changed("subject")
                    && let Some(subject) = subject
                {
                    self.tasks[index].entry.content = subject;
                }
            }
        }
        let after = self.snapshot();
        (before != after).then_some(after)
    }

    pub(super) fn finish_turn(&mut self) {
        // Failed/interrupted calls must never acquire success from a late result.
        // Keep confirmed tasks and replay guards for subsequent turns.
        self.pending.clear();
    }

    fn snapshot(&self) -> Vec<PlanEntry> {
        self.tasks.iter().map(|task| task.entry.clone()).collect()
    }
}

fn nonempty_string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|value| !value.trim().is_empty())
}
