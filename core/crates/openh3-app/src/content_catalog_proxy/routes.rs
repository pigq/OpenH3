// ApiError belongs at this HTTP middleware boundary, not in service logic.
#![allow(clippy::disallowed_types)]

use super::ContentCatalogProxy;
use axum::middleware::Next;
use openh3_auth::{AuthIdentityMode, AuthState, CookieConfig};
use openh3_common::ApiError;

// Static web-host always overwrites this marker. An embedded local Core must
// still authenticate remote WebUI requests instead of injecting its desktop user.
pub(crate) async fn authenticate(
    State(mut state): State<AuthState>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    if request.headers().contains_key("x-openh3-webui-request") && state.identity_mode == AuthIdentityMode::Local {
        state.identity_mode = AuthIdentityMode::UserSession;
    }
    openh3_auth::auth_middleware(State(state), request, next).await
}
pub(crate) async fn webui_csrf(
    State((cookies, local)): State<(Arc<CookieConfig>, bool)>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    if local && request.headers().contains_key("x-openh3-webui-request") {
        openh3_auth::csrf_middleware(State(cookies), request, next).await
    } else {
        Ok(next.run(request).await)
    }
}
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use openh3_api_types::ErrorResponse;
use std::sync::Arc;

pub fn content_catalog_routes(proxy: Option<Arc<ContentCatalogProxy>>) -> Router {
    Router::new()
        .route("/api/content-catalog/{*path}", any(forward))
        .with_state(proxy)
}
fn error(status: StatusCode, code: &'static str) -> Response {
    (
        status,
        Json(ErrorResponse::new("Official content request failed.", code)),
    )
        .into_response()
}
fn allowed(method: &Method, path: &str) -> bool {
    let Some(tail) = path.strip_prefix("/api/content-catalog/") else {
        return false;
    };
    match (method, tail) {
        (&Method::GET, "catalog" | "status") => true,
        (&Method::POST, "check" | "cancel" | "settings" | "restore" | "lease") => true,
        (&Method::GET | &Method::HEAD, _) => {
            let parts: Vec<_> = tail.split('/').collect();
            parts.len() == 3
                && parts[0] == "assets"
                && !parts[1].is_empty()
                && parts[1].len() <= 15
                && parts[1].bytes().all(|c| c.is_ascii_digit())
                && parts[2].len() == 64
                && parts[2]
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        }
        _ => false,
    }
}
async fn forward(State(proxy): State<Option<Arc<ContentCatalogProxy>>>, request: Request) -> Response {
    let Some(user) = request.extensions().get::<openh3_auth::CurrentUser>() else {
        return error(StatusCode::UNAUTHORIZED, "UNAUTHORIZED");
    };
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    if !allowed(&method, &path) || request.uri().query().is_some() {
        return error(StatusCode::NOT_FOUND, "NOT_FOUND");
    }
    let Some(proxy) = proxy else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "CONTENT_HOST_UNAVAILABLE");
    };
    let can_manage = proxy.can_manage(user);
    if method == Method::POST && !path.ends_with("/lease") {
        if !can_manage {
            return error(StatusCode::FORBIDDEN, "CONTENT_ADMIN_REQUIRED");
        }
        let mut last = proxy.last_control.lock().await;
        if last.is_some_and(|time| time.elapsed() < std::time::Duration::from_millis(250)) {
            return error(StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED");
        }
        *last = Some(std::time::Instant::now());
    }
    let Ok(Ok(_permit)) = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        proxy.permits.clone().acquire_owned(),
    )
    .await
    else {
        return error(StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED");
    };
    let mut upstream = proxy
        .client
        .request(method.clone(), format!("{}{path}", proxy.base))
        .header("x-openh3-content-token", proxy.token.clone());
    for name in [header::RANGE, header::CONTENT_TYPE] {
        if let Some(value) = request.headers().get(&name) {
            upstream = upstream.header(name, value);
        }
    }
    let body = match to_bytes(request.into_body(), 1024).await {
        Ok(b) => b,
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "PAYLOAD_TOO_LARGE"),
    };
    let mut upstream = match upstream.body(body).send().await {
        Ok(r) => r,
        Err(_) => return error(StatusCode::BAD_GATEWAY, "CONTENT_HOST_UNAVAILABLE"),
    };
    if upstream.status() == StatusCode::UNAUTHORIZED {
        return error(StatusCode::BAD_GATEWAY, "CONTENT_HOST_UNAVAILABLE");
    }
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let mut data = Vec::new();
    loop {
        match upstream.chunk().await {
            Ok(Some(chunk)) => {
                if data.len() + chunk.len() > 32 * 1024 * 1024 {
                    return error(StatusCode::BAD_GATEWAY, "CONTENT_RESPONSE_LIMIT");
                }
                data.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return error(StatusCode::BAD_GATEWAY, "CONTENT_HOST_UNAVAILABLE"),
        }
    }
    if path.ends_with("/status")
        && status.is_success()
        && let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&data)
    {
        value["data"]["canManage"] = serde_json::Value::Bool(can_manage);
        data = serde_json::to_vec(&value).unwrap_or_default();
    }
    let mut response = Response::builder().status(status);
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_RANGE,
        header::ACCEPT_RANGES,
        header::CACHE_CONTROL,
        header::ETAG,
        header::X_CONTENT_TYPE_OPTIONS,
    ] {
        if let Some(value) = headers.get(&name) {
            response = response.header(name, value);
        }
    }
    if method == Method::HEAD
        && let Some(length) = headers.get(header::CONTENT_LENGTH)
    {
        response = response.header(header::CONTENT_LENGTH, length);
    }
    response
        .body(Body::from(data))
        .unwrap_or_else(|_| error(StatusCode::BAD_GATEWAY, "CONTENT_HOST_UNAVAILABLE"))
}
