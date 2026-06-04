use std::collections::HashMap;
use std::error::Error as StdError;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use bytes::Buf;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use prost::Message;
use prost_types::FileDescriptorSet;
use prost_reflect::{DescriptorPool, DynamicMessage, MethodDescriptor, ReflectMessage};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, COOKIE, SET_COOKIE, USER_AGENT};
use reqwest::multipart;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;
use tokio::time::timeout;
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};
use tonic::transport::Endpoint;
use tonic::{Request, Status};

use super::models::{
    CookieJarEntry, FormBodyRowPayload, GrpcRequestPayload, OAuthCallbackWaitPayload, OAuthCallbackWaitResult,
    OAuthTokenExchangePayload, OAuthTokenExchangeResult, RequestPayload, ResponsePayload,
    UpsertCookieJarEntryPayload,
};
use crate::http::dynamic_vars::resolve_template_variables;
use crate::storage::{
    get_app_config, get_collection_dir, get_storage_root, load_collection_config_from_path,
    load_env_vars, AppSettings, GrpcMethodOption,
};

const DEFAULT_USER_AGENT: &str = concat!("kivo/", env!("CARGO_PKG_VERSION"));
const COOKIE_STORE_FILE_NAME: &str = "cookies.json";
const DIGEST_NONCE_COUNT: &str = "00000001";

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;

#[derive(Clone)]
struct DynamicCodec {
    input: prost_reflect::MessageDescriptor,
    output: prost_reflect::MessageDescriptor,
}

fn write_callback_response(stream: &mut std::net::TcpStream, status_line: &str, message: &str) {
    let body = format!(
        "<html><body style=\"font-family: sans-serif; padding: 24px;\"><h3>{}</h3><p>You can return to Kivo now.</p></body></html>",
        message
    );
    let response = format!(
        "{status_line}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

#[tauri::command]
pub async fn wait_for_oauth_callback(
    payload: OAuthCallbackWaitPayload,
) -> Result<OAuthCallbackWaitResult, String> {
    let callback_url = payload.callback_url.trim().to_string();
    if callback_url.is_empty() {
        return Err("Callback URL is required.".to_string());
    }

    let parsed = reqwest::Url::parse(&callback_url)
        .map_err(|_| "Invalid callback URL.".to_string())?;
    if parsed.scheme() != "http" {
        return Err("Callback URL must use http:// for local listener flow.".to_string());
    }

    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if host != "localhost" && host != "127.0.0.1" && host != "::1" {
        return Err("Callback URL must use localhost, 127.0.0.1, or ::1.".to_string());
    }

    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "Callback URL must include a local port.".to_string())?;
    let expected_path = if parsed.path().trim().is_empty() {
        "/".to_string()
    } else {
        parsed.path().to_string()
    };
    let bind_addr = if host == "::1" {
        format!("[::1]:{port}")
    } else {
        format!("127.0.0.1:{port}")
    };

    let expected_state = payload.expected_state.trim().to_string();
    let timeout_ms = payload.timeout_ms.unwrap_or(120_000).clamp(1_000, 600_000);

    tokio::task::spawn_blocking(move || -> Result<OAuthCallbackWaitResult, String> {
        let listener = TcpListener::bind(&bind_addr)
            .map_err(|err| format!("Failed to bind OAuth callback listener on {bind_addr}: {err}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|err| format!("Failed to configure callback listener: {err}"))?;

        let started_at = Instant::now();

        loop {
            if started_at.elapsed() >= Duration::from_millis(timeout_ms) {
                return Err("Timed out while waiting for OAuth callback.".to_string());
            }

            match listener.accept() {
                Ok((mut stream, _peer)) => {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                    let mut buffer = [0u8; 8192];
                    let read_count = stream
                        .read(&mut buffer)
                        .map_err(|err| format!("Failed to read OAuth callback request: {err}"))?;
                    let request_text = String::from_utf8_lossy(&buffer[..read_count]).to_string();
                    let first_line = request_text
                        .lines()
                        .next()
                        .ok_or_else(|| "Malformed OAuth callback request.".to_string())?;
                    let mut parts = first_line.split_whitespace();
                    let _method = parts.next().unwrap_or_default();
                    let target = parts.next().unwrap_or("/");

                    let callback_request_url = reqwest::Url::parse(&format!("http://localhost:{port}{target}"))
                        .map_err(|_| "Invalid OAuth callback target URL.".to_string())?;

                    if callback_request_url.path() != expected_path {
                        write_callback_response(
                            &mut stream,
                            "HTTP/1.1 404 Not Found",
                            "OAuth callback path mismatch.",
                        );
                        continue;
                    }

                    let oauth_error = callback_request_url.query_pairs().find_map(|(key, value)| {
                        if key == "error" {
                            Some(value.to_string())
                        } else {
                            None
                        }
                    });
                    if let Some(err_code) = oauth_error {
                        let err_description = callback_request_url
                            .query_pairs()
                            .find_map(|(key, value)| {
                                if key == "error_description" {
                                    Some(value.to_string())
                                } else {
                                    None
                                }
                            })
                            .unwrap_or_default();
                        write_callback_response(
                            &mut stream,
                            "HTTP/1.1 400 Bad Request",
                            "OAuth authorization failed.",
                        );
                        return Err(if err_description.trim().is_empty() {
                            format!("OAuth authorization failed: {err_code}")
                        } else {
                            format!("OAuth authorization failed: {err_code} ({err_description})")
                        });
                    }

                    let mut code = String::new();
                    let mut received_state = String::new();
                    for (key, value) in callback_request_url.query_pairs() {
                        if key == "code" {
                            code = value.to_string();
                        } else if key == "state" {
                            received_state = value.to_string();
                        }
                    }

                    if code.trim().is_empty() {
                        write_callback_response(
                            &mut stream,
                            "HTTP/1.1 400 Bad Request",
                            "Authorization code missing in callback.",
                        );
                        return Err("Authorization code missing in callback URL.".to_string());
                    }

                    if !expected_state.is_empty() && expected_state != received_state {
                        write_callback_response(
                            &mut stream,
                            "HTTP/1.1 400 Bad Request",
                            "OAuth state mismatch.",
                        );
                        return Err("OAuth state mismatch. Callback was rejected for security reasons.".to_string());
                    }

                    write_callback_response(
                        &mut stream,
                        "HTTP/1.1 200 OK",
                        "OAuth authorization received.",
                    );

                    return Ok(OAuthCallbackWaitResult {
                        authorization_code: code,
                        received_state,
                        callback_url: callback_request_url.to_string(),
                    });
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(err) => {
                    return Err(format!("OAuth callback listener error: {err}"));
                }
            }
        }
    })
    .await
    .map_err(|err| format!("OAuth callback listener task failed: {err}"))?
}

fn parse_no_proxy_list(no_proxy: &str) -> Vec<String> {
    no_proxy
        .split(',')
        .map(|entry| entry.trim().to_ascii_lowercase())
        .filter(|entry| !entry.is_empty())
        .collect()
}

fn host_bypasses_proxy(url: &str, no_proxy_list: &[String]) -> bool {
    if no_proxy_list.is_empty() {
        return false;
    }

    let host = match reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|value| value.to_ascii_lowercase()))
    {
        Some(value) => value,
        None => return false,
    };

    no_proxy_list.iter().any(|pattern| {
        if pattern == "*" {
            return true;
        }
        let normalized = pattern.trim_start_matches('.');
        if normalized.is_empty() {
            return false;
        }
        host == normalized || host.ends_with(&format!(".{normalized}"))
    })
}

fn load_custom_ca_cert(path: &str) -> Result<reqwest::Certificate, String> {
    let bytes = fs::read(path).map_err(|err| format!("Failed to read CA certificate file: {err}"))?;
    reqwest::Certificate::from_pem(&bytes)
        .or_else(|_| reqwest::Certificate::from_der(&bytes))
        .map_err(|err| format!("Invalid CA certificate file: {err}"))
}

fn load_client_identity(cert_path: &str, key_path: &str) -> Result<reqwest::Identity, String> {
    let cert = fs::read(cert_path).map_err(|err| format!("Failed to read client certificate: {err}"))?;
    let key = fs::read(key_path).map_err(|err| format!("Failed to read client key: {err}"))?;
    let mut pem = Vec::with_capacity(cert.len() + key.len() + 1);
    pem.extend_from_slice(&cert);
    if !pem.ends_with(b"\n") {
        pem.push(b'\n');
    }
    pem.extend_from_slice(&key);
    reqwest::Identity::from_pem(&pem)
        .map_err(|err| format!("Invalid client certificate/key pair: {err}"))
}

#[derive(Default)]
struct RequestNetworkOptions {
    proxy_mode: String,
    proxy_http: String,
    proxy_https: String,
    no_proxy: String,
    client_certificate_path: String,
    client_key_path: String,
}

fn build_http_client(
    settings: &AppSettings,
    request_url: &str,
    timeout_ms: u64,
    follow_redirects: bool,
    max_redirects: u32,
    validate_certs: bool,
    request_network: Option<&RequestNetworkOptions>,
) -> Result<reqwest::Client, String> {
    let redirect_policy = if follow_redirects {
        reqwest::redirect::Policy::limited(max_redirects.clamp(1, 50) as usize)
    } else {
        reqwest::redirect::Policy::none()
    };
    let mut builder = reqwest::Client::builder().redirect(redirect_policy);

    if timeout_ms > 0 {
        builder = builder.timeout(Duration::from_millis(timeout_ms));
    }

    if !validate_certs {
        builder = builder.danger_accept_invalid_certs(true);
    }

    if settings.use_custom_ca_certificate && !settings.custom_ca_certificate_path.trim().is_empty() {
        let cert = load_custom_ca_cert(settings.custom_ca_certificate_path.trim())?;
        if !settings.keep_default_ca_certificates {
            builder = builder.tls_built_in_root_certs(false);
        }
        builder = builder.add_root_certificate(cert);
    }

    let request_cert = request_network
        .and_then(|network| (!network.client_certificate_path.trim().is_empty()).then_some(network.client_certificate_path.trim()));
    let request_key = request_network
        .and_then(|network| (!network.client_key_path.trim().is_empty()).then_some(network.client_key_path.trim()));
    let settings_cert = (settings.use_client_certificate && !settings.client_certificate_path.trim().is_empty())
        .then_some(settings.client_certificate_path.trim());
    let settings_key = (settings.use_client_certificate && !settings.client_key_path.trim().is_empty())
        .then_some(settings.client_key_path.trim());
    if let (Some(cert), Some(key)) = (request_cert.or(settings_cert), request_key.or(settings_key)) {
        builder = builder.identity(load_client_identity(cert, key)?);
    }

    let request_proxy_mode = request_network
        .map(|network| network.proxy_mode.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let proxy_enabled = match request_proxy_mode.as_str() {
        "off" | "none" => false,
        "custom" => true,
        _ => settings.proxy_enabled,
    };

    if proxy_enabled {
        let using_custom = request_proxy_mode == "custom";
        let proxy_http = if using_custom {
            request_network.map(|network| network.proxy_http.as_str()).unwrap_or("")
        } else {
            settings.proxy_http.as_str()
        };
        let proxy_https = if using_custom {
            request_network.map(|network| network.proxy_https.as_str()).unwrap_or("")
        } else {
            settings.proxy_https.as_str()
        };
        let no_proxy = if using_custom {
            request_network.map(|network| network.no_proxy.as_str()).unwrap_or("")
        } else {
            settings.no_proxy.as_str()
        };
        let no_proxy_list = parse_no_proxy_list(no_proxy);
        if !host_bypasses_proxy(request_url, &no_proxy_list) {
            if !proxy_http.trim().is_empty() {
                let mut proxy = reqwest::Proxy::http(proxy_http.trim())
                    .map_err(|err| format!("Invalid HTTP proxy URL: {err}"))?;
                if !settings.proxy_username.trim().is_empty() {
                    proxy = proxy.basic_auth(settings.proxy_username.trim(), settings.proxy_password.trim());
                }
                builder = builder.proxy(proxy);
            }
            if !proxy_https.trim().is_empty() {
                let mut proxy = reqwest::Proxy::https(proxy_https.trim())
                    .map_err(|err| format!("Invalid HTTPS proxy URL: {err}"))?;
                if !settings.proxy_username.trim().is_empty() {
                    proxy = proxy.basic_auth(settings.proxy_username.trim(), settings.proxy_password.trim());
                }
                builder = builder.proxy(proxy);
            }
        }
    }

    builder.build().map_err(|err| err.to_string())
}

impl DynamicCodec {
    fn new(input: prost_reflect::MessageDescriptor, output: prost_reflect::MessageDescriptor) -> Self {
        Self { input, output }
    }
}

#[tauri::command]
pub fn get_cookie_jar(
    app: AppHandle,
    workspace_name: Option<String>,
    collection_name: Option<String>,
) -> Result<Vec<CookieJarEntry>, String> {
    let now = Utc::now();
    let mut entries = load_cookie_store(&app)?;
    entries.retain(|entry| !cookie_is_expired(entry, now));

    let ws = workspace_name.unwrap_or_default().trim().to_string();
    let col = collection_name.unwrap_or_default().trim().to_string();

    let filtered = entries
        .into_iter()
        .filter(|entry| ws.is_empty() || entry.workspace_name == ws)
        .filter(|entry| col.is_empty() || entry.collection_name == col)
        .collect::<Vec<_>>();

    Ok(filtered)
}

#[tauri::command]
pub fn delete_cookie_jar_entry(app: AppHandle, id: String) -> Result<bool, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }

    let mut entries = load_cookie_store(&app)?;
    let before = entries.len();
    entries.retain(|entry| entry.id != trimmed);
    let removed = entries.len() != before;
    if removed {
        save_cookie_store(&app, &entries)?;
    }
    Ok(removed)
}

fn build_cookie_id(workspace_name: &str, collection_name: &str, domain: &str, path: &str, name: &str) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        workspace_name.trim().to_ascii_lowercase(),
        collection_name.trim().to_ascii_lowercase(),
        domain.trim_start_matches('.').to_ascii_lowercase(),
        if path.trim().is_empty() {
            "/".to_string()
        } else if path.trim().starts_with('/') {
            path.trim().to_string()
        } else {
            format!("/{}", path.trim())
        },
        name.trim().to_ascii_lowercase(),
    )
}

