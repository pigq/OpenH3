use aion_protocol::events::ToolCategory;
use aion_tools::Tool;
use aion_types::tool::{JsonSchema, ToolDef, ToolResult};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::sync::{Arc, RwLock};

/// Per-turn registry snapshot, including only MCP tools that actually registered.
pub(super) type CapabilitySnapshot = Arc<RwLock<Vec<ToolDef>>>;
pub(super) struct SessionCapabilities(pub CapabilitySnapshot);

#[async_trait]
impl Tool for SessionCapabilities {
    fn name(&self) -> &str {
        "openh3_session_capabilities"
    }
    fn description(&self) -> &str {
        "Inspect this session's actually registered tools and exact schemas. Use a keyword such as web, source, ExecCommand, Read or Edit. A registered tool still requires the current permission policy; registration does not prove network reachability. Native command/file tools are available for authorized installation diagnosis and repair. Never fabricate tool names or bypass a denied permission."
    }
    fn input_schema(&self) -> JsonSchema {
        json!({"type":"object","properties":{"query":{"type":"string"}},"additionalProperties":false})
    }
    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }
    fn category(&self) -> ToolCategory {
        ToolCategory::Info
    }
    async fn execute(&self, input: Value) -> ToolResult {
        let query = input["query"].as_str().unwrap_or("").to_lowercase();
        let Ok(definitions) = self.0.read() else {
            return ToolResult {
                content: "SESSION_CAPABILITIES_UNAVAILABLE".into(),
                is_error: true,
            };
        };
        let matches: Vec<Value> = definitions.iter()
            .filter(|tool| query.is_empty() || tool.name.to_lowercase().contains(&query) || tool.description.to_lowercase().contains(&query))
            .take(80)
            .map(|tool| if query.is_empty() { json!({"name":tool.name,"deferred":tool.deferred}) }
                else { json!({"name":tool.name,"description":tool.description,"parameters":tool.input_schema,"deferred":tool.deferred}) })
            .collect();
        ToolResult { content: json!({"scope":"current-session-registry", "tools":matches,"registeredCount":definitions.len(),"permissionPolicy":"current runtime approvals apply; this tool grants nothing","networkHealth":"not probed","snapshot":"refreshed before each turn"}).to_string(), is_error:false }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn reports_observed_tools_and_updated_snapshot_without_inventing_search() {
        let snapshot = Arc::new(RwLock::new(vec![ToolDef {
            name: "ExecCommand".into(),
            description: "shell".into(),
            input_schema: json!({"required":["cmd"]}),
            deferred: false,
        }]));
        let tool = SessionCapabilities(snapshot.clone());
        let result: Value = serde_json::from_str(&tool.execute(json!({"query":"ExecCommand"})).await.content).unwrap();
        assert_eq!(result["tools"][0]["parameters"]["required"][0], "cmd");
        let result: Value = serde_json::from_str(&tool.execute(json!({"query":"web"})).await.content).unwrap();
        assert_eq!(result["tools"], json!([]));
        snapshot.write().unwrap().clear();
        let result: Value = serde_json::from_str(&tool.execute(json!({})).await.content).unwrap();
        assert_eq!(result["registeredCount"], 0);
    }
}
