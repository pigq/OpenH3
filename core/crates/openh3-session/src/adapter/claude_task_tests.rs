//! Task-plan projection checks against a real Claude Code 2.1.307 capture.

use super::*;
use crate::event::{PlanEntry, PlanStatus};

fn capture() -> Vec<Value> {
    include_str!("../../tests/fixtures/claude_task_plan/2.1.307.ndjson")
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn plans(events: &[SessionEvent]) -> Vec<Vec<PlanEntry>> {
    events
        .iter()
        .filter_map(|event| match event {
            SessionEvent::Plan { entries, .. } => Some(entries.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn captured_task_lifecycle_projects_confirmed_plan_and_keeps_raw_cards() {
    let mut adapter = ClaudeAdapter::new();
    let frames = capture();
    let mut events = Vec::new();
    for frame in &frames {
        let next = adapter.parse_value(frame);
        if frame["type"] == "assistant" {
            assert!(plans(&next).is_empty(), "a request is not a confirmed mutation");
        }
        events.extend(next);
    }
    let snapshots = plans(&events);
    assert_eq!(snapshots.len(), 4);
    assert_eq!(snapshots[0][0].content, "Protocol capture alpha");
    assert_eq!(snapshots[0][0].status, PlanStatus::Pending);
    assert_eq!(snapshots[1][1].content, "Protocol capture beta");
    assert_eq!(snapshots[2][0].status, PlanStatus::InProgress);
    assert_eq!(snapshots[3][0].status, PlanStatus::Completed);
    assert_eq!(snapshots[3][1].status, PlanStatus::Pending);
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, SessionEvent::ToolCall { .. }))
            .count(),
        4,
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, SessionEvent::ToolResult { .. }))
            .count(),
        4,
    );
}

#[test]
fn task_plan_uses_real_id_not_creation_order_and_survives_turn_boundary() {
    let mut adapter = ClaudeAdapter::new();
    let mut frames = capture();
    // A response may return a non-sequential ID. The update must bind that ID,
    // rather than assigning IDs from the order in which requests were observed.
    frames[2]["tool_use_result"]["task"]["id"] = json!("actual-id-42");
    frames[4]["message"]["content"][0]["input"]["taskId"] = json!("actual-id-42");
    frames[5]["tool_use_result"]["taskId"] = json!("actual-id-42");
    frames[6]["message"]["content"][0]["input"]["taskId"] = json!("actual-id-42");
    frames[7]["tool_use_result"]["taskId"] = json!("actual-id-42");
    for frame in &frames[..4] {
        adapter.parse_value(frame);
    }
    adapter.parse_value(&json!({"type":"result","is_error":false,"result":"turn one"}));
    let events: Vec<_> = frames[4..]
        .iter()
        .flat_map(|frame| adapter.parse_value(frame))
        .collect();
    let snapshots = plans(&events);
    assert_eq!(snapshots.len(), 2);
    assert_eq!(snapshots[1][0].content, "Protocol capture alpha");
    assert_eq!(snapshots[1][0].status, PlanStatus::Completed);
    assert_eq!(snapshots[1][1].status, PlanStatus::Pending);
}

#[test]
fn failed_mismatched_or_ambiguous_task_results_do_not_mutate_plan() {
    let frames = capture();
    for variant in 0..7 {
        let mut adapter = ClaudeAdapter::new();
        for frame in &frames[..4] {
            adapter.parse_value(frame);
        }
        adapter.parse_value(&frames[4]);
        let mut response = frames[5].clone();
        match variant {
            0 => response["message"]["content"][0]["is_error"] = json!(true),
            1 => response["tool_use_result"]["success"] = json!(false),
            2 => response["tool_use_result"]["taskId"] = json!("different-task"),
            3 => response["tool_use_result"] = Value::Null,
            4 => {
                let second = response["message"]["content"][0].clone();
                response["message"]["content"].as_array_mut().unwrap().push(second);
            }
            5 => response["tool_use_result"]["statusChange"]["to"] = json!("completed"),
            6 => response["tool_use_result"]["updatedFields"] = json!(["metadata"]),
            _ => unreachable!(),
        }
        let events = adapter.parse_value(&response);
        assert!(plans(&events).is_empty(), "variant {variant} must not change the plan");
        assert!(events.iter().any(|e| matches!(e, SessionEvent::ToolResult { .. })));
        // A failed result consumes its pending call: a later replay cannot turn
        // the same call into a successful mutation.
        assert!(plans(&adapter.parse_value(&frames[5])).is_empty());
        let mut create = frames[1].clone();
        create["message"]["content"][0]["id"] = json!("new-create");
        let mut created = frames[3].clone();
        created["message"]["content"][0]["tool_use_id"] = json!("new-create");
        created["tool_use_result"]["task"]["id"] = json!("new-task");
        adapter.parse_value(&create);
        let snapshot = plans(&adapter.parse_value(&created));
        assert_eq!(
            snapshot[0][0].status,
            PlanStatus::Pending,
            "variant {variant} must preserve confirmed status"
        );
    }
}

