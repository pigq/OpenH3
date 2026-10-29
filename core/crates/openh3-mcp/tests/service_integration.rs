//! Integration tests for McpConfigService with real SQLite.
//!
//! Tests from test-plan §1 (CRUD) at the service layer.

use std::collections::HashMap;
use std::sync::Arc;

const TEST_USER_ID: &str = "system_default_user";
const OTHER_USERNAME: &str = "user-2";

use openh3_api_types::{
    BatchImportMcpServersRequest, CreateMcpServerRequest, ImportMcpServerRequest, McpTransport, UpdateMcpServerRequest,
};
use openh3_db::{IMcpServerRepository, IUserRepository, SqliteMcpServerRepository, SqliteUserRepository};
use openh3_mcp::{McpConfigService, McpError};

async fn make_service() -> McpConfigService {
    make_service_with_other_user().await.0
}

async fn make_service_with_other_user() -> (McpConfigService, String) {
    let db = openh3_db::init_database_memory().await.unwrap();
    let user_repo = SqliteUserRepository::new(db.pool().clone());
    let other_user = user_repo.create_user(OTHER_USERNAME, "hash").await.unwrap();
    let repo = Arc::new(SqliteMcpServerRepository::new(db.pool().clone()));
    (McpConfigService::new(repo), other_user.id)
}

fn stdio_req(name: &str) -> CreateMcpServerRequest {
    CreateMcpServerRequest {
        name: name.to_owned(),
        description: Some("test".to_owned()),
        transport: McpTransport::Stdio {
            command: "npx".into(),
            args: vec!["-y".into(), "@test/server".into()],
            env: HashMap::new(),
        },
        original_json: None,
        builtin: false,
    }
}

fn http_req(name: &str) -> CreateMcpServerRequest {
    CreateMcpServerRequest {
        name: name.to_owned(),
        description: None,
        transport: McpTransport::Http {
            url: "https://example.com/mcp".into(),
            headers: HashMap::from([("Auth".into(), "Bearer tok".into())]),
        },
        original_json: None,
        builtin: false,
    }
}

fn stdio_import_req(name: &str) -> ImportMcpServerRequest {
    ImportMcpServerRequest {
        name: name.to_owned(),
        description: Some("test".to_owned()),
        transport: McpTransport::Stdio {
            command: "npx".into(),
            args: vec!["-y".into(), "@test/server".into()],
            env: HashMap::new(),
        },
        original_json: None,
        builtin: false,
        enabled: None,
    }
}

