//! Exercise actual child stderr, protocol pipes, and bounded teardown.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use openh3_api_types::McpConnectionTestErrorCode;
use openh3_mcp::{McpConnectionTestService, McpServerTransport};
use openh3_realtime::BroadcastEventBus;

fn script_transport(unix: &str, windows: &str) -> McpServerTransport {
    #[cfg(windows)]
    let (command, args) = ("powershell", vec!["-NoProfile", "-NonInteractive", "-Command", windows]);
    #[cfg(not(windows))]
    let (command, args) = ("sh", vec!["-c", unix]);
    let _ = (unix, windows);
    McpServerTransport::Stdio {
        command: command.into(),
        args: args.into_iter().map(str::to_owned).collect(),
        env: HashMap::from([("MCP_TEST_SECRET".into(), "env-secret-value".into())]),
    }
}

async fn test_script(transport: &McpServerTransport) -> openh3_api_types::McpConnectionTestResult {
    let service = McpConnectionTestService::new(reqwest::Client::new(), Arc::new(BroadcastEventBus::new(16)))
        .with_timeout(Duration::from_secs(5));
    tokio::time::timeout(Duration::from_secs(15), service.test_connection("fixture", transport))
        .await
        .expect("stderr drain and process cleanup must finish")
}

#[tokio::test]
async fn failed_stdio_reports_bridge_configuration_without_exposing_stderr() {
    let transport = script_transport(
        "printf '%s\\n' '[builtin-mcp-browser] CDP bridge port or token is unavailable; token=raw-secret-value payload=private-tool-content' >&2; exit 17",
        "[Console]::Error.WriteLine('[builtin-mcp-browser] CDP bridge port or token is unavailable; token=raw-secret-value payload=private-tool-content'); exit 17",
    );
    let result = test_script(&transport).await;
    assert!(!result.success);
    assert_eq!(result.code, Some(McpConnectionTestErrorCode::CommandStartFailed));
    let details = result.details.as_ref().unwrap();
    assert_eq!(details["stderr_diagnostic"], "browser_bridge_unavailable");
    assert_eq!(details["exit_code"], 17);
    assert!(
        result.error.as_deref().unwrap().contains("browser bridge"),
        "{result:?}"
    );
    let encoded = serde_json::to_string(&result).unwrap();
    for secret in [
        "raw-secret-value",
        "private-tool-content",
        "env-secret-value",
        "MCP_TEST_SECRET",
        "[Console]",
    ] {
        assert!(!encoded.contains(secret), "diagnostic leaked {secret}");
    }
}

#[tokio::test]
async fn failed_stdio_drains_large_stderr_without_deadlocking() {
    let transport = script_transport(
        "i=0; while [ $i -lt 6000 ]; do printf '%s\\n' 'unrecognized-private-payload-xxxxxxxxxxxx' >&2; i=$((i+1)); done; printf '%s\\n' 'Error: Cannot find module private-module-path' >&2; exit 23",
        "$line = 'unrecognized-private-payload-xxxxxxxxxxxx'; for ($i=0; $i -lt 6000; $i++) { [Console]::Error.WriteLine($line) }; [Console]::Error.WriteLine('Error: Cannot find module private-module-path'); exit 23",
    );
    let result = test_script(&transport).await;
    assert_eq!(result.code, Some(McpConnectionTestErrorCode::CommandStartFailed));
    let details = result.details.as_ref().unwrap();
    assert_eq!(details["stderr_diagnostic"], "module_not_found");
    assert_eq!(details["stderr_truncated"], true);
    assert_eq!(details["exit_code"], 23);
    assert!(serde_json::to_string(&result).unwrap().len() < 2048);
    assert!(!serde_json::to_string(&result).unwrap().contains("private-module-path"));
    assert!(
        !serde_json::to_string(&result)
            .unwrap()
            .contains("unrecognized-private-payload")
    );
}

#[tokio::test]
async fn successful_stdio_handshake_ignores_stderr_and_server_notifications() {
    let transport = script_transport(
        "printf '%s\\n' 'Error: Cannot find module private-warning-path' >&2; while IFS= read -r line; do case \"$line\" in *'\"id\":1'*) printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"params\":{}}' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"serverInfo\":{\"name\":\"fixture\",\"version\":\"1\"}}}' ;; *'\"id\":2'*) printf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"browser_fixture\",\"inputSchema\":{\"type\":\"object\"}}]}}'; exit 0 ;; esac; done",
        "[Console]::Error.WriteLine('Error: Cannot find module private-warning-path'); while ($null -ne ($line = [Console]::ReadLine())) { $request = $line | ConvertFrom-Json; if ($request.id -eq 1) { [Console]::WriteLine('{\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"params\":{}}'); [Console]::WriteLine('{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2024-11-05\",\"capabilities\":{},\"serverInfo\":{\"name\":\"fixture\",\"version\":\"1\"}}}') }; if ($request.id -eq 2) { [Console]::WriteLine('{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"browser_fixture\",\"inputSchema\":{\"type\":\"object\"}}]}}'); exit 0 } }",
    );
    let result = test_script(&transport).await;
    assert!(result.success, "{result:?}");
    assert_eq!(result.tools.as_ref().unwrap()[0].name, "browser_fixture");
    assert!(result.details.is_none());
    assert!(result.code.is_none());
}

#[tokio::test]
async fn stdio_timeout_retains_timeout_code_even_with_stderr() {
    let transport = script_transport(
        "printf '%s\\n' 'Error: Cannot find module private-warning-path' >&2; sleep 60",
        "[Console]::Error.WriteLine('Error: Cannot find module private-warning-path'); Start-Sleep -Seconds 60",
    );
    let service = McpConnectionTestService::new(reqwest::Client::new(), Arc::new(BroadcastEventBus::new(16)))
        .with_timeout(Duration::from_millis(750));
    let result = tokio::time::timeout(Duration::from_secs(10), service.test_connection("timeout", &transport))
        .await
        .unwrap();
    assert_eq!(result.code, Some(McpConnectionTestErrorCode::Timeout));
    assert!(result.error.as_deref().unwrap().contains("timed out"));
}
