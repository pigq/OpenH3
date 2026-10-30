use std::sync::Arc;
use std::time::Duration;

use aion_providers::{LlmProvider, ProviderError};
use aion_types::llm::{LlmEvent, LlmRequest};
use openh3_api_types::AgentErrorCode;
use tokio::sync::mpsc;
use tracing::Instrument;

use crate::protocol::send_error::classify_upstream_detail;

/// Recover status-less gateway failures at the provider boundary, before any
/// event has escaped to the engine. Never rerun an agent turn or its tools.
pub(crate) struct RecoveringProvider(pub(crate) Arc<dyn LlmProvider>);

fn retry_empty_stream(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    classify_upstream_detail(detail).code() == Some(AgentErrorCode::UserLlmProviderGatewayError)
        && [
            "upstream stream failed",
            "stream disconnected",
            "stream closed",
            "connection reset",
            "temporarily unavailable",
            "server_error",
            "internal server error",
            "service unavailable",
            "bad gateway",
        ]
        .iter()
        .any(|signature| lower.contains(signature))
}

#[async_trait::async_trait]
impl LlmProvider for RecoveringProvider {
    async fn stream(&self, request: &LlmRequest) -> Result<mpsc::Receiver<LlmEvent>, ProviderError> {
        let mut events = self.0.stream(request).await?;
        let (tx, rx) = mpsc::channel(64);
        let provider = self.0.clone();
        let request = request.clone();
        tokio::spawn(
            async move {
                let mut emitted = false;
                for attempt in 0..=2 {
                    let failure = loop {
                        let event = tokio::select! {
                            _ = tx.closed() => return,
                            event = events.recv() => event,
                        };
                        match event {
                            None => return,
                            Some(LlmEvent::Error(detail)) => break detail,
                            Some(event) => {
                                emitted = true;
                                if tx.send(event).await.is_err() {
                                    return;
                                }
                            }
                        }
                    };
                    if emitted || attempt == 2 || !retry_empty_stream(&failure) {
                        let _ = tx.send(LlmEvent::Error(failure)).await;
                        return;
                    }
                    tracing::warn!(
                        attempt = attempt + 1,
                        max_retries = 2,
                        "Retrying empty provider stream after gateway failure"
                    );
                    tokio::select! {
                        _ = tx.closed() => return,
                        _ = tokio::time::sleep(Duration::from_secs(1 << attempt)) => {}
                    }
                    match tokio::select! {
                        _ = tx.closed() => return,
                        response = provider.stream(&request) => response,
                    } {
                        Ok(response) => events = response,
                        Err(error) => {
                            let _ = tx.send(LlmEvent::Error(error.to_string())).await;
                            return;
                        }
                    }
                }
            }
            .instrument(tracing::Span::current()),
        );
        Ok(rx)
    }
}

#[cfg(test)]
#[path = "provider_stream_test.rs"]
mod tests;
