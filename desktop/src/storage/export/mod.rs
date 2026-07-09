use crate::storage::models::{
    CollectionRecord, FolderSettingsRecord, KeyValueRow, OAuthParamRow, RequestRecord,
    RequestTextOrJson,
};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone)]
pub struct ExportEnvOptions {
    pub exclude_env_contained_fields: bool,
    pub replace_env_vars_with_values: bool,
    pub env_vars: HashMap<String, String>,
}

impl Default for ExportEnvOptions {
    fn default() -> Self {
        Self {
            exclude_env_contained_fields: true,
            replace_env_vars_with_values: false,
            env_vars: HashMap::new(),
        }
    }
}

fn contains_template_var(value: &str) -> bool {
    let Some(start) = value.find("{{") else {
        return false;
    };
    value[start + 2..].contains("}}")
}

fn apply_env_replacement(value: &str, env_vars: &HashMap<String, String>) -> String {
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0usize;

    while let Some(open_rel) = value[cursor..].find("{{") {
        let open = cursor + open_rel;
        output.push_str(&value[cursor..open]);

        let after_open = open + 2;
        let Some(close_rel) = value[after_open..].find("}}") else {
            output.push_str(&value[open..]);
            return output;
        };

        let close = after_open + close_rel;
        let key = value[after_open..close].trim();
        if let Some(replacement) = env_vars.get(key) {
            output.push_str(replacement);
        } else {
            output.push_str(&value[open..close + 2]);
        }
        cursor = close + 2;
    }

    if cursor < value.len() {
        output.push_str(&value[cursor..]);
    }

    output
}

fn sanitize_export_text(value: &str, options: &ExportEnvOptions) -> String {
    let transformed = if options.replace_env_vars_with_values {
        apply_env_replacement(value, &options.env_vars)
    } else {
        value.to_string()
    };

    if options.exclude_env_contained_fields && contains_template_var(&transformed) {
        String::new()
    } else {
        transformed
    }
}

fn sanitize_json_value(value: &mut serde_json::Value, options: &ExportEnvOptions) {
    match value {
        serde_json::Value::String(text) => {
            *text = sanitize_export_text(text, options);
        }
        serde_json::Value::Array(items) => {
            for item in items {
                sanitize_json_value(item, options);
            }
        }
        serde_json::Value::Object(map) => {
            for entry in map.values_mut() {
                sanitize_json_value(entry, options);
            }
        }
        _ => {}
    }
}

fn sanitize_key_value_rows(rows: &mut [KeyValueRow], options: &ExportEnvOptions) {
    for row in rows {
        row.key = sanitize_export_text(&row.key, options);
        row.value = sanitize_export_text(&row.value, options);
    }
}

fn sanitize_oauth_rows(rows: &mut [OAuthParamRow], options: &ExportEnvOptions) {
    for row in rows {
        row.key = sanitize_export_text(&row.key, options);
        row.value = sanitize_export_text(&row.value, options);
    }
}

pub fn is_exportable_request_mode(mode: &str) -> bool {
    matches!(mode.trim().to_lowercase().as_str(), "http" | "graphql")
}

