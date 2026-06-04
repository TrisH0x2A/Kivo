use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcProtoDirectoryRecord {
    pub path: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedCollectionResult {
    pub detected_format: String,
    pub collection: CollectionRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedRequestsResult {
    pub detected_format: String,
    pub requests: Vec<RequestRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvVarsResult {
    pub workspace: Vec<EnvVar>,
    pub collection: Vec<EnvVar>,
    pub merged: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEnvironment {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEnvironmentsResult {
    pub active_environment_id: String,
    pub environments: Vec<WorkspaceEnvironment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CollectionScripts {
    #[serde(default)]
    pub pre_request: String,
    #[serde(default)]
    pub post_response: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionConfig {
    #[serde(default)]
    pub default_headers: Vec<KeyValueRow>,
    #[serde(default = "default_auth_record")]
    pub default_auth: AuthRecord,
    #[serde(default)]
    pub scripts: CollectionScripts,
}

impl Default for CollectionConfig {
    fn default() -> Self {
        CollectionConfig {
            default_headers: vec![],
            default_auth: default_auth_record(),
            scripts: CollectionScripts::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub clear_oauth_session_on_start: bool,
    #[serde(default = "default_true")]
    pub validate_certificates_during_authentication: bool,
    #[serde(default = "default_true")]
    pub ssl_tls_certificate_verification: bool,
    #[serde(default)]
    pub use_custom_ca_certificate: bool,
    #[serde(default)]
    pub custom_ca_certificate_path: String,
    #[serde(default = "default_true")]
    pub keep_default_ca_certificates: bool,
    #[serde(default)]
    pub store_last_response_by_default: bool,
    #[serde(default = "default_true")]
    pub store_cookies_automatically: bool,
    #[serde(default = "default_true")]
    pub send_cookies_automatically: bool,
    #[serde(default = "default_true")]
    pub use_system_browser_for_oauth2_authorization: bool,
    #[serde(default)]
    pub request_timeout_ms: u64,
    #[serde(default)]
    pub proxy_enabled: bool,
    #[serde(default)]
    pub proxy_http: String,
    #[serde(default)]
    pub proxy_https: String,
    #[serde(default)]
    pub no_proxy: String,
    #[serde(default)]
    pub proxy_username: String,
    #[serde(default)]
    pub proxy_password: String,
    #[serde(default)]
    pub use_client_certificate: bool,
    #[serde(default)]
    pub client_certificate_path: String,
    #[serde(default)]
    pub client_key_path: String,
    #[serde(default)]
    pub keybindings: HashMap<String, String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            clear_oauth_session_on_start: false,
            validate_certificates_during_authentication: true,
            ssl_tls_certificate_verification: true,
            use_custom_ca_certificate: false,
            custom_ca_certificate_path: String::new(),
            keep_default_ca_certificates: true,
            store_last_response_by_default: false,
            store_cookies_automatically: true,
            send_cookies_automatically: true,
            use_system_browser_for_oauth2_authorization: true,
            request_timeout_ms: 0,
            proxy_enabled: false,
            proxy_http: String::new(),
            proxy_https: String::new(),
            no_proxy: String::new(),
            proxy_username: String::new(),
            proxy_password: String::new(),
            use_client_certificate: false,
            client_certificate_path: String::new(),
            client_key_path: String::new(),
            keybindings: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedAppState {
    #[serde(default)]
    pub version: u8,
    pub storage_path: Option<std::path::PathBuf>,
    #[serde(default)]
    pub active_workspace_name: String,
    #[serde(default)]
    pub active_collection_name: String,
    #[serde(default)]
    pub active_request_name: String,
    #[serde(default = "default_sidebar_tab")]
    pub sidebar_tab: String,
    #[serde(default = "default_sidebar_width")]
    pub sidebar_width: u16,
    #[serde(default)]
    pub app_settings: AppSettings,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub request_runtime_state: HashMap<String, RequestRuntimeState>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub request_history: Vec<RequestHistoryEntry>,
    #[serde(default)]
    pub workspaces: Vec<WorkspaceRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RequestHistoryEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub workspace_name: String,
    #[serde(default)]
    pub collection_name: String,
    #[serde(default)]
    pub request_name: String,
    #[serde(default)]
    pub request_mode: String,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub status: u16,
    #[serde(default)]
    pub status_text: String,
    #[serde(default)]
    pub duration: String,
    #[serde(default)]
    pub size: String,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub sent_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RequestRuntimeState {
    #[serde(default = "default_active_editor_tab", skip_serializing_if = "is_default_active_editor_tab")]
    pub active_editor_tab: String,
    #[serde(default = "default_active_response_tab", skip_serializing_if = "is_default_active_response_tab")]
    pub active_response_tab: String,
    #[serde(default = "default_response_body_view", skip_serializing_if = "is_default_response_body_view")]
    pub response_body_view: String,
    #[serde(default = "default_script_active_phase", skip_serializing_if = "is_default_script_active_phase")]
    pub script_active_phase: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub script_last_run_at: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub script_last_phase: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub script_last_status: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub script_last_error: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub script_last_logs: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub script_last_tests: Vec<ScriptTestRecord>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub script_last_vars: HashMap<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_response: Option<SavedResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRecord {
    pub name: String,
    pub description: Option<String>,
    #[serde(default)]
    pub collections: Vec<CollectionRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub resource_type: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionMeta {
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub folders: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub folder_settings: Vec<FolderSettingsRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub info: WorkspaceInfo,
    pub collections: Vec<CollectionMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRecord {
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub folders: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub folder_settings: Vec<FolderSettingsRecord>,
    pub requests: Vec<RequestRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSettingsRecord {
    pub path: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub default_headers: Vec<KeyValueRow>,
    #[serde(default = "default_inherit_auth_record")]
    pub default_auth: AuthRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CollectionStateFile {
    #[serde(default)]
    pub folders: Vec<String>,
    #[serde(default)]
    pub folder_settings: Vec<FolderSettingsRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestTextOrJson {
    Text(String),
    Json(serde_json::Value),
}

impl Default for RequestTextOrJson {
    fn default() -> Self {
        RequestTextOrJson::Text(String::new())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestRecord {
    pub name: String,
    #[serde(default = "default_request_mode")]
    pub request_mode: String,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub query_params: Vec<KeyValueRow>,
    #[serde(default)]
    pub headers: Vec<KeyValueRow>,
    #[serde(default = "default_auth_record")]
    pub auth: AuthRecord,
    #[serde(default)]
    pub body_type: String,
    #[serde(default, skip_serializing_if = "is_empty_request_text_or_json")]
    pub body: RequestTextOrJson,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub body_rows: Vec<KeyValueRow>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub body_file_path: String,
    #[serde(default, skip_serializing_if = "is_empty_request_text_or_json")]
    pub graphql_variables: RequestTextOrJson,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub grpc_proto_file_path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub grpc_method_path: String,
    #[serde(
        default = "default_grpc_streaming_mode",
        skip_serializing_if = "is_default_grpc_streaming_mode"
    )]
    pub grpc_streaming_mode: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grpc_direct_proto_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grpc_proto_directories: Vec<GrpcProtoDirectoryRecord>,
    #[serde(default)]
    pub docs: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default = "default_true")]
    pub url_encoding: bool,
    #[serde(default = "default_true")]
    pub follow_redirects: bool,
    #[serde(default = "default_max_redirects")]
    pub max_redirects: u32,
    #[serde(default)]
    pub timeout_ms: u64,
    #[serde(default = "default_true")]
    pub use_cookie_jar: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub proxy_mode: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub proxy_http: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub proxy_https: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub no_proxy: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub client_certificate_path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub client_key_path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub folder_path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub script_pre_request: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub script_after_response: String,
    #[serde(default = "default_script_active_phase", skip_serializing_if = "is_default_script_active_phase")]
    pub script_active_phase: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub script_last_run_at: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub script_last_phase: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub script_last_status: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub script_last_error: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub script_last_logs: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub script_last_tests: Vec<ScriptTestRecord>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub script_last_vars: HashMap<String, Value>,
    #[serde(default = "default_active_editor_tab", skip_serializing_if = "is_default_active_editor_tab")]
    pub active_editor_tab: String,
    #[serde(default = "default_active_response_tab", skip_serializing_if = "is_default_active_response_tab")]
    pub active_response_tab: String,
    #[serde(default = "default_response_body_view", skip_serializing_if = "is_default_response_body_view")]
    pub response_body_view: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_response: Option<SavedResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyValueRow {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, rename = "fieldType", skip_serializing_if = "String::is_empty")]
    pub field_type: String,
    #[serde(default, rename = "filePath", skip_serializing_if = "String::is_empty")]
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptTestRecord {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub ok: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OAuthParamRow {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OAuthConfig {
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
    #[serde(default)]
    pub last_error: String,
    #[serde(default)]
    pub last_warning: String,
    #[serde(default)]
    pub last_status: String,
}

impl Default for OAuthConfig {
    fn default() -> Self {
        Self {
            grant_type: "authorization_code".to_string(),
            auth_url: String::new(),
            token_url: String::new(),
            callback_url: String::new(),
            client_id: String::new(),
            client_secret: String::new(),
            scope: String::new(),
            audience: String::new(),
            resource: String::new(),
            authorization_code: String::new(),
            access_token: String::new(),
            refresh_token: String::new(),
            token_type: "Bearer".to_string(),
            expires_at: String::new(),
            username: String::new(),
            password: String::new(),
            use_pkce: true,
            code_verifier: String::new(),
            state: String::new(),
            client_auth_method: "basic".to_string(),
            extra_token_params: vec![],
            last_error: String::new(),
            last_warning: String::new(),
            last_status: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthRecord {
    #[serde(rename = "type")]
    pub auth_type: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub token: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub username: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub password: String,
    #[serde(default, rename = "jwtToken", skip_serializing_if = "String::is_empty")]
    pub jwt_token: String,
    #[serde(default, rename = "digestRealm", skip_serializing_if = "String::is_empty")]
    pub digest_realm: String,
    #[serde(default, rename = "digestNonce", skip_serializing_if = "String::is_empty")]
    pub digest_nonce: String,
    #[serde(default, rename = "digestQop", skip_serializing_if = "String::is_empty")]
    pub digest_qop: String,
    #[serde(
        default,
        rename = "digestAlgorithm",
        skip_serializing_if = "String::is_empty"
    )]
    pub digest_algorithm: String,
    #[serde(
        default,
        rename = "apiKeyName",
        skip_serializing_if = "String::is_empty"
    )]
    pub api_key_name: String,
    #[serde(
        default,
        rename = "apiKeyValue",
        skip_serializing_if = "String::is_empty"
    )]
    pub api_key_value: String,
    #[serde(
        default,
        rename = "apiKeyIn",
        skip_serializing_if = "is_default_api_key_in"
    )]
    pub api_key_in: String,
    #[serde(default, skip_serializing_if = "is_default_oauth_config")]
    pub oauth2: OAuthConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedResponse {
    #[serde(default)]
    pub status: u16,
    #[serde(default)]
    pub badge: String,
    #[serde(default)]
    pub status_text: String,
    #[serde(default)]
    pub duration: String,
    #[serde(default)]
    pub size: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub cookies: Vec<String>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub raw_body: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub body_base64: String,
    #[serde(default)]
    pub is_binary: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub content_type: String,
    #[serde(default)]
    pub is_json: bool,
    #[serde(default)]
    pub meta: ResponseMeta,
    #[serde(default)]
    pub saved_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResponseMeta {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub method: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoragePathValidationResult {
    pub exists: bool,
    pub is_directory: bool,
    pub writable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSwitchPayload {
    pub path: String,
    pub mode: String,
}

pub fn default_sidebar_width() -> u16 {
    304
}
pub fn default_sidebar_tab() -> String {
    "requests".to_string()
}
pub fn default_true() -> bool {
    true
}
pub fn default_max_redirects() -> u32 {
    5
}

pub fn default_request_mode() -> String {
    "http".to_string()
}

pub fn default_grpc_streaming_mode() -> String {
    "bidi".to_string()
}

pub fn default_script_active_phase() -> String {
    "pre-request".to_string()
}

pub fn default_active_editor_tab() -> String {
    "Params".to_string()
}

pub fn default_active_response_tab() -> String {
    "Body".to_string()
}

pub fn default_response_body_view() -> String {
    "JSON".to_string()
}

pub fn is_default_grpc_streaming_mode(value: &String) -> bool {
    value == "bidi"
}

pub fn is_default_script_active_phase(value: &String) -> bool {
    value == "pre-request"
}

pub fn is_default_active_editor_tab(value: &String) -> bool {
    value.is_empty() || value == "Params"
}

pub fn is_default_active_response_tab(value: &String) -> bool {
    value.is_empty() || value == "Body"
}

pub fn is_default_response_body_view(value: &String) -> bool {
    value.is_empty() || value == "JSON"
}

pub fn default_auth_record() -> AuthRecord {
    AuthRecord {
        auth_type: "none".to_string(),
        token: String::new(),
        username: String::new(),
        password: String::new(),
        jwt_token: String::new(),
        digest_realm: String::new(),
        digest_nonce: String::new(),
        digest_qop: "auth".to_string(),
        digest_algorithm: "SHA-256".to_string(),
        api_key_name: String::new(),
        api_key_value: String::new(),
        api_key_in: "header".to_string(),
        oauth2: OAuthConfig::default(),
    }
}

pub fn default_inherit_auth_record() -> AuthRecord {
    AuthRecord {
        auth_type: "inherit".to_string(),
        token: String::new(),
        username: String::new(),
        password: String::new(),
        jwt_token: String::new(),
        digest_realm: String::new(),
        digest_nonce: String::new(),
        digest_qop: "auth".to_string(),
        digest_algorithm: "SHA-256".to_string(),
        api_key_name: String::new(),
        api_key_value: String::new(),
        api_key_in: "header".to_string(),
        oauth2: OAuthConfig::default(),
    }
}

pub fn default_state() -> PersistedAppState {
    PersistedAppState {
        version: 1,
        storage_path: None,
        active_workspace_name: String::new(),
        active_collection_name: String::new(),
        active_request_name: String::new(),
        sidebar_tab: "requests".to_string(),
        sidebar_width: default_sidebar_width(),
        app_settings: AppSettings::default(),
        request_runtime_state: HashMap::new(),
        request_history: vec![],
        workspaces: vec![],
    }
}

pub fn is_empty_request_text_or_json(value: &RequestTextOrJson) -> bool {
    matches!(value, RequestTextOrJson::Text(text) if text.trim().is_empty())
}

pub fn is_default_oauth_config(value: &OAuthConfig) -> bool {
    value == &OAuthConfig::default()
}

pub fn is_default_api_key_in(value: &String) -> bool {
    value.is_empty() || value == "header"
}
