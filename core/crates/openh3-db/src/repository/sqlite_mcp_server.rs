use std::collections::HashMap;

use openh3_common::TimestampMs;
use sqlx::QueryBuilder;
use sqlx::SqlitePool;

use crate::error::DbError;
use crate::models::McpServerRow;
use crate::repository::mcp_server::{CreateMcpServerParams, IMcpServerRepository, UpdateMcpServerParams};

/// SQLite-backed implementation of [`IMcpServerRepository`].
#[derive(Clone, Debug)]
pub struct SqliteMcpServerRepository {
    pool: SqlitePool,
}

impl SqliteMcpServerRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

#[async_trait::async_trait]
impl IMcpServerRepository for SqliteMcpServerRepository {
    async fn list(&self, user_id: &str) -> Result<Vec<McpServerRow>, DbError> {
        let rows = sqlx::query_as::<_, McpServerRow>(
            "SELECT * FROM mcp_servers WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, rowid ASC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows)
    }

    async fn find_by_id(&self, user_id: &str, id: &str) -> Result<Option<McpServerRow>, DbError> {
        let row = sqlx::query_as::<_, McpServerRow>(
            "SELECT * FROM mcp_servers WHERE user_id = ? AND id = ? AND deleted_at IS NULL",
        )
        .bind(user_id)
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row)
    }

