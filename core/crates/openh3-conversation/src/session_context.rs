use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Datelike;
use openh3_ai_agent::session_context::{
    AcpSessionBuildContext, AgentSessionContext, AgentSessionKind, AionrsSessionBuildContext,
    AntigravitySessionBuildContext, ConversationContext, WorkspaceContext,
};
use openh3_ai_agent::shared_kernel::{ConfigKey, ConfigValue, ModeId, ModelId, PersistedSessionState};
use openh3_ai_agent::types::BuildTaskOptions;
use openh3_api_types::{AcpBuildExtra, AionrsBuildExtra, TeamSessionBinding};
use openh3_common::{AgentType, WorkspacePathValidationError, validate_workspace_path_availability};
use openh3_db::models::ConversationRow;
use openh3_db::{IAcpSessionRepository, IAgentMetadataRepository};
use tracing::{debug, info, warn};

use crate::convert::string_to_enum;
use crate::error::ConversationError;
use crate::task_options::provider_model_from_conversation_row;

const LEGACY_CONVERSATION_ARCHIVED_MESSAGE: &str =
    "This historical conversation can no longer be continued. Please start a new conversation.";

pub(crate) struct SessionContextBuilder<'a> {
    workspace_root: &'a Path,
    agent_metadata_repo: &'a Arc<dyn IAgentMetadataRepository>,
    acp_session_repo: &'a Arc<dyn IAcpSessionRepository>,
}

impl<'a> SessionContextBuilder<'a> {
    pub(crate) fn new(
        workspace_root: &'a Path,
        agent_metadata_repo: &'a Arc<dyn IAgentMetadataRepository>,
        acp_session_repo: &'a Arc<dyn IAcpSessionRepository>,
    ) -> Self {
        Self {
            workspace_root,
            agent_metadata_repo,
            acp_session_repo,
        }
    }

    pub(crate) async fn build_options(
        &self,
        row: &ConversationRow,
        seed: Option<AionrsRuntimePermissionSeed>,
    ) -> Result<BuildTaskOptions, ConversationError> {
        Ok(BuildTaskOptions::new(
            self.build_with_workspace_override(row, None, seed).await?,
        ))
    }

    pub(crate) async fn build_options_with_workspace_override(
        &self,
        row: &ConversationRow,
        workspace_override: Option<&str>,
        seed: Option<AionrsRuntimePermissionSeed>,
    ) -> Result<BuildTaskOptions, ConversationError> {
        Ok(BuildTaskOptions::new(
            self.build_with_workspace_override(row, workspace_override, seed)
                .await?,
        ))
    }

    /// Test-only convenience wrapper. Production entry points thread a real
    /// permission seed via `build_options*`; tests exercise the default
    /// (no-seed) path.
    #[cfg(test)]
    async fn build(&self, row: &ConversationRow) -> Result<AgentSessionContext, ConversationError> {
        self.build_with_workspace_override(row, None, None).await
    }

    async fn build_with_workspace_override(
        &self,
        row: &ConversationRow,
        workspace_override: Option<&str>,
        seed: Option<AionrsRuntimePermissionSeed>,
    ) -> Result<AgentSessionContext, ConversationError> {
        let agent_type: AgentType = string_to_enum(&row.r#type)?;
        reject_deprecated_runtime_kind(row, &agent_type)?;
        let extra = parse_extra(row)?;
        let workspace = self.resolve_workspace(row, &agent_type, &extra, workspace_override)?;
        let model = provider_model_from_conversation_row(row);
        let skills = parse_string_array(extra.get("skills").cloned()).unwrap_or_default();
        let team = TeamSessionBinding::from_extra_value(&extra).map_err(|e| ConversationError::BadRequest {
            reason: format!("Invalid Team runtime context: {e}"),
        })?;
        let kind = self.build_kind(row, &agent_type, extra, team.clone(), seed).await?;

        Ok(AgentSessionContext {
            conversation: ConversationContext {
                conversation_id: row.id.clone(),
                user_id: row.user_id.clone(),
                agent_type,
                source: row.source.clone(),
            },
            workspace,
            model,
            skills,
            runtime_env: Vec::new(),
            team,
            kind,
        })
    }

    fn resolve_workspace(
        &self,
        row: &ConversationRow,
        agent_type: &AgentType,
        extra: &serde_json::Value,
        workspace_override: Option<&str>,
    ) -> Result<WorkspaceContext, ConversationError> {
        let expected_auto_workspace = expected_auto_workspace_path(
            self.workspace_root,
            &row.user_id,
            &row.id,
            agent_type,
            extra.get("backend"),
        );
        let existing_stored_path = extra
            .get("workspace")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned();

        if let Some(override_path) = workspace_override.map(str::trim).filter(|value| !value.is_empty()) {
            let normalized = match validate_workspace_path_availability(override_path) {
                Ok(normalized) => normalized,
                Err(error) => {
                    log_workspace_path_check(&row.id, &error);
                    return Err(map_runtime_workspace_validation_error(error));
                }
            };
            return Ok(WorkspaceContext {
                path: normalized,
                stored_path: existing_stored_path,
                is_custom: true,
            });
        }

        let stored = extra
            .get("workspace")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty());

        let Some(stored_path) = stored else {
            std::fs::create_dir_all(&expected_auto_workspace)
                .map_err(|e| ConversationError::internal(format!("Failed to create workspace: {e}")))?;
            return Ok(WorkspaceContext {
                path: expected_auto_workspace.to_string_lossy().into_owned(),
                stored_path: String::new(),
                is_custom: false,
            });
        };

        let normalized = match validate_workspace_path_availability(stored_path) {
            Ok(normalized) => normalized,
            Err(WorkspacePathValidationError::DoesNotExist(_))
                if let Some(relocated) = relocated_auto_workspace(
                    self.workspace_root,
                    &row.id,
                    agent_type,
                    extra.get("backend"),
                    Path::new(stored_path),
                ) =>
            {
                info!(conversation_id = %row.id, "Resolved existing auto workspace after data directory relocation");
                relocated.to_string_lossy().into_owned()
            }
            Err(WorkspacePathValidationError::DoesNotExist(path))
                if is_auto_workspace(
                    self.workspace_root,
                    &row.id,
                    agent_type,
                    extra.get("backend"),
                    Path::new(stored_path),
                ) =>
            {
                path
            }
            Err(error) => {
                log_workspace_path_check(&row.id, &error);
                return Err(map_runtime_workspace_validation_error(error));
            }
        };

        Ok(WorkspaceContext {
            is_custom: !is_auto_workspace(
                self.workspace_root,
                &row.id,
                agent_type,
                extra.get("backend"),
                Path::new(&normalized),
            ),
            stored_path: stored_path.to_owned(),
            path: normalized,
        })
    }

    async fn build_kind(
        &self,
        row: &ConversationRow,
        agent_type: &AgentType,
        extra: serde_json::Value,
        team: Option<TeamSessionBinding>,
        seed: Option<AionrsRuntimePermissionSeed>,
    ) -> Result<AgentSessionKind, ConversationError> {
        match agent_type {
            AgentType::Acp => self
                .build_acp_context(row, extra, team)
                .await
                .map(|context| AgentSessionKind::Acp(Box::new(context))),
            AgentType::Aionrs => Ok(AgentSessionKind::Aionrs(Box::new(build_aionrs_context(
                row, extra, team, seed,
            )))),
            // Antigravity reuses the ACP build context's SHAPE (a CLI agent with
            // a workspace, MCP servers, skills and a resume anchor) but never the
            // ACP factory: agy does not speak ACP.
            AgentType::Antigravity => {
                let acp = self.build_acp_context(row, extra, team).await?;
                Ok(AgentSessionKind::Antigravity(Box::new(
                    AntigravitySessionBuildContext {
                        config: acp.config,
                        team: acp.team,
                        belongs_to_team: acp.belongs_to_team,
                        session_id: acp.session_id,
                        session_snapshot: acp.session_snapshot,
                    },
                )))
            }
            AgentType::Gemini
            | AgentType::Codex
            | AgentType::OpenclawGateway
            | AgentType::Remote
            | AgentType::Nanobot => {
                unreachable!("legacy agent types are rejected before build_kind")
            }
        }
    }