pub fn sanitize_request_for_export(
    request: &RequestRecord,
    options: &ExportEnvOptions,
) -> RequestRecord {
    let mut sanitized = request.clone();

    sanitized.name = sanitize_export_text(&sanitized.name, options);
    sanitized.method = sanitize_export_text(&sanitized.method, options);
    sanitized.url = sanitize_export_text(&sanitized.url, options);
    sanitize_key_value_rows(&mut sanitized.query_params, options);
    sanitize_key_value_rows(&mut sanitized.headers, options);
    sanitize_key_value_rows(&mut sanitized.body_rows, options);
    sanitized.body_file_path = sanitize_export_text(&sanitized.body_file_path, options);
    sanitized.docs = sanitize_export_text(&sanitized.docs, options);
    sanitized.tags = sanitized
        .tags
        .iter()
        .map(|tag| sanitize_export_text(tag, options))
        .collect();
    sanitized.folder_path = sanitize_export_text(&sanitized.folder_path, options);
    sanitized.script_pre_request = sanitize_export_text(&sanitized.script_pre_request, options);
    sanitized.script_after_response = sanitize_export_text(&sanitized.script_after_response, options);
    sanitized.script_active_phase = sanitize_export_text(&sanitized.script_active_phase, options);
    sanitized.script_last_run_at = sanitize_export_text(&sanitized.script_last_run_at, options);
    sanitized.script_last_phase = sanitize_export_text(&sanitized.script_last_phase, options);
    sanitized.script_last_status = sanitize_export_text(&sanitized.script_last_status, options);
    sanitized.script_last_error = sanitize_export_text(&sanitized.script_last_error, options);
    sanitized.script_last_logs = sanitized
        .script_last_logs
        .iter()
        .map(|line| sanitize_export_text(line, options))
        .collect();
    for test in &mut sanitized.script_last_tests {
        test.name = sanitize_export_text(&test.name, options);
        test.error = sanitize_export_text(&test.error, options);
    }
    for value in sanitized.script_last_vars.values_mut() {
        sanitize_json_value(value, options);
    }

    sanitized.auth.auth_type = sanitize_export_text(&sanitized.auth.auth_type, options);
    sanitized.auth.token = sanitize_export_text(&sanitized.auth.token, options);
    sanitized.auth.username = sanitize_export_text(&sanitized.auth.username, options);
    sanitized.auth.password = sanitize_export_text(&sanitized.auth.password, options);
    sanitized.auth.api_key_name = sanitize_export_text(&sanitized.auth.api_key_name, options);
    sanitized.auth.api_key_value = sanitize_export_text(&sanitized.auth.api_key_value, options);
    sanitized.auth.api_key_in = sanitize_export_text(&sanitized.auth.api_key_in, options);

    sanitized.auth.oauth2.grant_type = sanitize_export_text(&sanitized.auth.oauth2.grant_type, options);
    sanitized.auth.oauth2.auth_url = sanitize_export_text(&sanitized.auth.oauth2.auth_url, options);
    sanitized.auth.oauth2.token_url = sanitize_export_text(&sanitized.auth.oauth2.token_url, options);
    sanitized.auth.oauth2.callback_url = sanitize_export_text(&sanitized.auth.oauth2.callback_url, options);
    sanitized.auth.oauth2.client_id = sanitize_export_text(&sanitized.auth.oauth2.client_id, options);
    sanitized.auth.oauth2.client_secret = sanitize_export_text(&sanitized.auth.oauth2.client_secret, options);
    sanitized.auth.oauth2.scope = sanitize_export_text(&sanitized.auth.oauth2.scope, options);
    sanitized.auth.oauth2.audience = sanitize_export_text(&sanitized.auth.oauth2.audience, options);
    sanitized.auth.oauth2.resource = sanitize_export_text(&sanitized.auth.oauth2.resource, options);
    sanitized.auth.oauth2.authorization_code =
        sanitize_export_text(&sanitized.auth.oauth2.authorization_code, options);
    sanitized.auth.oauth2.access_token = sanitize_export_text(&sanitized.auth.oauth2.access_token, options);
    sanitized.auth.oauth2.refresh_token = sanitize_export_text(&sanitized.auth.oauth2.refresh_token, options);
    sanitized.auth.oauth2.token_type = sanitize_export_text(&sanitized.auth.oauth2.token_type, options);
    sanitized.auth.oauth2.expires_at = sanitize_export_text(&sanitized.auth.oauth2.expires_at, options);
    sanitized.auth.oauth2.username = sanitize_export_text(&sanitized.auth.oauth2.username, options);
    sanitized.auth.oauth2.password = sanitize_export_text(&sanitized.auth.oauth2.password, options);
    sanitized.auth.oauth2.code_verifier = sanitize_export_text(&sanitized.auth.oauth2.code_verifier, options);
    sanitized.auth.oauth2.state = sanitize_export_text(&sanitized.auth.oauth2.state, options);
    sanitized.auth.oauth2.client_auth_method =
        sanitize_export_text(&sanitized.auth.oauth2.client_auth_method, options);
    sanitize_oauth_rows(&mut sanitized.auth.oauth2.extra_token_params, options);
    sanitized.auth.oauth2.last_error = sanitize_export_text(&sanitized.auth.oauth2.last_error, options);
    sanitized.auth.oauth2.last_warning = sanitize_export_text(&sanitized.auth.oauth2.last_warning, options);
    sanitized.auth.oauth2.last_status = sanitize_export_text(&sanitized.auth.oauth2.last_status, options);

    sanitized.grpc_proto_file_path = sanitize_export_text(&sanitized.grpc_proto_file_path, options);
    sanitized.grpc_method_path = sanitize_export_text(&sanitized.grpc_method_path, options);
    sanitized.grpc_streaming_mode = sanitize_export_text(&sanitized.grpc_streaming_mode, options);
    sanitized.grpc_direct_proto_files = sanitized
        .grpc_direct_proto_files
        .iter()
        .map(|path| sanitize_export_text(path, options))
        .collect();
    sanitized.grpc_proto_directories = sanitized
        .grpc_proto_directories
        .iter()
        .map(|entry| {
            let mut next = entry.clone();
            next.path = sanitize_export_text(&entry.path, options);
            next.files = entry
                .files
                .iter()
                .map(|path| sanitize_export_text(path, options))
                .collect();
            next
        })
        .collect();

    match &mut sanitized.body {
        RequestTextOrJson::Text(text) => {
            *text = sanitize_export_text(text, options);
        }
        RequestTextOrJson::Json(json) => {
            sanitize_json_value(json, options);
        }
    }

    match &mut sanitized.graphql_variables {
        RequestTextOrJson::Text(text) => {
            *text = sanitize_export_text(text, options);
        }
        RequestTextOrJson::Json(json) => {
            sanitize_json_value(json, options);
        }
    }

    sanitized.last_response = None;

    sanitized
}