#[tauri::command]
pub fn upsert_cookie_jar_entry(
    app: AppHandle,
    payload: UpsertCookieJarEntryPayload,
) -> Result<CookieJarEntry, String> {
    let name = payload.name.trim();
    let domain = payload.domain.trim().trim_start_matches('.').to_ascii_lowercase();
    if name.is_empty() {
        return Err("Cookie name is required.".to_string());
    }
    if domain.is_empty() {
        return Err("Cookie domain is required.".to_string());
    }

    let path = if payload.path.trim().is_empty() {
        "/".to_string()
    } else if payload.path.trim().starts_with('/') {
        payload.path.trim().to_string()
    } else {
        format!("/{}", payload.path.trim())
    };

    let same_site = payload.same_site.trim().to_string();
    if !same_site.is_empty() {
        let valid = ["lax", "strict", "none"];
        if !valid.contains(&same_site.to_ascii_lowercase().as_str()) {
            return Err("SameSite must be Lax, Strict, None, or empty.".to_string());
        }
    }

    let now = Utc::now();
    let ws = payload.workspace_name.trim().to_string();
    let col = payload.collection_name.trim().to_string();
    let previous_id = payload.id.unwrap_or_default();
    let computed_id = build_cookie_id(&ws, &col, &domain, &path, name);

    let mut store = load_cookie_store(&app)?;
    store.retain(|entry| !cookie_is_expired(entry, now));

    let previous = store
        .iter()
        .find(|entry| entry.id == computed_id || (!previous_id.trim().is_empty() && entry.id == previous_id));
    let entry = CookieJarEntry {
        id: computed_id.clone(),
        name: name.to_string(),
        value: payload.value,
        domain,
        path,
        expires_at: payload.expires_at,
        secure: payload.secure,
        http_only: payload.http_only,
        same_site,
        host_only: payload.host_only,
        workspace_name: ws,
        collection_name: col,
        created_at: previous
            .map(|existing| existing.created_at.clone())
            .filter(|existing| !existing.trim().is_empty())
            .unwrap_or_else(|| now.to_rfc3339()),
        last_accessed_at: now.to_rfc3339(),
    };

    store.retain(|existing| {
        if existing.id == entry.id {
            return false;
        }
        if !previous_id.trim().is_empty() && existing.id == previous_id {
            return false;
        }
        true
    });
    if !cookie_is_expired(&entry, now) {
        store.push(entry.clone());
    }
    save_cookie_store(&app, &store)?;

    Ok(entry)
}

#[tauri::command]
pub fn clear_cookie_jar(
    app: AppHandle,
    workspace_name: Option<String>,
    collection_name: Option<String>,
) -> Result<u32, String> {
    let ws = workspace_name.unwrap_or_default().trim().to_string();
    let col = collection_name.unwrap_or_default().trim().to_string();

    let mut entries = load_cookie_store(&app)?;
    let before = entries.len();

    entries.retain(|entry| {
        if !ws.is_empty() && entry.workspace_name != ws {
            return true;
        }
        if !col.is_empty() && entry.collection_name != col {
            return true;
        }
        false
    });

    let removed = (before.saturating_sub(entries.len())) as u32;
    if removed > 0 {
        save_cookie_store(&app, &entries)?;
    }
    Ok(removed)
}

struct DynamicEncoder {
    descriptor: prost_reflect::MessageDescriptor,
}

struct DynamicDecoder {
    descriptor: prost_reflect::MessageDescriptor,
}

impl Codec for DynamicCodec {
    type Encode = DynamicMessage;
    type Decode = DynamicMessage;
    type Encoder = DynamicEncoder;
    type Decoder = DynamicDecoder;