    async fn build_acp_context(
        &self,
        row: &ConversationRow,
        extra: serde_json::Value,
        team: Option<TeamSessionBinding>,
    ) -> Result<AcpSessionBuildContext, ConversationError> {
        let mut config: AcpBuildExtra =
            serde_json::from_value(extra.clone()).map_err(|e| ConversationError::BadRequest {
                reason: format!("Invalid ACP build options: {e}"),
            })?;
        config.user_id = Some(row.user_id.clone());
        apply_team_seed_to_acp_config(&team, &mut config);
        normalize_cron_alias(row, &extra, &mut config.cron_job_id);

        if config.session_mode.is_none()
            && let Some(mode) = extra
                .get("current_mode_id")
                .and_then(serde_json::Value::as_str)
                .filter(|value| !value.is_empty())
        {
            debug!(
                conversation_id = %row.id,
                "session_context: using legacy ACP extra.current_mode_id as startup seed"
            );
            config.session_mode = Some(mode.to_owned());
        }

        let belongs_to_team = team.is_some();
        let session_row = self
            .acp_session_repo
            .get_for_user(&row.user_id, &row.id)
            .await
            .map_err(|e| ConversationError::internal(format!("Failed to load acp_session row: {e}")))?;
        self.resolve_acp_identity(row, &mut config, &extra, session_row.as_ref())
            .await?;
        let session_id = session_row.as_ref().and_then(|row| row.session_id.clone());
        let session_snapshot = self
            .load_acp_session_snapshot(&row.user_id, &row.id, &config, session_id.as_deref())
            .await?;

        Ok(AcpSessionBuildContext {
            config,
            team,
            belongs_to_team,
            session_id,
            session_snapshot,
        })
    }

    async fn resolve_acp_identity(
        &self,
        row: &ConversationRow,
        config: &mut AcpBuildExtra,
        extra: &serde_json::Value,
        session_row: Option<&openh3_db::models::AcpSessionRow>,
    ) -> Result<(), ConversationError> {
        let agent_id = config.agent_id.as_deref().filter(|value| !value.is_empty());
        if agent_id.is_some() {
            return Ok(());
        }

        if let Some(session_row) = session_row.filter(|row| !row.agent_id.is_empty()) {
            let metadata = self
                .agent_metadata_repo
                .get_for_user(&row.user_id, &session_row.agent_id)
                .await
                .map_err(|e| ConversationError::internal(format!("agent_metadata lookup: {e}")))?;
            debug!(
                conversation_id = %row.id,
                agent_id = %session_row.agent_id,
                "session_context: restored ACP identity from persisted acp_session row"
            );
            config.agent_id = Some(session_row.agent_id.clone());
            if let Some(metadata) = metadata {
                config.backend = metadata.backend;
            }
            return Ok(());
        }

        let backend = config.backend.as_deref().filter(|value| !value.is_empty());
        let agent_source = extra
            .get("agent_source")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("builtin");

        if agent_source != "builtin" {
            return Err(ConversationError::BadRequest {
                reason: "ACP non-builtin agent requires agent_id in extra".to_owned(),
            });
        }

        let Some(backend) = backend else {
            return Ok(());
        };

        let Some(row_meta) = self
            .agent_metadata_repo
            .find_builtin_by_backend_for_user(&row.user_id, backend)
            .await
            .map_err(|e| ConversationError::internal(format!("agent_metadata lookup: {e}")))?
        else {
            debug!(
                conversation_id = %row.id,
                backend,
                "session_context: legacy ACP backend fallback left for factory resolution"
            );
            return Ok(());
        };

        debug!(
            conversation_id = %row.id,
            backend,
            "session_context: resolved legacy ACP backend fallback"
        );
        config.agent_id = Some(row_meta.id);
        Ok(())
    }

    async fn load_acp_session_snapshot(
        &self,
        user_id: &str,
        conversation_id: &str,
        config: &AcpBuildExtra,
        session_id: Option<&str>,
    ) -> Result<Option<PersistedSessionState>, ConversationError> {
        if session_id.is_none() {
            debug!(
                conversation_id,
                "session_context: skipping ACP runtime snapshot before session assignment"
            );
            return Ok(None);
        }

        let db_state = self
            .acp_session_repo
            .load_runtime_state_for_user(user_id, conversation_id)
            .await
            .map_err(|e| ConversationError::internal(format!("Failed to load acp_session runtime state: {e}")))?;
        let snapshot = db_state.map(decode_persisted_session_state);
        if snapshot
            .as_ref()
            .and_then(|state| state.current_model_id.as_ref())
            .is_none()
            && config
                .current_model_id
                .as_deref()
                .is_some_and(|value| !value.is_empty())
        {
            debug!(
                conversation_id,
                "session_context: using legacy ACP extra.current_model_id as startup seed"
            );
        }
        Ok(snapshot)
    }

    /// Re-resolve ONLY the resume anchor (`session_id` + its runtime snapshot)
    /// into an already-built `BuildTaskOptions`, leaving every turn-scoped field
    /// (model, skills, workspace, config) frozen.
    ///
    /// Used by the turn orchestrator's auto-replay (ELECTRON-3Q0): the turn-start
    /// snapshot deliberately freezes the turn's parameters, but the resume anchor
    /// is backend CONNECTION state — attempt 1's dead-anchor self-heal clears
    /// `acp_session.session_id` mid-turn, and the replay must see that clear.
    /// Replaying the frozen snapshot re-resumed the same dead session and failed
    /// identically, defeating the self-heal. Non-ACP kinds carry no anchor → no-op.
    pub(crate) async fn refresh_resume_anchor(
        &self,
        conversation_id: &str,
        options: &mut BuildTaskOptions,
    ) -> Result<(), ConversationError> {
        let user_id = options.context.conversation.user_id.clone();
        let AgentSessionKind::Acp(ctx) = &mut options.context.kind else {
            return Ok(());
        };
        let session_row = self
            .acp_session_repo
            .get_for_user(&user_id, conversation_id)
            .await
            .map_err(|e| ConversationError::internal(format!("Failed to load acp_session row: {e}")))?;
        let session_id = session_row.as_ref().and_then(|row| row.session_id.clone());
        if session_id == ctx.session_id {
            return Ok(());
        }
        let session_snapshot = self
            .load_acp_session_snapshot(&user_id, conversation_id, &ctx.config, session_id.as_deref())
            .await?;
        info!(
            conversation_id,
            had_anchor = ctx.session_id.is_some(),
            has_anchor = session_id.is_some(),
            "session_context: refreshed resume anchor for replay (turn-start snapshot was stale)"
        );
        ctx.session_id = session_id;
        ctx.session_snapshot = session_snapshot;
        Ok(())
    }
}

