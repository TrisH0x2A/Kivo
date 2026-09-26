use super::{build_http_client, get_env_context, normalize_url, resolve_payload_value, RequestNetworkOptions};
use crate::storage::{get_app_config, AppSettings};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tokio::net::TcpStream;
use tokio::time::timeout;

const STEP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiagnosticInput {
    url: String,
    workspace_name: String,
    collection_name: String,
    proxy_mode: String,
    proxy_http: String,
    proxy_https: String,
    no_proxy: String,
    client_certificate_path: String,
    client_key_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticStep {
    stage: String,
    status: String,
    duration_ms: Option<u128>,
    detail: String,
    hint: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    target: String,
    steps: Vec<DiagnosticStep>,
}

impl DiagnosticReport {
    fn push(&mut self, stage: &str, status: &str, started: Option<Instant>, detail: impl Into<String>, hint: &str) {
        self.steps.push(DiagnosticStep {
            stage: stage.into(), status: status.into(), duration_ms: started.map(|time| time.elapsed().as_millis()),
            detail: detail.into(), hint: hint.into(),
        });
    }
}

#[tauri::command]
pub async fn diagnose_connection(app: AppHandle, payload: DiagnosticInput) -> Result<DiagnosticReport, String> {
    let env = get_env_context(&app, &payload.workspace_name, &payload.collection_name)?;
    let url = normalize_url(&resolve_payload_value(&payload.url, &env))?;
    let settings = get_app_config(app)?.app_settings;
    let network = RequestNetworkOptions {
        proxy_mode: payload.proxy_mode,
        proxy_http: resolve_payload_value(&payload.proxy_http, &env),
        proxy_https: resolve_payload_value(&payload.proxy_https, &env),
        no_proxy: resolve_payload_value(&payload.no_proxy, &env),
        client_certificate_path: resolve_payload_value(&payload.client_certificate_path, &env),
        client_key_path: resolve_payload_value(&payload.client_key_path, &env),
    };
    diagnose(&url, &settings, &network).await
}

async fn diagnose(raw_url: &str, settings: &AppSettings, network: &RequestNetworkOptions) -> Result<DiagnosticReport, String> {
    let mut url = url::Url::parse(raw_url).map_err(|_| "Enter a valid HTTP or HTTPS URL.")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() || raw_url.contains("{{") {
        return Err("Diagnostics require a resolved HTTP or HTTPS URL.".into());
    }
    url.set_username("").map_err(|_| "Invalid URL authority")?;
    url.set_password(None).map_err(|_| "Invalid URL authority")?;
    url.set_fragment(None);
    let mut report = DiagnosticReport { target: url.origin().ascii_serialization(), steps: Vec::new() };
    // Do not probe the origin directly when the request may use a proxy.
    let proxy_possible = settings.proxy_enabled || network.proxy_mode == "custom" ||
        ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].iter().any(|key| std::env::var(key).is_ok_and(|value| !value.is_empty()));
    report.push("Proxy", "info", None,
        if proxy_possible { "Configured or system proxy settings apply to the HEAD check." } else { "No configured or system proxy detected." },
        "HEAD uses the request's proxy and certificate settings. Direct probes are skipped when a proxy may apply.");
    if proxy_possible {
        for stage in ["DNS", "TCP", "TLS"] {
            report.push(stage, "skipped", None, "Not measured separately on a proxied route.", "Inspect the HEAD result for proxy or tunnel errors.");
        }
    } else {
        direct_checks(&url, settings, network, &mut report).await;
    }

    // HEAD has no request headers, cookies or body. Redirects are inspected without following them.
    let client = match build_http_client(settings, url.as_str(), 10_000, false, 1, true, Some(network)) {
        Ok(client) => client,
        Err(error) => {
            report.push("Configuration", "failed", None, error, "Check proxy URLs and certificate files in request and app settings.");
            return Ok(report);
        }
    };
    let start = Instant::now();
    match client.head(url).send().await {
        Ok(response) => {
            let code = response.status().as_u16();
            report.push("Application", if code >= 400 { "warning" } else { "passed" }, Some(start), format!("HEAD returned HTTP {code}. Timing includes connection setup and server response."),
                if code == 405 || code == 501 { "This server may not support HEAD. The original request can still work." }
                else if code == 401 || code == 403 { "The server was reached. HEAD does not include the request's authorization headers or cookies." }
                else if code == 407 { "The proxy requires authentication. Check proxy credentials in app settings." }
                else { "This is a separate HEAD probe, not a replay of the original request." });
            if response.status().is_redirection() {
                let destination = response.headers().get("location").and_then(|value| value.to_str().ok())
                    .and_then(|value| response.url().join(value).ok()).map(|value| value.origin().ascii_serialization());
                report.push("Redirect", "warning", None,
                    destination.map(|origin| format!("Redirect to {origin}; not followed.")).unwrap_or_else(|| "Redirect has no valid Location header.".into()),
                    "Check the destination and the request's redirect settings.");
            } else {
                report.push("Redirect", "passed", None, "No redirect returned by HEAD.", "");
            }
        }
        Err(error) => {
            let timed_out = error.is_timeout();
            let error = error.without_url();
            let mut detail = error.to_string();
            let mut cause = std::error::Error::source(&error);
            while let Some(source) = cause { detail.push_str(&format!("; {source}")); cause = source.source(); }
            report.push("Application", "failed", Some(start), detail,
                if timed_out { "HEAD exceeded its 10 second limit. Check the server, firewall and proxy." } else { "Check the reported cause and the DNS, TCP and TLS results above." });
            report.push("Redirect", "skipped", None, "No HTTP response was received.", "");
        }
    }
    Ok(report)
}

