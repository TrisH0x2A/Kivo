use crate::storage::models::{KeyValueRow, MockRouteRecord, MockServerConfig};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

const MAX_HEADERS: usize = 64 * 1024;
const MAX_BODY: usize = 8 * 1024 * 1024;
const MAX_DELAY_MS: u64 = 60_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MockServerInfo {
    pub running: bool,
    pub url: String,
    pub port: u16,
    pub route_count: usize,
}

struct MockRuntime {
    port: u16,
    route_count: usize,
    stop: oneshot::Sender<()>,
}

fn runtime() -> &'static Mutex<Option<MockRuntime>> {
    static RUNTIME: OnceLock<Mutex<Option<MockRuntime>>> = OnceLock::new();
    RUNTIME.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Deserialize)]
struct RequestHead {
    method: String,
    target: String,
    headers: HashMap<String, String>,
}

fn parse_head(bytes: &[u8]) -> Result<(RequestHead, usize), String> {
    let marker = bytes.windows(4).position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "Incomplete HTTP request headers".to_string())?;
    let text = std::str::from_utf8(&bytes[..marker]).map_err(|_| "Request headers are not UTF-8".to_string())?;
    let mut lines = text.lines();
    let request = lines.next().ok_or_else(|| "Missing HTTP request line".to_string())?;
    let mut parts = request.split_whitespace();
    let method = parts.next().unwrap_or_default().to_ascii_uppercase();
    let target = parts.next().unwrap_or_default().to_string();
    if method.is_empty() || target.is_empty() || parts.next().is_none() { return Err("Malformed HTTP request line".into()); }
    let mut headers = HashMap::new();
    for line in lines {
        let (key, value) = line.split_once(':').ok_or_else(|| "Malformed HTTP header".to_string())?;
        headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
    }
    Ok((RequestHead { method, target, headers }, marker + 4))
}

async fn read_request(stream: &mut TcpStream) -> Result<(RequestHead, Vec<u8>), String> {
    let mut bytes = Vec::with_capacity(4096);
    let header_end;
    loop {
        if bytes.len() > MAX_HEADERS { return Err("Request headers exceed 64 KiB".into()); }
        let mut chunk = [0u8; 4096];
        let read = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut chunk)).await
            .map_err(|_| "Timed out reading mock request".to_string())?
            .map_err(|error| error.to_string())?;
        if read == 0 { return Err("Client closed the mock request".into()); }
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") { header_end = index + 4; break; }
    }
    let (head, _) = parse_head(&bytes)?;
    let length = head.headers.get("content-length").map(|value| value.parse::<usize>().map_err(|_| "Invalid Content-Length".to_string())).transpose()?.unwrap_or(0);
    if length > MAX_BODY { return Err("Request body exceeds 8 MiB".into()); }
    while bytes.len() - header_end < length {
        let mut chunk = [0u8; 8192];
        let read = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut chunk)).await
            .map_err(|_| "Timed out reading mock request body".to_string())?
            .map_err(|error| error.to_string())?;
        if read == 0 { return Err("Client closed the mock request body".into()); }
        bytes.extend_from_slice(&chunk[..read]);
    }
    Ok((head, bytes[header_end..header_end + length].to_vec()))
}

fn clean_headers(rows: &[KeyValueRow]) -> String {
    rows.iter().filter(|row| row.enabled && !row.key.trim().is_empty())
        .filter(|row| !matches!(row.key.trim().to_ascii_lowercase().as_str(), "connection" | "content-length" | "transfer-encoding"))
        .map(|row| format!("{}: {}\r\n", row.key.trim(), row.value.replace(['\r', '\n'], "")))
        .collect()
}

fn path_matches(pattern: &str, target: &str) -> bool {
    let path = target.split('?').next().unwrap_or(target);
    let pattern = if pattern.starts_with('/') { pattern } else { &format!("/{pattern}") };
    if pattern.ends_with("/*") { return path.starts_with(pattern.trim_end_matches('*')); }
    let left: Vec<_> = path.trim_matches('/').split('/').filter(|part| !part.is_empty()).collect();
    let right: Vec<_> = pattern.trim_matches('/').split('/').filter(|part| !part.is_empty()).collect();
    left.len() == right.len() && left.iter().zip(right.iter()).all(|(actual, expected)| expected.starts_with('{') && expected.ends_with('}') || actual == expected)
}

fn selected_route<'a>(config: &'a MockServerConfig, head: &RequestHead) -> Option<&'a MockRouteRecord> {
    let scenario = head.headers.get("x-kivo-scenario").map(String::as_str).or_else(|| head.target.split_once("__scenario=").and_then(|(_, value)| value.split('&').next())).unwrap_or("");
    config.routes.iter().find(|route| route.enabled && route.method.eq_ignore_ascii_case(&head.method) && route.scenario == scenario && path_matches(&route.path, &head.target))
        .or_else(|| config.routes.iter().find(|route| route.enabled && route.method.eq_ignore_ascii_case(&head.method) && route.scenario.is_empty() && path_matches(&route.path, &head.target)))
}

fn response_for(route: Option<&MockRouteRecord>) -> (u16, String, String, u64) {
    let Some(route) = route else { return (404, "Not Found".into(), "{\"error\":\"mock route not found\"}".into(), 0); };
    let status = route.status.clamp(100, 599);
    let reason = match status { 200 => "OK", 201 => "Created", 204 => "No Content", 400 => "Bad Request", 401 => "Unauthorized", 403 => "Forbidden", 404 => "Not Found", 409 => "Conflict", 422 => "Unprocessable Entity", 429 => "Too Many Requests", 500 => "Internal Server Error", 502 => "Bad Gateway", 503 => "Service Unavailable", _ => "Mock Response" };
    (status, reason.into(), route.body.clone(), route.delay_ms.min(MAX_DELAY_MS))
}