/// Runtime permission gate inputs for an aionrs rebuild, loaded from the
/// conversation's persisted assistant snapshot in the service layer
/// (`ConversationService::load_aionrs_permission_seed`) and threaded down so
/// `SessionContextBuilder` needs no `conversation_repo` handle.
///
/// - `default_permission_mode`: the assistant's permission mode (`auto` /
///   `fixed`), decides whether the runtime value may be adopted.
/// - `resolved_permission_value`: the last runtime-selected permission
///   persisted on the snapshot; only honored under `auto` for non-team
///   sessions.
#[derive(Debug, Clone)]
pub(crate) struct AionrsRuntimePermissionSeed {
    pub default_permission_mode: String,
    pub resolved_permission_value: Option<String>,
}

fn build_aionrs_context(
    row: &ConversationRow,
    extra: serde_json::Value,
    team: Option<TeamSessionBinding>,
    permission_seed: Option<AionrsRuntimePermissionSeed>,
) -> AionrsSessionBuildContext {
    let mut config: AionrsBuildExtra = match serde_json::from_value(extra.clone()) {
        Ok(config) => config,
        Err(err) => {
            warn!(
                conversation_id = %row.id,
                error = %err,
                "session_context: invalid aionrs extra; using defaults"
            );
            AionrsBuildExtra::default()
        }
    };
    config.user_id = Some(row.user_id.clone());
    apply_team_seed_to_aionrs_config(&team, &mut config);
    let belongs_to_team = team.is_some();
    // Team-bound sessions keep the team seed / create-time value; runtime
    // resolved permission is intentionally NOT read back (centralized team
    // governance — same safety principle as `fixed`). Only non-team sessions
    // consult the persisted runtime permission.
    if !belongs_to_team && let Some(seed) = permission_seed {
        apply_runtime_permission_seed(seed, row, &mut config);
    }
    AionrsSessionBuildContext {
        config,
        team,
        belongs_to_team,
    }
}

/// Applies the persisted runtime permission to the rebuild seed, honoring
/// `default_permission_mode` semantics (spec §7.1/§7.2). Callers must ensure
/// team-bound sessions never reach here.
fn apply_runtime_permission_seed(
    seed: AionrsRuntimePermissionSeed,
    row: &ConversationRow,
    config: &mut AionrsBuildExtra,
) {
    // `fixed` (and any unknown mode): keep the create-time seed
    // (== create-time default_permission_value); never adopt the runtime
    // residue — anti-privilege-escalation gate.
    if seed.default_permission_mode != "auto" {
        return;
    }
    // `auto`: remember and reuse the runtime selection. The resolved value is
    // authoritative and MUST override the create-time seed.
    if let Some(resolved) = seed.resolved_permission_value.filter(|value| !value.is_empty()) {
        debug!(
            conversation_id = %row.id,
            "session_context: aionrs rebuild seeded from resolved runtime permission"
        );
        config.session_mode = Some(resolved);
    }
}

fn apply_team_seed_to_acp_config(team: &Option<TeamSessionBinding>, config: &mut AcpBuildExtra) {
    let Some(team) = team else {
        return;
    };
    if config.backend.as_deref().is_none_or(str::is_empty) {
        config.backend.clone_from(&team.runtime_seed.backend);
    }
    if config.session_mode.as_deref().is_none_or(str::is_empty) {
        config.session_mode.clone_from(&team.runtime_seed.session_mode);
    }
    if config.current_model_id.as_deref().is_none_or(str::is_empty) {
        config.current_model_id.clone_from(&team.runtime_seed.current_model_id);
    }
    if config.team_mcp_stdio_config.is_none() {
        config.team_mcp_stdio_config = team.mcp.as_ref().map(|mcp| mcp.stdio.clone());
    }
}

fn apply_team_seed_to_aionrs_config(team: &Option<TeamSessionBinding>, config: &mut AionrsBuildExtra) {
    let Some(team) = team else {
        return;
    };
    if config.backend.as_deref().is_none_or(str::is_empty) {
        config.backend.clone_from(&team.runtime_seed.backend);
    }
    if config.session_mode.as_deref().is_none_or(str::is_empty) {
        config.session_mode.clone_from(&team.runtime_seed.session_mode);
    }
    if config.team_mcp_stdio_config.is_none() {
        config.team_mcp_stdio_config = team.mcp.as_ref().map(|mcp| mcp.stdio.clone());
    }
}

fn parse_extra(row: &ConversationRow) -> Result<serde_json::Value, ConversationError> {
    serde_json::from_str(&row.extra).map_err(|e| ConversationError::internal(format!("Invalid extra JSON: {e}")))
}

fn reject_deprecated_runtime_kind(row: &ConversationRow, agent_type: &AgentType) -> Result<(), ConversationError> {
    if !agent_type.is_deprecated_runtime() {
        return Ok(());
    }

    debug!(
        conversation_id = %row.id,
        agent_type = agent_type.serde_name(),
        "Rejected deprecated runtime conversation before session context build"
    );

    Err(ConversationError::Archived {
        id: row.id.clone(),
        reason: LEGACY_CONVERSATION_ARCHIVED_MESSAGE.into(),
    })
}

fn parse_string_array(value: Option<serde_json::Value>) -> Option<Vec<String>> {
    serde_json::from_value(value?).ok()
}

fn normalize_cron_alias(row: &ConversationRow, extra: &serde_json::Value, cron_job_id: &mut Option<String>) {
    if cron_job_id.is_none()
        && let Some(legacy) = extra
            .get("cronJobId")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
    {
        debug!(
            conversation_id = %row.id,
            "session_context: normalized legacy cronJobId alias"
        );
        *cron_job_id = Some(legacy.to_owned());
    }
}

fn decode_persisted_session_state(state: openh3_db::PersistedSessionState) -> PersistedSessionState {
    let mut decoded = PersistedSessionState {
        current_mode_id: state.current_mode_id.map(ModeId::new),
        current_model_id: state.current_model_id.map(ModelId::new),
        ..Default::default()
    };
    if let Some(raw) = state.config_selections_json
        && let Ok(map) = serde_json::from_str::<HashMap<String, String>>(&raw)
    {
        decoded.config_selections = map
            .into_iter()
            .map(|(key, value)| (ConfigKey::new(key), ConfigValue::new(value)))
            .collect();
    }
    if let Some(raw) = state.context_usage_json
        && let Ok(usage) = serde_json::from_str(&raw)
    {
        decoded.context_usage = Some(usage);
    }
    decoded
}

fn expected_auto_workspace_path(
    workspace_root: &Path,
    user_id: &str,
    conversation_id: &str,
    agent_type: &AgentType,
    backend: Option<&serde_json::Value>,
) -> PathBuf {
    auto_workspace_parent(workspace_root, user_id).join(format!(
        "{}-temp-{conversation_id}",
        conversation_label(agent_type, backend)
    ))
}

fn auto_workspace_parent(workspace_root: &Path, user_id: &str) -> PathBuf {
    let dir = openh3_common::user_dir_name(user_id).unwrap_or_else(|_| user_id.to_owned());
    let now = chrono::Local::now();
    workspace_root
        .join("conversations")
        .join("users")
        .join(dir)
        .join(format!("{:04}", now.year()))
        .join(format!("{:02}", now.month()))
        .join(format!("{:02}", now.day()))
}