fn insert_non_empty_string(map: &mut Map<String, Value>, key: &str, value: &str) {
    if !value.trim().is_empty() {
        map.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn key_value_rows_to_compact(rows: &[KeyValueRow]) -> Vec<Value> {
    rows.iter()
        .filter(|row| !row.key.trim().is_empty() || !row.value.trim().is_empty())
        .map(|row| {
            let mut item = Map::new();
            item.insert("key".to_string(), Value::String(row.key.clone()));
            item.insert("value".to_string(), Value::String(row.value.clone()));
            item.insert("enabled".to_string(), Value::Bool(row.enabled));
            Value::Object(item)
        })
        .collect()
}

fn oauth_to_compact(oauth: &crate::storage::models::OAuthConfig) -> Option<Value> {
    let mut map = Map::new();

    insert_non_empty_string(&mut map, "grantType", &oauth.grant_type);
    insert_non_empty_string(&mut map, "authUrl", &oauth.auth_url);
    insert_non_empty_string(&mut map, "tokenUrl", &oauth.token_url);
    insert_non_empty_string(&mut map, "callbackUrl", &oauth.callback_url);
    insert_non_empty_string(&mut map, "clientId", &oauth.client_id);
    insert_non_empty_string(&mut map, "clientSecret", &oauth.client_secret);
    insert_non_empty_string(&mut map, "scope", &oauth.scope);
    insert_non_empty_string(&mut map, "audience", &oauth.audience);
    insert_non_empty_string(&mut map, "resource", &oauth.resource);
    insert_non_empty_string(&mut map, "authorizationCode", &oauth.authorization_code);
    insert_non_empty_string(&mut map, "accessToken", &oauth.access_token);
    insert_non_empty_string(&mut map, "refreshToken", &oauth.refresh_token);
    insert_non_empty_string(&mut map, "tokenType", &oauth.token_type);
    insert_non_empty_string(&mut map, "expiresAt", &oauth.expires_at);
    insert_non_empty_string(&mut map, "username", &oauth.username);
    insert_non_empty_string(&mut map, "password", &oauth.password);
    if !oauth.use_pkce {
        map.insert("usePkce".to_string(), Value::Bool(false));
    }
    insert_non_empty_string(&mut map, "codeVerifier", &oauth.code_verifier);
    insert_non_empty_string(&mut map, "state", &oauth.state);
    insert_non_empty_string(&mut map, "clientAuthMethod", &oauth.client_auth_method);

    let extra = oauth
        .extra_token_params
        .iter()
        .filter(|row| !row.key.trim().is_empty() || !row.value.trim().is_empty())
        .map(|row| {
            let mut item = Map::new();
            item.insert("key".to_string(), Value::String(row.key.clone()));
            item.insert("value".to_string(), Value::String(row.value.clone()));
            item.insert("enabled".to_string(), Value::Bool(row.enabled));
            Value::Object(item)
        })
        .collect::<Vec<_>>();
    if !extra.is_empty() {
        map.insert("extraTokenParams".to_string(), Value::Array(extra));
    }

    insert_non_empty_string(&mut map, "lastError", &oauth.last_error);
    insert_non_empty_string(&mut map, "lastWarning", &oauth.last_warning);
    insert_non_empty_string(&mut map, "lastStatus", &oauth.last_status);

    if map.is_empty() {
        None
    } else {
        Some(Value::Object(map))
    }
}

fn auth_to_compact(auth: &crate::storage::models::AuthRecord) -> Option<Value> {
    let auth_type = auth.auth_type.trim().to_lowercase();
    if auth_type.is_empty() || auth_type == "none" {
        return None;
    }

    let mut map = Map::new();
    map.insert("type".to_string(), Value::String(auth.auth_type.clone()));
    insert_non_empty_string(&mut map, "token", &auth.token);
    insert_non_empty_string(&mut map, "username", &auth.username);
    insert_non_empty_string(&mut map, "password", &auth.password);
    insert_non_empty_string(&mut map, "apiKeyName", &auth.api_key_name);
    insert_non_empty_string(&mut map, "apiKeyValue", &auth.api_key_value);
    if !auth.api_key_in.trim().is_empty() && auth.api_key_in != "header" {
        map.insert("apiKeyIn".to_string(), Value::String(auth.api_key_in.clone()));
    }
    if let Some(oauth) = oauth_to_compact(&auth.oauth2) {
        map.insert("oauth2".to_string(), oauth);
    }
    Some(Value::Object(map))
}

fn request_text_or_json_to_compact(value: &RequestTextOrJson) -> Option<Value> {
    match value {
        RequestTextOrJson::Text(text) => {
            if text.trim().is_empty() {
                None
            } else {
                Some(Value::String(text.clone()))
            }
        }
        RequestTextOrJson::Json(json) => {
            if json.is_null() {
                None
            } else {
                Some(json.clone())
            }
        }
    }
}

fn graphql_variables_to_compact(value: &RequestTextOrJson) -> Option<Value> {
    match value {
        RequestTextOrJson::Text(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() || trimmed == "{}" {
                None
            } else {
                Some(Value::String(text.clone()))
            }
        }
        RequestTextOrJson::Json(json) => match json {
            Value::Object(map) if map.is_empty() => None,
            Value::Null => None,
            _ => Some(json.clone()),
        },
    }
}

fn compact_request_name(request: &RequestRecord) -> String {
    let name = request.name.trim();
    if !name.is_empty() {
        return request.name.clone();
    }

    let method = if request.method.trim().is_empty() {
        "GET"
    } else {
        request.method.trim()
    };
    let target = if request.url.trim().is_empty() {
        "/"
    } else {
        request.url.trim()
    };
    format!("{} {}", method, target)
}

fn request_to_compact_kivo_value(request: &RequestRecord) -> Value {
    let mut map = Map::new();
    map.insert("name".to_string(), Value::String(compact_request_name(request)));
    insert_non_empty_string(&mut map, "requestMode", &request.request_mode);
    insert_non_empty_string(&mut map, "method", &request.method);
    insert_non_empty_string(&mut map, "url", &request.url);

    let query_params = key_value_rows_to_compact(&request.query_params);
    if !query_params.is_empty() {
        map.insert("queryParams".to_string(), Value::Array(query_params));
    }
    let headers = key_value_rows_to_compact(&request.headers);
    if !headers.is_empty() {
        map.insert("headers".to_string(), Value::Array(headers));
    }

    if let Some(auth) = auth_to_compact(&request.auth) {
        map.insert("auth".to_string(), auth);
    }

    if !request.body_type.trim().is_empty() && request.body_type != "none" {
        map.insert("bodyType".to_string(), Value::String(request.body_type.clone()));
    }
    if let Some(body) = request_text_or_json_to_compact(&request.body) {
        map.insert("body".to_string(), body);
    }

    let body_rows = key_value_rows_to_compact(&request.body_rows);
    if !body_rows.is_empty() {
        map.insert("bodyRows".to_string(), Value::Array(body_rows));
    }
    insert_non_empty_string(&mut map, "bodyFilePath", &request.body_file_path);

    if let Some(graphql_variables) = graphql_variables_to_compact(&request.graphql_variables) {
        map.insert("graphqlVariables".to_string(), graphql_variables);
    }

    insert_non_empty_string(&mut map, "grpcProtoFilePath", &request.grpc_proto_file_path);
    insert_non_empty_string(&mut map, "grpcMethodPath", &request.grpc_method_path);
    if !request.grpc_streaming_mode.trim().is_empty() && request.grpc_streaming_mode != "bidi" {
        map.insert(
            "grpcStreamingMode".to_string(),
            Value::String(request.grpc_streaming_mode.clone()),
        );
    }
    if !request.grpc_direct_proto_files.is_empty() {
        map.insert(
            "grpcDirectProtoFiles".to_string(),
            Value::Array(
                request
                    .grpc_direct_proto_files
                    .iter()
                    .map(|path| Value::String(path.clone()))
                    .collect(),
            ),
        );
    }
    if !request.grpc_proto_directories.is_empty() {
        map.insert(
            "grpcProtoDirectories".to_string(),
            Value::Array(
                request
                    .grpc_proto_directories
                    .iter()
                    .map(|entry| {
                        let mut item = Map::new();
                        insert_non_empty_string(&mut item, "path", &entry.path);
                        if !entry.files.is_empty() {
                            item.insert(
                                "files".to_string(),
                                Value::Array(
                                    entry
                                        .files
                                        .iter()
                                        .map(|file| Value::String(file.clone()))
                                        .collect(),
                                ),
                            );
                        }
                        Value::Object(item)
                    })
                    .collect(),
            ),
        );
    }

    insert_non_empty_string(&mut map, "docs", &request.docs);
    if !request.tags.is_empty() {
        map.insert(
            "tags".to_string(),
            Value::Array(request.tags.iter().map(|tag| Value::String(tag.clone())).collect()),
        );
    }
    if !request.url_encoding {
        map.insert("urlEncoding".to_string(), Value::Bool(false));
    }
    if !request.follow_redirects {
        map.insert("followRedirects".to_string(), Value::Bool(false));
    }
    if request.max_redirects != 5 {
        map.insert(
            "maxRedirects".to_string(),
            Value::Number(serde_json::Number::from(request.max_redirects)),
        );
    }
    if request.timeout_ms > 0 {
        map.insert(
            "timeoutMs".to_string(),
            Value::Number(serde_json::Number::from(request.timeout_ms)),
        );
    }
    if !request.use_cookie_jar {
        map.insert("useCookieJar".to_string(), Value::Bool(false));
    }
    insert_non_empty_string(&mut map, "folderPath", &request.folder_path);

    insert_non_empty_string(&mut map, "scriptPreRequest", &request.script_pre_request);
    insert_non_empty_string(&mut map, "scriptAfterResponse", &request.script_after_response);

    Value::Object(map)
}

pub fn kivo_request_export_value(request: &RequestRecord) -> Value {
    serde_json::json!({
        "kivo": "1.0",
        "type": "request",
        "request": request_to_compact_kivo_value(request),
    })
}

pub fn kivo_collection_export_value(collection: &CollectionRecord) -> Value {
    let mut collection_map = Map::new();
    let collection_name = if collection.name.trim().is_empty() {
        "Kivo Collection".to_string()
    } else {
        collection.name.clone()
    };
    collection_map.insert("name".to_string(), Value::String(collection_name));

    if !collection.folders.is_empty() {
        collection_map.insert(
            "folders".to_string(),
            Value::Array(
                collection
                    .folders
                    .iter()
                    .map(|folder| Value::String(folder.clone()))
                    .collect(),
            ),
        );
    }

    if !collection.folder_settings.is_empty() {
        collection_map.insert(
            "folderSettings".to_string(),
            Value::Array(
                collection
                    .folder_settings
                    .iter()
                    .map(|setting| {
                        let mut item = Map::new();
                        insert_non_empty_string(&mut item, "path", &setting.path);
                        let headers = key_value_rows_to_compact(&setting.default_headers);
                        if !headers.is_empty() {
                            item.insert("defaultHeaders".to_string(), Value::Array(headers));
                        }
                        if let Some(auth) = auth_to_compact(&setting.default_auth) {
                            item.insert("defaultAuth".to_string(), auth);
                        }
                        Value::Object(item)
                    })
                    .collect(),
            ),
        );
    }

    collection_map.insert(
        "requests".to_string(),
        Value::Array(
            collection
                .requests
                .iter()
                .map(request_to_compact_kivo_value)
                .collect(),
        ),
    );

    serde_json::json!({
        "kivo": "1.0",
        "type": "collection",
        "collection": collection_map,
    })
}

pub fn prepare_request_for_export(
    request: &RequestRecord,
    options: &ExportEnvOptions,
) -> Result<RequestRecord, String> {
    if !is_exportable_request_mode(&request.request_mode) {
        return Err(
            "Export is supported only for HTTP and GraphQL requests. Realtime and gRPC requests are not exportable."
                .to_string(),
        );
    }

    Ok(sanitize_request_for_export(request, options))
}

pub fn prepare_kivo_request_for_export(
    request: &RequestRecord,
    options: &ExportEnvOptions,
) -> RequestRecord {
    sanitize_request_for_export(request, options)
}

pub fn prepare_requests_for_export(
    requests: &[RequestRecord],
    options: &ExportEnvOptions,
) -> Vec<RequestRecord> {
    requests
        .iter()
        .filter(|request| is_exportable_request_mode(&request.request_mode))
        .map(|request| sanitize_request_for_export(request, options))
        .collect()
}

pub fn prepare_collection_for_kivo_export(
    collection: &CollectionRecord,
    options: &ExportEnvOptions,
) -> CollectionRecord {
    let mut sanitized = collection.clone();
    sanitized.name = sanitize_export_text(&sanitized.name, options);
    sanitized.folders = sanitized
        .folders
        .iter()
        .map(|folder| sanitize_export_text(folder, options))
        .collect();
    sanitized.folder_settings = sanitized
        .folder_settings
        .iter()
        .map(|setting| {
            let mut next = FolderSettingsRecord {
                path: sanitize_export_text(&setting.path, options),
                default_headers: setting.default_headers.clone(),
                default_auth: setting.default_auth.clone(),
            };
            sanitize_key_value_rows(&mut next.default_headers, options);
            next.default_auth.auth_type = sanitize_export_text(&next.default_auth.auth_type, options);
            next.default_auth.token = sanitize_export_text(&next.default_auth.token, options);
            next.default_auth.username = sanitize_export_text(&next.default_auth.username, options);
            next.default_auth.password = sanitize_export_text(&next.default_auth.password, options);
            next.default_auth.api_key_name = sanitize_export_text(&next.default_auth.api_key_name, options);
            next.default_auth.api_key_value = sanitize_export_text(&next.default_auth.api_key_value, options);
            next.default_auth.api_key_in = sanitize_export_text(&next.default_auth.api_key_in, options);
            next.default_auth.oauth2.grant_type = sanitize_export_text(&next.default_auth.oauth2.grant_type, options);
            next.default_auth.oauth2.auth_url = sanitize_export_text(&next.default_auth.oauth2.auth_url, options);
            next.default_auth.oauth2.token_url = sanitize_export_text(&next.default_auth.oauth2.token_url, options);
            next.default_auth.oauth2.callback_url = sanitize_export_text(&next.default_auth.oauth2.callback_url, options);
            next.default_auth.oauth2.client_id = sanitize_export_text(&next.default_auth.oauth2.client_id, options);
            next.default_auth.oauth2.client_secret = sanitize_export_text(&next.default_auth.oauth2.client_secret, options);
            next.default_auth.oauth2.scope = sanitize_export_text(&next.default_auth.oauth2.scope, options);
            next.default_auth.oauth2.audience = sanitize_export_text(&next.default_auth.oauth2.audience, options);
            next.default_auth.oauth2.resource = sanitize_export_text(&next.default_auth.oauth2.resource, options);
            next.default_auth.oauth2.authorization_code = sanitize_export_text(&next.default_auth.oauth2.authorization_code, options);
            next.default_auth.oauth2.access_token = sanitize_export_text(&next.default_auth.oauth2.access_token, options);
            next.default_auth.oauth2.refresh_token = sanitize_export_text(&next.default_auth.oauth2.refresh_token, options);
            next.default_auth.oauth2.token_type = sanitize_export_text(&next.default_auth.oauth2.token_type, options);
            next.default_auth.oauth2.expires_at = sanitize_export_text(&next.default_auth.oauth2.expires_at, options);
            next.default_auth.oauth2.username = sanitize_export_text(&next.default_auth.oauth2.username, options);
            next.default_auth.oauth2.password = sanitize_export_text(&next.default_auth.oauth2.password, options);
            next.default_auth.oauth2.code_verifier = sanitize_export_text(&next.default_auth.oauth2.code_verifier, options);
            next.default_auth.oauth2.state = sanitize_export_text(&next.default_auth.oauth2.state, options);
            next.default_auth.oauth2.client_auth_method = sanitize_export_text(&next.default_auth.oauth2.client_auth_method, options);
            sanitize_oauth_rows(&mut next.default_auth.oauth2.extra_token_params, options);
            next.default_auth.oauth2.last_error = sanitize_export_text(&next.default_auth.oauth2.last_error, options);
            next.default_auth.oauth2.last_warning = sanitize_export_text(&next.default_auth.oauth2.last_warning, options);
            next.default_auth.oauth2.last_status = sanitize_export_text(&next.default_auth.oauth2.last_status, options);
            next
        })
        .collect();
    sanitized.requests = collection
        .requests
        .iter()
        .map(|request| sanitize_request_for_export(request, options))
        .collect();
    sanitized
}

#[derive(Default)]
pub(crate) struct ExportFolderNode<'a> {
    requests: Vec<&'a RequestRecord>,
    children: BTreeMap<String, ExportFolderNode<'a>>,
}

pub fn build_export_folder_tree<'a>(requests: &'a [RequestRecord]) -> ExportFolderNode<'a> {
    fn normalize_folder_segments(path: &str) -> Vec<String> {
        path.split('/')
            .map(|segment| segment.trim())
            .filter(|segment| !segment.is_empty())
            .map(ToString::to_string)
            .collect::<Vec<_>>()
    }

    let mut root = ExportFolderNode::default();
    for request in requests {
        let mut cursor = &mut root;
        let segments = normalize_folder_segments(&request.folder_path);
        for segment in segments {
            cursor = cursor.children.entry(segment).or_default();
        }
        cursor.requests.push(request);
    }

    root
}