#[test]
fn task_create_requires_structured_nonempty_id_and_subject() {
    let frames = capture();
    for invalid in [
        json!(null),
        json!({"task":{"subject":"missing id"}}),
        json!({"task":{"id":"","subject":"empty id"}}),
        json!({"task":{"id":"1","subject":""}}),
    ] {
        let mut adapter = ClaudeAdapter::new();
        adapter.parse_value(&frames[0]);
        let mut result = frames[2].clone();
        result["tool_use_result"] = invalid;
        assert!(plans(&adapter.parse_value(&result)).is_empty());
        assert!(plans(&adapter.parse_value(&frames[2])).is_empty());
    }
}

#[test]
fn sdk_confirmed_subject_and_deleted_updates_change_the_existing_task() {
    let frames = capture();
    let mut adapter = ClaudeAdapter::new();
    adapter.parse_value(&frames[0]);
    adapter.parse_value(&frames[2]);
    // Derived from TaskUpdateInput/Output in the official SDK schema. These
    // variants exercise our mapping; they are not additional live captures.
    let mut call = frames[4].clone();
    call["message"]["content"][0]["id"] = json!("rename-call");
    call["message"]["content"][0]["input"] = json!({"taskId":"1","subject":"Renamed task"});
    let mut result = frames[5].clone();
    result["message"]["content"][0]["tool_use_id"] = json!("rename-call");
    result["tool_use_result"] = json!({"success":true,"taskId":"1","updatedFields":["subject"]});
    adapter.parse_value(&call);
    let snapshots = plans(&adapter.parse_value(&result));
    assert_eq!(snapshots[0][0].content, "Renamed task");
    assert_eq!(snapshots[0][0].status, PlanStatus::Pending);

    call["message"]["content"][0]["id"] = json!("delete-call");
    call["message"]["content"][0]["input"] = json!({"taskId":"1","status":"deleted"});
    result["message"]["content"][0]["tool_use_id"] = json!("delete-call");
    result["tool_use_result"] = json!({"success":true,"taskId":"1","updatedFields":["status"]});
    adapter.parse_value(&call);
    assert_eq!(plans(&adapter.parse_value(&result)), vec![Vec::<PlanEntry>::new()]);
}

#[test]
fn subagent_tasks_and_mismatched_parent_results_do_not_replace_main_plan() {
    let frames = capture();
    let mut adapter = ClaudeAdapter::new();
    for frame in &frames {
        let mut child = frame.clone();
        child["parent_tool_use_id"] = json!("parent-agent-call");
        let events = adapter.parse_value(&child);
        assert!(plans(&events).is_empty());
        assert!(
            events
                .iter()
                .any(|e| matches!(e, SessionEvent::ToolCall { .. } | SessionEvent::ToolResult { .. }))
        );
    }
    // A child can reuse a call ID without suppressing the main agent's call.
    adapter.parse_value(&frames[0]);
    let mut child_result = frames[2].clone();
    child_result["parent_tool_use_id"] = json!("parent-agent-call");
    assert!(plans(&adapter.parse_value(&child_result)).is_empty());
    assert_eq!(
        plans(&adapter.parse_value(&frames[2]))[0][0].status,
        PlanStatus::Pending
    );
}

#[test]
fn replayed_task_calls_and_results_cannot_duplicate_or_rewind_plan() {
    let mut adapter = ClaudeAdapter::new();
    let frames = capture();
    for frame in &frames {
        adapter.parse_value(frame);
    }
    adapter.parse_value(&json!({"type":"result","is_error":false,"result":"done"}));
    for frame in &frames {
        let events = adapter.parse_value(frame);
        assert!(
            plans(&events).is_empty(),
            "replay must not duplicate or rewind completed tasks"
        );
        assert!(
            events
                .iter()
                .any(|e| matches!(e, SessionEvent::ToolCall { .. } | SessionEvent::ToolResult { .. }))
        );
    }
}

#[test]
fn unconfirmed_task_creation_does_not_survive_turn_boundary() {
    let mut adapter = ClaudeAdapter::new();
    let frames = capture();
    adapter.parse_value(&frames[0]);
    adapter.parse_value(&json!({"type":"result","is_error":true,"result":"cancelled"}));
    assert!(plans(&adapter.parse_value(&frames[2])).is_empty());
}

#[test]
fn subagent_legacy_todowrite_remains_a_raw_card_instead_of_main_plan() {
    let mut adapter = ClaudeAdapter::new();
    let call = json!({"type":"assistant","parent_tool_use_id":"parent-agent-call","message":{"content":[
        {"type":"tool_use","id":"child-todo","name":"TodoWrite","input":{"todos":[{"content":"child work","status":"pending"}]}}
    ]}});
    let events = adapter.parse_value(&call);
    assert!(plans(&events).is_empty());
    assert!(matches!(events.as_slice(), [SessionEvent::ToolCall { .. }]));
    let result = json!({"type":"user","parent_tool_use_id":"parent-agent-call","message":{"content":[
        {"type":"tool_result","tool_use_id":"child-todo","content":"ok"}
    ]}});
    assert!(matches!(
        adapter.parse_value(&result).as_slice(),
        [SessionEvent::ToolResult { .. }]
    ));
}
