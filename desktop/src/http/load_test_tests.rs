//! Unit + integration tests for `http::load_test`.
//!
//! Unit tests cover statistics helpers, request byte serialization, work
//! distribution, and method-body-length rules. The integration test spins up
//! a tiny in-process HTTP/1.1 server on a loopback port, drives a short
//! `run_load_test` against it, and asserts the aggregated result shape.

use std::collections::HashMap;

use super::*;

// ---------------------------------------------------------------------------
// Pure statistics helpers
// ---------------------------------------------------------------------------

#[test]
fn percentile_empty_returns_zero() {
    assert_eq!(percentile(&[], 50.0), 0);
    assert_eq!(percentile(&[], 99.0), 0);
}

#[test]
fn percentile_single_value_is_that_value() {
    assert_eq!(percentile(&[42], 50.0), 42);
    assert_eq!(percentile(&[42], 99.9), 42);
}

#[test]
fn percentile_ten_sorted_values_matches_rank_rounding() {
    // values 10..=100, step 10. Sorted.
    let sorted: Vec<u64> = (1..=10).map(|n| n * 10).collect();
    // p50 -> ceil(0.5 * 10) = 5 -> index 4 -> 50
    assert_eq!(percentile(&sorted, 50.0), 50);
    // p95 -> ceil(0.95 * 10) = 10 -> index 9 -> 100
    assert_eq!(percentile(&sorted, 95.0), 100);
    // p99 -> ceil(0.99 * 10) = 10 -> index 9 -> 100
    assert_eq!(percentile(&sorted, 99.0), 100);
}

#[test]
fn us_to_ms_rounds_half_up() {
    assert_eq!(us_to_ms(0), 0);
    assert_eq!(us_to_ms(499), 0);
    assert_eq!(us_to_ms(500), 1);
    assert_eq!(us_to_ms(1_499), 1);
    assert_eq!(us_to_ms(1_500), 2);
    assert_eq!(us_to_ms(1_999_500), 2_000);
}

#[test]
fn round1_keeps_one_decimal_and_handles_non_finite() {
    assert_eq!(round1(1.04), 1.0);
    assert_eq!(round1(1.05), 1.1);
    assert_eq!(round1(1.2345), 1.2);
    assert_eq!(round1(f64::NAN), 0.0);
    assert_eq!(round1(f64::INFINITY), 0.0);
    assert_eq!(round1(f64::NEG_INFINITY), 0.0);
}

// ---------------------------------------------------------------------------
// Method / framing rules
// ---------------------------------------------------------------------------

#[test]
fn method_requires_length_only_for_mutating_verbs() {
    for m in ["QUERY", "POST", "PUT", "PATCH", "DELETE"] {
        assert!(method_requires_length(m), "{m} should require length");
    }
    for m in ["GET", "HEAD", "OPTIONS", "TRACE", ""] {
        assert!(!method_requires_length(m), "{m} should not require length");
    }
}

#[test]
fn find_subslice_returns_first_match_or_none() {
    assert_eq!(find_subslice(b"aabbccbb", b"bb"), Some(2));
    assert_eq!(find_subslice(b"abc", b"xyz"), None);
    assert_eq!(find_subslice(b"", b"x"), None);
}

// ---------------------------------------------------------------------------
// Work distribution
// ---------------------------------------------------------------------------

#[test]
fn distribute_spreads_evenly_with_remainder() {
    assert_eq!(distribute(10, 4), vec![3, 3, 2, 2]);
    assert_eq!(distribute(8, 4), vec![2, 2, 2, 2]);
    assert_eq!(distribute(5, 2), vec![3, 2]);
}

#[test]
fn distribute_filters_zero_chunks() {
    // 3 users across 5 threads -> the empty slots are dropped.
    let v = distribute(3, 5);
    assert_eq!(v.iter().sum::<usize>(), 3);
    assert!(v.iter().all(|n| *n > 0));
    assert!(v.len() <= 3);
}

#[test]
fn distribute_zero_total_yields_empty() {
    assert!(distribute(0, 4).is_empty());
}

// ---------------------------------------------------------------------------
// Wire-format request builder
// ---------------------------------------------------------------------------