fn request_to_postman_item(request: &RequestRecord) -> serde_json::Value {
    let mut body = serde_json::Map::new();
    let body_type = if request.body_type.trim().is_empty() {
        "none"
    } else {
        request.body_type.as_str()
    };
    if body_type == "json"
        || body_type == "text"
        || body_type == "xml"
        || body_type == "soap"
        || body_type == "yaml"
        || body_type == "graphql"
    {
        body.insert(
            "mode".to_string(),
            serde_json::Value::String("raw".to_string()),
        );
        let raw = match &request.body {
            RequestTextOrJson::Text(text) => text.clone(),
            RequestTextOrJson::Json(json) => serde_json::to_string_pretty(json).unwrap_or_default(),
        };
        body.insert("raw".to_string(), serde_json::Value::String(raw));
        let raw_language = match body_type {
            "graphql" => "graphql",
            "xml" | "soap" => "xml",
            "yaml" => "yaml",
            _ => "text",
        };
        body.insert(
            "options".to_string(),
            serde_json::json!({ "raw": { "language": raw_language } }),
        );
    }

    let header = request
        .headers
        .iter()
        .filter(|h| h.enabled && !h.key.trim().is_empty())
        .map(|h| serde_json::json!({ "key": h.key, "value": h.value }))
        .collect::<Vec<_>>();

    serde_json::json!({
        "name": request.name,
        "request": {
            "method": request.method,
            "header": header,
            "url": request.url,
            "body": serde_json::Value::Object(body),
        }
    })
}