    fn encoder(&mut self) -> Self::Encoder {
        DynamicEncoder {
            descriptor: self.input.clone(),
        }
    }

    fn decoder(&mut self) -> Self::Decoder {
        DynamicDecoder {
            descriptor: self.output.clone(),
        }
    }
}

impl Encoder for DynamicEncoder {
    type Item = DynamicMessage;
    type Error = Status;

    fn encode(&mut self, item: Self::Item, dst: &mut EncodeBuf<'_>) -> Result<(), Self::Error> {
        if item.descriptor().full_name() != self.descriptor.full_name() {
            return Err(Status::invalid_argument("gRPC request body does not match selected method input type."));
        }

        item.encode(dst)
            .map_err(|err| Status::internal(format!("Failed to encode gRPC request payload: {err}")))
    }
}

impl Decoder for DynamicDecoder {
    type Item = DynamicMessage;
    type Error = Status;

    fn decode(&mut self, src: &mut DecodeBuf<'_>) -> Result<Option<Self::Item>, Self::Error> {
        if src.remaining() == 0 {
            return Ok(None);
        }

        let bytes = src.copy_to_bytes(src.remaining());
        let message = DynamicMessage::decode(self.descriptor.clone(), bytes)
            .map_err(|err| Status::internal(format!("Failed to decode gRPC response payload: {err}")))?;
        Ok(Some(message))
    }
}

static OAUTH_CANCEL_REGISTRY: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
static HTTP_CANCEL_REGISTRY: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();

fn oauth_cancel_registry() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    OAUTH_CANCEL_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn http_cancel_registry() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    HTTP_CANCEL_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_oauth_cancel(request_id: &str) -> Option<watch::Receiver<bool>> {
    if request_id.trim().is_empty() {
        return None;
    }

    let (cancel_tx, cancel_rx) = watch::channel(false);
    let mut registry = oauth_cancel_registry().lock().unwrap();
    registry.insert(request_id.to_string(), cancel_tx);
    Some(cancel_rx)
}

fn unregister_oauth_cancel(request_id: &str) {
    if request_id.trim().is_empty() {
        return;
    }

    let mut registry = oauth_cancel_registry().lock().unwrap();
    registry.remove(request_id);
}

fn register_http_cancel(request_id: &str) -> Option<watch::Receiver<bool>> {
    if request_id.trim().is_empty() {
        return None;
    }

    let (cancel_tx, cancel_rx) = watch::channel(false);
    let mut registry = http_cancel_registry().lock().unwrap();
    registry.insert(request_id.to_string(), cancel_tx);
    Some(cancel_rx)
}

fn unregister_http_cancel(request_id: &str) {
    if request_id.trim().is_empty() {
        return;
    }

    let mut registry = http_cancel_registry().lock().unwrap();
    registry.remove(request_id);
}

struct OAuthCancelGuard {
    request_id: String,
}

struct HttpCancelGuard {
    request_id: String,
}

impl OAuthCancelGuard {
    fn new(request_id: String) -> Self {
        Self { request_id }
    }
}

impl HttpCancelGuard {
    fn new(request_id: String) -> Self {
        Self { request_id }
    }
}

impl Drop for HttpCancelGuard {
    fn drop(&mut self) {
        unregister_http_cancel(&self.request_id);
    }
}

impl Drop for OAuthCancelGuard {
    fn drop(&mut self) {
        unregister_oauth_cancel(&self.request_id);
    }
}

async fn send_oauth_form(
    request: reqwest::RequestBuilder,
    form: &[(String, String)],
    cancel_rx: &mut Option<watch::Receiver<bool>>,
    context: &str,
) -> Result<reqwest::Response, String> {
    if let Some(receiver) = cancel_rx.as_mut() {
        tokio::select! {
            changed = receiver.changed() => {
                match changed {
                    Ok(_) => {
                        if *receiver.borrow() {
                            return Err("OAuth token request cancelled by user.".to_string());
                        }
                        Err("OAuth token request cancelled by user.".to_string())
                    }
                    Err(_) => Err("OAuth token request cancelled by user.".to_string()),
                }
            }
            response = request.form(form).send() => {
                response.map_err(|err| format!("{context}: {err}"))
            }
        }
    } else {
        request
            .form(form)
            .send()
            .await
            .map_err(|err| format!("{context}: {err}"))
    }
}

async fn send_http_request_with_cancel(
    request: reqwest::RequestBuilder,
    cancel_rx: &mut Option<watch::Receiver<bool>>,
) -> Result<reqwest::Response, String> {
    fn format_reqwest_error(err: &reqwest::Error) -> String {
        let mut message = err.to_string();
        let mut causes = Vec::new();
        let mut current = StdError::source(err);
        while let Some(source) = current {
            causes.push(source.to_string());
            current = source.source();
        }
        if !causes.is_empty() {
            message = format!("{message} | caused by: {}", causes.join(" -> "));
        }
        message
    }

    if let Some(receiver) = cancel_rx.as_mut() {
        tokio::select! {
            changed = receiver.changed() => {
                match changed {
                    Ok(_) => {
                        if *receiver.borrow() {
                            return Err("Request cancelled by user.".to_string());
                        }
                        Err("Request cancelled by user.".to_string())
                    }
                    Err(_) => Err("Request cancelled by user.".to_string()),
                }
            }
            response = request.send() => {
                response.map_err(|err| format_reqwest_error(&err))
            }
        }
    } else {
        request
            .send()
            .await
            .map_err(|err| format_reqwest_error(&err))
    }
}

#[tauri::command]
pub async fn cancel_oauth_exchange(request_id: String) -> Result<bool, String> {
    let trimmed = request_id.trim().to_string();
    if trimmed.is_empty() {
        return Ok(false);
    }

    let sender = {
        let mut registry = oauth_cancel_registry().lock().unwrap();
        registry.remove(&trimmed)
    };

    if let Some(cancel_tx) = sender {
        let _ = cancel_tx.send(true);
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn cancel_http_request(request_id: String) -> Result<bool, String> {
    let trimmed = request_id.trim().to_string();
    if trimmed.is_empty() {
        return Ok(false);
    }

    let sender = {
        let mut registry = http_cancel_registry().lock().unwrap();
        registry.remove(&trimmed)
    };

    if let Some(cancel_tx) = sender {
        let _ = cancel_tx.send(true);
        Ok(true)
    } else {
        Ok(false)
    }
}

fn resolve_variables(input: &str, vars: &HashMap<String, String>) -> String {
    resolve_template_variables(input, vars)
}

fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn digest_uri(url: &str) -> String {
    reqwest::Url::parse(url)
        .map(|parsed| {
            let mut uri = parsed.path().to_string();
            if uri.is_empty() {
                uri.push('/');
            }
            if let Some(query) = parsed.query() {
                uri.push('?');
                uri.push_str(query);
            }
            uri
        })
        .unwrap_or_else(|_| "/".to_string())
}

fn build_digest_auth_header(
    username: &str,
    password: &str,
    realm: &str,
    nonce: &str,
    qop: &str,
    method: &str,
    url: &str,
) -> Option<String> {
    let username = username.trim();
    let realm = realm.trim();
    let nonce = nonce.trim();
    if username.is_empty() || realm.is_empty() || nonce.is_empty() {
        return None;
    }

    let uri = digest_uri(url);
    let cnonce = sha256_hex(&format!("{username}:{nonce}:{uri}"))
        .chars()
        .take(16)
        .collect::<String>();
    let ha1 = sha256_hex(&format!("{username}:{realm}:{password}"));
    let ha2 = sha256_hex(&format!("{}:{}", method.to_uppercase(), uri));
    let qop = qop.trim();
    let response = if qop.is_empty() {
        sha256_hex(&format!("{ha1}:{nonce}:{ha2}"))
    } else {
        sha256_hex(&format!(
            "{ha1}:{nonce}:{DIGEST_NONCE_COUNT}:{cnonce}:{qop}:{ha2}"
        ))
    };

    let mut parts = vec![
        format!("username=\"{username}\""),
        format!("realm=\"{realm}\""),
        format!("nonce=\"{nonce}\""),
        format!("uri=\"{uri}\""),
        "algorithm=\"SHA-256\"".to_string(),
        format!("response=\"{response}\""),
    ];
    if !qop.is_empty() {
        parts.push(format!("qop={qop}"));
        parts.push(format!("nc={DIGEST_NONCE_COUNT}"));
        parts.push(format!("cnonce=\"{cnonce}\""));
    }
    Some(format!("Digest {}", parts.join(", ")))
}

fn normalize_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();

    if trimmed.is_empty() {
        return Err("Enter a URL first.".to_string());
    }

    let candidate = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };

    reqwest::Url::parse(&candidate)
        .map(|url| url.to_string())
        .map_err(|_| format!("Invalid URL: {trimmed}"))
}