async fn serve_connection(mut stream: TcpStream, config: MockServerConfig) {
    let result = async {
        let (head, _) = read_request(&mut stream).await?;
        let route = selected_route(&config, &head);
        let (status, reason, body, delay) = response_for(route);
        if delay > 0 { tokio::time::sleep(Duration::from_millis(delay)).await; }
        let custom = route.map(|item| clean_headers(&item.headers)).unwrap_or_default();
        let body = if status == 204 { String::new() } else { body };
        let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n{custom}\r\n{body}", body.as_bytes().len());
        stream.write_all(response.as_bytes()).await.map_err(|error| error.to_string())?;
        stream.shutdown().await.map_err(|error| error.to_string())
    }.await;
    if result.is_err() { let _ = stream.shutdown().await; }
}

#[tauri::command]
pub async fn start_mock_server(config: MockServerConfig) -> Result<MockServerInfo, String> {
    stop_mock_server().await?;
    if config.routes.len() > 500 { return Err("A mock server can contain at most 500 routes".into()); }
    for route in &config.routes {
        if route.body.len() > 2 * 1024 * 1024 { return Err("Mock response bodies must be smaller than 2 MiB".into()); }
        if route.path.len() > 2048 || route.scenario.len() > 128 { return Err("Mock route fields are too long".into()); }
    }
    let listener = TcpListener::bind(("127.0.0.1", config.port)).await.map_err(|error| format!("Could not bind mock server: {error}"))?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let (stop, mut stop_rx) = oneshot::channel();
    let route_count = config.routes.len();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                accepted = listener.accept() => if let Ok((stream, _)) = accepted { tokio::spawn(serve_connection(stream, config.clone())); },
            }
        }
    });
    runtime().lock().map_err(|_| "Mock server state is unavailable".to_string())?.replace(MockRuntime { port, route_count, stop });
    Ok(MockServerInfo { running: true, url: format!("http://127.0.0.1:{port}"), port, route_count })
}

#[tauri::command]
pub async fn stop_mock_server() -> Result<MockServerInfo, String> {
    let previous = runtime().lock().map_err(|_| "Mock server state is unavailable".to_string())?.take();
    if let Some(active) = previous { let _ = active.stop.send(()); }
    Ok(MockServerInfo { running: false, url: String::new(), port: 0, route_count: 0 })
}

#[tauri::command]
pub fn mock_server_status() -> Result<MockServerInfo, String> {
    let active = runtime().lock().map_err(|_| "Mock server state is unavailable".to_string())?;
    Ok(active.as_ref().map(|item| MockServerInfo { running: true, url: format!("http://127.0.0.1:{}", item.port), port: item.port, route_count: item.route_count }).unwrap_or(MockServerInfo { running: false, url: String::new(), port: 0, route_count: 0 }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn route_matching_supports_parameters_wildcards_and_scenarios() {
        assert!(path_matches("/users/{id}", "/users/42?verbose=1"));
        assert!(path_matches("/assets/*", "/assets/css/app.css"));
        assert!(!path_matches("/users/{id}", "/users/42/posts"));
        let config = MockServerConfig { port: 0, routes: vec![MockRouteRecord { id: "1".into(), method: "GET".into(), path: "/health".into(), scenario: "down".into(), status: 503, headers: vec![], body: "down".into(), delay_ms: 0, enabled: true }] };
        let head = RequestHead { method: "GET".into(), target: "/health".into(), headers: HashMap::from([(String::from("x-kivo-scenario"), String::from("down"))]) };
        assert_eq!(selected_route(&config, &head).unwrap().status, 503);
    }

    #[tokio::test]
    async fn loopback_server_serves_scenarios_and_stops() {
        let config = MockServerConfig { port: 0, routes: vec![
            MockRouteRecord { id: "ok".into(), method: "GET".into(), path: "/health".into(), scenario: String::new(), status: 200, headers: vec![KeyValueRow { key: "X-Mock".into(), value: "true".into(), enabled: true, field_type: String::new(), file_path: String::new() }], body: "{\"ok\":true}".into(), delay_ms: 0, enabled: true },
            MockRouteRecord { id: "down".into(), method: "GET".into(), path: "/health".into(), scenario: "down".into(), status: 503, headers: vec![], body: "{\"ok\":false}".into(), delay_ms: 0, enabled: true },
        ] };
        let info = start_mock_server(config).await.unwrap();
        let client = reqwest::Client::new();
        let ok = client.get(format!("{}/health", info.url)).send().await.unwrap();
        assert_eq!(ok.status(), 200);
        assert_eq!(ok.headers().get("x-mock").unwrap(), "true");
        assert_eq!(ok.text().await.unwrap(), "{\"ok\":true}");
        let down = client.get(format!("{}/health", info.url)).header("x-kivo-scenario", "down").send().await.unwrap();
        assert_eq!(down.status(), 503);
        assert_eq!(client.get(format!("{}/missing", info.url)).send().await.unwrap().status(), 404);
        stop_mock_server().await.unwrap();
        assert!(!mock_server_status().unwrap().running);
    }
}