fn postman_items_from_tree(node: &ExportFolderNode) -> Vec<serde_json::Value> {
    let mut items = vec![];

    for (folder_name, child) in &node.children {
        items.push(serde_json::json!({
            "name": folder_name,
            "item": postman_items_from_tree(child),
        }));
    }

    for request in &node.requests {
        items.push(request_to_postman_item(request));
    }

    items
}

pub fn requests_to_openapi_doc(
    requests: &[RequestRecord],
    title: &str,
    version: &str,
    openapi_version: &str,
) -> serde_json::Value {
    let mut paths = serde_json::Map::new();
    for request in requests {
        let method = request.method.to_lowercase();
        let path_key = if request.url.trim().is_empty() {
            "/".to_string()
        } else {
            request.url.clone()
        };
        let entry = paths
            .entry(path_key)
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
        if let Some(obj) = entry.as_object_mut() {
            obj.insert(
                method,
                serde_json::json!({
                    "summary": request.name,
                    "responses": {
                        "200": { "description": "OK" }
                    }
                }),
            );
        }
    }

    if openapi_version == "2.0" {
        serde_json::json!({
            "swagger": "2.0",
            "info": { "title": title, "version": version },
            "paths": paths,
        })
    } else {
        serde_json::json!({
            "openapi": openapi_version,
            "info": { "title": title, "version": version },
            "paths": paths,
        })
    }
}

