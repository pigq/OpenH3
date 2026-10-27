mod common;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use openh3_app::{AppConfig, AppServices, create_router};
use std::sync::Arc;
use tower::ServiceExt;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{header, method, path},
};

#[tokio::test]
async fn webui_cannot_inherit_embedded_desktop_auth() {
    let root = tempfile::tempdir().unwrap();
    let config = AppConfig {
        local: true,
        data_dir: root.path().to_path_buf(),
        work_dir: root.path().to_path_buf(),
        ..Default::default()
    };
    let services = AppServices::from_config(openh3_db::init_database_memory().await.unwrap(), &config)
        .await
        .unwrap();
    let app = create_router(&services).await.unwrap();
    let request = Request::builder()
        .uri("/api/content-catalog/catalog")
        .header("x-openh3-webui-request", "1")
        .body(Body::empty())
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(common::body_json(response).await["code"], "UNAUTHORIZED");
    let request = Request::builder()
        .method("POST")
        .uri("/api/content-catalog/check")
        .header("x-openh3-webui-request", "1")
        .body(Body::from("{}"))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(common::body_json(response).await["code"], "CSRF_INVALID");
}
#[tokio::test]
async fn content_routes_require_auth_and_csrf() {
    let root = tempfile::tempdir().unwrap();
    let config = AppConfig {
        data_dir: root.path().to_path_buf(),
        work_dir: root.path().to_path_buf(),
        ..Default::default()
    };
    let services = AppServices::from_config(openh3_db::init_database_memory().await.unwrap(), &config)
        .await
        .unwrap();
    let app = create_router(&services).await.unwrap();
    let res = app
        .clone()
        .oneshot(common::get_request("/api/content-catalog/catalog"))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(common::body_json(res).await["code"], "UNAUTHORIZED");
    let req = Request::builder()
        .method("POST")
        .uri("/api/content-catalog/settings")
        .header("content-type", "application/json")
        .body(Body::from(r#"{"autoSync":false}"#))
        .unwrap();
    let res = app.oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(common::body_json(res).await["code"], "CSRF_INVALID");
}

#[tokio::test]
async fn content_proxy_scopes_host_control_and_never_forwards_browser_credentials() {
    let root = tempfile::tempdir().unwrap();
    let server = MockServer::start().await;
    let config = AppConfig {
        data_dir: root.path().to_path_buf(),
        work_dir: root.path().to_path_buf(),
        ..Default::default()
    };
    let mut services = AppServices::from_config(openh3_db::init_database_memory().await.unwrap(), &config)
        .await
        .unwrap();
    let owner = services.user_repo.create_user("owner", "test-only").await.unwrap();
    let reader = services.user_repo.create_user("reader", "test-only").await.unwrap();
    let owner_token = services
        .jwt_service
        .sign(&owner.id, owner.username.as_deref().unwrap())
        .unwrap();
    let reader_token = services
        .jwt_service
        .sign(&reader.id, reader.username.as_deref().unwrap())
        .unwrap();
    let internal = "a".repeat(64);
    services.content_catalog_proxy = Some(Arc::new(
        openh3_app::ContentCatalogProxy::new(server.address().port(), &internal, false, Some(owner.id)).unwrap(),
    ));
    let app = create_router(&services).await.unwrap();
    Mock::given(method("GET"))
        .and(path("/api/content-catalog/status"))
        .and(header("x-openh3-content-token", internal.as_str()))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true,"data":{"activeSequence":1}})),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/content-catalog/catalog"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_delay(std::time::Duration::from_millis(50))
                .set_body_json(serde_json::json!({"success":true})),
        )
        .mount(&server)
        .await;
    let mut reads = tokio::task::JoinSet::new();
    for _ in 0..8 {
        let app = app.clone();
        let token = reader_token.clone();
        reads.spawn(async move {
            app.oneshot(common::get_with_token("/api/content-catalog/catalog", &token))
                .await
                .unwrap()
                .status()
        });
    }
    while let Some(result) = reads.join_next().await {
        assert_eq!(result.unwrap(), StatusCode::OK);
    }
    Mock::given(method("POST"))
        .and(path("/api/content-catalog/check"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"success":true,"data":{}})))
        .mount(&server)
        .await;
    let res = app
        .clone()
        .oneshot(common::get_with_token("/api/content-catalog/status", &reader_token))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let json = common::body_json(res).await;
    assert_eq!(json["data"]["canManage"], false);
    assert!(!json.to_string().contains(&internal));
    let req = common::json_with_token(
        "POST",
        "/api/content-catalog/check",
        serde_json::json!({}),
        &reader_token,
        "csrf",
    );
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);
    assert_eq!(common::body_json(res).await["code"], "CONTENT_ADMIN_REQUIRED");
    let req = common::json_with_token(
        "POST",
        "/api/content-catalog/check",
        serde_json::json!({}),
        &owner_token,
        "csrf",
    );
    let res = app.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let res = app
        .oneshot(common::get_with_token(
            "/api/content-catalog/catalog?url=http://example.com",
            &owner_token,
        ))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    for req in server.received_requests().await.unwrap() {
        assert!(!req.headers.contains_key("authorization"));
        assert!(!req.headers.contains_key("cookie"));
    }
}