/// Whether `candidate` is an auto-provisioned workspace for this conversation.
///
/// Matches by path STRUCTURE, not by an exact per-user/dated path. The leaf
/// carries the globally-unique `conversation_id` and the caller has already
/// validated ownership, so the `users/{dir}` segment and the `{Y}/{M}/{D}`
/// date are wildcarded. Accepts:
///   - legacy userless:     `conversations/{Y}/{M}/{D}/{leaf}`
///   - per-user type-first: `conversations/users/{any_dir}/{Y}/{M}/{D}/{leaf}`
///
/// The previous exact-match compared against `auto_workspace_parent(_, user_id)`
/// built from TODAY's date and the acting user's dir. That misclassified as
/// "custom" any workspace created on an earlier day, and any workspace still
/// under `users/system_default_user/` after an account adoption. Structural
/// matching fixes both. Mirrors the delete-side
/// `is_dated_auto_workspace_relative_path` in `service.rs`.
fn is_auto_workspace(
    workspace_root: &Path,
    conversation_id: &str,
    agent_type: &AgentType,
    backend: Option<&serde_json::Value>,
    candidate: &Path,
) -> bool {
    let expected_leaf = format!("{}-temp-{conversation_id}", conversation_label(agent_type, backend));
    let Ok(relative) = candidate.strip_prefix(workspace_root.join("conversations")) else {
        return false;
    };
    let Some(parts) = relative.iter().map(|part| part.to_str()).collect::<Option<Vec<_>>>() else {
        return false;
    };
    let dated = |year: &str, month: &str, day: &str| {
        year.len() == 4
            && month.len() == 2
            && day.len() == 2
            && year.chars().all(|ch| ch.is_ascii_digit())
            && month.chars().all(|ch| ch.is_ascii_digit())
            && day.chars().all(|ch| ch.is_ascii_digit())
    };
    match parts.as_slice() {
        [year, month, day, leaf] => dated(year, month, day) && *leaf == expected_leaf,
        ["users", _user_dir, year, month, day, leaf] => dated(year, month, day) && *leaf == expected_leaf,
        _ => false,
    }
}

/// Reuse only an existing conversation-specific directory under the new root.
/// Never create an empty replacement or redirect a custom project directory.
fn relocated_auto_workspace(
    workspace_root: &Path,
    conversation_id: &str,
    agent_type: &AgentType,
    backend: Option<&serde_json::Value>,
    candidate: &Path,
) -> Option<PathBuf> {
    if !candidate.is_absolute()
        || candidate
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return None;
    }
    let old_conversations = candidate
        .ancestors()
        .find(|ancestor| ancestor.file_name().is_some_and(|name| name == "conversations"))?;
    let old_root = old_conversations.parent()?;
    if !is_auto_workspace(old_root, conversation_id, agent_type, backend, candidate) {
        return None;
    }
    let relocated = workspace_root
        .join("conversations")
        .join(candidate.strip_prefix(old_conversations).ok()?);
    let canonical_root = workspace_root.join("conversations").canonicalize().ok()?;
    let canonical_target = relocated.canonicalize().ok()?;
    if !canonical_target.starts_with(canonical_root) || !canonical_target.is_dir() {
        return None;
    }
    Some(relocated)
}

fn conversation_label(agent_type: &AgentType, backend: Option<&serde_json::Value>) -> String {
    if *agent_type == AgentType::Acp
        && let Some(serde_json::Value::String(s)) = backend
        && !s.is_empty()
    {
        return s.clone();
    }
    agent_type.serde_name().to_owned()
}

fn map_runtime_workspace_validation_error(error: WorkspacePathValidationError) -> ConversationError {
    match error {
        WorkspacePathValidationError::Empty => ConversationError::BadRequest {
            reason: "Workspace directory is empty".into(),
        },
        WorkspacePathValidationError::DoesNotExist(path)
        | WorkspacePathValidationError::NotDirectory(path)
        | WorkspacePathValidationError::NotAccessible { path, .. } => {
            ConversationError::WorkspacePathRuntimeUnavailable { path }
        }
    }
}

fn log_workspace_path_check(conversation_id: &str, error: &WorkspacePathValidationError) {
    warn!(
        target: "aionui_feedback_diagnostics",
        diagnostic_event = "feedback.runtime.workspace_path_check",
        conversation_id = %conversation_id,
        path_present = !matches!(error, WorkspacePathValidationError::Empty),
        path_exists = matches!(
            error,
            WorkspacePathValidationError::NotDirectory(_) | WorkspacePathValidationError::NotAccessible { .. }
        ),
        error_class = %workspace_error_class(error),
        "feedback.runtime.workspace_path_check"
    );
}