fn parse_wire_request(bytes: &[u8]) -> (String, Vec<(String, String)>, Vec<u8>) {
    let sep = find_subslice(bytes, b"\r\n\r\n").expect("header/body separator");
    let head = std::str::from_utf8(&bytes[..sep]).unwrap();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap().to_string();
    let headers: Vec<(String, String)> = lines
        .map(|l| {
            let (k, v) = l.split_once(':').unwrap_or((l, ""));
            (k.trim().to_ascii_lowercase(), v.trim().to_string())
        })
        .collect();
    let body = bytes[sep + 4..].to_vec();
    (request_line, headers, body)
}

fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

#[test]
fn build_request_bytes_get_adds_defaults_without_content_length() {
    let headers = HashMap::new();
    let bytes = build_request_bytes("GET", "/a?x=1", "example.com:8080", &headers, &[], true);
    let (req_line, hdrs, body) = parse_wire_request(&bytes);
    assert_eq!(req_line, "GET /a?x=1 HTTP/1.1");
    assert!(body.is_empty());

    assert_eq!(header_value(&hdrs, "Host"), Some("example.com:8080"));
    assert_eq!(header_value(&hdrs, "Accept"), Some("*/*"));
    assert_eq!(header_value(&hdrs, "Connection"), Some("keep-alive"));
    let ua = header_value(&hdrs, "User-Agent").expect("user-agent");
    assert!(ua.starts_with("kivo/"));
    assert!(header_value(&hdrs, "Content-Length").is_none());
}

#[test]
fn build_request_bytes_post_inserts_content_length_and_body() {
    let headers = HashMap::new();
    let body = b"hello=world";
    let bytes = build_request_bytes("POST", "/submit", "example.com", &headers, body, false);
    let (req_line, hdrs, out_body) = parse_wire_request(&bytes);

    assert_eq!(req_line, "POST /submit HTTP/1.1");
    assert_eq!(header_value(&hdrs, "Content-Length"), Some("11"));
    assert_eq!(header_value(&hdrs, "Connection"), Some("close"));
    assert_eq!(out_body, body);
}

#[test]
fn build_request_bytes_empty_body_on_mutating_verb_sets_zero_length() {
    let headers = HashMap::new();
    let bytes = build_request_bytes("DELETE", "/x", "example.com", &headers, &[], true);
    let (_, hdrs, _) = parse_wire_request(&bytes);
    assert_eq!(header_value(&hdrs, "Content-Length"), Some("0"));
}

#[test]
fn build_request_bytes_respects_user_supplied_headers() {
    let mut headers = HashMap::new();
    headers.insert("Host".to_string(), "override.example".to_string());
    headers.insert("User-Agent".to_string(), "custom-agent/1".to_string());
    headers.insert("Accept".to_string(), "application/json".to_string());
    headers.insert("Connection".to_string(), "close".to_string());

    let bytes = build_request_bytes("GET", "/", "ignored:80", &headers, &[], true);
    let (_, hdrs, _) = parse_wire_request(&bytes);
    assert_eq!(header_value(&hdrs, "Host"), Some("override.example"));
    assert_eq!(header_value(&hdrs, "User-Agent"), Some("custom-agent/1"));
    assert_eq!(header_value(&hdrs, "Accept"), Some("application/json"));
    assert_eq!(header_value(&hdrs, "Connection"), Some("close"));

    let host_count = hdrs.iter().filter(|(k, _)| k == "host").count();
    let ua_count = hdrs.iter().filter(|(k, _)| k == "user-agent").count();
    assert_eq!(host_count, 1);
    assert_eq!(ua_count, 1);
}

#[test]
fn build_request_bytes_user_content_length_not_overridden() {
    let mut headers = HashMap::new();
    headers.insert("Transfer-Encoding".to_string(), "chunked".to_string());
    let bytes = build_request_bytes("POST", "/", "x", &headers, b"payload", true);
    let (_, hdrs, body) = parse_wire_request(&bytes);

    assert!(header_value(&hdrs, "Content-Length").is_none());
    assert_eq!(header_value(&hdrs, "Transfer-Encoding"), Some("chunked"));
    assert_eq!(body, b"payload");
}