fn build_headers(headers: &HashMap<String, String>, disable_user_agent: bool) -> Result<HeaderMap, String> {
    let mut header_map = HeaderMap::new();

    for (key, value) in headers {
        let name = HeaderName::from_bytes(key.as_bytes())
            .map_err(|_| format!("Invalid header name: {key}"))?;
        let header_value =
            HeaderValue::from_str(value).map_err(|_| format!("Invalid header value for: {key}"))?;

        header_map.insert(name, header_value);
    }

    if !disable_user_agent && !header_map.contains_key(USER_AGENT) {
        header_map.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_USER_AGENT));
    }

    Ok(header_map)
}

async fn build_multipart_form(rows: &[FormBodyRowPayload]) -> Result<multipart::Form, String> {
    let mut form = multipart::Form::new();
    for row in rows {
        if !row.enabled || row.key.trim().is_empty() {
            continue;
        }
        let key = row.key.trim().to_string();
        if row.field_type.trim().eq_ignore_ascii_case("file") {
            if row.file_path.trim().is_empty() {
                continue;
            }
            let bytes = fs::read(row.file_path.trim())
                .map_err(|err| format!("Failed to read multipart file '{}': {err}", row.file_path.trim()))?;
            let file_name = PathBuf::from(row.file_path.trim())
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "upload.bin".to_string());
            let part = multipart::Part::bytes(bytes).file_name(file_name);
            form = form.part(key, part);
        } else {
            form = form.text(key, row.value.clone());
        }
    }
    Ok(form)
}

fn cookie_store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {e}"))?;
    if !app_data_dir.exists() {
        fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("Failed to create app data directory: {e}"))?;
    }
    Ok(app_data_dir.join(COOKIE_STORE_FILE_NAME))
}

pub(crate) fn load_cookie_store(app: &AppHandle) -> Result<Vec<CookieJarEntry>, String> {
    let path = cookie_store_path(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }

    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read cookie store: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(vec![]);
    }

    serde_json::from_str::<Vec<CookieJarEntry>>(&raw)
        .map_err(|e| format!("Failed to parse cookie store: {e}"))
}

fn save_cookie_store(app: &AppHandle, entries: &[CookieJarEntry]) -> Result<(), String> {
    let path = cookie_store_path(app)?;
    let serialized = serde_json::to_string_pretty(entries)
        .map_err(|e| format!("Failed to serialize cookie store: {e}"))?;
    fs::write(&path, serialized)
        .map_err(|e| format!("Failed to write cookie store: {e}"))
}

fn parse_cookie_datetime(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc2822(value.trim())
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
        .or_else(|| {
            DateTime::parse_from_rfc3339(value.trim())
                .ok()
                .map(|dt| dt.with_timezone(&Utc))
        })
}

fn cookie_is_expired(cookie: &CookieJarEntry, now: DateTime<Utc>) -> bool {
    cookie
        .expires_at
        .as_deref()
        .and_then(parse_cookie_datetime)
        .map(|dt| dt <= now)
        .unwrap_or(false)
}

fn default_cookie_path(request_path: &str) -> String {
    if !request_path.starts_with('/') || request_path == "/" {
        return "/".to_string();
    }

    match request_path.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(index) => request_path[..index].to_string(),
    }
}

fn cookie_domain_matches(host: &str, domain: &str, host_only: bool) -> bool {
    let host_l = host.to_ascii_lowercase();
    let domain_l = domain.trim_start_matches('.').to_ascii_lowercase();

    if host_only {
        return host_l == domain_l;
    }

    host_l == domain_l || host_l.ends_with(&format!(".{domain_l}"))
}

fn cookie_path_matches(request_path: &str, cookie_path: &str) -> bool {
    let req = if request_path.is_empty() { "/" } else { request_path };
    let cp = if cookie_path.is_empty() { "/" } else { cookie_path };
    req.starts_with(cp)
}

fn parse_set_cookie(
    raw: &str,
    request_url: &reqwest::Url,
    workspace_name: &str,
    collection_name: &str,
) -> Option<CookieJarEntry> {
    let mut parts = raw.split(';').map(str::trim).filter(|part| !part.is_empty());
    let first = parts.next()?;
    let (name, value) = first.split_once('=')?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }

    let request_host = request_url.host_str()?.to_ascii_lowercase();
    let mut domain = request_host.clone();
    let mut path = default_cookie_path(request_url.path());
    let mut secure = false;
    let mut http_only = false;
    let mut same_site = String::new();
    let mut host_only = true;
    let mut expires_at: Option<String> = None;
    let now = Utc::now();

    for attr in parts {
        let (raw_key, raw_val) = attr
            .split_once('=')
            .map(|(k, v)| (k.trim(), Some(v.trim())))
            .unwrap_or((attr, None));
        let key = raw_key.to_ascii_lowercase();

        match key.as_str() {
            "domain" => {
                if let Some(v) = raw_val {
                    let normalized = v.trim_start_matches('.').to_ascii_lowercase();
                    if !normalized.is_empty() {
                        domain = normalized;
                        host_only = false;
                    }
                }
            }
            "path" => {
                if let Some(v) = raw_val {
                    let candidate = v.trim();
                    if !candidate.is_empty() {
                        path = if candidate.starts_with('/') {
                            candidate.to_string()
                        } else {
                            format!("/{candidate}")
                        };
                    }
                }
            }
            "secure" => secure = true,
            "httponly" => http_only = true,
            "samesite" => {
                if let Some(v) = raw_val {
                    same_site = v.to_string();
                }
            }
            "max-age" => {
                if let Some(v) = raw_val.and_then(|v| i64::from_str(v).ok()) {
                    if v <= 0 {
                        expires_at = Some((now - ChronoDuration::seconds(1)).to_rfc3339());
                    } else {
                        expires_at = Some((now + ChronoDuration::seconds(v)).to_rfc3339());
                    }
                }
            }
            "expires" => {
                if let Some(v) = raw_val {
                    if let Some(dt) = parse_cookie_datetime(v) {
                        expires_at = Some(dt.to_rfc3339());
                    }
                }
            }
            _ => {}
        }
    }

    let id = build_cookie_id(workspace_name, collection_name, &domain, &path, name);

    Some(CookieJarEntry {
        id,
        name: name.to_string(),
        value: value.to_string(),
        domain,
        path,
        expires_at,
        secure,
        http_only,
        same_site,
        host_only,
        workspace_name: workspace_name.trim().to_string(),
        collection_name: collection_name.trim().to_string(),
        created_at: now.to_rfc3339(),
        last_accessed_at: now.to_rfc3339(),
    })
}

pub(crate) fn merge_set_cookie_headers(
    app: &AppHandle,
    workspace_name: &str,
    collection_name: &str,
    request_url: &reqwest::Url,
    set_cookie_values: &[String],
) -> Result<(), String> {
    if set_cookie_values.is_empty() {
        return Ok(());
    }

    let now = Utc::now();
    let mut store = load_cookie_store(app)?;
    store.retain(|entry| !cookie_is_expired(entry, now));

    for raw in set_cookie_values {
        if let Some(parsed) = parse_set_cookie(raw, request_url, workspace_name, collection_name) {
            store.retain(|entry| entry.id != parsed.id);
            if !cookie_is_expired(&parsed, now) {
                store.push(parsed);
            }
        }
    }

    save_cookie_store(app, &store)
}

pub(crate) fn build_cookie_header_from_store(
    app: &AppHandle,
    workspace_name: &str,
    collection_name: &str,
    request_url: &reqwest::Url,
) -> Result<Option<String>, String> {
    let now = Utc::now();
    let mut store = load_cookie_store(app)?;
    let request_host = request_url
        .host_str()
        .ok_or_else(|| "Request host is missing".to_string())?
        .to_ascii_lowercase();
    let request_path = if request_url.path().is_empty() {
        "/"
    } else {
        request_url.path()
    };
    let is_https = request_url.scheme().eq_ignore_ascii_case("https");

    let ws = workspace_name.trim();
    let col = collection_name.trim();

    store.retain(|entry| !cookie_is_expired(entry, now));

    let mut header_parts = Vec::new();
    for cookie in &mut store {
        if !ws.is_empty() && cookie.workspace_name != ws {
            continue;
        }
        if !col.is_empty() && cookie.collection_name != col {
            continue;
        }
        if cookie.secure && !is_https {
            continue;
        }
        if !cookie_domain_matches(&request_host, &cookie.domain, cookie.host_only) {
            continue;
        }
        if !cookie_path_matches(request_path, &cookie.path) {
            continue;
        }

        cookie.last_accessed_at = now.to_rfc3339();
        header_parts.push(format!("{}={}", cookie.name, cookie.value));
    }

    save_cookie_store(app, &store)?;

    if header_parts.is_empty() {
        Ok(None)
    } else {
        Ok(Some(header_parts.join("; ")))
    }
}

fn get_env_context(app: &AppHandle, workspace_name: &str, collection_name: &str) -> HashMap<String, String> {
    let storage_root = get_storage_root(app).unwrap_or_default();
    let workspace_path = storage_root.join(workspace_name);
    let collection_path = if collection_name.is_empty() {
        None
    } else {
        Some(get_collection_dir(&storage_root, workspace_name, collection_name))
    };
    load_env_vars(&workspace_path, collection_path.as_deref())
}

