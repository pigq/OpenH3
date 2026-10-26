//! Authenticated bridge to the host-owned, loopback-only content runtime.
mod routes;
pub use routes::content_catalog_routes;
pub(crate) use routes::{authenticate, webui_csrf};

use axum::http::HeaderValue;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore};

pub struct ContentCatalogProxy {
    client: reqwest::Client,
    base: String,
    token: HeaderValue,
    local: bool,
    admin_user_id: Option<String>,
    last_control: Mutex<Option<Instant>>,
    permits: Arc<Semaphore>,
}
impl ContentCatalogProxy {
    pub fn new(port: u16, token: &str, local: bool, admin_user_id: Option<String>) -> anyhow::Result<Self> {
        anyhow::ensure!(
            port > 0 && token.len() == 64 && token.bytes().all(|c| c.is_ascii_hexdigit()),
            "Invalid content host configuration"
        );
        Ok(Self {
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(45))
                .build()?,
            base: format!("http://127.0.0.1:{port}"),
            token: HeaderValue::from_str(token)?,
            local,
            admin_user_id,
            last_control: Mutex::new(None),
            permits: Arc::new(Semaphore::new(4)),
        })
    }
    pub(crate) fn from_env(local: bool) -> anyhow::Result<Option<Arc<Self>>> {
        match (
            std::env::var("OPENH3_CONTENT_PORT").ok(),
            std::env::var("OPENH3_CONTENT_TOKEN").ok(),
        ) {
            (None, None) => Ok(None),
            (Some(port), Some(token)) => {
                let proxy = Self::new(
                    port.parse()?,
                    &token,
                    local,
                    Some(
                        std::env::var("OPENH3_CONTENT_ADMIN_USER_ID")
                            .unwrap_or_else(|_| "system_default_user".to_owned()),
                    ),
                )?;
                tracing::info!("official content host bridge configured");
                Ok(Some(Arc::new(proxy)))
            }
            _ => anyhow::bail!("Incomplete content host configuration"),
        }
    }
    fn can_manage(&self, user: &openh3_auth::CurrentUser) -> bool {
        (self.local && user.id == "system_default_user") || self.admin_user_id.as_deref() == Some(user.id.as_str())
    }
}
