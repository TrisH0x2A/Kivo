use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OAuthParamRow {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub enabled: bool,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OAuthPayload {
    #[serde(default)]
    pub grant_type: String,
    #[serde(default)]
    pub auth_url: String,
    #[serde(default)]
    pub token_url: String,
    #[serde(default)]
    pub callback_url: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub audience: String,
    #[serde(default)]
    pub resource: String,
    #[serde(default)]
    pub authorization_code: String,
    #[serde(default)]
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    #[serde(default)]
    pub token_type: String,
    #[serde(default)]
    pub expires_at: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub use_pkce: bool,
    #[serde(default)]
    pub code_verifier: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub client_auth_method: String,
    #[serde(default)]
    pub extra_token_params: Vec<OAuthParamRow>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthPayload {
    #[serde(default)]
    pub api_key_in: String,
    #[serde(default)]
    pub api_key_name: String,
    #[serde(default)]
    pub api_key_value: String,
    #[serde(default)]
    pub oauth2: Option<OAuthPayload>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestPayload {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    #[serde(default)]
    pub body_file_path: Option<String>,
    #[serde(default)]
    pub body_rows: Vec<FormBodyRowPayload>,

    #[serde(default)]
    pub request_id: String,

    #[serde(default)]
    pub workspace_name: String,

    #[serde(default)]
    pub collection_name: String,

    #[serde(default)]
    pub auth_type: String,

    #[serde(default)]
    pub inherit_headers: Option<bool>,

    #[serde(default)]
    pub disable_user_agent: Option<bool>,

    #[serde(default)]
    pub use_cookie_jar: Option<bool>,

    #[serde(default)]
    pub timeout_ms: Option<u64>,

    #[serde(default)]
    pub follow_redirects: Option<bool>,

    #[serde(default)]
    pub max_redirects: Option<u32>,

    #[serde(default)]
    pub auth_payload: Option<AuthPayload>,

    #[serde(default)]
    pub proxy_mode: Option<String>,
    #[serde(default)]
    pub proxy_http: Option<String>,
    #[serde(default)]
    pub proxy_https: Option<String>,
    #[serde(default)]
    pub no_proxy: Option<String>,
    #[serde(default)]
    pub client_certificate_path: Option<String>,
    #[serde(default)]
    pub client_key_path: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FormBodyRowPayload {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub field_type: String,
    #[serde(default)]
    pub file_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcRequestPayload {
    pub url: String,
    pub grpc_proto_file_path: String,
    pub grpc_method_path: String,
    #[serde(default)]
    pub grpc_streaming_mode: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub workspace_name: String,
    #[serde(default)]
    pub collection_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthTokenExchangePayload {
    #[serde(default)]
    pub workspace_name: String,
    #[serde(default)]
    pub collection_name: String,
    #[serde(default)]
    pub request_id: String,
    pub oauth: OAuthPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCallbackWaitPayload {
    pub callback_url: String,
    #[serde(default)]
    pub expected_state: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCallbackWaitResult {
    pub authorization_code: String,
    pub received_state: String,
    pub callback_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthTokenExchangeResult {
    pub access_token: String,
    pub refresh_token: String,
    pub token_type: String,
    pub scope: String,
    pub expires_in: Option<u64>,
    pub expires_at: String,
    pub raw: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponsePayload {
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub cookies: Vec<String>,
    pub body: String,
    #[serde(default)]
    pub body_base64: String,
    #[serde(default)]
    pub is_binary: bool,
    #[serde(default)]
    pub content_type: String,
    pub duration_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookieJarEntry {
    pub id: String,
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub http_only: bool,
    #[serde(default)]
    pub same_site: String,
    #[serde(default)]
    pub host_only: bool,
    #[serde(default)]
    pub workspace_name: String,
    #[serde(default)]
    pub collection_name: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub last_accessed_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertCookieJarEntryPayload {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub value: String,
    pub domain: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub http_only: bool,
    #[serde(default)]
    pub same_site: String,
    #[serde(default)]
    pub host_only: bool,
    #[serde(default)]
    pub workspace_name: String,
    #[serde(default)]
    pub collection_name: String,
}