fn workspace_error_class(error: &WorkspacePathValidationError) -> &'static str {
    match error {
        WorkspacePathValidationError::Empty => "empty",
        WorkspacePathValidationError::DoesNotExist(_) => "not_found",
        WorkspacePathValidationError::NotDirectory(_) => "not_directory",
        WorkspacePathValidationError::NotAccessible { .. } => "not_accessible",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openh3_db::{
        CreateAcpSessionParams, SaveRuntimeStateParams, SqliteAcpSessionRepository, SqliteAgentMetadataRepository,
        UpsertAgentMetadataParams, init_database_memory,
    };
    use std::io::Write;
    use std::sync::Mutex;
    use tracing::Level;
    use tracing_subscriber::fmt;

    struct TestRepos {
        workspace_root: PathBuf,
        metadata_repo: Arc<dyn IAgentMetadataRepository>,
        acp_session_repo: Arc<dyn IAcpSessionRepository>,
        pool: sqlx::SqlitePool,
    }

    impl TestRepos {
        fn builder(&self) -> SessionContextBuilder<'_> {
            SessionContextBuilder::new(&self.workspace_root, &self.metadata_repo, &self.acp_session_repo)
        }

        async fn insert_conversation(&self, row: &ConversationRow) {
            sqlx::query(
                "INSERT OR IGNORE INTO users \
                    (id, user_type, username, password_hash, status, session_generation, created_at, updated_at) \
                 VALUES (?, 'local', ?, 'hash', 'active', 0, ?, ?)",
            )
            .bind(&row.user_id)
            .bind(&row.user_id)
            .bind(row.created_at)
            .bind(row.updated_at)
            .execute(&self.pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO conversations \
                    (id, user_id, name, type, extra, model, status, source, \
                     channel_chat_id, pinned, pinned_at, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&row.id)
            .bind(&row.user_id)
            .bind(&row.name)
            .bind(&row.r#type)
            .bind(&row.extra)
            .bind(&row.model)
            .bind(row.status.as_deref().unwrap_or("pending"))
            .bind(&row.source)
            .bind(&row.channel_chat_id)
            .bind(row.pinned)
            .bind(row.pinned_at)
            .bind(row.created_at)
            .bind(row.updated_at)
            .execute(&self.pool)
            .await
            .unwrap();
        }
    }

    #[derive(Clone)]
    struct SharedBuf(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedBuf {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn capture_logs(max_level: Level, f: impl FnOnce()) -> String {
        let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
        let make_writer = {
            let buffer = Arc::clone(&buffer);
            move || SharedBuf(Arc::clone(&buffer))
        };
        let subscriber = fmt::Subscriber::builder()
            .with_max_level(max_level)
            .with_writer(make_writer)
            .with_ansi(false)
            .finish();

        tracing::subscriber::with_default(subscriber, || {
            // Other tests can reach these callsites without a subscriber.
            // Rebuild their global interest cache after installing this scoped
            // subscriber, as the stream relay log-capture helper does.
            tracing::callsite::rebuild_interest_cache();
            f();
        });
        String::from_utf8(buffer.lock().unwrap().clone()).unwrap()
    }

    async fn setup() -> TestRepos {
        let db = init_database_memory().await.unwrap();
        let pool = db.pool().clone();
        let metadata_repo: Arc<dyn IAgentMetadataRepository> =
            Arc::new(SqliteAgentMetadataRepository::new(pool.clone()));
        let acp_session_repo: Arc<dyn IAcpSessionRepository> = Arc::new(SqliteAcpSessionRepository::new(pool));
        let workspace_root = std::env::temp_dir().join(format!(
            "aion-session-context-test-{}",
            openh3_common::generate_short_id()
        ));
        TestRepos {
            workspace_root,
            metadata_repo,
            acp_session_repo,
            pool: db.pool().clone(),
        }
    }

    fn row(agent_type: &str, extra: serde_json::Value, model: Option<serde_json::Value>) -> ConversationRow {
        ConversationRow {
            id: "conv-1".into(),
            user_id: "user-1".into(),
            name: "test".into(),
            r#type: agent_type.into(),
            model: model.map(|value| serde_json::to_string(&value).unwrap()),
            extra: serde_json::to_string(&extra).unwrap(),
            status: None,
            source: Some("chat".into()),
            channel_chat_id: None,
            pinned: false,
            pinned_at: None,
            created_at: 0,
            updated_at: 0,
            project_id: None,
            folder_id: None,
            name_source: None,
        }
    }

    async fn upsert_builtin(repos: &TestRepos, id: &str, backend: &str) {
        repos
            .metadata_repo
            .upsert(&UpsertAgentMetadataParams {
                id,
                icon: None,
                name: id,
                name_i18n: None,
                description: None,
                description_i18n: None,
                backend: Some(backend),
                agent_type: "acp",
                agent_source: "builtin",
                agent_source_info: None,
                enabled: true,
                command: Some("/bin/echo"),
                args: None,
                env: None,
                native_skills_dirs: None,
                skill_delivery: None,
                behavior_policy: None,
                yolo_id: None,
                agent_capabilities: None,
                auth_methods: None,
                config_options: None,
                available_modes: None,
                available_models: None,
                available_commands: None,
                sort_order: 0,
            })
            .await
            .unwrap();
    }

    fn acp_context(context: AgentSessionContext) -> AcpSessionBuildContext {
        match context.kind {
            AgentSessionKind::Acp(acp) => *acp,
            other => panic!("expected ACP context, got {other:?}"),
        }
    }

    fn aionrs_context(context: AgentSessionContext) -> AionrsSessionBuildContext {
        match context.kind {
            AgentSessionKind::Aionrs(aionrs) => *aionrs,
            other => panic!("expected Aionrs context, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn acp_agent_id_takes_priority_over_backend() {
        let repos = setup().await;
        let row = row(
            "acp",
            serde_json::json!({
                "agent_id": "custom-agent-1",
                "backend": "claude",
                "agent_source": "custom"
            }),
            None,
        );

        let context = repos.builder().build(&row).await.unwrap();
        let acp = acp_context(context);
        assert_eq!(acp.config.agent_id.as_deref(), Some("custom-agent-1"));
        assert_eq!(acp.config.backend.as_deref(), Some("claude"));
    }

    #[tokio::test]
    async fn acp_extra_user_id_is_overridden_by_conversation_owner() {
        let repos = setup().await;
        let row = row(
            "acp",
            serde_json::json!({
                "backend": "claude",
                "user_id": "other-user"
            }),
            None,
        );

        let context = repos.builder().build(&row).await.unwrap();
        let acp = acp_context(context);
        assert_eq!(acp.config.user_id.as_deref(), Some("user-1"));
    }

    #[tokio::test]
    async fn acp_builtin_backend_fallback_resolves_agent_id() {
        let repos = setup().await;
        upsert_builtin(&repos, "builtin-claude-test", "claude").await;
        let row = row("acp", serde_json::json!({ "backend": "claude" }), None);

        let context = repos.builder().build(&row).await.unwrap();
        let acp = acp_context(context);
        assert_eq!(acp.config.agent_id.as_deref(), Some("builtin-claude-test"));
        assert_eq!(acp.config.backend.as_deref(), Some("claude"));
    }

    #[tokio::test]
    async fn acp_openclaw_builtin_backend_fallback_resolves_agent_id() {
        let repos = setup().await;
        upsert_builtin(&repos, "builtin-openclaw-test", "openclaw").await;
        let row = row("acp", serde_json::json!({ "backend": "openclaw" }), None);

        let context = repos.builder().build(&row).await.unwrap();
        let acp = acp_context(context);
        assert_eq!(acp.config.agent_id.as_deref(), Some("builtin-openclaw-test"));
        assert_eq!(acp.config.backend.as_deref(), Some("openclaw"));
    }

    #[tokio::test]
    async fn acp_non_builtin_without_agent_id_is_rejected() {
        let repos = setup().await;
        let row = row(
            "acp",
            serde_json::json!({ "backend": "custom", "agent_source": "custom" }),
            None,
        );

        let err = repos.builder().build(&row).await.unwrap_err();
        assert!(err.to_string().contains("requires agent_id"));
    }

    #[tokio::test]
    async fn acp_persisted_runtime_is_loaded_before_legacy_seed() {
        let repos = setup().await;
        upsert_builtin(&repos, "builtin-claude-test", "claude").await;
        let row = row(
            "acp",
            serde_json::json!({
                "backend": "claude",
                "current_mode_id": "legacy-mode",
                "current_model_id": "legacy-model"
            }),
            None,
        );
        repos.insert_conversation(&row).await;
        repos
            .acp_session_repo
            .create(&CreateAcpSessionParams {
                user_id: "user-1",
                conversation_id: "conv-1",
                agent_source: "builtin",
                agent_id: "builtin-claude-test",
            })
            .await
            .unwrap();
        repos
            .acp_session_repo
            .update_session_id_for_user("user-1", "conv-1", "sess-1")
            .await
            .unwrap();
        repos
            .acp_session_repo
            .save_runtime_state_for_user(
                "user-1",
                "conv-1",
                &SaveRuntimeStateParams {
                    current_mode_id: Some(Some("persisted-mode")),
                    current_model_id: Some(Some("persisted-model")),
                    config_selections_json: None,
                    context_usage_json: None,
                },
            )
            .await
            .unwrap();

        let context = repos.builder().build(&row).await.unwrap();
        let acp = acp_context(context);
        let snapshot = acp.session_snapshot.expect("snapshot loaded");
        assert_eq!(snapshot.current_mode_id.unwrap().as_str(), "persisted-mode");
        assert_eq!(snapshot.current_model_id.unwrap().as_str(), "persisted-model");
        assert_eq!(acp.config.session_mode.as_deref(), Some("legacy-mode"));
        assert_eq!(acp.config.current_model_id.as_deref(), Some("legacy-model"));
    }

    #[tokio::test]
    async fn acp_unassigned_session_runtime_is_startup_seed_not_resume_snapshot() {
        let repos = setup().await;
        upsert_builtin(&repos, "builtin-codex-test", "codex").await;
        let row = row(
            "acp",
            serde_json::json!({
                "backend": "codex",
                "current_mode_id": "full-access",
                "current_model_id": "gpt-5.5"
            }),
            None,
        );
        repos.insert_conversation(&row).await;
        repos
            .acp_session_repo
            .create(&CreateAcpSessionParams {
                user_id: "user-1",
                conversation_id: "conv-1",
                agent_source: "builtin",
                agent_id: "builtin-codex-test",
            })
            .await
            .unwrap();
        repos
            .acp_session_repo
            .save_runtime_state_for_user(
                "user-1",
                "conv-1",
                &SaveRuntimeStateParams {
                    current_mode_id: Some(Some("full-access")),
                    current_model_id: Some(Some("gpt-5.5")),
                    config_selections_json: None,
                    context_usage_json: None,
                },
            )
            .await
            .unwrap();

        let context = repos.builder().build(&row).await.unwrap();
        let acp = acp_context(context);
        assert_eq!(acp.config.session_mode.as_deref(), Some("full-access"));
        assert_eq!(acp.config.current_model_id.as_deref(), Some("gpt-5.5"));
        assert!(acp.session_snapshot.is_none());
    }

    #[tokio::test]
    async fn acp_session_identity_takes_priority_over_legacy_backend_seed() {
        let repos = setup().await;
        upsert_builtin(&repos, "builtin-claude-test", "claude").await;
        upsert_builtin(&repos, "builtin-codex-test", "codex").await;
        let row = row("acp", serde_json::json!({ "backend": "claude" }), None);
        repos.insert_conversation(&row).await;
        repos
            .acp_session_repo
            .create(&CreateAcpSessionParams {
                user_id: "user-1",
                conversation_id: "conv-1",
                agent_source: "builtin",
                agent_id: "builtin-codex-test",
            })
            .await
            .unwrap();

        let context = repos.builder().build(&row).await.unwrap();
        let acp = acp_context(context);
        assert_eq!(acp.config.agent_id.as_deref(), Some("builtin-codex-test"));
        assert_eq!(acp.config.backend.as_deref(), Some("codex"));
    }

    #[tokio::test]
    async fn acp_legacy_current_mode_becomes_startup_seed_without_runtime() {
        let repos = setup().await;
        upsert_builtin(&repos, "builtin-claude-test", "claude").await;
        let row = row(
            "acp",
            serde_json::json!({ "backend": "claude", "current_mode_id": "legacy-mode" }),
            None,
        );

        let context = repos.builder().build(&row).await.unwrap();
        let acp = acp_context(context);
        assert_eq!(acp.config.session_mode.as_deref(), Some("legacy-mode"));
        assert!(acp.session_snapshot.is_none());
    }

    #[tokio::test]
    async fn acp_extra_thought_level_is_exposed_as_typed_context() {
        let repos = setup().await;
        upsert_builtin(&repos, "builtin-codex-test", "codex").await;
        let row = row(
            "acp",
            serde_json::json!({
                "backend": "codex",
                "thought_level": "high"
            }),
            None,
        );

        let context = repos.builder().build(&row).await.unwrap();
        let acp = acp_context(context);
        assert_eq!(acp.config.thought_level.as_deref(), Some("high"));
        assert!(acp.session_snapshot.is_none());
    }

    #[tokio::test]
    async fn aionrs_extra_thought_level_is_exposed_as_typed_context() {
        let repos = setup().await;
        let row = row("aionrs", serde_json::json!({ "thought_level": "xhigh" }), None);
        let context = repos.builder().build(&row).await.unwrap();
        assert_eq!(aionrs_context(context).config.thought_level.as_deref(), Some("xhigh"));
    }

    #[tokio::test]
    async fn acp_team_extra_is_exposed_as_typed_context() {
        let repos = setup().await;
        upsert_builtin(&repos, "builtin-claude-test", "claude").await;
        let row = row(
            "acp",
            serde_json::json!({
                "teamId": "team-1",
                "slot_id": "lead-1",
                "role": "lead",
                "backend": "claude",
                "session_mode": "yolo",
                "current_model_id": "claude-opus",
                "team_mcp_stdio_config": {
                    "team_id": "team-1",
                    "port": 4242,
                    "token": "tok-1",
                    "slot_id": "lead-1",
                    "binary_path": "/tmp/aioncore"
                }
            }),
            None,
        );

        let context = repos.builder().build(&row).await.unwrap();
        let team = context.team.as_ref().expect("team context");
        assert_eq!(team.team_id, "team-1");
        assert_eq!(team.slot_id.as_deref(), Some("lead-1"));
        assert_eq!(team.role.as_deref(), Some("lead"));
        assert_eq!(team.runtime_seed.backend.as_deref(), Some("claude"));
        assert_eq!(team.runtime_seed.session_mode.as_deref(), Some("yolo"));
        assert_eq!(team.runtime_seed.current_model_id.as_deref(), Some("claude-opus"));
        let mcp = team.mcp.as_ref().expect("typed team mcp");
        assert_eq!(mcp.stdio.port, 4242);
        assert_eq!(mcp.stdio.slot_id, "lead-1");

        let acp = acp_context(context);
        assert!(acp.belongs_to_team);
        assert_eq!(acp.config.team_mcp_stdio_config.unwrap().port, 4242);
    }

    #[tokio::test]
    async fn aionrs_team_extra_is_exposed_as_typed_context() {
        let repos = setup().await;
        let row = row(
            "aionrs",
            serde_json::json!({
                "teamId": "team-2",
                "slot_id": "worker-1",
                "role": "teammate",
                "backend": "aionrs",
                "session_mode": "yolo",
                "team_mcp_stdio_config": {
                    "team_id": "team-2",
                    "port": 5252,
                    "token": "tok-2",
                    "slot_id": "worker-1",
                    "binary_path": "/tmp/aioncore"
                }
            }),
            Some(serde_json::json!({
                "provider_id": "provider-1",
                "model": "gpt-5"
            })),
        );

        let context = repos.builder().build(&row).await.unwrap();
        let team = context.team.as_ref().expect("team context");
        assert_eq!(team.team_id, "team-2");
        assert_eq!(team.slot_id.as_deref(), Some("worker-1"));
        assert_eq!(team.runtime_seed.backend.as_deref(), Some("aionrs"));
        assert_eq!(team.mcp.as_ref().unwrap().stdio.port, 5252);

        let aionrs = aionrs_context(context);
        assert!(aionrs.belongs_to_team);
        assert_eq!(aionrs.config.team_mcp_stdio_config.unwrap().port, 5252);
    }

    #[tokio::test]
    async fn aionrs_extra_user_id_is_overridden_by_conversation_owner() {
        let repos = setup().await;
        let row = row("aionrs", serde_json::json!({ "user_id": "other-user" }), None);

        let context = repos.builder().build(&row).await.unwrap();
        let aionrs = aionrs_context(context);
        assert_eq!(aionrs.config.user_id.as_deref(), Some("user-1"));
    }

    #[tokio::test]
    async fn aionrs_uses_conversation_model_and_ignores_legacy_extra_model() {
        let repos = setup().await;
        let row = row(
            "aionrs",
            serde_json::json!({
                "model": { "provider_id": "wrong", "model": "wrong-model" }
            }),
            Some(serde_json::json!({
                "provider_id": "provider-1",
                "model": "gpt-5",
                "use_model": "gpt-5.1"
            })),
        );

        let context = repos.builder().build(&row).await.unwrap();
        assert_eq!(context.model.provider_id, "provider-1");
        assert_eq!(context.model.model, "gpt-5");
        assert_eq!(context.model.use_model.as_deref(), Some("gpt-5.1"));
    }

    #[tokio::test]
    async fn workspace_empty_uses_auto_path_and_is_not_custom() {
        let repos = setup().await;
        let row = row("aionrs", serde_json::json!({}), None);

        let context = repos.builder().build(&row).await.unwrap();
        assert!(!context.workspace.is_custom);
        assert!(context.workspace.stored_path.is_empty());
        assert!(context.workspace.path.ends_with("aionrs-temp-conv-1"));
    }

    #[tokio::test]
    async fn workspace_existing_path_is_custom() {
        let repos = setup().await;
        let custom = repos.workspace_root.join("custom-workspace");
        std::fs::create_dir_all(&custom).unwrap();
        let row = row(
            "aionrs",
            serde_json::json!({ "workspace": custom.to_string_lossy().to_string() }),
            None,
        );

        let context = repos.builder().build(&row).await.unwrap();
        assert!(context.workspace.is_custom);
        assert_eq!(context.workspace.path, custom.to_string_lossy());
    }

    #[tokio::test]
    async fn workspace_relinks_existing_auto_workspace_after_data_root_migration() {
        let repos = setup().await;
        let relative = Path::new("conversations/users/system_default_user/2026/10/08/aionrs-temp-conv-1");
        let relocated = repos.workspace_root.join(relative);
        std::fs::create_dir_all(&relocated).unwrap();
        let old_profile = tempfile::tempdir().unwrap();
        let legacy = old_profile.path().join(relative).to_string_lossy().into_owned();
        assert!(!Path::new(&legacy).exists());
        let row = row("aionrs", serde_json::json!({ "workspace": legacy }), None);

        let context = repos.builder().build(&row).await.unwrap();

        assert!(!context.workspace.is_custom);
        assert_eq!(Path::new(&context.workspace.path), relocated.as_path());
        assert_eq!(context.workspace.stored_path, legacy);
    }

    #[tokio::test]
    async fn workspace_relocation_preserves_existing_original() {
        let repos = setup().await;
        let old_profile = tempfile::tempdir().unwrap();
        let relative = Path::new("conversations/2026/10/08/aionrs-temp-conv-1");
        let original = old_profile.path().join(relative);
        std::fs::create_dir_all(&original).unwrap();
        std::fs::create_dir_all(repos.workspace_root.join(relative)).unwrap();
        let row = row("aionrs", serde_json::json!({ "workspace": original }), None);
        let context = repos.builder().build(&row).await.unwrap();
        assert_eq!(Path::new(&context.workspace.path), original.as_path());
    }

    #[tokio::test]
    async fn workspace_relocation_accepts_userless_layout_and_preserves_files() {
        let repos = setup().await;
        let old_profile = tempfile::tempdir().unwrap();
        let relative = Path::new("conversations/2026/10/08/aionrs-temp-conv-1");
        let relocated = repos.workspace_root.join(relative);
        std::fs::create_dir_all(&relocated).unwrap();
        std::fs::write(relocated.join("existing.txt"), "existing content").unwrap();
        let row = row(
            "aionrs",
            serde_json::json!({ "workspace": old_profile.path().join(relative) }),
            None,
        );
        let context = repos.builder().build(&row).await.unwrap();
        assert_eq!(Path::new(&context.workspace.path), relocated.as_path());
        assert!(!context.workspace.is_custom);
        assert_eq!(
            std::fs::read_to_string(relocated.join("existing.txt")).unwrap(),
            "existing content"
        );
    }

    #[tokio::test]
    async fn workspace_relocation_rejects_missing_file_custom_and_wrong_conversation() {
        let repos = setup().await;
        let old_profile = tempfile::tempdir().unwrap();
        for (relative, create_target, file_target) in [
            ("conversations/2026/10/08/aionrs-temp-conv-1", false, false),
            ("conversations/2026/10/09/aionrs-temp-conv-1", true, true),
            ("projects/custom", true, false),
            ("conversations/2026/10/08/aionrs-temp-other", true, false),
            ("conversations/2026/10/08/../08/aionrs-temp-conv-1", true, false),
        ] {
            let target = repos.workspace_root.join(relative);
            if create_target {
                if file_target {
                    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                    std::fs::write(&target, "not a directory").unwrap();
                } else {
                    std::fs::create_dir_all(&target).unwrap();
                }
            }
            let original = old_profile.path().join(relative);
            let row = row("aionrs", serde_json::json!({ "workspace": original }), None);
            assert!(
                matches!(repos.builder().build(&row).await,
                Err(ConversationError::WorkspacePathRuntimeUnavailable { path }) if Path::new(&path) == original),
                "{relative}"
            );
            assert!(!original.exists());
            if !create_target {
                assert!(!target.exists());
            }
        }
    }

    #[test]
    fn is_auto_workspace_matches_by_structure_across_user_and_date() {
        let root = std::path::Path::new("/w");
        let user = "user_019f8de8-3537-7c73-8d92-3bfde17eb1ee";
        let new_path = expected_auto_workspace_path(root, user, "conv-1", &AgentType::Acp, None);
        let components: Vec<_> = new_path.components().collect();
        assert!(
            components.windows(3).any(|window| {
                window[0].as_os_str() == "conversations"
                    && window[1].as_os_str() == "users"
                    && window[2].as_os_str() == "019f8de8-3537-7c73-8d92-3bfde17eb1ee"
            }),
            "new workspace must be under conversations/users/{{dir}}/: {}",
            new_path.display()
        );
        assert!(new_path.to_string_lossy().ends_with("-temp-conv-1"));

        let auto = |candidate: &std::path::Path| is_auto_workspace(root, "conv-1", &AgentType::Acp, None, candidate);
        let dated = |segments: &[&str], leaf: &str| {
            let mut p = root.join("conversations");
            for seg in segments {
                p = p.join(seg);
            }
            p.join(leaf)
        };

        // Current per-user path (today, acting user's dir).
        assert!(auto(&new_path));

        // Legacy userless path (today).
        let now = chrono::Local::now();
        let legacy = dated(
            &[
                &format!("{:04}", now.year()),
                &format!("{:02}", now.month()),
                &format!("{:02}", now.day()),
            ],
            "acp-temp-conv-1",
        );
        assert!(auto(&legacy));

        // Cross-day per-user path (a different date than today): the old exact
        // match rejected this, structural matching accepts it.
        let cross_day = dated(
            &["users", "019f8de8-3537-7c73-8d92-3bfde17eb1ee", "2020", "01", "02"],
            "acp-temp-conv-1",
        );
        assert!(
            auto(&cross_day),
            "a workspace created on an earlier day must still count as auto"
        );

        // Post-adoption path still under users/system_default_user/: must be
        // recognized so adopted conversations are not misclassified as custom.
        let adopted = dated(&["users", "system_default_user", "2020", "01", "02"], "acp-temp-conv-1");
        assert!(
            auto(&adopted),
            "old system_default_user workspace must still count as auto"
        );

        // Different conversation's leaf → not THIS conversation's auto workspace.
        let other_conv = dated(&["users", "d", "2020", "01", "02"], "acp-temp-conv-2");
        assert!(!auto(&other_conv));

        // Non-dated segments must be rejected (guards the structural matcher).
        let bad_date = dated(&["users", "d", "YY", "MM", "DD"], "acp-temp-conv-1");
        assert!(!auto(&bad_date));

        // A genuinely custom path is not auto.
        assert!(!auto(&root.join("somewhere-else")));
    }

    #[test]
    fn workspace_validation_failure_logs_redacted_runtime_check() {
        const CHILD: &str = "OPENH3_WORKSPACE_LOG_CAPTURE_CHILD";
        if std::env::var_os(CHILD).is_none() {
            // tracing callsite interest is process-global. Run this assertion
            // alone so parallel tests cannot disable its scoped subscriber.
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "session_context::tests::workspace_validation_failure_logs_redacted_runtime_check",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "isolated log capture failed:\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let raw_path = "/tmp/aionui-secret-workspace-token-12345";
        let captured = capture_logs(Level::WARN, || {
            runtime.block_on(async {
                let repos = setup().await;
                let row = row("aionrs", serde_json::json!({ "workspace": raw_path }), None);

                let err = repos.builder().build(&row).await.unwrap_err();
                assert!(matches!(err, ConversationError::WorkspacePathRuntimeUnavailable { .. }));
            });
        });

        assert!(captured.contains("aionui_feedback_diagnostics"), "{captured}");
        assert!(captured.contains("feedback.runtime.workspace_path_check"), "{captured}");
        assert!(captured.contains("conversation_id=conv-1"), "{captured}");
        assert!(captured.contains("path_present=true"), "{captured}");
        assert!(captured.contains("path_exists=false"), "{captured}");
        assert!(captured.contains("error_class=not_found"), "{captured}");
        assert!(!captured.contains(raw_path), "{captured}");
        assert!(!captured.contains("token-12345"), "{captured}");
    }

    fn assert_archived(err: ConversationError, expected_id: &str) {
        match err {
            ConversationError::Archived { id, reason } => {
                assert_eq!(id, expected_id);
                assert!(
                    reason.contains("This historical conversation can no longer be continued."),
                    "unexpected archive reason: {reason}"
                );
            }
            other => panic!("expected ConversationError::Archived, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn legacy_agent_types_are_archived_before_runtime_context() {
        let repos = setup().await;

        for (agent_type, extra) in [
            ("gemini", serde_json::json!({})),
            ("codex", serde_json::json!({ "workspace": "/tmp/aionui-codex-history" })),
            (
                "openclaw-gateway",
                serde_json::json!({ "gateway": { "use_external_gateway": true } }),
            ),
            ("nanobot", serde_json::json!({})),
            ("remote", serde_json::json!({})),
        ] {
            let row = row(agent_type, extra, None);
            let err = repos.builder().build(&row).await.unwrap_err();
            assert_archived(err, "conv-1");
        }
    }

    fn aionrs_seed(mode: &str, resolved: Option<&str>) -> AionrsRuntimePermissionSeed {
        AionrsRuntimePermissionSeed {
            default_permission_mode: mode.to_owned(),
            resolved_permission_value: resolved.map(ToOwned::to_owned),
        }
    }

    #[test]
    fn aionrs_auto_mode_rebuild_adopts_resolved_permission_value() {
        // AC#1: auto happy path — runtime yolo survives rebuild.
        let row = row("aionrs", serde_json::json!({ "session_mode": "default" }), None);
        let ctx = build_aionrs_context(
            &row,
            serde_json::json!({ "session_mode": "default" }),
            None,
            Some(aionrs_seed("auto", Some("yolo"))),
        );
        assert_eq!(ctx.config.session_mode.as_deref(), Some("yolo"));
    }

    #[test]
    fn aionrs_auto_mode_resolved_overrides_create_time_seed() {
        // AC#2: existing-data compat — create-time non-yolo seed is overridden.
        let row = row("aionrs", serde_json::json!({ "session_mode": "auto_edit" }), None);
        let ctx = build_aionrs_context(
            &row,
            serde_json::json!({ "session_mode": "auto_edit" }),
            None,
            Some(aionrs_seed("auto", Some("yolo"))),
        );
        assert_eq!(ctx.config.session_mode.as_deref(), Some("yolo"));
    }

    #[test]
    fn aionrs_fixed_mode_ignores_resolved_permission_value() {
        // AC#3: fixed safety gate — runtime residue must NOT escalate.
        let row = row("aionrs", serde_json::json!({ "session_mode": "default" }), None);
        let ctx = build_aionrs_context(
            &row,
            serde_json::json!({ "session_mode": "default" }),
            None,
            Some(aionrs_seed("fixed", Some("yolo"))),
        );
        assert_eq!(ctx.config.session_mode.as_deref(), Some("default"));
    }

    #[test]
    fn aionrs_team_bound_session_ignores_resolved_permission_value() {
        // Team-bound governance: keep team seed, never read resolved runtime value.
        let team = TeamSessionBinding::from_extra_value(&serde_json::json!({
            "teamId": "team-1",
            "slot_id": "worker-1",
            "role": "teammate",
            "session_mode": "auto_edit"
        }))
        .unwrap();
        let row = row("aionrs", serde_json::json!({ "session_mode": "auto_edit" }), None);
        let ctx = build_aionrs_context(
            &row,
            serde_json::json!({ "session_mode": "auto_edit" }),
            team,
            Some(aionrs_seed("auto", Some("yolo"))),
        );
        assert_eq!(ctx.config.session_mode.as_deref(), Some("auto_edit"));
    }

    // ELECTRON-3Q0 fix C: the auto-replay must see attempt 1's mid-turn anchor
    // clear. refresh_resume_anchor re-resolves ONLY session_id + session_snapshot
    // into the frozen turn-start snapshot; every turn-scoped field stays put.
    #[tokio::test]
    async fn refresh_resume_anchor_picks_up_midturn_clear_and_freezes_the_rest() {
        let repos = setup().await;
        upsert_builtin(&repos, "builtin-claude-test", "claude").await;
        let row = row("acp", serde_json::json!({ "backend": "claude" }), None);
        // Scoped acp_session access authorizes through the conversations
        // parent chain — seed the owning user + conversation first.
        repos.insert_conversation(&row).await;
        repos
            .acp_session_repo
            .create(&CreateAcpSessionParams {
                user_id: "user-1",
                conversation_id: "conv-1",
                agent_source: "builtin",
                agent_id: "builtin-claude-test",
            })
            .await
            .unwrap();
        repos
            .acp_session_repo
            .update_session_id_for_user("user-1", "conv-1", "dead-anchor")
            .await
            .unwrap();
        let mut options = repos.builder().build_options(&row, None).await.unwrap();

        // The dead-anchor self-heal (session layer) clears the anchor mid-turn.
        repos
            .acp_session_repo
            .clear_session_id_for_user("user-1", "conv-1")
            .await
            .unwrap();
        repos
            .builder()
            .refresh_resume_anchor("conv-1", &mut options)
            .await
            .unwrap();

        let acp = acp_context(options.context);
        assert_eq!(
            acp.session_id, None,
            "the replay must open Fresh — replaying the stale turn-start anchor re-resumes the dead session"
        );
        assert!(
            acp.session_snapshot.is_none(),
            "no anchor → no resume snapshot (mirrors build_acp_context's skip)"
        );
        assert_eq!(
            acp.config.backend.as_deref(),
            Some("claude"),
            "turn-scoped config stays frozen — only the anchor fields refresh"
        );
    }

    #[tokio::test]
    async fn refresh_resume_anchor_noop_when_anchor_unchanged() {
        let repos = setup().await;
        upsert_builtin(&repos, "builtin-claude-test", "claude").await;
        let row = row("acp", serde_json::json!({ "backend": "claude" }), None);
        // Scoped acp_session access authorizes through the conversations
        // parent chain — seed the owning user + conversation first.
        repos.insert_conversation(&row).await;
        repos
            .acp_session_repo
            .create(&CreateAcpSessionParams {
                user_id: "user-1",
                conversation_id: "conv-1",
                agent_source: "builtin",
                agent_id: "builtin-claude-test",
            })
            .await
            .unwrap();
        repos
            .acp_session_repo
            .update_session_id_for_user("user-1", "conv-1", "live-anchor")
            .await
            .unwrap();
        let mut options = repos.builder().build_options(&row, None).await.unwrap();

        repos
            .builder()
            .refresh_resume_anchor("conv-1", &mut options)
            .await
            .unwrap();

        let acp = acp_context(options.context);
        assert_eq!(
            acp.session_id.as_deref(),
            Some("live-anchor"),
            "an unchanged anchor is left exactly as the turn-start snapshot had it"
        );
    }
}