fn resolve_payload_value(input: &str, env_vars: &HashMap<String, String>) -> String {
    resolve_variables(input, env_vars)
}

fn normalize_grpc_target(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Enter a gRPC server URL first.".to_string());
    }

    let candidate = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };

    reqwest::Url::parse(&candidate)
        .map(|url| {
            let mut normalized = url.to_string();
            if normalized.ends_with('/') {
                normalized.pop();
            }
            normalized
        })
        .map_err(|_| format!("Invalid gRPC URL: {trimmed}"))
}

fn parse_grpc_method_parts(raw_path: &str) -> Result<(String, String), String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("Select a gRPC method first.".to_string());
    }

    let mut parts = trimmed.trim_start_matches('/').split('/');
    let service = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Invalid gRPC method path.".to_string())?;
    let method = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Invalid gRPC method path.".to_string())?;

    Ok((service.to_string(), method.to_string()))
}

fn compile_descriptor_pool(proto_file_path: &str) -> Result<DescriptorPool, String> {
    let proto_path = PathBuf::from(proto_file_path.trim());
    if !proto_path.exists() {
        return Err("Selected proto file does not exist.".to_string());
    }

    if proto_path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "bin" | "fds" | "pb"))
        .unwrap_or(false)
    {
        let bytes = fs::read(&proto_path)
            .map_err(|err| format!("Failed to read descriptor set: {err}"))?;
        let descriptor_set = FileDescriptorSet::decode(bytes.as_slice())
            .map_err(|err| format!("Failed to decode descriptor set: {err}"))?;
        return DescriptorPool::from_file_descriptor_set(descriptor_set)
            .map_err(|err| format!("Failed to load descriptor pool: {err}"));
    }

    let include_dir = proto_path
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "Failed to resolve proto parent directory.".to_string())?;

    let descriptor_set = protox::compile([proto_path], [include_dir])
        .map_err(|err| format!("Failed to compile proto descriptors: {err}"))?;

    DescriptorPool::from_file_descriptor_set(descriptor_set)
        .map_err(|err| format!("Failed to load descriptor pool: {err}"))
}

