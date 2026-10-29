//! Bounded stderr collection. Only fixed diagnostic summaries may leave this module.

use openh3_api_types::{McpConnectionTestErrorCode, McpConnectionTestResult};
use tokio::io::{AsyncRead, AsyncReadExt};

const STDERR_LIMIT: usize = 16 * 1024;

#[derive(Default)]
pub(super) struct StderrCapture {
    tail: Vec<u8>,
    truncated: bool,
}

#[derive(Clone, Copy)]
pub(super) struct Diagnostic {
    pub code: &'static str,
    pub message: &'static str,
}

// Match known failure markers, never echo arbitrary stderr, paths, URLs, or credentials.
const DIAGNOSTICS: &[(&str, Diagnostic)] = &[
    (
        "cdp bridge port or token is unavailable",
        Diagnostic {
            code: "browser_bridge_unavailable",
            message: "The in-app browser bridge configuration is unavailable. Restart OpenH3 and retry the connection test.",
        },
    ),
    (
        "cannot find module",
        Diagnostic {
            code: "module_not_found",
            message: "An MCP startup module is missing. Check the server installation and configured script path.",
        },
    ),
    (
        "err_module_not_found",
        Diagnostic {
            code: "module_not_found",
            message: "An MCP startup module is missing. Check the server installation and configured script path.",
        },
    ),
    (
        "econnrefused",
        Diagnostic {
            code: "connection_refused",
            message: "The MCP server could not reach a required local service. Check that its browser bridge or dependency is running.",
        },
    ),
    (
        "eaddrinuse",
        Diagnostic {
            code: "address_in_use",
            message: "A port required by the MCP server is already in use.",
        },
    ),
    (
        "eacces",
        Diagnostic {
            code: "permission_denied",
            message: "The MCP server was denied access to a required resource. Check its permissions.",
        },
    ),
    (
        "unknown option",
        Diagnostic {
            code: "invalid_arguments",
            message: "The MCP server rejected a launch option. Check that its installed version supports the configured arguments.",
        },
    ),
    (
        "syntaxerror",
        Diagnostic {
            code: "runtime_syntax_error",
            message: "The MCP server reported a startup syntax error. Check its runtime version and installation.",
        },
    ),
];

pub(super) fn diagnostic_from_code(code: &str) -> Option<Diagnostic> {
    DIAGNOSTICS
        .iter()
        .find_map(|(_, diagnostic)| (diagnostic.code == code).then_some(*diagnostic))
}

impl StderrCapture {
    /// Keep draining after the limit so verbose subprocesses cannot block on a full pipe.
    pub async fn drain(&mut self, reader: &mut (impl AsyncRead + Unpin)) {
        let mut chunk = [0u8; 2048];
        loop {
            let count = match reader.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(count) => count,
            };
            let overflow = (self.tail.len() + count).saturating_sub(STDERR_LIMIT);
            if overflow > 0 {
                self.tail.drain(..overflow);
                self.truncated = true;
            }
            self.tail.extend_from_slice(&chunk[..count]);
        }
    }

    pub fn enrich_failure(&self, result: &mut McpConnectionTestResult, exit_code: Option<i32>) {
        if result.success {
            return;
        }
        let lower = String::from_utf8_lossy(&self.tail).to_ascii_lowercase();
        let diagnostic = DIAGNOSTICS
            .iter()
            .find_map(|(marker, diagnostic)| lower.contains(marker).then_some(*diagnostic));
        let details = result.details.get_or_insert_with(|| serde_json::json!({}));
        let Some(details) = details.as_object_mut() else { return };
        details.insert("stderr_present".into(), (!self.tail.is_empty()).into());
        details.insert("stderr_truncated".into(), self.truncated.into());
        if let Some(exit_code) = exit_code {
            details.insert("exit_code".into(), exit_code.into());
        }
        if let Some(diagnostic) = diagnostic {
            details.insert("stderr_diagnostic".into(), diagnostic.code.into());
            details.insert("stderr_summary".into(), diagnostic.message.into());
        }
        let failed_initialization = matches!(
            details.get("stage").and_then(serde_json::Value::as_str),
            Some("initialize_send" | "initialize_response")
        );
        if failed_initialization
            && result.code == Some(McpConnectionTestErrorCode::ProtocolError)
            && (diagnostic.is_some() || exit_code.is_some_and(|code| code != 0))
        {
            result.code = Some(McpConnectionTestErrorCode::CommandStartFailed);
            let summary = diagnostic.map(|diagnostic| diagnostic.message)
                .unwrap_or("The MCP server exited before completing initialization. Check its installation and launch configuration.");
            result.error = Some(format!("MCP server startup failed: {summary}"));
        }
    }
}
