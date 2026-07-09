//! Unit tests for `http::client` helpers.
//!
//! Covers: proxy bypass, URL normalization, env variable resolution,
//! header construction, cookie parsing/matching/serialization.
//!

use std::collections::HashMap;

use chrono::{Duration as ChronoDuration, Utc};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;
use crate::http::models::CookieJarEntry;
use crate::storage::models::AppSettings;

// ---------------------------------------------------------------------------
// proxy bypass logic
// ---------------------------------------------------------------------------

#[test]
fn digest_auth_header_uses_sha256_digest_parts() {
    let header = build_digest_auth_header(
        "user",
        "pass",
        "api",
        "nonce",
        "auth",
        "GET",
        "https://example.com/v1/users?active=true",
    )
    .expect("digest header");

    assert!(header.starts_with("Digest "));
    assert!(header.contains("username=\"user\""));
    assert!(header.contains("realm=\"api\""));
    assert!(header.contains("algorithm=\"SHA-256\""));
    assert!(header.contains("uri=\"/v1/users?active=true\""));
    assert!(header.contains("qop=auth"));
    assert!(header.contains("response=\""));
}

#[test]
fn parse_digest_challenge_reads_quoted_values() {
    let challenge = parse_digest_challenge(
        r#"Digest realm="api", nonce="abc123", qop="auth,auth-int", algorithm=SHA-256"#,
    )
    .expect("digest challenge");

    assert_eq!(challenge.realm, "api");
    assert_eq!(challenge.nonce, "abc123");
    assert_eq!(challenge.qop, "auth,auth-int");
    assert_eq!(challenge.algorithm, "SHA-256");
}

#[test]
fn choose_digest_qop_prefers_auth() {
    assert_eq!(choose_digest_qop("auth-int, auth", "auth"), "auth");
    assert_eq!(choose_digest_qop("", "auth"), "auth");
}

#[test]
fn parse_no_proxy_list_trims_and_lowers() {
    let list = parse_no_proxy_list("  FOO.com , ,bar.io ,,\tbaz.local\n");
    assert_eq!(list, vec!["foo.com", "bar.io", "baz.local"]);
}

#[test]
fn parse_no_proxy_list_empty_yields_empty() {
    assert!(parse_no_proxy_list("").is_empty());
    assert!(parse_no_proxy_list(" , , ").is_empty());
}

#[test]
fn host_bypasses_proxy_wildcard_matches_everything() {
    let list = parse_no_proxy_list("*");
    assert!(host_bypasses_proxy("https://example.com/x", &list));
    assert!(host_bypasses_proxy("http://10.0.0.1:8080", &list));
}

#[test]
fn host_bypasses_proxy_exact_and_subdomain() {
    let list = parse_no_proxy_list("internal.corp, .example.com");
    assert!(host_bypasses_proxy("https://internal.corp/", &list));
    assert!(host_bypasses_proxy("https://API.example.com/", &list));
    assert!(host_bypasses_proxy("https://example.com/", &list));
}

#[test]
fn host_bypasses_proxy_no_match() {
    let list = parse_no_proxy_list("internal.corp, .example.com");
    assert!(!host_bypasses_proxy("https://other.io/", &list));
    assert!(!host_bypasses_proxy("https://notexample.com/", &list));
}

#[test]
fn host_bypasses_proxy_empty_list_returns_false() {
    assert!(!host_bypasses_proxy("https://anything.dev/", &[]));
}

#[test]
fn host_bypasses_proxy_handles_malformed_url() {
    let list = parse_no_proxy_list("foo");
    assert!(!host_bypasses_proxy("not a url", &list));
}

// ---------------------------------------------------------------------------
// URL normalization + variable substitution
// ---------------------------------------------------------------------------

#[test]
fn normalize_url_rejects_empty() {
    assert!(normalize_url("   ").is_err());
}

#[test]
fn normalize_url_prepends_https_when_missing_scheme() {
    let out = normalize_url("example.com/path").unwrap();
    assert!(out.starts_with("https://example.com/"));
}

#[test]
fn normalize_url_preserves_http_and_https() {
    assert!(normalize_url("http://example.com").unwrap().starts_with("http://"));
    assert!(normalize_url("https://example.com").unwrap().starts_with("https://"));
}