async fn direct_checks(url: &url::Url, settings: &AppSettings, network: &RequestNetworkOptions, report: &mut DiagnosticReport) {
    let host = match url.host() {
        Some(url::Host::Domain(value)) => value.to_string(),
        Some(url::Host::Ipv4(value)) => value.to_string(),
        Some(url::Host::Ipv6(value)) => value.to_string(),
        None => return,
    };
    let port = url.port_or_known_default().unwrap_or(443);
    let start = Instant::now();
    let addresses: Vec<_> = match timeout(STEP_TIMEOUT, tokio::net::lookup_host((host.as_str(), port))).await {
        Ok(Ok(addresses)) => addresses.collect(),
        result => {
            let detail = match result { Ok(Err(error)) => error.to_string(), _ => "DNS lookup timed out.".into() };
            report.push("DNS", "failed", Some(start), detail, "Check the hostname, selected environment, VPN and DNS resolver.");
            for stage in ["TCP", "TLS"] { report.push(stage, "skipped", None, "DNS lookup failed.", ""); }
            return;
        }
    };
    report.push("DNS", if addresses.is_empty() { "failed" } else { "passed" }, Some(start), format!("{} addresses resolved.", addresses.len()), "");
    let start = Instant::now();
    let stream = match timeout(STEP_TIMEOUT, TcpStream::connect(addresses.as_slice())).await {
        Ok(Ok(stream)) => stream,
        result => {
            let detail = match result { Ok(Err(error)) => error.to_string(), _ => "TCP connection timed out.".into() };
            report.push("TCP", "failed", Some(start), detail, "Check the port, server listener, firewall and VPN.");
            report.push("TLS", "skipped", None, "TCP connection failed.", "");
            return;
        }
    };
    report.push("TCP", "passed", Some(start), format!("Connected to port {port}."), "");
    if url.scheme() != "https" {
        report.push("TLS", "skipped", None, "Plain HTTP does not use TLS.", "");
        return;
    }
    if settings.use_custom_ca_certificate || settings.use_client_certificate || !network.client_certificate_path.is_empty() {
        report.push("TLS", "skipped", None, "Custom certificate configuration is checked by HEAD.", "Separate TLS timing is unavailable for this configuration.");
        return;
    }
    let start = Instant::now();
    let roots = match tokio::task::spawn_blocking(|| {
        let mut roots = rustls::RootCertStore::empty();
        for cert in rustls_native_certs::load_native_certs().certs { let _ = roots.add(cert); }
        roots
    }).await {
        Ok(roots) => roots,
        Err(error) => { report.push("TLS", "failed", Some(start), error.to_string(), "Unable to load system certificate roots."); return; }
    };
    let config = match rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider())).with_safe_default_protocol_versions() {
        Ok(builder) => builder.with_root_certificates(roots).with_no_client_auth(),
        Err(error) => { report.push("TLS", "failed", Some(start), error.to_string(), "Unable to initialize TLS."); return; }
    };
    let name = match rustls::pki_types::ServerName::try_from(host) {
        Ok(name) => name,
        Err(error) => { report.push("TLS", "failed", Some(start), error.to_string(), "Check the server hostname."); return; }
    };
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    match timeout(STEP_TIMEOUT, connector.connect(name, stream)).await {
        Ok(Ok(connection)) => report.push("TLS", "passed", Some(start), format!("Validated with system roots; {:?}.", connection.get_ref().1.protocol_version()), "HEAD uses Kivo's configured certificate trust."),
        result => {
            let detail = match result { Ok(Err(error)) => error.to_string(), _ => "TLS handshake timed out.".into() };
            report.push("TLS", "failed", Some(start), detail, "Check certificate expiry, hostname and issuer trust. HEAD uses Kivo's configured certificate trust.");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn head_reports_application_and_redirect_without_following_or_leaking_url() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                tokio::spawn(async move {
                    let mut bytes = [0; 2048];
                    let count = stream.read(&mut bytes).await.unwrap();
                    if count > 0 {
                        assert!(String::from_utf8_lossy(&bytes[..count]).starts_with("HEAD "));
                        stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: /login?token=private-token\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                    }
                });
            }
        });
        let report = diagnose(&format!("http://{address}/?token=private-input"), &AppSettings::default(), &RequestNetworkOptions::default()).await.unwrap();
        server.abort();
        assert!(report.steps.iter().any(|step| step.stage == "Application" && step.detail.contains("302") && step.duration_ms.is_some()));
        assert!(report.steps.iter().any(|step| step.stage == "Redirect" && step.status == "warning"));
        assert!(!serde_json::to_string(&report).unwrap().contains("private-"));
    }

    #[tokio::test]
    async fn rejects_unresolved_and_non_http_targets() {
        for url in ["file:///secret", "https://example.com/{{missing}}"] {
            assert!(diagnose(url, &AppSettings::default(), &RequestNetworkOptions::default()).await.is_err());
        }
    }

    #[tokio::test]
    async fn closed_port_produces_failed_application_with_timing() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let report = diagnose(&format!("http://{address}"), &AppSettings::default(), &RequestNetworkOptions::default()).await.unwrap();
        assert!(report.steps.iter().any(|step| step.stage == "Application" && step.status == "failed" && step.duration_ms.is_some()));
        assert!(report.steps.iter().any(|step| step.stage == "Redirect" && step.status == "skipped"));
    }

    #[tokio::test]
    async fn direct_tls_probe_reports_invalid_handshake() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = url::Url::parse(&format!("https://{}", listener.local_addr().unwrap())).unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 2048];
            let _ = stream.read(&mut bytes).await;
            let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
        });
        let mut report = DiagnosticReport { target: url.origin().ascii_serialization(), steps: Vec::new() };
        direct_checks(&url, &AppSettings::default(), &RequestNetworkOptions::default(), &mut report).await;
        server.await.unwrap();
        assert!(report.steps.iter().any(|step| step.stage == "DNS" && step.status == "passed"));
        assert!(report.steps.iter().any(|step| step.stage == "TCP" && step.status == "passed"));
        assert!(report.steps.iter().any(|step| step.stage == "TLS" && step.status == "failed" && step.duration_ms.is_some()));
    }
}