    async fn find_by_name(&self, user_id: &str, name: &str) -> Result<Option<McpServerRow>, DbError> {
        let row = sqlx::query_as::<_, McpServerRow>(
            "SELECT * FROM mcp_servers WHERE user_id = ? AND name = ? AND deleted_at IS NULL",
        )
        .bind(user_id)
        .bind(name)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row)
    }

    async fn find_by_id_any(&self, user_id: &str, id: &str) -> Result<Option<McpServerRow>, DbError> {
        let row = sqlx::query_as::<_, McpServerRow>("SELECT * FROM mcp_servers WHERE user_id = ? AND id = ?")
            .bind(user_id)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;

        Ok(row)
    }

    async fn find_by_name_any(&self, user_id: &str, name: &str) -> Result<Option<McpServerRow>, DbError> {
        let row = sqlx::query_as::<_, McpServerRow>("SELECT * FROM mcp_servers WHERE user_id = ? AND name = ?")
            .bind(user_id)
            .bind(name)
            .fetch_optional(&self.pool)
            .await?;

        Ok(row)
    }

    async fn list_by_ids_any(&self, user_id: &str, ids: &[String]) -> Result<Vec<McpServerRow>, DbError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }

        let mut query = QueryBuilder::new("SELECT * FROM mcp_servers WHERE user_id = ");
        query.push_bind(user_id);
        query.push(" AND id IN (");
        let mut separated = query.separated(", ");
        for id in ids {
            separated.push_bind(id);
        }
        separated.push_unseparated(") ORDER BY created_at ASC, rowid ASC");

        let rows = query.build_query_as::<McpServerRow>().fetch_all(&self.pool).await?;
        let rows_by_id: HashMap<_, _> = rows.into_iter().map(|row| (row.id.clone(), row)).collect();

        Ok(ids.iter().filter_map(|id| rows_by_id.get(id).cloned()).collect())
    }

    async fn create(&self, params: CreateMcpServerParams<'_>) -> Result<McpServerRow, DbError> {
        let id = openh3_common::generate_prefixed_id("mcp");
        let now = openh3_common::now_ms();
        let last_test_status = "disconnected";

        sqlx::query(
            "INSERT INTO mcp_servers \
                (id, user_id, name, description, enabled, transport_type, transport_config, \
                 tools, last_test_status, last_connected, original_json, builtin, \
                 deleted_at, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(params.user_id)
        .bind(params.name)
        .bind(params.description)
        .bind(params.enabled)
        .bind(params.transport_type)
        .bind(params.transport_config)
        .bind(params.tools)
        .bind(last_test_status)
        .bind(Option::<TimestampMs>::None)
        .bind(params.original_json)
        .bind(params.builtin)
        .bind(Option::<TimestampMs>::None)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(db_err) if is_unique_violation(db_err.as_ref()) => {
                DbError::Conflict(format!("MCP server name '{}' already exists", params.name))
            }
            _ => DbError::Query(e),
        })?;

        Ok(McpServerRow {
            id,
            user_id: params.user_id.to_string(),
            name: params.name.to_string(),
            description: params.description.map(String::from),
            enabled: params.enabled,
            transport_type: params.transport_type.to_string(),
            transport_config: params.transport_config.to_string(),
            tools: params.tools.map(String::from),
            last_test_status: last_test_status.to_string(),
            last_connected: None,
            original_json: params.original_json.map(String::from),
            builtin: params.builtin,
            deleted_at: None,
            created_at: now,
            updated_at: now,
        })
    }

    async fn update(
        &self,
        user_id: &str,
        id: &str,
        params: UpdateMcpServerParams<'_>,
    ) -> Result<McpServerRow, DbError> {
        let existing = self
            .find_by_id_any(user_id, id)
            .await?
            .ok_or_else(|| DbError::NotFound(format!("MCP server '{id}' not found")))?;

        let merged = merge_update(existing, params);

        sqlx::query(
            "UPDATE mcp_servers SET \
                name = ?, description = ?, enabled = ?, transport_type = ?, \
                transport_config = ?, tools = ?, original_json = ?, \
                builtin = ?, deleted_at = ?, updated_at = ? \
             WHERE user_id = ? AND id = ?",
        )
        .bind(&merged.name)
        .bind(&merged.description)
        .bind(merged.enabled)
        .bind(&merged.transport_type)
        .bind(&merged.transport_config)
        .bind(&merged.tools)
        .bind(&merged.original_json)
        .bind(merged.builtin)
        .bind(merged.deleted_at)
        .bind(merged.updated_at)
        .bind(user_id)
        .bind(id)
        .execute(&self.pool)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(db_err) if is_unique_violation(db_err.as_ref()) => {
                DbError::Conflict(format!("MCP server name '{}' already exists", merged.name))
            }
            _ => DbError::Query(e),
        })?;

        Ok(merged)
    }

    async fn merge_builtin_duplicate(
        &self,
        user_id: &str,
        survivor: &McpServerRow,
        duplicate: &McpServerRow,
        params: UpdateMcpServerParams<'_>,
    ) -> Result<McpServerRow, DbError> {
        let mut tx = self.pool.begin().await?;
        let mut rows = Vec::with_capacity(2);
        for expected in [survivor, duplicate] {
            let stored = sqlx::query_as::<_, McpServerRow>("SELECT * FROM mcp_servers WHERE user_id = ? AND id = ?")
                .bind(user_id)
                .bind(&expected.id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| DbError::NotFound(format!("MCP server '{}' not found", expected.id)))?;
            if !snapshot_matches(&stored, expected) {
                return Err(DbError::Conflict(
                    "MCP server changed during builtin migration; reload and retry".into(),
                ));
            }
            rows.push(stored);
        }
        let duplicate = rows.pop().expect("duplicate was loaded");
        let survivor = rows.pop().expect("survivor was loaded");
        if survivor.id == duplicate.id
            || !survivor.builtin
            || !duplicate.builtin
            || survivor.deleted_at.is_some()
            || params.name != Some(duplicate.name.as_str())
            || params.builtin == Some(false)
            || params.deleted_at.flatten().is_some()
        {
            return Err(DbError::Conflict(
                "Only distinct builtin MCP records can be merged".into(),
            ));
        }
        let enabled = survivor.enabled && duplicate.enabled && params.enabled.unwrap_or(true);
        let mut merged = merge_update(survivor, params);
        merged.enabled = enabled;
        let now = merged.updated_at;
        // Soft deletion alone cannot free UNIQUE(user_id, name). Keep the row/ID
        // for historical references, but reserve a unique tombstone name instead.
        let tombstone = format!("__openh3_merged__{}", duplicate.id);
        sqlx::query(
            "UPDATE mcp_servers SET name = ?, enabled = 0, deleted_at = COALESCE(deleted_at, ?), \
            updated_at = ? WHERE user_id = ? AND id = ?",
        )
        .bind(&tombstone)
        .bind(now)
        .bind(now)
        .bind(user_id)
        .bind(&duplicate.id)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "UPDATE mcp_servers SET name = ?, description = ?, enabled = ?, transport_type = ?, \
            transport_config = ?, tools = ?, original_json = ?, builtin = ?, deleted_at = ?, updated_at = ? \
            WHERE user_id = ? AND id = ?",
        )
        .bind(&merged.name)
        .bind(&merged.description)
        .bind(merged.enabled)
        .bind(&merged.transport_type)
        .bind(&merged.transport_config)
        .bind(&merged.tools)
        .bind(&merged.original_json)
        .bind(merged.builtin)
        .bind(merged.deleted_at)
        .bind(merged.updated_at)
        .bind(user_id)
        .bind(&merged.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(merged)
    }

    async fn delete(&self, user_id: &str, id: &str) -> Result<(), DbError> {
        let now = openh3_common::now_ms();
        let result = sqlx::query(
            "UPDATE mcp_servers SET enabled = 0, deleted_at = ?, updated_at = ? \
             WHERE user_id = ? AND id = ? AND deleted_at IS NULL",
        )
        .bind(now)
        .bind(now)
        .bind(user_id)
        .bind(id)
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 0 {
            return Err(DbError::NotFound(format!("MCP server '{id}' not found")));
        }

        Ok(())
    }

    async fn batch_upsert(
        &self,
        user_id: &str,
        servers: &[CreateMcpServerParams<'_>],
    ) -> Result<Vec<McpServerRow>, DbError> {
        let mut results = Vec::with_capacity(servers.len());

        for params in servers {
            let row = match self.find_by_name(user_id, params.name).await? {
                Some(existing) => {
                    let update_params = UpdateMcpServerParams {
                        description: Some(params.description),
                        enabled: Some(params.enabled),
                        transport_type: Some(params.transport_type),
                        transport_config: Some(params.transport_config),
                        tools: Some(params.tools),
                        original_json: Some(params.original_json),
                        builtin: Some(params.builtin),
                        ..Default::default()
                    };
                    self.update(user_id, &existing.id, update_params).await?
                }
                None => self.create(params.clone()).await?,
            };
            results.push(row);
        }

        Ok(results)
    }

    async fn update_status(
        &self,
        user_id: &str,
        id: &str,
        status: &str,
        last_connected: Option<TimestampMs>,
    ) -> Result<(), DbError> {
        let now = openh3_common::now_ms();

        let result = sqlx::query(
            "UPDATE mcp_servers SET last_test_status = ?, \
             last_connected = COALESCE(?, last_connected), \
	             updated_at = ? WHERE user_id = ? AND id = ? AND deleted_at IS NULL",
        )
        .bind(status)
        .bind(last_connected)
        .bind(now)
        .bind(user_id)
        .bind(id)
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 0 {
            return Err(DbError::NotFound(format!("MCP server '{id}' not found")));
        }

        Ok(())
    }

    async fn update_tools(&self, user_id: &str, id: &str, tools: Option<&str>) -> Result<(), DbError> {
        let now = openh3_common::now_ms();

        let result = sqlx::query(
            "UPDATE mcp_servers SET tools = ?, updated_at = ? \
             WHERE user_id = ? AND id = ? AND deleted_at IS NULL",
        )
        .bind(tools)
        .bind(now)
        .bind(user_id)
        .bind(id)
        .execute(&self.pool)
        .await?;

        if result.rows_affected() == 0 {
            return Err(DbError::NotFound(format!("MCP server '{id}' not found")));
        }

        Ok(())
    }
}