// ---------------------------------------------------------------------------
// cancel_load_test behaviour on unknown id
// ---------------------------------------------------------------------------

#[tokio::test]
async fn cancel_load_test_returns_false_for_unknown_id() {
    let ok = cancel_load_test("does-not-exist-xyz".to_string()).await;
    assert!(!ok);
}

// ---------------------------------------------------------------------------
// Integration: run_load_test against a local HTTP/1.1 loopback server
// ---------------------------------------------------------------------------

/// Spawn a lightweight HTTP/1.1 server that answers every request with a
/// fixed 200 OK "OK" body and supports keep-alive + pipelining (it reads
/// one set of headers at a time and writes one response back).
async fn spawn_mini_http_server() -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        loop {
            let (mut socket, _) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => return,
            };
            tokio::spawn(async move {
                let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
                let mut tmp = [0u8; 4096];
                loop {
                    while let Some(idx) = find_boundary(&buf) {
                        let _ = buf.drain(..idx + 4);
                        let resp = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\nContent-Type: text/plain\r\n\r\nOK";
                        if socket.write_all(resp.as_bytes()).await.is_err() {
                            return;
                        }
                    }

                    let n = match socket.read(&mut tmp).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => n,
                    };
                    buf.extend_from_slice(&tmp[..n]);
                    if buf.len() > 64 * 1024 {
                        return;
                    }
                }
            });
        }
    });

    port
}

fn find_boundary(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn run_load_test_against_local_http_server_produces_results() {
    let port = spawn_mini_http_server().await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    let payload = LoadTestPayload {
        url: format!("http://127.0.0.1:{port}/"),
        method: "GET".to_string(),
        test_id: "unit-test-run".to_string(),
        headers: HashMap::new(),
        body: None,
        virtual_users: 2,
        duration_secs: 1,
        ramp_up_secs: Some(0),
        timeout_ms: Some(2_000),
        pipeline_depth: Some(2),
        insecure: Some(false),
    };

    let result = run_load_test(payload).await.expect("load test ran");

    assert!(
        result.total_requests > 0,
        "expected at least one request, got {result:?}",
    );
    assert_eq!(
        result.total_requests,
        result.successful + result.failed,
        "totals must split into successful + failed",
    );
    assert!(
        result.status_codes.get("200").copied().unwrap_or(0) > 0,
        "no 200 responses recorded: {:?}",
        result.status_codes,
    );
    assert!(!result.was_cancelled);
    assert!(result.duration_ms >= 1_000);
    if result.successful > 0 {
        assert!(result.latency_histogram.p50 <= result.latency_histogram.p99);
        assert!(result.min_latency_ms <= result.max_latency_ms);
    }
    assert!(!result.timeline.is_empty());
}

#[tokio::test]
async fn run_load_test_rejects_invalid_inputs() {
    let res = run_load_test(LoadTestPayload {
        url: "   ".to_string(),
        method: "GET".to_string(),
        test_id: String::new(),
        headers: HashMap::new(),
        body: None,
        virtual_users: 1,
        duration_secs: 1,
        ramp_up_secs: None,
        timeout_ms: None,
        pipeline_depth: None,
        insecure: None,
    })
    .await;
    assert!(res.is_err());

    let res = run_load_test(LoadTestPayload {
        url: "ftp://example.com/".to_string(),
        method: "GET".to_string(),
        test_id: String::new(),
        headers: HashMap::new(),
        body: None,
        virtual_users: 1,
        duration_secs: 1,
        ramp_up_secs: None,
        timeout_ms: None,
        pipeline_depth: None,
        insecure: None,
    })
    .await;
    assert!(res.is_err());

    let res = run_load_test(LoadTestPayload {
        url: "http://".to_string(),
        method: "GET".to_string(),
        test_id: String::new(),
        headers: HashMap::new(),
        body: None,
        virtual_users: 1,
        duration_secs: 1,
        ramp_up_secs: None,
        timeout_ms: None,
        pipeline_depth: None,
        insecure: None,
    })
    .await;
    assert!(res.is_err());
}