fn http_import_req(name: &str) -> ImportMcpServerRequest {
    ImportMcpServerRequest {
        name: name.to_owned(),
        description: None,
        transport: McpTransport::Http {
            url: "https://example.com/mcp".into(),
            headers: HashMap::from([("Auth".into(), "Bearer tok".into())]),
        },
        original_json: None,
        builtin: false,
        enabled: None,
    }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

#[tokio::test]
async fn create_and_get_stdio_server() {
    let svc = make_service().await;
    let resp = svc.add_server(TEST_USER_ID, stdio_req("test-stdio")).await.unwrap();

    assert!(resp.id.starts_with("mcp_"));
    assert_eq!(resp.name, "test-stdio");
    assert!(!resp.enabled);
    assert_eq!(resp.description.as_deref(), Some("test"));

    let found = svc.get_server(TEST_USER_ID, &resp.id).await.unwrap();
    assert_eq!(found.id, resp.id);
}

#[tokio::test]
async fn create_http_with_headers() {
    let svc = make_service().await;
    let resp = svc.add_server(TEST_USER_ID, http_req("test-http")).await.unwrap();

    match resp.transport {
        McpTransport::Http { ref url, ref headers } => {
            assert_eq!(url, "https://example.com/mcp");
            assert_eq!(headers.get("Auth").unwrap(), "Bearer tok");
        }
        _ => panic!("expected Http"),
    }
}

#[tokio::test]
async fn create_same_name_upserts() {
    let svc = make_service().await;
    let first = svc.add_server(TEST_USER_ID, stdio_req("dup")).await.unwrap();
    let second = svc.add_server(TEST_USER_ID, http_req("dup")).await.unwrap();

    assert_eq!(first.id, second.id);
    match second.transport {
        McpTransport::Http { .. } => {}
        _ => panic!("expected Http after upsert"),
    }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

#[tokio::test]
async fn list_empty() {
    let svc = make_service().await;
    assert!(svc.list_servers(TEST_USER_ID).await.unwrap().is_empty());
}

#[tokio::test]
async fn list_returns_all() {
    let svc = make_service().await;
    svc.add_server(TEST_USER_ID, stdio_req("a")).await.unwrap();
    svc.add_server(TEST_USER_ID, http_req("b")).await.unwrap();
    assert_eq!(svc.list_servers(TEST_USER_ID).await.unwrap().len(), 2);
}

#[tokio::test]
async fn get_not_found() {
    let svc = make_service().await;
    let err = svc.get_server(TEST_USER_ID, "nonexistent").await.unwrap_err();
    assert!(matches!(err, McpError::NotFound(_)));
}

#[tokio::test]
async fn servers_are_scoped_by_current_user() {
    let (svc, other_user_id) = make_service_with_other_user().await;
    let owner_server = svc.add_server(TEST_USER_ID, stdio_req("shared")).await.unwrap();
    let other_server = svc.add_server(&other_user_id, http_req("shared")).await.unwrap();

    assert_ne!(owner_server.id, other_server.id);
    assert_eq!(svc.list_servers(TEST_USER_ID).await.unwrap().len(), 1);
    assert_eq!(svc.list_servers(&other_user_id).await.unwrap().len(), 1);

    assert!(matches!(
        svc.get_server(TEST_USER_ID, &other_server.id).await.unwrap_err(),
        McpError::NotFound(_)
    ));
    assert!(matches!(
        svc.edit_server(
            TEST_USER_ID,
            &other_server.id,
            UpdateMcpServerRequest {
                name: None,
                description: Some(Some("forged".into())),
                transport: None,
                original_json: None,
                builtin: None,
            },
        )
        .await
        .unwrap_err(),
        McpError::NotFound(_)
    ));
    assert!(matches!(
        svc.delete_server(TEST_USER_ID, &other_server.id).await.unwrap_err(),
        McpError::NotFound(_)
    ));

    svc.delete_server(&other_user_id, &other_server.id).await.unwrap();
    assert_eq!(
        svc.get_server(TEST_USER_ID, &owner_server.id).await.unwrap().id,
        owner_server.id
    );
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

#[tokio::test]
async fn edit_name_is_rejected() {
    let svc = make_service().await;
    let created = svc.add_server(TEST_USER_ID, stdio_req("old")).await.unwrap();

    let err = svc
        .edit_server(
            TEST_USER_ID,
            &created.id,
            UpdateMcpServerRequest {
                name: Some("new".into()),
                description: None,
                transport: None,
                original_json: None,
                builtin: None,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, McpError::InvalidEdit(_)));
}

#[tokio::test]
async fn edit_transport() {
    let svc = make_service().await;
    let created = svc.add_server(TEST_USER_ID, stdio_req("test")).await.unwrap();

    let updated = svc
        .edit_server(
            TEST_USER_ID,
            &created.id,
            UpdateMcpServerRequest {
                name: None,
                description: None,
                transport: Some(McpTransport::Sse {
                    url: "https://new.url".into(),
                    headers: HashMap::new(),
                }),
                original_json: None,
                builtin: None,
            },
        )
        .await
        .unwrap();
    match updated.transport {
        McpTransport::Sse { ref url, .. } => assert_eq!(url, "https://new.url"),
        _ => panic!("expected Sse"),
    }
}

#[tokio::test]
async fn edit_clears_description() {
    let svc = make_service().await;
    let created = svc.add_server(TEST_USER_ID, stdio_req("test")).await.unwrap();
    assert!(created.description.is_some());

    let updated = svc
        .edit_server(
            TEST_USER_ID,
            &created.id,
            UpdateMcpServerRequest {
                name: None,
                description: Some(None),
                transport: None,
                original_json: None,
                builtin: None,
            },
        )
        .await
        .unwrap();
    assert!(updated.description.is_none());
}

#[tokio::test]
async fn edit_not_found() {
    let svc = make_service().await;
    let err = svc
        .edit_server(
            TEST_USER_ID,
            "nonexistent",
            UpdateMcpServerRequest {
                name: Some("x".into()),
                description: None,
                transport: None,
                original_json: None,
                builtin: None,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, McpError::NotFound(_)));
}

#[tokio::test]
async fn edit_name_conflict() {
    let svc = make_service().await;
    svc.add_server(TEST_USER_ID, stdio_req("a")).await.unwrap();
    let b = svc.add_server(TEST_USER_ID, stdio_req("b")).await.unwrap();

    let err = svc
        .edit_server(
            TEST_USER_ID,
            &b.id,
            UpdateMcpServerRequest {
                name: Some("a".into()),
                description: None,
                transport: None,
                original_json: None,
                builtin: None,
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, McpError::InvalidEdit(_)));
}

// ---------------------------------------------------------------------------
// Builtin upgrade migrations
// ---------------------------------------------------------------------------

#[tokio::test]
async fn builtin_legacy_names_migrate_in_place_preserving_enabled_and_custom_env() {
    for (legacy, canonical) in [
        ("aionui-video-media", "openh3-video-media"),
        ("aionui-browser", "openh3-browser"),
        ("aionui-image-generation", "openh3-image-generation"),
        ("AionUi Image Generation", "openh3-image-generation"),
        ("builtin-image-gen", "openh3-image-generation"),
    ] {
        let svc = make_service().await;
        let mut request = stdio_req(legacy);
        request.builtin = true;
        if let McpTransport::Stdio { env, .. } = &mut request.transport {
            env.insert("USER_CONFIG".into(), "retain-me".into());
        }
        let created = svc.add_server(TEST_USER_ID, request).await.unwrap();
        svc.toggle_server(TEST_USER_ID, &created.id).await.unwrap();
        let update = UpdateMcpServerRequest {
            name: Some(canonical.into()),
            description: None,
            transport: Some(McpTransport::Stdio {
                command: "node".into(),
                args: vec!["/new/resources/builtin-mcp.js".into()],
                env: HashMap::from([("MANAGED_CONFIG".into(), "current".into())]),
            }),
            original_json: None,
            builtin: Some(true),
        };
        let updated = svc.edit_server(TEST_USER_ID, &created.id, update).await.unwrap();
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.name, canonical);
        assert!(updated.builtin);
        assert!(updated.enabled);
        let McpTransport::Stdio { command, env, .. } = &updated.transport else {
            panic!("expected stdio")
        };
        assert_eq!(command, "node");
        assert_eq!(env.get("USER_CONFIG").map(String::as_str), Some("retain-me"));
        assert_eq!(env.get("MANAGED_CONFIG").map(String::as_str), Some("current"));
        assert_eq!(svc.list_servers(TEST_USER_ID).await.unwrap().len(), 1);

        // A repeated bootstrap must remain an ordinary idempotent edit.
        svc.edit_server(
            TEST_USER_ID,
            &created.id,
            UpdateMcpServerRequest {
                name: Some(canonical.into()),
                description: None,
                transport: None,
                original_json: None,
                builtin: Some(true),
            },
        )
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn builtin_migration_requires_stored_builtin_flag_and_matching_name_pair() {
    let svc = make_service().await;
    for (name, builtin, target, requested_builtin) in [
        ("aionui-video-media", false, "openh3-video-media", Some(true)),
        ("aionui-browser", true, "openh3-video-media", Some(true)),
        ("custom-builtin", true, "openh3-browser", Some(true)),
        ("aionui-image-generation", true, "openh3-image-generation", Some(false)),
    ] {
        let mut request = stdio_req(name);
        request.builtin = builtin;
        let created = svc.add_server(TEST_USER_ID, request).await.unwrap();
        let err = svc
            .edit_server(
                TEST_USER_ID,
                &created.id,
                UpdateMcpServerRequest {
                    name: Some(target.into()),
                    description: None,
                    transport: None,
                    original_json: None,
                    builtin: requested_builtin,
                },
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, McpError::InvalidEdit(ref message) if message.contains("cannot be changed")),
            "{err}"
        );
    }
}

#[tokio::test]
async fn builtin_migration_reports_canonical_conflict_without_changing_legacy_row() {
    let svc = make_service().await;
    let mut request = stdio_req("aionui-browser");
    request.builtin = true;
    let legacy = svc.add_server(TEST_USER_ID, request).await.unwrap();
    svc.add_server(TEST_USER_ID, stdio_req("openh3-browser")).await.unwrap();
    let err = svc
        .edit_server(
            TEST_USER_ID,
            &legacy.id,
            UpdateMcpServerRequest {
                name: Some("openh3-browser".into()),
                description: None,
                transport: None,
                original_json: None,
                builtin: Some(true),
            },
        )
        .await
        .unwrap_err();
    assert!(
        matches!(err, McpError::Conflict(ref name) if name == "openh3-browser"),
        "{err}"
    );
    assert_eq!(
        svc.get_server(TEST_USER_ID, &legacy.id).await.unwrap().name,
        "aionui-browser"
    );
}

#[tokio::test]
async fn builtin_migration_cannot_update_another_users_server() {
    let (svc, other_user_id) = make_service_with_other_user().await;
    let mut request = stdio_req("aionui-browser");
    request.builtin = true;
    let legacy = svc.add_server(TEST_USER_ID, request).await.unwrap();
    let err = svc
        .edit_server(
            &other_user_id,
            &legacy.id,
            UpdateMcpServerRequest {
                name: Some("openh3-browser".into()),
                description: None,
                transport: None,
                original_json: None,
                builtin: Some(true),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(err, McpError::NotFound(ref id) if id == &legacy.id), "{err}");
}

#[tokio::test]
async fn builtin_migration_merges_duplicate_in_place_with_disabled_winning() {
    for (legacy_enabled, canonical_enabled) in [(false, false), (false, true), (true, false), (true, true)] {
        let db = openh3_db::init_database_memory().await.unwrap();
        let repo = Arc::new(SqliteMcpServerRepository::new(db.pool().clone()));
        let svc = McpConfigService::new(repo.clone());
        let mut legacy_request = stdio_req("aionui-browser");
        legacy_request.builtin = true;
        if let McpTransport::Stdio { env, .. } = &mut legacy_request.transport {
            env.extend(HashMap::from([
                ("LEGACY_ONLY".into(), "legacy".into()),
                ("COLLISION".into(), "legacy".into()),
            ]));
        }
        let legacy = svc.add_server(TEST_USER_ID, legacy_request).await.unwrap();
        let mut canonical_request = stdio_req("openh3-browser");
        canonical_request.builtin = true;
        if let McpTransport::Stdio { env, .. } = &mut canonical_request.transport {
            env.extend(HashMap::from([
                ("CANONICAL_ONLY".into(), "canonical".into()),
                ("COLLISION".into(), "canonical".into()),
            ]));
        }
        let canonical = svc.add_server(TEST_USER_ID, canonical_request).await.unwrap();
        if legacy_enabled {
            svc.toggle_server(TEST_USER_ID, &legacy.id).await.unwrap();
        }
        if canonical_enabled {
            svc.toggle_server(TEST_USER_ID, &canonical.id).await.unwrap();
        }
        let updated = svc
            .edit_server(
                TEST_USER_ID,
                &legacy.id,
                UpdateMcpServerRequest {
                    name: Some("openh3-browser".into()),
                    description: None,
                    transport: Some(McpTransport::Stdio {
                        command: "node".into(),
                        args: vec!["/current/builtin-mcp-browser.js".into()],
                        env: HashMap::from([("COLLISION".into(), "request".into())]),
                    }),
                    original_json: None,
                    builtin: Some(true),
                },
            )
            .await
            .unwrap();
        assert_eq!(updated.id, legacy.id);
        assert_eq!(updated.name, "openh3-browser");
        assert_eq!(updated.enabled, legacy_enabled && canonical_enabled);
        let McpTransport::Stdio { command, args, env } = &updated.transport else {
            panic!("expected stdio")
        };
        assert_eq!(command, "node");
        assert_eq!(args, &["/current/builtin-mcp-browser.js"]);
        assert_eq!(env.get("LEGACY_ONLY").map(String::as_str), Some("legacy"));
        assert_eq!(env.get("CANONICAL_ONLY").map(String::as_str), Some("canonical"));
        assert_eq!(env.get("COLLISION").map(String::as_str), Some("request"));
        assert_eq!(svc.list_servers(TEST_USER_ID).await.unwrap().len(), 1);
        let retired = repo.find_by_id_any(TEST_USER_ID, &canonical.id).await.unwrap().unwrap();
        assert!(retired.deleted_at.is_some());
        assert!(!retired.enabled);
        assert_ne!(retired.name, "openh3-browser");
    }
}

#[tokio::test]
async fn builtin_migration_merges_soft_deleted_canonical_without_releasing_unique_name() {
    let svc = make_service().await;
    let mut request = stdio_req("aionui-browser");
    request.builtin = true;
    let legacy = svc.add_server(TEST_USER_ID, request).await.unwrap();
    svc.toggle_server(TEST_USER_ID, &legacy.id).await.unwrap();
    let mut request = stdio_req("openh3-browser");
    request.builtin = true;
    let canonical = svc.add_server(TEST_USER_ID, request).await.unwrap();
    svc.delete_server(TEST_USER_ID, &canonical.id).await.unwrap();
    let updated = svc
        .edit_server(
            TEST_USER_ID,
            &legacy.id,
            UpdateMcpServerRequest {
                name: Some("openh3-browser".into()),
                description: None,
                transport: None,
                original_json: None,
                builtin: Some(true),
            },
        )
        .await
        .unwrap();
    assert_eq!(updated.id, legacy.id);
    assert_eq!(updated.name, "openh3-browser");
    assert!(!updated.enabled);
    assert_eq!(svc.list_servers(TEST_USER_ID).await.unwrap().len(), 1);
}

#[tokio::test]
async fn builtin_migration_original_json_matches_merged_transport_and_survives_edit_roundtrip() {
    let svc = make_service().await;
    for (name, key, value) in [
        ("aionui-browser", "LEGACY_ONLY", "legacy"),
        ("openh3-browser", "CANONICAL_ONLY", "canonical"),
    ] {
        let mut request = stdio_req(name);
        request.builtin = true;
        if let McpTransport::Stdio { env, .. } = &mut request.transport {
            env.insert(key.into(), value.into());
        }
        svc.add_server(TEST_USER_ID, request).await.unwrap();
    }
    let legacy = svc
        .list_servers(TEST_USER_ID)
        .await
        .unwrap()
        .into_iter()
        .find(|server| server.name == "aionui-browser")
        .unwrap();
    // The bootstrap request only knows its own env. Its editable JSON can also
    // contain an old nested transport that the UI parser would otherwise prefer.
    let stale_json = serde_json::json!({
        "metadata": { "keep": true },
        "mcpServers": {
            "aionui-browser": {
                "command": "node",
                "args": ["/stale/browser.js"],
                "env": { "REQUEST_ONLY": "request" },
                "transport": { "type": "http", "url": "https://stale.example/mcp" },
                "timeout": 45,
            },
        },
    })
    .to_string();
    let updated = svc
        .edit_server(
            TEST_USER_ID,
            &legacy.id,
            UpdateMcpServerRequest {
                name: Some("openh3-browser".into()),
                description: Some(Some("Current browser".into())),
                transport: Some(McpTransport::Stdio {
                    command: "node".into(),
                    args: vec!["/current/browser.js".into()],
                    env: HashMap::from([("REQUEST_ONLY".into(), "request".into())]),
                }),
                original_json: Some(Some(stale_json)),
                builtin: Some(true),
            },
        )
        .await
        .unwrap();
    let original = updated.original_json.as_ref().unwrap();
    let parsed: serde_json::Value = serde_json::from_str(original).unwrap();
    let config = &parsed["mcpServers"]["openh3-browser"];
    assert!(parsed["mcpServers"].get("aionui-browser").is_none());
    assert_eq!(parsed["metadata"]["keep"], true);
    assert_eq!(config["timeout"], 45);
    assert_eq!(config["description"], "Current browser");
    assert!(config.get("transport").is_none());
    assert_eq!(config["command"], "node");
    assert_eq!(config["args"], serde_json::json!(["/current/browser.js"]));
    let McpTransport::Stdio { env, .. } = &updated.transport else {
        panic!("expected stdio")
    };
    assert_eq!(config["env"], serde_json::to_value(env).unwrap());
    assert_eq!(config["env"]["CANONICAL_ONLY"], "canonical");
    assert_eq!(config["env"]["LEGACY_ONLY"], "legacy");
    assert_eq!(config["env"]["REQUEST_ONLY"], "request");

    // Model JsonImportModal opening stored JSON and saving its parsed transport.
    let roundtrip = svc
        .edit_server(
            TEST_USER_ID,
            &updated.id,
            UpdateMcpServerRequest {
                name: Some("openh3-browser".into()),
                description: None,
                transport: Some(McpTransport::Stdio {
                    command: config["command"].as_str().unwrap().into(),
                    args: serde_json::from_value(config["args"].clone()).unwrap(),
                    env: serde_json::from_value(config["env"].clone()).unwrap(),
                }),
                original_json: Some(Some(original.clone())),
                builtin: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&roundtrip.transport).unwrap(),
        serde_json::to_value(&updated.transport).unwrap()
    );
    assert_eq!(roundtrip.original_json, updated.original_json);
}

#[tokio::test]
async fn builtin_rename_only_regenerates_existing_original_json_with_canonical_key() {
    let svc = make_service().await;
    let mut request = stdio_req("aionui-video-media");
    request.builtin = true;
    request.original_json = Some(
        serde_json::json!({
            "mcpServers": { "aionui-video-media": {
                "command": "stale-command", "env": {}, "timeout": 30,
            } },
        })
        .to_string(),
    );
    if let McpTransport::Stdio { env, .. } = &mut request.transport {
        env.insert("USER_SETTING".into(), "retain".into());
    }
    let created = svc.add_server(TEST_USER_ID, request).await.unwrap();
    let updated = svc
        .edit_server(
            TEST_USER_ID,
            &created.id,
            UpdateMcpServerRequest {
                name: Some("openh3-video-media".into()),
                description: None,
                transport: None,
                original_json: None,
                builtin: Some(true),
            },
        )
        .await
        .unwrap();
    let original: serde_json::Value = serde_json::from_str(updated.original_json.as_deref().unwrap()).unwrap();
    let config = &original["mcpServers"]["openh3-video-media"];
    assert!(original["mcpServers"].get("aionui-video-media").is_none());
    assert_eq!(config["command"], "npx");
    assert_eq!(config["env"]["USER_SETTING"], "retain");
    assert_eq!(config["timeout"], 30);
    assert_eq!(
        serde_json::to_value(&updated.transport).unwrap(),
        serde_json::to_value(&created.transport).unwrap()
    );
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

#[tokio::test]
async fn delete_removes_server() {
    let svc = make_service().await;
    let created = svc.add_server(TEST_USER_ID, stdio_req("del")).await.unwrap();
    let was_enabled = svc.delete_server(TEST_USER_ID, &created.id).await.unwrap();
    assert!(!was_enabled);

    let err = svc.get_server(TEST_USER_ID, &created.id).await.unwrap_err();
    assert!(matches!(err, McpError::NotFound(_)));
}

#[tokio::test]
async fn delete_enabled_returns_true() {
    let svc = make_service().await;
    let created = svc.add_server(TEST_USER_ID, stdio_req("del-en")).await.unwrap();
    svc.toggle_server(TEST_USER_ID, &created.id).await.unwrap();

    let was_enabled = svc.delete_server(TEST_USER_ID, &created.id).await.unwrap();
    assert!(was_enabled);
}

#[tokio::test]
async fn delete_not_found() {
    let svc = make_service().await;
    let err = svc.delete_server(TEST_USER_ID, "nonexistent").await.unwrap_err();
    assert!(matches!(err, McpError::NotFound(_)));
}

// ---------------------------------------------------------------------------
// Toggle
// ---------------------------------------------------------------------------

#[tokio::test]
async fn toggle_enables_then_disables() {
    let svc = make_service().await;
    let created = svc.add_server(TEST_USER_ID, stdio_req("tog")).await.unwrap();
    assert!(!created.enabled);

    let toggled = svc.toggle_server(TEST_USER_ID, &created.id).await.unwrap();
    assert!(toggled.enabled);

    let toggled_back = svc.toggle_server(TEST_USER_ID, &created.id).await.unwrap();
    assert!(!toggled_back.enabled);
}

// ---------------------------------------------------------------------------
// Batch import
// ---------------------------------------------------------------------------

#[tokio::test]
async fn batch_import_creates_and_upserts() {
    let svc = make_service().await;
    svc.add_server(TEST_USER_ID, stdio_req("existing")).await.unwrap();

    let req = BatchImportMcpServersRequest {
        servers: vec![
            http_import_req("existing"), // upsert
            stdio_import_req("new"),     // create
        ],
    };
    let results = svc.batch_import(TEST_USER_ID, req).await.unwrap();
    assert_eq!(results.len(), 2);

    let all = svc.list_servers(TEST_USER_ID).await.unwrap();
    assert_eq!(all.len(), 2);
}

#[tokio::test]
async fn batch_import_preserves_enabled_in_database() {
    let svc = make_service().await;
    let mut req = stdio_import_req("enabled-db-mcp");
    req.enabled = Some(true);

    let result = svc
        .batch_import(TEST_USER_ID, BatchImportMcpServersRequest { servers: vec![req] })
        .await
        .unwrap();

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].name, "enabled-db-mcp");
    assert!(result[0].enabled);

    let listed = svc.list_servers(TEST_USER_ID).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert!(listed[0].enabled);
}