/// Merge partial update params into an existing row, returning a new instance.
fn merge_update(existing: McpServerRow, params: UpdateMcpServerParams<'_>) -> McpServerRow {
    let now = openh3_common::now_ms();
    McpServerRow {
        id: existing.id,
        user_id: existing.user_id,
        name: params.name.unwrap_or(&existing.name).to_string(),
        description: params.description.map_or(existing.description, |v| v.map(String::from)),
        enabled: params.enabled.unwrap_or(existing.enabled),
        transport_type: params.transport_type.unwrap_or(&existing.transport_type).to_string(),
        transport_config: params
            .transport_config
            .unwrap_or(&existing.transport_config)
            .to_string(),
        tools: params.tools.map_or(existing.tools, |v| v.map(String::from)),
        last_test_status: existing.last_test_status,
        last_connected: existing.last_connected,
        original_json: params
            .original_json
            .map_or(existing.original_json, |v| v.map(String::from)),
        builtin: params.builtin.unwrap_or(existing.builtin),
        deleted_at: params.deleted_at.map_or(existing.deleted_at, |v| v),
        created_at: existing.created_at,
        updated_at: now,
    }
}

fn snapshot_matches(stored: &McpServerRow, expected: &McpServerRow) -> bool {
    stored.id == expected.id
        && stored.user_id == expected.user_id
        && stored.name == expected.name
        && stored.description == expected.description
        && stored.enabled == expected.enabled
        && stored.transport_type == expected.transport_type
        && stored.transport_config == expected.transport_config
        && stored.tools == expected.tools
        && stored.original_json == expected.original_json
        && stored.builtin == expected.builtin
        && stored.deleted_at == expected.deleted_at
        && stored.created_at == expected.created_at
        && stored.updated_at == expected.updated_at
        && stored.last_test_status == expected.last_test_status
        && stored.last_connected == expected.last_connected
}