fn request_body_as_text(request: &RequestRecord) -> String {
    match &request.body {
        RequestTextOrJson::Text(text) => text.clone(),
        RequestTextOrJson::Json(json) => serde_json::to_string_pretty(json).unwrap_or_default(),
    }
}

fn default_open_collection_item_settings() -> serde_json::Value {
    serde_json::json!({
        "encodeUrl": true,
        "timeout": 0,
        "followRedirects": true,
        "maxRedirects": 5,
    })
}

fn request_to_open_collection_item(request: &RequestRecord, seq: usize) -> serde_json::Value {
    let body_text = request_body_as_text(request);
    let is_graphql = request.body_type == "graphql";

    if is_graphql {
        return serde_json::json!({
            "info": {
                "name": request.name,
                "type": "graphql",
                "seq": seq,
            },
            "graphql": {
                "url": request.url,
                "method": if request.method.trim().is_empty() { "POST" } else { request.method.as_str() },
                "body": {
                    "query": body_text,
                    "variables": "",
                },
                "auth": "inherit",
            },
            "settings": default_open_collection_item_settings(),
        });
    }

    let http_body = if body_text.trim().is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::json!({
            "type": if request.body_type == "json" { "json" } else { "text" },
            "data": body_text,
        })
    };

    let mut http = serde_json::Map::new();
    http.insert(
        "method".to_string(),
        serde_json::Value::String(if request.method.trim().is_empty() {
            "GET".to_string()
        } else {
            request.method.clone()
        }),
    );
    http.insert(
        "url".to_string(),
        serde_json::Value::String(request.url.clone()),
    );
    http.insert(
        "auth".to_string(),
        serde_json::Value::String("inherit".to_string()),
    );
    if !http_body.is_null() {
        http.insert("body".to_string(), http_body);
    }

    serde_json::json!({
        "info": {
            "name": request.name,
            "type": "http",
            "seq": seq,
        },
        "http": serde_json::Value::Object(http),
        "settings": default_open_collection_item_settings(),
    })
}