#[test]
fn normalize_url_rejects_invalid() {
    let err = normalize_url("http://").unwrap_err();
    assert!(err.contains("Invalid URL"));
}

#[test]
fn resolve_variables_replaces_simple_and_multiple() {
    let mut vars = HashMap::new();
    vars.insert("HOST".to_string(), "api.example.com".to_string());
    vars.insert("TOKEN".to_string(), "abc123".to_string());
    let out = resolve_variables("https://{{HOST}}/x?t={{TOKEN}}", &vars);
    assert_eq!(out, "https://api.example.com/x?t=abc123");
}

#[test]
fn resolve_variables_leaves_unknown_placeholders() {
    let vars = HashMap::new();
    let out = resolve_variables("a/{{MISSING}}/{{$unknown}}", &vars);
    assert_eq!(out, "a/{{MISSING}}/{{$unknown}}");
}

#[test]
fn resolve_variables_supports_dynamic_uuid() {
    let vars = HashMap::new();
    let out = resolve_variables("id={{$uuid}}", &vars);
    let uuid_value = out.trim_start_matches("id=");
    assert!(uuid::Uuid::parse_str(uuid_value).is_ok());
}

#[test]
fn resolve_variables_supports_dynamic_timestamp() {
    let vars = HashMap::new();
    let before = Utc::now().timestamp();
    let out = resolve_variables("t={{$timestamp}}", &vars);
    let after = Utc::now().timestamp();

    let raw = out.trim_start_matches("t=");
    let parsed = raw.parse::<i64>().expect("timestamp should be numeric");
    assert!(parsed >= before && parsed <= after);
}

// ---------------------------------------------------------------------------
// header building
// ---------------------------------------------------------------------------

#[test]
fn build_headers_adds_default_user_agent() {
    let h = HashMap::new();
    let map = build_headers(&h, false).unwrap();
    let ua = map
        .get(reqwest::header::USER_AGENT)
        .expect("user-agent present")
        .to_str()
        .unwrap();
    assert!(ua.starts_with("kivo/"));
}

#[test]
fn build_headers_respects_disable_user_agent() {
    let h = HashMap::new();
    let map = build_headers(&h, true).unwrap();
    assert!(!map.contains_key(reqwest::header::USER_AGENT));
}

#[test]
fn build_headers_preserves_user_supplied_user_agent() {
    let mut h = HashMap::new();
    h.insert("user-agent".to_string(), "my-agent/1".to_string());
    let map = build_headers(&h, false).unwrap();
    let ua = map
        .get(reqwest::header::USER_AGENT)
        .unwrap()
        .to_str()
        .unwrap();
    assert_eq!(ua, "my-agent/1");
}

#[test]
fn build_headers_rejects_invalid_header_name() {
    let mut h = HashMap::new();
    h.insert("bad header".to_string(), "v".to_string());
    let err = build_headers(&h, false).unwrap_err();
    assert!(err.contains("Invalid header name"));
}

#[test]
fn build_headers_rejects_invalid_header_value() {
    let mut h = HashMap::new();
    h.insert("X-Thing".to_string(), "line1\r\nline2".to_string());
    let err = build_headers(&h, false).unwrap_err();
    assert!(err.contains("Invalid header value"));
}

// ---------------------------------------------------------------------------
// cookie id + path + domain + matching
// ---------------------------------------------------------------------------

#[test]
fn build_cookie_id_is_deterministic_and_lowercased() {
    let a = build_cookie_id("Work", "Coll", "Example.COM", "/a", "Sid");
    let b = build_cookie_id("work", "coll", "example.com", "/a", "sid");
    assert_eq!(a, b, "case should not affect id");
    assert_eq!(a, "work|coll|example.com|/a|sid");
    let c = build_cookie_id("ws", "", ".Example.com", "/", "t");
    assert_eq!(c, "ws||example.com|/|t");
}

#[test]
fn default_cookie_path_handles_root_and_subpaths() {
    assert_eq!(default_cookie_path(""), "/");
    assert_eq!(default_cookie_path("/"), "/");
    assert_eq!(default_cookie_path("/api"), "/");
    assert_eq!(default_cookie_path("/api/users"), "/api");
    assert_eq!(default_cookie_path("/a/b/c"), "/a/b");
}

