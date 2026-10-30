use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

struct FailingStream {
    calls: AtomicUsize,
    tool_event: bool,
}

#[async_trait::async_trait]
impl LlmProvider for FailingStream {
    async fn stream(&self, _: &LlmRequest) -> Result<mpsc::Receiver<LlmEvent>, ProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel(2);
        if self.tool_event {
            tx.send(LlmEvent::ToolUse {
                id: "generation".into(),
                name: "generate_video".into(),
                input: serde_json::json!({}),
                extra: None,
            })
            .await
            .unwrap();
        }
        tx.send(LlmEvent::Error(
            "SSE parse error: upstream stream failed after response started".into(),
        ))
        .await
        .unwrap();
        Ok(rx)
    }
}

fn request() -> LlmRequest {
    LlmRequest {
        model: "test".into(),
        system: String::new(),
        messages: vec![],
        tools: vec![],
        max_tokens: None,
        thinking: None,
        reasoning_effort: None,
    }
}

#[tokio::test]
async fn empty_stream_recovery_is_bounded() {
    let inner = Arc::new(FailingStream {
        calls: AtomicUsize::new(0),
        tool_event: false,
    });
    let mut events = RecoveringProvider(inner.clone()).stream(&request()).await.unwrap();
    assert!(matches!(events.recv().await, Some(LlmEvent::Error(_))));
    assert!(events.recv().await.is_none());
    assert_eq!(inner.calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn tool_events_prevent_replay() {
    let inner = Arc::new(FailingStream {
        calls: AtomicUsize::new(0),
        tool_event: true,
    });
    let mut events = RecoveringProvider(inner.clone()).stream(&request()).await.unwrap();
    assert!(matches!(events.recv().await, Some(LlmEvent::ToolUse { .. })));
    assert!(matches!(events.recv().await, Some(LlmEvent::Error(_))));
    assert_eq!(inner.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn closing_receiver_cancels_recovery() {
    let inner = Arc::new(FailingStream {
        calls: AtomicUsize::new(0),
        tool_event: false,
    });
    let events = RecoveringProvider(inner.clone()).stream(&request()).await.unwrap();
    drop(events);
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(inner.calls.load(Ordering::SeqCst), 1);
}