fn open_collection_items_from_tree(
    node: &ExportFolderNode,
    seq: &mut usize,
) -> Vec<serde_json::Value> {
    let mut items = vec![];

    for (folder_name, child) in &node.children {
        let folder_seq = *seq;
        *seq += 1;
        items.push(serde_json::json!({
            "info": {
                "name": folder_name,
                "type": "folder",
                "seq": folder_seq,
            },
            "request": {
                "auth": "inherit",
            },
            "items": open_collection_items_from_tree(child, seq),
        }));
    }

    for request in &node.requests {
        let request_seq = *seq;
        *seq += 1;
        items.push(request_to_open_collection_item(request, request_seq));
    }

    items
}

pub fn requests_to_bruno_doc(requests: &[RequestRecord], name: &str) -> serde_json::Value {
    let tree = build_export_folder_tree(requests);
    let mut seq = 1usize;
    let items = open_collection_items_from_tree(&tree, &mut seq);

    serde_json::json!({
        "opencollection": "1.0.0",
        "info": {
            "name": name
        },
        "config": {
            "proxy": {
                "inherit": true,
                "config": {
                    "protocol": "http",
                    "hostname": "",
                    "port": "",
                    "auth": {
                        "username": "",
                        "password": ""
                    },
                    "bypassProxy": ""
                }
            }
        },
        "items": items,
        "request": {
            "auth": "inherit"
        },
        "bundled": true,
        "extensions": {
            "bruno": {
                "ignore": ["node_modules", ".git"],
                "exportedUsing": "Kivo"
            }
        }
    })
}