#[test]
fn cookie_domain_matches_host_only() {
    assert!(cookie_domain_matches("example.com", "example.com", true));
    assert!(!cookie_domain_matches("api.example.com", "example.com", true));
}

#[test]
fn cookie_domain_matches_subdomain_when_not_host_only() {
    assert!(cookie_domain_matches("api.example.com", "example.com", false));
    assert!(cookie_domain_matches("a.b.example.com", ".example.com", false));
    assert!(!cookie_domain_matches("example.org", "example.com", false));
}

#[test]
fn cookie_path_matches_prefix_rules() {
    assert!(cookie_path_matches("/api/users", "/api"));
    assert!(cookie_path_matches("/", "/"));
    assert!(cookie_path_matches("", "/"));
    assert!(!cookie_path_matches("/other", "/api"));
}

// ---------------------------------------------------------------------------
// cookie datetime + expiration
// ---------------------------------------------------------------------------

#[test]
fn parse_cookie_datetime_accepts_rfc2822_and_rfc3339() {
    assert!(parse_cookie_datetime("Wed, 21 Oct 2015 07:28:00 GMT").is_some());
    assert!(parse_cookie_datetime("2015-10-21T07:28:00Z").is_some());
    assert!(parse_cookie_datetime("not a date").is_none());
}

#[test]
fn cookie_is_expired_by_expires_at() {
    let past = (Utc::now() - ChronoDuration::hours(1)).to_rfc3339();
    let future = (Utc::now() + ChronoDuration::hours(1)).to_rfc3339();
    let base = sample_cookie("id", "k", "v");

    let mut expired = base.clone();
    expired.expires_at = Some(past);
    assert!(cookie_is_expired(&expired, Utc::now()));

    let mut live = base.clone();
    live.expires_at = Some(future);
    assert!(!cookie_is_expired(&live, Utc::now()));

    let session = base;
    assert!(!cookie_is_expired(&session, Utc::now()));
}

// ---------------------------------------------------------------------------
// parse_set_cookie end-to-end
// ---------------------------------------------------------------------------

fn req_url(s: &str) -> reqwest::Url {
    reqwest::Url::parse(s).unwrap()
}

#[test]
fn parse_set_cookie_minimal_defaults_host_only_and_root_path() {
    let url = req_url("https://api.example.com/users/me");
    let c = parse_set_cookie("sid=abc", &url, "ws", "coll").expect("parsed");
    assert_eq!(c.name, "sid");
    assert_eq!(c.value, "abc");
    assert_eq!(c.domain, "api.example.com");
    assert!(c.host_only);
    assert_eq!(c.path, "/users");
    assert!(!c.secure);
    assert!(!c.http_only);
    assert_eq!(c.workspace_name, "ws");
    assert_eq!(c.collection_name, "coll");
    assert!(c.expires_at.is_none());
}

#[test]
fn parse_set_cookie_respects_domain_path_secure_httponly() {
    let url = req_url("https://api.example.com/x");
    let c = parse_set_cookie(
        "k=v; Domain=.Example.COM; Path=/api; Secure; HttpOnly; SameSite=Lax",
        &url,
        "ws",
        "",
    )
    .expect("parsed");
    assert_eq!(c.domain, "example.com");
    assert_eq!(c.path, "/api");
    assert!(c.secure);
    assert!(c.http_only);
    assert_eq!(c.same_site, "Lax");
    assert!(!c.host_only, "explicit Domain disables host_only");
}

#[test]
fn parse_set_cookie_max_age_overrides_expires() {
    let url = req_url("https://example.com/");
    let now = Utc::now();
    let c = parse_set_cookie("k=v; Max-Age=60", &url, "", "").unwrap();
    let exp = parse_cookie_datetime(c.expires_at.as_deref().unwrap()).unwrap();
    let delta = (exp - now).num_seconds();
    assert!(
        (55..=65).contains(&delta),
        "expires ~60s in future, got {delta}"
    );
}

#[test]
fn parse_set_cookie_max_age_zero_or_negative_is_already_expired() {
    let url = req_url("https://example.com/");
    let c = parse_set_cookie("k=v; Max-Age=0", &url, "", "").unwrap();
    assert!(cookie_is_expired(&c, Utc::now()));

    let c2 = parse_set_cookie("k=v; Max-Age=-10", &url, "", "").unwrap();
    assert!(cookie_is_expired(&c2, Utc::now()));
}