fn grpc_methods_from_descriptor_pool(pool: &DescriptorPool) -> Vec<GrpcMethodOption> {
    let mut methods = Vec::new();
    for service in pool.services() {
        for method in service.methods() {
            let streaming_mode = match (method.is_client_streaming(), method.is_server_streaming()) {
                (false, false) => "unary",
                (false, true) => "server_stream",
                (true, false) => "client_stream",
                (true, true) => "bidi",
            };
            let badge = match streaming_mode {
                "unary" => "U",
                "server_stream" => "SS",
                "client_stream" => "CS",
                "bidi" => "BI",
                _ => "U",
            };
            methods.push(GrpcMethodOption {
                value: format!("{}/{}", service.full_name(), method.name()),
                label: format!("{} · {}", badge, method.name()),
                streaming_mode: streaming_mode.to_string(),
            });
        }
    }
    methods
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcReflectionPayload {
    pub url: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcReflectionResult {
    pub descriptor_file_path: String,
    pub methods: Vec<GrpcMethodOption>,
}

#[tauri::command]
pub async fn reflect_grpc_server(
    app: AppHandle,
    payload: GrpcReflectionPayload,
) -> Result<GrpcReflectionResult, String> {
    use tonic_reflection::pb::v1alpha::server_reflection_client::ServerReflectionClient;
    use tonic_reflection::pb::v1alpha::server_reflection_request::MessageRequest;
    use tonic_reflection::pb::v1alpha::server_reflection_response::MessageResponse;
    use tonic_reflection::pb::v1alpha::ServerReflectionRequest;

    let target = normalize_grpc_target(&payload.url)?;
    let timeout_ms = payload.timeout_ms.unwrap_or(20_000).clamp(1_000, 120_000);
    let endpoint = Endpoint::from_shared(target.clone())
        .map_err(|err| format!("Invalid gRPC endpoint: {err}"))?
        .timeout(Duration::from_millis(timeout_ms))
        .connect_timeout(Duration::from_millis(timeout_ms.min(10_000)));
    let channel = endpoint
        .connect()
        .await
        .map_err(|err| format!("Failed to connect to gRPC server: {err}"))?;
    let mut client = ServerReflectionClient::new(channel);

    let request_stream = futures_util::stream::iter(vec![ServerReflectionRequest {
        host: String::new(),
        message_request: Some(MessageRequest::ListServices(String::new())),
    }]);
    let response = client
        .server_reflection_info(request_stream)
        .await
        .map_err(|err| format!("gRPC reflection request failed: {err}"))?;
    let mut stream = response.into_inner();
    let list_response = timeout(Duration::from_millis(timeout_ms), stream.message())
        .await
        .map_err(|_| "gRPC reflection list-services request timed out.".to_string())?
        .map_err(|err| format!("Failed to read reflection response: {err}"))?
        .ok_or_else(|| "gRPC reflection returned no list-services response.".to_string())?;

    let services = match list_response.message_response {
        Some(MessageResponse::ListServicesResponse(list)) => list.service,
        Some(MessageResponse::ErrorResponse(err)) => {
            return Err(format!("gRPC reflection failed ({}): {}", err.error_code, err.error_message));
        }
        _ => return Err("gRPC reflection server returned an unexpected response.".to_string()),
    };

    let mut descriptor_files = Vec::new();
    for service in services {
        let service_name = service.name;
        if service_name == "grpc.reflection.v1alpha.ServerReflection"
            || service_name == "grpc.reflection.v1.ServerReflection"
        {
            continue;
        }
        let request_stream = futures_util::stream::iter(vec![ServerReflectionRequest {
            host: String::new(),
            message_request: Some(MessageRequest::FileContainingSymbol(service_name)),
        }]);
        let response = client
            .server_reflection_info(request_stream)
            .await
            .map_err(|err| format!("gRPC reflection descriptor request failed: {err}"))?;
        let mut stream = response.into_inner();
        let descriptor_response = timeout(Duration::from_millis(timeout_ms), stream.message())
            .await
            .map_err(|_| "gRPC reflection descriptor request timed out.".to_string())?
            .map_err(|err| format!("Failed to read reflection descriptor response: {err}"))?
            .ok_or_else(|| "gRPC reflection returned no descriptor response.".to_string())?;
        match descriptor_response.message_response {
            Some(MessageResponse::FileDescriptorResponse(file_response)) => {
                for raw in file_response.file_descriptor_proto {
                    let file = prost_types::FileDescriptorProto::decode(raw.as_slice())
                        .map_err(|err| format!("Failed to decode reflected descriptor: {err}"))?;
                    if !descriptor_files.iter().any(|existing: &prost_types::FileDescriptorProto| existing.name == file.name) {
                        descriptor_files.push(file);
                    }
                }
            }
            Some(MessageResponse::ErrorResponse(_)) => {}
            _ => {}
        }
    }

    if descriptor_files.is_empty() {
        return Err("gRPC reflection did not return any service descriptors.".to_string());
    }

    let descriptor_set = FileDescriptorSet { file: descriptor_files };
    let pool = DescriptorPool::from_file_descriptor_set(descriptor_set.clone())
        .map_err(|err| format!("Failed to load reflected descriptors: {err}"))?;
    let methods = grpc_methods_from_descriptor_pool(&pool);
    if methods.is_empty() {
        return Err("gRPC reflection succeeded, but no RPC methods were found.".to_string());
    }

    let reflection_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed to resolve app data directory: {err}"))?
        .join("reflected-grpc");
    fs::create_dir_all(&reflection_dir)
        .map_err(|err| format!("Failed to create reflection cache directory: {err}"))?;
    let file_name = format!(
        "reflection-{}.fds",
        chrono::Utc::now().timestamp_millis()
    );
    let descriptor_file_path = reflection_dir.join(file_name);
    let mut bytes = Vec::new();
    descriptor_set
        .encode(&mut bytes)
        .map_err(|err| format!("Failed to encode reflected descriptors: {err}"))?;
    fs::write(&descriptor_file_path, bytes)
        .map_err(|err| format!("Failed to write reflection descriptor cache: {err}"))?;

    Ok(GrpcReflectionResult {
        descriptor_file_path: descriptor_file_path.to_string_lossy().to_string(),
        methods,
    })
}

fn find_grpc_method_descriptor(
    pool: &DescriptorPool,
    requested_service: &str,
    requested_method: &str,
) -> Option<MethodDescriptor> {
    for service in pool.services() {
        let service_full = service.full_name();
        let service_short = service.name();
        let service_match = requested_service == service_full
            || requested_service == service_short
            || requested_service.ends_with(&format!(".{service_short}"));

        if !service_match {
            continue;
        }

        if let Some(method) = service
            .methods()
            .find(|method| method.name() == requested_method)
        {
            return Some(method);
        }
    }

    None
}

fn build_dynamic_request_message(
    descriptor: prost_reflect::MessageDescriptor,
    raw_body: Option<&str>,
) -> Result<DynamicMessage, String> {
    let body = raw_body.unwrap_or("{}").trim();
    let json_value = if body.is_empty() {
        Value::Object(serde_json::Map::new())
    } else {
        serde_json::from_str::<Value>(body)
            .map_err(|err| format!("Invalid JSON body for gRPC request: {err}"))?
    };

    let object_value = match json_value {
        Value::Object(map) => Value::Object(map),
        Value::Array(values) if !values.is_empty() => {
            match values.into_iter().next() {
                Some(Value::Object(map)) => Value::Object(map),
                _ => {
                    return Err(
                        "gRPC request body array must contain a JSON object as its first item."
                            .to_string(),
                    )
                }
            }
        }
        _ => {
            return Err("gRPC request body must be a JSON object for unary/server streaming calls."
                .to_string())
        }
    };

    let json_text = serde_json::to_string(&object_value)
        .map_err(|err| format!("Failed to serialize gRPC JSON body: {err}"))?;
    let mut deserializer = serde_json::Deserializer::from_str(&json_text);
    DynamicMessage::deserialize(descriptor, &mut deserializer)
        .map_err(|err| format!("Failed to map JSON body to proto message: {err}"))
}

#[tauri::command]
pub async fn send_grpc_request(
    app: AppHandle,
    payload: GrpcRequestPayload,
) -> Result<ResponsePayload, String> {
    let env_vars = get_env_context(&app, &payload.workspace_name, &payload.collection_name);

    let target = normalize_grpc_target(&resolve_payload_value(&payload.url, &env_vars))?;
    let proto_path = resolve_payload_value(&payload.grpc_proto_file_path, &env_vars);
    let (requested_service, requested_method) = parse_grpc_method_parts(&payload.grpc_method_path)?;
    let streaming_mode = payload.grpc_streaming_mode.trim().to_string();

    if streaming_mode == "client_stream" || streaming_mode == "bidi" {
        return Err("Client streaming and bidirectional streaming are not supported yet.".to_string());
    }

    let descriptor_pool = compile_descriptor_pool(&proto_path)?;
    let method_descriptor = find_grpc_method_descriptor(&descriptor_pool, &requested_service, &requested_method)
        .ok_or_else(|| {
            format!(
                "Method {}/{} was not found in selected proto descriptors.",
                requested_service, requested_method
            )
        })?;

    let path = format!(
        "/{}/{}",
        method_descriptor.parent_service().full_name(),
        method_descriptor.name()
    );
    let path_and_query = tonic::codegen::http::uri::PathAndQuery::from_str(&path)
        .map_err(|err| format!("Invalid gRPC method path: {err}"))?;

    let mut endpoint = Endpoint::from_shared(target.clone())
        .map_err(|err| format!("Invalid gRPC endpoint: {err}"))?;
    endpoint = endpoint
        .user_agent(DEFAULT_USER_AGENT)
        .map_err(|err| format!("Failed to set gRPC user-agent: {err}"))?;
    endpoint = endpoint.connect_timeout(Duration::from_secs(10));
    endpoint = endpoint.timeout(Duration::from_secs(45));

    let channel = endpoint
        .connect()
        .await
        .map_err(|err| format!("Failed to connect to gRPC server: {err}"))?;

    let request_body = payload
        .body
        .as_ref()
        .map(|body| resolve_payload_value(body, &env_vars));
    let request_message = build_dynamic_request_message(method_descriptor.input(), request_body.as_deref())?;

    let mut request = Request::new(request_message);
    for (key, value) in &payload.headers {
        let normalized_key = resolve_payload_value(key, &env_vars);
        let normalized_value = resolve_payload_value(value, &env_vars);
        if normalized_key.trim().is_empty() {
            continue;
        }
        let lower = normalized_key.to_ascii_lowercase();
        if lower == "content-type" || lower == "te" || lower == "host" {
            continue;
        }

        if let Ok(metadata_key) = tonic::metadata::MetadataKey::from_bytes(lower.as_bytes()) {
            if let Ok(metadata_value) = tonic::metadata::MetadataValue::try_from(normalized_value.as_str()) {
                request.metadata_mut().insert(metadata_key, metadata_value);
            }
        }
    }

    let started_at = Instant::now();
    let mut grpc = tonic::client::Grpc::new(channel);
    let codec = DynamicCodec::new(method_descriptor.input(), method_descriptor.output());

    timeout(Duration::from_secs(10), grpc.ready())
        .await
        .map_err(|_| "gRPC client timed out while waiting to become ready.".to_string())?
        .map_err(|err| format!("gRPC client not ready: {err}"))?;

    let (body, headers, status_code, status_text) = if method_descriptor.is_server_streaming() {
        let response = timeout(
            Duration::from_secs(20),
            grpc.server_streaming(request, path_and_query, codec),
        )
        .await
        .map_err(|_| "gRPC request timed out while starting server stream.".to_string())?
        .map_err(|status| {
            format!(
                "gRPC request failed ({}): {}",
                status.code(),
                status.message()
            )
        })?;

        let mut stream = response.into_inner();
        let mut values = Vec::new();
        loop {
            let next_item = timeout(Duration::from_secs(20), stream.message())
                .await
                .map_err(|_| "Timed out while waiting for gRPC stream message.".to_string())?
                .map_err(|status| {
                    format!(
                        "Failed while reading gRPC stream ({}): {}",
                        status.code(),
                        status.message()
                    )
                })?;

            let Some(message) = next_item else {
                break;
            };

            values.push(
                serde_json::to_value(&message)
                    .map_err(|err| format!("Failed to encode stream message as JSON: {err}"))?,
            );
        }

        let stream_body = serde_json::to_string_pretty(&values)
            .map_err(|err| format!("Failed to serialize gRPC stream response: {err}"))?;
        let mut response_headers = HashMap::new();
        response_headers.insert("content-type".to_string(), "application/json".to_string());
        response_headers.insert("x-kivo-grpc-mode".to_string(), "server_stream".to_string());

        (stream_body, response_headers, 200, "OK".to_string())
    } else {
        let response = timeout(Duration::from_secs(20), grpc.unary(request, path_and_query, codec))
            .await
            .map_err(|_| "gRPC unary request timed out.".to_string())?
            .map_err(|status| {
                format!(
                    "gRPC request failed ({}): {}",
                    status.code(),
                    status.message()
                )
            })?;

        let message = response.into_inner();
        let value = serde_json::to_value(&message)
            .map_err(|err| format!("Failed to encode gRPC response as JSON: {err}"))?;
        let unary_body = serde_json::to_string_pretty(&value)
            .map_err(|err| format!("Failed to serialize gRPC response: {err}"))?;

        let mut response_headers = HashMap::new();
        response_headers.insert("content-type".to_string(), "application/json".to_string());
        response_headers.insert("x-kivo-grpc-mode".to_string(), "unary".to_string());

        (unary_body, response_headers, 200, "OK".to_string())
    };

    Ok(ResponsePayload {
        status: status_code,
        status_text,
        headers,
        cookies: vec![],
        body,
        body_base64: String::new(),
        is_binary: false,
        content_type: "application/json".to_string(),
        duration_ms: started_at.elapsed().as_millis(),
    })
}

fn get_expiry_iso(expires_in: Option<u64>) -> String {
    expires_in
        .map(|seconds| {
            let expiry = chrono::Utc::now() + chrono::Duration::seconds(seconds as i64);
            expiry.to_rfc3339()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn oauth_exchange_token(
    app: AppHandle,
    payload: OAuthTokenExchangePayload,
) -> Result<OAuthTokenExchangeResult, String> {
    let request_id = payload.request_id.trim().to_string();
    let _cancel_guard = OAuthCancelGuard::new(request_id.clone());
    let mut cancel_rx = register_oauth_cancel(&request_id);

    let env_vars = get_env_context(&app, &payload.workspace_name, &payload.collection_name);
    let app_settings = get_app_config(app.clone())
        .map(|state| state.app_settings)
        .unwrap_or_default();
    let oauth = payload.oauth;

    let token_url = normalize_url(&resolve_payload_value(&oauth.token_url, &env_vars))?;
    let grant_type = if oauth.grant_type.trim().is_empty() {
        "authorization_code".to_string()
    } else {
        oauth.grant_type.trim().to_string()
    };

    let oauth_timeout_ms = if app_settings.request_timeout_ms > 0 {
        app_settings.request_timeout_ms
    } else {
        45_000
    };
    let client = build_http_client(
        &app_settings,
        &token_url,
        oauth_timeout_ms,
        true,
        10,
        app_settings.validate_certificates_during_authentication,
        None,
    )?;

    let client_id = resolve_payload_value(&oauth.client_id, &env_vars);
    let client_secret = resolve_payload_value(&oauth.client_secret, &env_vars);
    let callback_url = resolve_payload_value(&oauth.callback_url, &env_vars);
    let authorization_code = resolve_payload_value(&oauth.authorization_code, &env_vars);
    let refresh_token = resolve_payload_value(&oauth.refresh_token, &env_vars);
    let username = resolve_payload_value(&oauth.username, &env_vars);
    let password = resolve_payload_value(&oauth.password, &env_vars);
    let scope = resolve_payload_value(&oauth.scope, &env_vars);
    let audience = resolve_payload_value(&oauth.audience, &env_vars);
    let resource = resolve_payload_value(&oauth.resource, &env_vars);
    let code_verifier = resolve_payload_value(&oauth.code_verifier, &env_vars);
    let client_auth_method = if oauth.client_auth_method.trim().is_empty() {
        "basic".to_string()
    } else {
        oauth.client_auth_method.trim().to_string()
    };

    let mut form: Vec<(String, String)> = vec![("grant_type".to_string(), grant_type.clone())];

    match grant_type.as_str() {
        "authorization_code" => {
            if authorization_code.trim().is_empty() {
                return Err("Authorization code is missing.".to_string());
            }
            form.push(("code".to_string(), authorization_code));
            if !callback_url.trim().is_empty() {
                form.push(("redirect_uri".to_string(), callback_url));
            }
            if !code_verifier.trim().is_empty() {
                form.push(("code_verifier".to_string(), code_verifier));
            }
        }
        "client_credentials" => {}
        "password" => {
            if username.trim().is_empty() || password.trim().is_empty() {
                return Err("Username and password are required for password grant.".to_string());
            }
            form.push(("username".to_string(), username));
            form.push(("password".to_string(), password));
        }
        "refresh_token" => {
            if refresh_token.trim().is_empty() {
                return Err("Refresh token is missing.".to_string());
            }
            form.push(("refresh_token".to_string(), refresh_token));
        }
        _ => return Err(format!("Unsupported OAuth grant type: {}", grant_type)),
    }

    if !scope.trim().is_empty() {
        form.push(("scope".to_string(), scope));
    }
    if !audience.trim().is_empty() {
        form.push(("audience".to_string(), audience));
    }
    if !resource.trim().is_empty() {
        form.push(("resource".to_string(), resource));
    }

    for row in oauth.extra_token_params {
        if row.enabled && !row.key.trim().is_empty() {
            form.push((
                resolve_payload_value(row.key.trim(), &env_vars),
                resolve_payload_value(&row.value, &env_vars),
            ));
        }
    }

    let can_use_basic = !client_id.trim().is_empty();
    let mut use_basic_auth = client_auth_method == "basic" && can_use_basic;

    let mut request_form = form.clone();
    if !use_basic_auth {
        if !client_id.trim().is_empty() {
            request_form.push(("client_id".to_string(), client_id.clone()));
        }
        if !client_secret.trim().is_empty() {
            request_form.push(("client_secret".to_string(), client_secret.clone()));
        }
    }

    let mut request = client
        .post(&token_url)
        .header(ACCEPT, "application/json")
        .header(USER_AGENT, DEFAULT_USER_AGENT)
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded");

    if use_basic_auth {
        let encoded = BASE64_STANDARD.encode(format!("{}:{}", client_id, client_secret));
        request = request.header(AUTHORIZATION, format!("Basic {}", encoded));
    }

    let mut response = send_oauth_form(
        request,
        &request_form,
        &mut cancel_rx,
        "OAuth token request failed",
    ).await?;

    let mut status = response.status();
    let mut text = response
        .text()
        .await
        .map_err(|err| format!("Failed to read OAuth response: {err}"))?;
    let mut raw_json: Value = serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text.clone()));

    let should_retry_with_alternate = !status.is_success()
        && status.as_u16() == 401
        && raw_json
            .get("error")
            .and_then(|value| value.as_str())
            .map(|value| value == "invalid_client")
            .unwrap_or(false)
        && can_use_basic;

    if should_retry_with_alternate {
        use_basic_auth = !use_basic_auth;
        let mut retry_form = form.clone();
        if !use_basic_auth {
            if !client_id.trim().is_empty() {
                retry_form.push(("client_id".to_string(), client_id.clone()));
            }
            if !client_secret.trim().is_empty() {
                retry_form.push(("client_secret".to_string(), client_secret.clone()));
            }
        }

        let mut retry_request = client
            .post(&token_url)
            .header(ACCEPT, "application/json")
            .header(USER_AGENT, DEFAULT_USER_AGENT)
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded");

        if use_basic_auth {
            let encoded = BASE64_STANDARD.encode(format!("{}:{}", client_id, client_secret));
            retry_request = retry_request.header(AUTHORIZATION, format!("Basic {}", encoded));
        }

        response = send_oauth_form(
            retry_request,
            &retry_form,
            &mut cancel_rx,
            "OAuth token retry failed",
        ).await?;

        status = response.status();
        text = response
            .text()
            .await
            .map_err(|err| format!("Failed to read OAuth retry response: {err}"))?;
        raw_json = serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text.clone()));
    }

    if !status.is_success() {
        let description = raw_json
            .get("error_description")
            .and_then(|value| value.as_str())
            .or_else(|| raw_json.get("error").and_then(|value| value.as_str()))
            .unwrap_or(&text);
        return Err(format!("OAuth token request failed ({}): {}", status.as_u16(), description));
    }

    let access_token = raw_json
        .get("access_token")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let refresh_token = raw_json
        .get("refresh_token")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let token_type = raw_json
        .get("token_type")
        .and_then(|value| value.as_str())
        .unwrap_or("Bearer")
        .to_string();
    let scope = raw_json
        .get("scope")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let expires_in = raw_json.get("expires_in").and_then(|value| value.as_u64());
    let expires_at = get_expiry_iso(expires_in);

    Ok(OAuthTokenExchangeResult {
        access_token,
        refresh_token,
        token_type,
        scope,
        expires_in,
        expires_at,
        raw: raw_json,
    })
}

#[tauri::command]
pub async fn send_http_request(
    app: AppHandle,
    payload: RequestPayload,
) -> Result<ResponsePayload, String> {
    let request_id = payload.request_id.trim().to_string();
    let _cancel_guard = HttpCancelGuard::new(request_id.clone());
    let mut cancel_rx = register_http_cancel(&request_id);

    let storage_root = get_storage_root(&app).unwrap_or_default();
    let workspace_path = storage_root.join(&payload.workspace_name);
    let collection_path = if payload.collection_name.is_empty() {
        None
    } else {
        Some(
            get_collection_dir(&storage_root, &payload.workspace_name, &payload.collection_name),
        )
    };

    let env_vars = load_env_vars(&workspace_path, collection_path.as_deref());
    let app_settings = get_app_config(app.clone())
        .map(|state| state.app_settings)
        .unwrap_or_default();

    let col_config = collection_path
        .as_deref()
        .map(load_collection_config_from_path)
        .unwrap_or_default();

    let mut merged_headers: HashMap<String, String> = HashMap::new();

    if payload.inherit_headers.unwrap_or(true) {
        merged_headers = col_config
            .default_headers
            .iter()
            .filter(|row| row.enabled && !row.key.trim().is_empty())
            .map(|row| {
                (
                    resolve_variables(row.key.trim(), &env_vars),
                    resolve_variables(&row.value, &env_vars),
                )
            })
            .collect();
    }

    for (k, v) in &payload.headers {
        merged_headers.insert(
            resolve_variables(k, &env_vars),
            resolve_variables(v, &env_vars),
        );
    }

    let has_multipart_file_rows = payload.body_rows.iter().any(|row| {
        row.enabled
            && row.field_type.trim().eq_ignore_ascii_case("file")
            && !row.key.trim().is_empty()
            && !row.file_path.trim().is_empty()
    });
    if has_multipart_file_rows {
        merged_headers.retain(|key, _| !key.trim().eq_ignore_ascii_case("content-type"));
    }

    let has_auth_header = merged_headers
        .keys()
        .any(|k| k.to_lowercase() == "authorization");

    if payload.auth_type == "inherit" && !has_auth_header {
        let auth = &col_config.default_auth;
        match auth.auth_type.as_str() {
            "bearer" if !auth.token.is_empty() => {
                let resolved = resolve_variables(&auth.token, &env_vars);
                merged_headers.insert(
                    "Authorization".to_string(),
                    format!("Bearer {}", resolved),
                );
            }
            "jwt" if !auth.jwt_token.is_empty() || !auth.token.is_empty() => {
                let token = if auth.jwt_token.trim().is_empty() {
                    &auth.token
                } else {
                    &auth.jwt_token
                };
                let resolved = resolve_variables(token, &env_vars);
                merged_headers.insert(
                    "Authorization".to_string(),
                    format!("Bearer {}", resolved),
                );
            }
            "basic" if !auth.username.is_empty() || !auth.password.is_empty() => {
                let u = resolve_variables(&auth.username, &env_vars);
                let p = resolve_variables(&auth.password, &env_vars);
                let encoded = BASE64_STANDARD.encode(format!("{}:{}", u, p));
                merged_headers.insert(
                    "Authorization".to_string(),
                    format!("Basic {}", encoded),
                );
            }
            "apikey" if !auth.api_key_name.is_empty() => {
                let name = resolve_variables(&auth.api_key_name, &env_vars);
                let value = resolve_variables(&auth.api_key_value, &env_vars);
                if auth.api_key_in != "query" {
                    merged_headers.insert(name, value);
                }
            }
            "oauth2" if !auth.oauth2.access_token.is_empty() => {
                let token_type = if auth.oauth2.token_type.trim().is_empty() {
                    "Bearer".to_string()
                } else {
                    resolve_variables(&auth.oauth2.token_type, &env_vars)
                };
                let token = resolve_variables(&auth.oauth2.access_token, &env_vars);
                merged_headers.insert(
                    "Authorization".to_string(),
                    format!("{} {}", token_type, token),
                );
            }
            _ => {}
        }
    }

    let resolved_url = resolve_variables(&payload.url, &env_vars);
    let resolved_body = payload
        .body
        .as_deref()
        .map(|b| resolve_variables(b, &env_vars));
    let resolved_body_file_path = payload
        .body_file_path
        .as_deref()
        .map(|path| resolve_variables(path, &env_vars));

    let mut url = normalize_url(&resolved_url)?;

    if !merged_headers
        .keys()
        .any(|k| k.to_lowercase() == "authorization")
    {
        if payload.auth_type == "inherit" {
            let auth = &col_config.default_auth;
            if auth.auth_type == "digest" {
                let username = resolve_variables(&auth.username, &env_vars);
                let password = resolve_variables(&auth.password, &env_vars);
                let realm = resolve_variables(&auth.digest_realm, &env_vars);
                let nonce = resolve_variables(&auth.digest_nonce, &env_vars);
                let qop = if auth.digest_qop.trim().is_empty() {
                    "auth".to_string()
                } else {
                    resolve_variables(&auth.digest_qop, &env_vars)
                };
                if let Some(header) = build_digest_auth_header(
                    &username,
                    &password,
                    &realm,
                    &nonce,
                    &qop,
                    &payload.method,
                    &url,
                ) {
                    merged_headers.insert("Authorization".to_string(), header);
                }
            }
        } else if payload.auth_type == "digest" {
            if let Some(ref auth) = payload.auth_payload {
                let username = resolve_variables(&auth.username, &env_vars);
                let password = resolve_variables(&auth.password, &env_vars);
                let realm = resolve_variables(&auth.digest_realm, &env_vars);
                let nonce = resolve_variables(&auth.digest_nonce, &env_vars);
                let qop = if auth.digest_qop.trim().is_empty() {
                    "auth".to_string()
                } else {
                    resolve_variables(&auth.digest_qop, &env_vars)
                };
                if let Some(header) = build_digest_auth_header(
                    &username,
                    &password,
                    &realm,
                    &nonce,
                    &qop,
                    &payload.method,
                    &url,
                ) {
                    merged_headers.insert("Authorization".to_string(), header);
                }
            }
        } else if payload.auth_type == "jwt" {
            if let Some(ref auth) = payload.auth_payload {
                let token = if auth.jwt_token.trim().is_empty() {
                    &auth.token
                } else {
                    &auth.jwt_token
                };
                let resolved = resolve_variables(token, &env_vars);
                if !resolved.trim().is_empty() {
                    merged_headers
                        .insert("Authorization".to_string(), format!("Bearer {}", resolved));
                }
            }
        }
    }

    let should_inject_apikey_query = if payload.auth_type == "inherit" {
        col_config.default_auth.auth_type == "apikey"
            && col_config.default_auth.api_key_in == "query"
            && !col_config.default_auth.api_key_name.is_empty()
    } else {
        false
    };

    if should_inject_apikey_query {
        let name = resolve_variables(&col_config.default_auth.api_key_name, &env_vars);
        let value = resolve_variables(&col_config.default_auth.api_key_value, &env_vars);
        if let Ok(mut parsed) = reqwest::Url::parse(&url) {
            parsed.query_pairs_mut().append_pair(&name, &value);
            url = parsed.to_string();
        }
    }

    if payload.auth_type == "apikey" {
        if let Some(ref ap) = payload.auth_payload {
            if ap.api_key_in == "query" && !ap.api_key_name.is_empty() {
                let name = resolve_variables(&ap.api_key_name, &env_vars);
                let value = resolve_variables(&ap.api_key_value, &env_vars);
                if let Ok(mut parsed) = reqwest::Url::parse(&url) {
                    let already_has = parsed.query_pairs().any(|(k, _)| k == name);
                    if !already_has {
                        parsed.query_pairs_mut().append_pair(&name, &value);
                        url = parsed.to_string();
                    }
                }
            }
        }
    }

    let effective_timeout_ms = if payload.timeout_ms.unwrap_or(0) > 0 {
        payload.timeout_ms.unwrap_or(0)
    } else {
        app_settings.request_timeout_ms
    };
    let effective_follow_redirects = payload.follow_redirects.unwrap_or(true);
    let effective_max_redirects = payload.max_redirects.unwrap_or(5);
    let request_network = RequestNetworkOptions {
        proxy_mode: payload.proxy_mode.clone().unwrap_or_default(),
        proxy_http: payload.proxy_http.clone().unwrap_or_default(),
        proxy_https: payload.proxy_https.clone().unwrap_or_default(),
        no_proxy: payload.no_proxy.clone().unwrap_or_default(),
        client_certificate_path: payload.client_certificate_path.clone().unwrap_or_default(),
        client_key_path: payload.client_key_path.clone().unwrap_or_default(),
    };
    let client = build_http_client(
        &app_settings,
        &url,
        effective_timeout_ms,
        effective_follow_redirects,
        effective_max_redirects,
        app_settings.ssl_tls_certificate_verification,
        Some(&request_network),
    )?;

    let method_str = payload.method.to_uppercase();
    let method = reqwest::Method::from_bytes(method_str.as_bytes())
        .map_err(|_| format!("Unsupported HTTP method: {}", payload.method))?;

    let request_url = reqwest::Url::parse(&url)
        .map_err(|_| format!("Invalid URL: {url}"))?;
    let mut request = client
        .request(method.clone(), &url)
        .headers(build_headers(&merged_headers, payload.disable_user_agent.unwrap_or(false))?);

    let use_cookie_jar = payload.use_cookie_jar.unwrap_or(true);
    let should_send_cookies = use_cookie_jar && app_settings.send_cookies_automatically;
    let should_store_cookies = use_cookie_jar && app_settings.store_cookies_automatically;
    let has_cookie_header = merged_headers
        .keys()
        .any(|key| key.trim().eq_ignore_ascii_case("cookie"));
    if should_send_cookies && !has_cookie_header {
        if let Some(cookie_header) = build_cookie_header_from_store(
            &app,
            &payload.workspace_name,
            &payload.collection_name,
            &request_url,
        )? {
            request = request.header(COOKIE, cookie_header);
        }
    }

    if has_multipart_file_rows {
        request = request.multipart(build_multipart_form(&payload.body_rows).await?);
    } else if let Some(path) = resolved_body_file_path {
        if !path.trim().is_empty() {
            let bytes = fs::read(&path).map_err(|err| format!("Failed to read body file: {err}"))?;
            request = request.body(bytes);
        }
    } else if let Some(body) = resolved_body {
        if !body.trim().is_empty() {
            request = request.body(body);
        }
    }

    let started_at = Instant::now();
    let response = send_http_request_with_cancel(request, &mut cancel_rx).await?;
    let duration_ms = started_at.elapsed().as_millis();

    let status = response.status();
    let status_text = status.canonical_reason().unwrap_or("Unknown").to_string();
    let set_cookie_values = response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok().map(|text| text.to_string()))
        .collect::<Vec<_>>();
    if should_store_cookies {
        let _ = merge_set_cookie_headers(
            &app,
            &payload.workspace_name,
            &payload.collection_name,
            &request_url,
            &set_cookie_values,
        );
    }
    let headers = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.to_string(),
                value.to_str().unwrap_or("<binary>").to_string(),
            )
        })
        .collect::<HashMap<_, _>>();
    let content_type = headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("content-type"))
        .map(|(_, value)| value.clone())
        .unwrap_or_default();
    let bytes = response.bytes().await.map_err(|err| err.to_string())?;
    let body_base64 = BASE64_STANDARD.encode(&bytes);
    let body = String::from_utf8(bytes.to_vec()).unwrap_or_default();
    let lower_content_type = content_type.to_ascii_lowercase();
    let is_textual = lower_content_type.starts_with("text/")
        || lower_content_type.contains("json")
        || lower_content_type.contains("xml")
        || lower_content_type.contains("yaml")
        || lower_content_type.contains("javascript")
        || lower_content_type.contains("html")
        || lower_content_type.is_empty();
    let is_binary = !is_textual || (body.is_empty() && !body_base64.is_empty());

    Ok(ResponsePayload {
        status: status.as_u16(),
        status_text,
        headers,
        cookies: set_cookie_values,
        body,
        body_base64,
        is_binary,
        content_type,
        duration_ms,
    })
}