fn is_unique_violation(err: &dyn sqlx::error::DatabaseError) -> bool {
    err.code().is_some_and(|c| c == "2067")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::init_database_memory;

    const USER_A: &str = "system_default_user";
    const USER_B: &str = "user_b";

    async fn setup() -> (SqliteMcpServerRepository, crate::Database) {
        let db = init_database_memory().await.unwrap();
        sqlx::query(
            "INSERT INTO users (id, user_type, username, password_hash, status, session_generation, created_at, updated_at) \
             VALUES (?, 'local', ?, 'hash', 'active', 0, 1, 1)",
        )
        .bind(USER_B)
        .bind(USER_B)
        .execute(db.pool())
        .await
        .unwrap();
        let repo = SqliteMcpServerRepository::new(db.pool().clone());
        (repo, db)
    }

    fn stdio_params() -> CreateMcpServerParams<'static> {
        CreateMcpServerParams {
            user_id: USER_A,
            name: "test-mcp",
            description: Some("A test MCP server"),
            enabled: false,
            transport_type: "stdio",
            transport_config: r#"{"command":"npx","args":["-y","test-server"]}"#,
            tools: None,
            original_json: Some(r#"{"name":"test-mcp"}"#),
            builtin: false,
        }
    }

    fn http_params() -> CreateMcpServerParams<'static> {
        CreateMcpServerParams {
            user_id: USER_A,
            name: "http-mcp",
            description: None,
            enabled: true,
            transport_type: "http",
            transport_config: r#"{"url":"https://example.com/mcp"}"#,
            tools: None,
            original_json: None,
            builtin: false,
        }
    }

    #[tokio::test]
    async fn list_empty() {
        let (repo, _db) = setup().await;
        let servers = repo.list(USER_A).await.unwrap();
        assert!(servers.is_empty());
    }

    #[tokio::test]
    async fn create_returns_populated_fields() {
        let (repo, _db) = setup().await;
        let server = repo.create(stdio_params()).await.unwrap();

        assert!(server.id.starts_with("mcp_"));
        assert_eq!(server.name, "test-mcp");
        assert_eq!(server.description.as_deref(), Some("A test MCP server"));
        assert!(!server.enabled);
        assert_eq!(server.transport_type, "stdio");
        assert!(server.transport_config.contains("npx"));
        assert!(server.tools.is_none());
        assert_eq!(server.last_test_status, "disconnected");
        assert!(server.last_connected.is_none());
        assert!(server.original_json.is_some());
        assert!(!server.builtin);
        assert!(server.created_at > 0);
        assert_eq!(server.created_at, server.updated_at);
    }

    #[tokio::test]
    async fn create_duplicate_name_returns_conflict() {
        let (repo, _db) = setup().await;
        repo.create(stdio_params()).await.unwrap();

        let err = repo.create(stdio_params()).await.unwrap_err();
        assert!(matches!(err, DbError::Conflict(_)));
    }

    #[tokio::test]
    async fn find_by_id_returns_record() {
        let (repo, _db) = setup().await;
        let created = repo.create(stdio_params()).await.unwrap();

        let found = repo.find_by_id(USER_A, &created.id).await.unwrap().unwrap();
        assert_eq!(found.id, created.id);
        assert_eq!(found.name, "test-mcp");
    }

    #[tokio::test]
    async fn find_by_id_nonexistent() {
        let (repo, _db) = setup().await;
        assert!(repo.find_by_id(USER_A, "no_such_id").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn find_by_name_returns_record() {
        let (repo, _db) = setup().await;
        let created = repo.create(stdio_params()).await.unwrap();

        let found = repo.find_by_name(USER_A, "test-mcp").await.unwrap().unwrap();
        assert_eq!(found.id, created.id);
    }

    #[tokio::test]
    async fn find_by_name_nonexistent() {
        let (repo, _db) = setup().await;
        assert!(repo.find_by_name(USER_A, "nope").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn list_returns_all_ordered() {
        let (repo, _db) = setup().await;
        let s1 = repo.create(stdio_params()).await.unwrap();
        let s2 = repo.create(http_params()).await.unwrap();

        let all = repo.list(USER_A).await.unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, s1.id);
        assert_eq!(all[1].id, s2.id);
    }

    #[tokio::test]
    async fn update_partial_fields() {
        let (repo, _db) = setup().await;
        let created = repo.create(stdio_params()).await.unwrap();

        let updated = repo
            .update(
                USER_A,
                &created.id,
                UpdateMcpServerParams {
                    enabled: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert!(updated.enabled);
        assert_eq!(updated.name, "test-mcp");
        assert_eq!(updated.transport_type, "stdio");
        assert!(updated.updated_at >= created.updated_at);
    }

    #[tokio::test]
    async fn update_name_conflict_returns_conflict() {
        let (repo, _db) = setup().await;
        repo.create(stdio_params()).await.unwrap();
        let s2 = repo.create(http_params()).await.unwrap();

        let err = repo
            .update(
                USER_A,
                &s2.id,
                UpdateMcpServerParams {
                    name: Some("test-mcp"),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, DbError::Conflict(_)));
    }

    #[tokio::test]
    async fn update_clear_optional_fields() {
        let (repo, _db) = setup().await;
        let created = repo.create(stdio_params()).await.unwrap();
        assert!(created.description.is_some());

        let updated = repo
            .update(
                USER_A,
                &created.id,
                UpdateMcpServerParams {
                    description: Some(None),
                    original_json: Some(None),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert!(updated.description.is_none());
        assert!(updated.original_json.is_none());
    }

    #[tokio::test]
    async fn update_nonexistent_returns_not_found() {
        let (repo, _db) = setup().await;
        let err = repo
            .update(USER_A, "no_id", UpdateMcpServerParams::default())
            .await
            .unwrap_err();
        assert!(matches!(err, DbError::NotFound(_)));
    }

    #[tokio::test]
    async fn delete_existing() {
        let (repo, _db) = setup().await;
        let created = repo.create(stdio_params()).await.unwrap();

        repo.delete(USER_A, &created.id).await.unwrap();
        assert!(repo.find_by_id(USER_A, &created.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_nonexistent_returns_not_found() {
        let (repo, _db) = setup().await;
        let err = repo.delete(USER_A, "no_id").await.unwrap_err();
        assert!(matches!(err, DbError::NotFound(_)));
    }

    #[tokio::test]
    async fn batch_upsert_creates_new_and_updates_existing() {
        let (repo, _db) = setup().await;
        let existing = repo.create(stdio_params()).await.unwrap();
        assert!(!existing.enabled);

        let results = repo
            .batch_upsert(
                USER_A,
                &[
                    CreateMcpServerParams {
                        enabled: true,
                        ..stdio_params()
                    },
                    http_params(),
                ],
            )
            .await
            .unwrap();

        assert_eq!(results.len(), 2);
        // Existing was updated (same ID, enabled changed)
        assert_eq!(results[0].id, existing.id);
        assert!(results[0].enabled);
        // New was created
        assert_eq!(results[1].name, "http-mcp");
        assert!(results[1].id.starts_with("mcp_"));
    }

    #[tokio::test]
    async fn update_status_sets_status_and_last_connected() {
        let (repo, _db) = setup().await;
        let created = repo.create(stdio_params()).await.unwrap();

        let ts = openh3_common::now_ms();
        repo.update_status(USER_A, &created.id, "connected", Some(ts))
            .await
            .unwrap();

        let found = repo.find_by_id(USER_A, &created.id).await.unwrap().unwrap();
        assert_eq!(found.last_test_status, "connected");
        assert_eq!(found.last_connected, Some(ts));
    }

    #[tokio::test]
    async fn update_status_without_timestamp_preserves_existing() {
        let (repo, _db) = setup().await;
        let created = repo.create(stdio_params()).await.unwrap();

        let ts = openh3_common::now_ms();
        repo.update_status(USER_A, &created.id, "connected", Some(ts))
            .await
            .unwrap();

        repo.update_status(USER_A, &created.id, "error", None).await.unwrap();

        let found = repo.find_by_id(USER_A, &created.id).await.unwrap().unwrap();
        assert_eq!(found.last_test_status, "error");
        assert_eq!(found.last_connected, Some(ts));
    }

    #[tokio::test]
    async fn update_status_nonexistent_returns_not_found() {
        let (repo, _db) = setup().await;
        let err = repo
            .update_status(USER_A, "no_id", "connected", None)
            .await
            .unwrap_err();
        assert!(matches!(err, DbError::NotFound(_)));
    }

    #[tokio::test]
    async fn update_tools_sets_tools_json() {
        let (repo, _db) = setup().await;
        let created = repo.create(stdio_params()).await.unwrap();
        assert!(created.tools.is_none());

        let tools_json = r#"[{"name":"read_file","description":"Read a file"}]"#;
        repo.update_tools(USER_A, &created.id, Some(tools_json)).await.unwrap();

        let found = repo.find_by_id(USER_A, &created.id).await.unwrap().unwrap();
        assert_eq!(found.tools.as_deref(), Some(tools_json));
    }

    #[tokio::test]
    async fn update_tools_clear() {
        let (repo, _db) = setup().await;
        let created = repo
            .create(CreateMcpServerParams {
                tools: Some(r#"[{"name":"tool"}]"#),
                ..stdio_params()
            })
            .await
            .unwrap();
        assert!(created.tools.is_some());

        repo.update_tools(USER_A, &created.id, None).await.unwrap();

        let found = repo.find_by_id(USER_A, &created.id).await.unwrap().unwrap();
        assert!(found.tools.is_none());
    }

    #[tokio::test]
    async fn update_tools_nonexistent_returns_not_found() {
        let (repo, _db) = setup().await;
        let err = repo.update_tools(USER_A, "no_id", Some("[]")).await.unwrap_err();
        assert!(matches!(err, DbError::NotFound(_)));
    }

    #[tokio::test]
    async fn mcp_server_operations_are_scoped_by_user() {
        let (repo, _db) = setup().await;
        let server_a = repo.create(stdio_params()).await.unwrap();
        let server_b = repo
            .create(CreateMcpServerParams {
                user_id: USER_B,
                ..stdio_params()
            })
            .await
            .unwrap();

        assert_ne!(server_a.id, server_b.id);
        assert_eq!(repo.list(USER_A).await.unwrap().len(), 1);
        assert_eq!(repo.list(USER_B).await.unwrap().len(), 1);
        assert!(repo.find_by_id(USER_B, &server_a.id).await.unwrap().is_none());
        assert_eq!(
            repo.find_by_name(USER_B, "test-mcp").await.unwrap().unwrap().id,
            server_b.id
        );

        let err = repo
            .update(
                USER_B,
                &server_a.id,
                UpdateMcpServerParams {
                    enabled: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(err, DbError::NotFound(_)));

        repo.delete(USER_B, &server_b.id).await.unwrap();
        assert_eq!(repo.list(USER_A).await.unwrap().len(), 1);
        assert!(repo.list(USER_B).await.unwrap().is_empty());
    }

    async fn builtin_pair(repo: &SqliteMcpServerRepository) -> (McpServerRow, McpServerRow) {
        let legacy = repo
            .create(CreateMcpServerParams {
                name: "aionui-browser",
                builtin: true,
                enabled: true,
                ..stdio_params()
            })
            .await
            .unwrap();
        let canonical = repo
            .create(CreateMcpServerParams {
                name: "openh3-browser",
                builtin: true,
                ..stdio_params()
            })
            .await
            .unwrap();
        (legacy, canonical)
    }

    #[tokio::test]
    async fn builtin_merge_keeps_survivor_and_tombstones_duplicate() {
        let (repo, _db) = setup().await;
        let (legacy, canonical) = builtin_pair(&repo).await;
        let merged = repo
            .merge_builtin_duplicate(
                USER_A,
                &legacy,
                &canonical,
                UpdateMcpServerParams {
                    name: Some("openh3-browser"),
                    enabled: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(merged.id, legacy.id);
        assert_eq!(merged.name, "openh3-browser");
        assert!(!merged.enabled);
        assert_eq!(repo.list(USER_A).await.unwrap().len(), 1);
        let retired = repo.find_by_id_any(USER_A, &canonical.id).await.unwrap().unwrap();
        assert!(!retired.enabled);
        assert!(retired.deleted_at.is_some());
        assert_ne!(retired.name, canonical.name);
    }

    #[tokio::test]
    async fn builtin_merge_rolls_back_retirement_if_survivor_write_fails() {
        let (repo, db) = setup().await;
        let (legacy, canonical) = builtin_pair(&repo).await;
        sqlx::query(
            "CREATE TRIGGER reject_builtin_rename BEFORE UPDATE OF name ON mcp_servers \
            WHEN OLD.name = 'aionui-browser' BEGIN SELECT RAISE(ABORT, 'fixture survivor write failure'); END",
        )
        .execute(db.pool())
        .await
        .unwrap();
        let error = repo
            .merge_builtin_duplicate(
                USER_A,
                &legacy,
                &canonical,
                UpdateMcpServerParams {
                    name: Some("openh3-browser"),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("fixture survivor write failure"), "{error}");
        assert_eq!(repo.list(USER_A).await.unwrap().len(), 2);
        assert_eq!(
            repo.find_by_id(USER_A, &legacy.id).await.unwrap().unwrap().name,
            legacy.name
        );
        assert_eq!(
            repo.find_by_id(USER_A, &canonical.id).await.unwrap().unwrap().name,
            canonical.name
        );
    }

    #[tokio::test]
    async fn builtin_merge_rejects_foreign_user_and_stale_snapshots() {
        let (repo, _db) = setup().await;
        let (legacy, canonical) = builtin_pair(&repo).await;
        let error = repo
            .merge_builtin_duplicate(
                USER_B,
                &legacy,
                &canonical,
                UpdateMcpServerParams {
                    name: Some("openh3-browser"),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(error, DbError::NotFound(_)), "{error}");
        repo.update(
            USER_A,
            &canonical.id,
            UpdateMcpServerParams {
                enabled: Some(true),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let error = repo
            .merge_builtin_duplicate(
                USER_A,
                &legacy,
                &canonical,
                UpdateMcpServerParams {
                    name: Some("openh3-browser"),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(error, DbError::Conflict(_)), "{error}");
        assert_eq!(repo.list(USER_A).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn builtin_merge_rejects_user_owned_canonical() {
        let (repo, _db) = setup().await;
        let (legacy, mut canonical) = builtin_pair(&repo).await;
        canonical = repo
            .update(
                USER_A,
                &canonical.id,
                UpdateMcpServerParams {
                    builtin: Some(false),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let error = repo
            .merge_builtin_duplicate(
                USER_A,
                &legacy,
                &canonical,
                UpdateMcpServerParams {
                    name: Some("openh3-browser"),
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(matches!(error, DbError::Conflict(_)), "{error}");
        assert_eq!(repo.list(USER_A).await.unwrap().len(), 2);
    }
}