#[test]
fn parse_set_cookie_rejects_blank_name() {
    let url = req_url("https://example.com/");
    assert!(parse_set_cookie("=value", &url, "", "").is_none());
    assert!(parse_set_cookie("   ", &url, "", "").is_none());
    assert!(parse_set_cookie("nothing", &url, "", "").is_none());
}

#[test]
fn parse_set_cookie_id_reflects_effective_domain_path() {
    let url = req_url("https://api.example.com/base/x");
    let c = parse_set_cookie("tok=1; Path=/base", &url, "ws", "coll").unwrap();
    let expected = build_cookie_id("ws", "coll", "api.example.com", "/base", "tok");
    assert_eq!(c.id, expected);
}

// ---------------------------------------------------------------------------
// cookie store (de)serialization roundtrip
// ---------------------------------------------------------------------------

#[test]
fn cookie_jar_entry_json_roundtrip_is_stable() {
    let c = sample_cookie("abc", "sid", "xyz");
    let s = serde_json::to_string(&c).unwrap();
    let back: CookieJarEntry = serde_json::from_str(&s).unwrap();
    assert_eq!(back.id, c.id);
    assert_eq!(back.name, c.name);
    assert_eq!(back.value, c.value);
    assert_eq!(back.domain, c.domain);
    assert_eq!(back.path, c.path);
    assert_eq!(back.host_only, c.host_only);
}

#[test]
fn cookie_jar_entry_camelcase_keys() {
    let c = sample_cookie("abc", "sid", "xyz");
    let s = serde_json::to_string(&c).unwrap();
    assert!(s.contains("\"hostOnly\""));
    assert!(s.contains("\"httpOnly\""));
    assert!(s.contains("\"sameSite\""));
    assert!(s.contains("\"workspaceName\""));
}

// ---------------------------------------------------------------------------
// redirect behavior
// ---------------------------------------------------------------------------

async fn spawn_redirect_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().expect("local addr").port();

    tokio::spawn(async move {
        loop {
            let (mut socket, _) = match listener.accept().await {
                Ok(pair) => pair,
                Err(_) => return,
            };

            tokio::spawn(async move {
                let mut buf = vec![0_u8; 4096];
                let n = match socket.read(&mut buf).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => n,
                };
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");

                let response = if path == "/start" {
                    "HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
                } else {
                    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".to_string()
                };

                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });

    port
}

#[tokio::test]
async fn build_http_client_does_not_follow_redirects_when_disabled() {
    let port = spawn_redirect_server().await;
    let settings = AppSettings::default();
    let client = build_http_client(
        &settings,
        &format!("http://127.0.0.1:{port}/start"),
        2_000,
        false,
        5,
        true,
        None,
    )
    .expect("client");

    let response = client
        .get(format!("http://127.0.0.1:{port}/start"))
        .send()
        .await
        .expect("request");

    assert_eq!(response.status().as_u16(), 302);
}

#[tokio::test]
async fn build_http_client_follows_redirects_when_enabled() {
    let port = spawn_redirect_server().await;
    let settings = AppSettings::default();
    let client = build_http_client(
        &settings,
        &format!("http://127.0.0.1:{port}/start"),
        2_000,
        true,
        5,
        true,
        None,
    )
    .expect("client");

    let response = client
        .get(format!("http://127.0.0.1:{port}/start"))
        .send()
        .await
        .expect("request");
    let status = response.status().as_u16();
    let body = response.text().await.expect("body");

    assert_eq!(status, 200);
    assert_eq!(body, "ok");
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

fn sample_cookie(id: &str, name: &str, value: &str) -> CookieJarEntry {
    let now = Utc::now().to_rfc3339();
    CookieJarEntry {
        id: id.to_string(),
        name: name.to_string(),
        value: value.to_string(),
        domain: "example.com".to_string(),
        path: "/".to_string(),
        expires_at: None,
        secure: false,
        http_only: false,
        same_site: String::new(),
        host_only: true,
        workspace_name: "ws".to_string(),
        collection_name: "coll".to_string(),
        created_at: now.clone(),
        last_accessed_at: now,
    }
}