pub fn serialize_export_value(format: &str, value: &serde_json::Value) -> Result<String, String> {
    if format == "bruno" || format.ends_with("yaml") || format.ends_with("yml") {
        return serde_yaml::to_string(value).map_err(|e| format!("Failed to serialize YAML: {e}"));
    }
    serde_json::to_string_pretty(value).map_err(|e| format!("Failed to serialize JSON: {e}"))
}

pub fn normalize_export_format(format: &str) -> String {
    match format.trim().to_lowercase().as_str() {
        "openapi3" | "openapi3.0" | "openapi" => "openapi3.0".to_string(),
        "swagger2" | "swagger2.0" | "swagger" => "swagger2.0".to_string(),
        "postman" => "postman".to_string(),
        "kivo" | "kivo-json" | "kivo.json" => "kivo".to_string(),
        "bruno" | "bruno-yml" | "bruno.yml" | "yml" | "yaml" => "bruno".to_string(),
        other => other.to_string(),
    }
}

pub fn build_export_value(
    format: &str,
    name: &str,
    requests: &[RequestRecord],
    options: &ExportEnvOptions,
) -> Result<serde_json::Value, String> {
    let normalized = normalize_export_format(format);
    let export_requests = prepare_requests_for_export(requests, options);
    if export_requests.is_empty() {
        return Err(
            "No exportable requests found. Export supports only HTTP and GraphQL requests."
                .to_string(),
        );
    }

    match normalized.as_str() {
        "kivo" => {
            if export_requests.len() == 1 {
                Ok(kivo_request_export_value(&export_requests[0]))
            } else {
                Ok(kivo_collection_export_value(&CollectionRecord {
                    name: name.to_string(),
                    folders: vec![],
                    folder_settings: vec![],
                    requests: export_requests,
                }))
            }
        }
        "postman" => Ok(serde_json::json!({
            "info": {
                "name": name,
                "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
            },
            "item": postman_items_from_tree(&build_export_folder_tree(&export_requests))
        })),
        "openapi3.0" => Ok(requests_to_openapi_doc(&export_requests, name, "1.0.0", "3.0.0")),
        "swagger2.0" => Ok(requests_to_openapi_doc(&export_requests, name, "1.0.0", "2.0")),
        "bruno" => Ok(requests_to_bruno_doc(&export_requests, name)),
        _ => Err(
            "Unsupported export format. Use kivo, postman, openapi3.0, swagger2.0, or bruno.".to_string(),
        ),
    }
}
