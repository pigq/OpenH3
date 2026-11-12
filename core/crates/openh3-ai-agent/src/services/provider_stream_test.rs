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
async fn compaction_omits_unsupported_thinking_at_the_actual_openai_http_boundary() {
    use aion_agent::compact::{auto::autocompact, state::CompactState};
    use aion_config::compat::ProviderCompat;
    use axum::{Json, Router, routing::post};
    let captured = Arc::new(tokio::sync::Mutex::new(None));
    let observed = captured.clone();
    let router = Router::new().route("/chat/completions", post(move |Json(body): Json<serde_json::Value>| {
        let observed = observed.clone();
        async move {
            *observed.lock().await = Some(body);
            ([ ("content-type", "text/event-stream") ], "data: {\"choices\":[{\"delta\":{\"content\":\"summary\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let provider = aion_providers::openai::OpenAIProvider::new(
        "test",
        &format!("http://{address}"),
        ProviderCompat::openai_defaults(),
    );
    let provider = RequestCompatibilityProvider {
        inner: Arc::new(provider),
        supports_thinking: false,
    };
    let mut state = CompactState::new();
    state.last_input_tokens = 180_000;
    let result = autocompact(&provider, &[], "gpt-test", &Default::default(), &mut state)
        .await
        .unwrap();
    assert_eq!(result.messages.len(), 2);
    assert_eq!(state.consecutive_failures, 0);
    let body = captured.lock().await.clone().expect("actual HTTP request captured");
    assert!(
        body.get("thinking").is_none(),
        "unsupported thinking field sent: {body}"
    );
    server.abort();
}

#[tokio::test]
async fn supported_thinking_and_reasoning_effort_are_preserved() {
    struct Capture(tokio::sync::Mutex<Option<LlmRequest>>);
    #[async_trait::async_trait]
    impl LlmProvider for Capture {
        async fn stream(&self, request: &LlmRequest) -> Result<mpsc::Receiver<LlmEvent>, ProviderError> {
            *self.0.lock().await = Some(request.clone());
            let (_, rx) = mpsc::channel(1);
            Ok(rx)
        }
    }
    let capture = Arc::new(Capture(tokio::sync::Mutex::new(None)));
    let provider = RequestCompatibilityProvider {
        inner: capture.clone(),
        supports_thinking: true,
    };
    let mut original = request();
    original.thinking = Some(aion_types::llm::ThinkingConfig::Disabled);
    original.reasoning_effort = Some("high".into());
    provider.stream(&original).await.unwrap();
    let sent = capture.0.lock().await.clone().unwrap();
    assert!(matches!(sent.thinking, Some(aion_types::llm::ThinkingConfig::Disabled)));
    assert_eq!(sent.reasoning_effort, original.reasoning_effort);
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
