//! Health check endpoint.

use crate::services::UpdateActivityService;
use axum::Json;
use axum::{
    Router,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::post,
};
use openh3_api_types::{ApiResponse, ErrorResponse, UpdateLeaseRequest, UpdateLeaseStatus};
use serde::Serialize;
use std::sync::Arc;

pub(super) fn update_control_routes(state: Arc<UpdateActivityService>) -> Router {
    Router::new()
        .route("/api/system/update-lease", post(acquire_update).delete(release_update))
        .with_state(state)
}

fn authorize_update(
    state: &UpdateActivityService,
    headers: &HeaderMap,
    request: &UpdateLeaseRequest,
) -> Result<(), Box<Response>> {
    if state.control_token.as_deref().is_none_or(|token| {
        headers
            .get("x-openh3-update-token")
            .and_then(|value| value.to_str().ok())
            != Some(token)
    }) {
        return Err(Box::new(
            (
                StatusCode::FORBIDDEN,
                Json(ErrorResponse::new(
                    "Update control forbidden",
                    "UPDATE_CONTROL_FORBIDDEN",
                )),
            )
                .into_response(),
        ));
    }
    if uuid::Uuid::parse_str(&request.lease_id).is_err() {
        return Err(Box::new(
            (
                StatusCode::BAD_REQUEST,
                Json(ErrorResponse::new("Invalid update lease", "UPDATE_LEASE_INVALID")),
            )
                .into_response(),
        ));
    }
    Ok(())
}

async fn acquire_update(
    State(state): State<Arc<UpdateActivityService>>,
    headers: HeaderMap,
    Json(request): Json<UpdateLeaseRequest>,
) -> Response {
    if let Err(response) = authorize_update(&state, &headers, &request) {
        return *response;
    }
    let now = openh3_common::now_ms();
    if request.expires_at <= now || request.expires_at > now + 15_000 {
        return Json(ApiResponse::ok(UpdateLeaseStatus { idle: false })).into_response();
    }
    Json(ApiResponse::ok(UpdateLeaseStatus {
        idle: state.acquire(&request.lease_id, request.expires_at),
    }))
    .into_response()
}

async fn release_update(
    State(state): State<Arc<UpdateActivityService>>,
    headers: HeaderMap,
    Json(request): Json<UpdateLeaseRequest>,
) -> Response {
    if let Err(response) = authorize_update(&state, &headers, &request) {
        return *response;
    }
    state.runtime.resume_after_update(&request.lease_id);
    Json(ApiResponse::success()).into_response()
}

pub(super) async fn update_admission(
    State(state): State<Arc<UpdateActivityService>>,
    request: Request,
    next: Next,
) -> Response {
    if matches!(request.uri().path(), "/health" | "/api/system/update-lease") {
        return next.run(request).await;
    }
    let Some(_claim) = state.runtime.enter_update_request() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse::new("App update pending", "APP_UPDATE_PENDING")),
        )
            .into_response();
    };
    next.run(request).await
}

#[derive(Serialize)]
pub(super) struct HealthResponse {
    status: &'static str,
    version: &'static str,
    build_time: &'static str,
}

pub(super) async fn health_check() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        build_time: env!("BUILD_TIME"),
    })
}

#[cfg(test)]
mod update_tests {
    use super::*;
    use axum::body::Body;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn call(
        app: &Router,
        method: &str,
        path: &str,
        token: Option<&str>,
        lease_id: &str,
    ) -> (StatusCode, serde_json::Value) {
        let mut request = axum::http::Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("x-openh3-update-token", token);
        }
        let response = app
            .clone()
            .oneshot(
                request
                    .body(Body::from(
                        serde_json::json!({"leaseId": lease_id, "expiresAt": openh3_common::now_ms() + 10_000})
                            .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn parent_only_lease_refuses_busy_runtime_and_fences_new_requests_until_rollback() {
        let root = tempfile::tempdir().unwrap();
        let db = openh3_db::init_database_memory().await.unwrap();
        let config = crate::AppConfig {
            data_dir: root.path().into(),
            work_dir: root.path().into(),
            ..Default::default()
        };
        let services = crate::AppServices::from_config(db, &config).await.unwrap();
        let mut activity = UpdateActivityService::new(&services);
        activity.control_token = Some("parent-only".into());
        let activity = Arc::new(activity);
        let app = update_control_routes(activity.clone())
            .route("/work", post(|| async { Json(serde_json::json!({"ok": true})) }))
            .layer(axum::middleware::from_fn_with_state(activity, update_admission));
        let id = "11111111-1111-4111-8111-111111111111";
        assert_eq!(
            call(&app, "POST", "/api/system/update-lease", None, id).await.1["code"],
            "UPDATE_CONTROL_FORBIDDEN"
        );
        assert_eq!(
            call(&app, "POST", "/api/system/update-lease", Some("parent-only"), "bad")
                .await
                .1["code"],
            "UPDATE_LEASE_INVALID"
        );
        let turn = services
            .conversation_runtime_state
            .try_claim_turn("conversation", "active")
            .unwrap();
        assert_eq!(
            call(&app, "POST", "/api/system/update-lease", Some("parent-only"), id)
                .await
                .1["data"]["idle"],
            false
        );
        assert!(services.conversation_runtime_state.is_claimed("conversation"));
        drop(turn);
        assert_eq!(
            call(&app, "POST", "/api/system/update-lease", Some("parent-only"), id)
                .await
                .1["data"]["idle"],
            true
        );
        assert_eq!(
            call(&app, "POST", "/work", None, id).await.1["code"],
            "APP_UPDATE_PENDING"
        );
        assert_eq!(
            call(&app, "DELETE", "/api/system/update-lease", Some("parent-only"), id)
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(call(&app, "POST", "/work", None, id).await.0, StatusCode::OK);
        assert_eq!(
            call(&app, "POST", "/api/system/update-lease", Some("parent-only"), id)
                .await
                .1["data"]["idle"],
            false
        );
    }
}
