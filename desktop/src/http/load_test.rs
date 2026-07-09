// kivo in-process HTTP load generator.
//
//
//   - DNS resolved once at test start; workers reuse a `SocketAddr`.
//   - The HTTP/1.1 wire bytes are pre-serialized once into `Bytes` and
//     shared by reference - zero formatting per request.
//   - Each physical CPU gets its own OS thread running a dedicated
//     `tokio::runtime::Builder::new_current_thread()` + `LocalSet`.
//     No work-stealing, no cross-core synchronization on the hot path,
//     no contention with Tauri's IPC runtime.
//   - Connections are distributed across those threads. Each connection
//     runs two `spawn_local` tasks - writer and reader - communicating
//     through a bounded `mpsc` channel that enforces pipeline depth.
//   - Responses are parsed with `httparse` (picohttpparser port) + a
//     hand-rolled chunked-transfer decoder. No `HeaderMap` allocated,
//     no response body copied - just counted.
//   - Results are accumulated in per-task `ResultData` and merged at
//     the end. Only the per-second timeline buckets use atomics, and
//     those are touched once per completed request.
//
// Supports HTTP/1.1 over plain TCP and TLS (rustls + native cert store,
// with `--insecure` mode for self-signed). HTTP/2 and HTTP/3 are not
// implemented yet.

use std::collections::{BTreeMap, HashMap};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use bytes::{BufMut, Bytes, BytesMut};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio::task::LocalSet;
use tokio_util::sync::CancellationToken;
use url::Url;

const DEFAULT_USER_AGENT: &str = concat!("kivo/", env!("CARGO_PKG_VERSION"));
const READ_CHUNK: usize = 16 * 1024;
const MAX_HEADERS: usize = 64;
const MAX_ERRORS_TOTAL: usize = 64;

#[cfg(test)]
#[path = "load_test_tests.rs"]
mod tests;

// ========================================================================
// Cancellation registry (test_id -> watch sender).
// ========================================================================

static CANCEL_REGISTRY: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();

fn cancel_registry() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    CANCEL_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

struct CancelGuard {
    test_id: String,
}
impl CancelGuard {
    fn new(id: String, tx: watch::Sender<bool>) -> Self {
        cancel_registry().lock().unwrap().insert(id.clone(), tx);
        Self { test_id: id }
    }
}
impl Drop for CancelGuard {
    fn drop(&mut self) {
        cancel_registry().lock().unwrap().remove(&self.test_id);
    }
}

#[tauri::command]
pub async fn cancel_load_test(test_id: String) -> bool {
    if let Some(tx) = cancel_registry().lock().unwrap().get(&test_id) {
        let _ = tx.send(true);
        true
    } else {
        false
    }
}

// ========================================================================
// Frontend DTOs (shape preserved so LoadTestPane.jsx is unchanged).
// ========================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadTestPayload {
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub test_id: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    pub virtual_users: u32,
    pub duration_secs: u32,
    #[serde(default)]
    pub ramp_up_secs: Option<u32>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub pipeline_depth: Option<u32>,
    #[serde(default)]
    pub insecure: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LatencyHistogram {
    pub p50: u64,
    pub p75: u64,
    pub p90: u64,
    pub p95: u64,
    pub p99: u64,
    pub p999: u64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TimelineBucket {
    pub second: u64,
    pub requests: u64,
    pub errors: u64,
    pub avg_latency_ms: f64,
    pub rps: f64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoadTestResult {
    pub total_requests: u64,
    pub successful: u64,
    pub failed: u64,
    pub avg_latency_ms: f64,
    pub min_latency_ms: u64,
    pub max_latency_ms: u64,
    pub latency_histogram: LatencyHistogram,
    pub requests_per_sec: f64,
    pub peak_rps: f64,
    pub error_rate: f64,
    pub status_codes: HashMap<String, u64>,
    pub bytes_received: u64,
    pub duration_ms: u64,
    pub timeline: Vec<TimelineBucket>,
    pub errors: Vec<String>,
    pub connection_errors: u64,
    pub timeout_errors: u64,
    pub was_cancelled: bool,
}

// ========================================================================
// Internal error + outcome.
// ========================================================================

#[derive(Debug)]
enum LtError {
    Timeout,
    Eof,
    Connect(String),
    Tls(String),
    Io(String),
    Parse(String),
}
impl LtError {
    fn display(&self) -> String {
        match self {
            LtError::Timeout => "[timeout]".into(),
            LtError::Eof => "[io] connection closed".into(),
            LtError::Connect(m) => format!("[connect] {m}"),
            LtError::Tls(m) => format!("[tls] {m}"),
            LtError::Io(m) => format!("[io] {m}"),
            LtError::Parse(m) => format!("[parse] {m}"),
        }
    }
}

#[derive(Default)]
struct ResultData {
    latencies_us: Vec<u64>, // microseconds for precision on fast endpoints
    status_codes: HashMap<u16, u64>,
    errors: Vec<String>,
    success: u64,
    fail: u64,
    bytes: u64,
    timeouts: u64,
    connects: u64,
}

// ========================================================================
// TLS config (loaded once, reused across tests).
// ========================================================================

static TLS_SECURE: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
static TLS_INSECURE: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();

fn provider() -> rustls::crypto::CryptoProvider {
    rustls::crypto::ring::default_provider()
}

fn tls_secure() -> Arc<rustls::ClientConfig> {
    TLS_SECURE
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            let loaded = rustls_native_certs::load_native_certs();
            for cert in loaded.certs {
                let _ = roots.add(cert);
            }
            let cfg = rustls::ClientConfig::builder_with_provider(provider().into())
                .with_safe_default_protocol_versions()
                .expect("tls defaults")
                .with_root_certificates(roots)
                .with_no_client_auth();
            Arc::new(cfg)
        })
        .clone()
}

fn tls_insecure() -> Arc<rustls::ClientConfig> {
    TLS_INSECURE
        .get_or_init(|| {
            #[derive(Debug)]
            struct AllowAny;
            impl rustls::client::danger::ServerCertVerifier for AllowAny {
                fn verify_server_cert(
                    &self,
                    _e: &rustls::pki_types::CertificateDer<'_>,
                    _i: &[rustls::pki_types::CertificateDer<'_>],
                    _n: &rustls::pki_types::ServerName<'_>,
                    _o: &[u8],
                    _t: rustls::pki_types::UnixTime,
                ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
                    Ok(rustls::client::danger::ServerCertVerified::assertion())
                }
                fn verify_tls12_signature(
                    &self,
                    _m: &[u8],
                    _c: &rustls::pki_types::CertificateDer<'_>,
                    _d: &rustls::DigitallySignedStruct,
                ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
                    Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
                }
                fn verify_tls13_signature(
                    &self,
                    _m: &[u8],
                    _c: &rustls::pki_types::CertificateDer<'_>,
                    _d: &rustls::DigitallySignedStruct,
                ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
                    Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
                }
                fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
                    provider().signature_verification_algorithms.supported_schemes()
                }
            }
            let cfg = rustls::ClientConfig::builder_with_provider(provider().into())
                .with_safe_default_protocol_versions()
                .expect("tls defaults")
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(AllowAny))
                .with_no_client_auth();
            Arc::new(cfg)
        })
        .clone()
}

// ========================================================================
// Shared per-test config.
// ========================================================================

struct TestCtx {
    #[allow(dead_code)]
    host: String,
    #[allow(dead_code)]
    port: u16,
    https: bool,
    addr: SocketAddr,
    server_name: rustls::pki_types::ServerName<'static>,
    tls_config: Option<Arc<rustls::ClientConfig>>,
    request_bytes: Bytes,
    timeout: Duration,
    connect_timeout: Duration,
    pipeline_depth: usize,
    buckets: Arc<Vec<BucketStats>>,
    bucket_count: usize,
    test_start: Instant,
}

struct BucketStats {
    requests: AtomicU64,
    errors: AtomicU64,
    latency_sum_us: AtomicU64,
}
impl BucketStats {
    fn new() -> Self {
        Self {
            requests: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            latency_sum_us: AtomicU64::new(0),
        }
    }
}

fn bucket_idx(ctx: &TestCtx) -> usize {
    (ctx.test_start.elapsed().as_secs() as usize).min(ctx.bucket_count - 1)
}

// ========================================================================
// Pre-build HTTP/1.1 request wire bytes.
// ========================================================================

fn build_request_bytes(
    method: &str,
    path_and_query: &str,
    host_header: &str,
    user_headers: &HashMap<String, String>,
    body: &[u8],
    keep_alive: bool,
) -> Bytes {
    let approx = 128 + host_header.len()
        + user_headers.iter().map(|(k, v)| k.len() + v.len() + 4).sum::<usize>()
        + body.len();
    let mut buf = BytesMut::with_capacity(approx);
    // Request line.
    buf.put_slice(method.as_bytes());
    buf.put_u8(b' ');
    buf.put_slice(path_and_query.as_bytes());
    buf.put_slice(b" HTTP/1.1\r\n");
    // Track which core headers the user already set.
    let mut has_host = false;
    let mut has_ua = false;
    let mut has_accept = false;
    let mut has_conn = false;
    let mut has_cl = false;
    let mut has_te = false;
    for (k, v) in user_headers {
        let lk = k.trim();
        if lk.is_empty() {
            continue;
        }
        let lower = lk.to_ascii_lowercase();
        match lower.as_str() {
            "host" => has_host = true,
            "user-agent" => has_ua = true,
            "accept" => has_accept = true,
            "connection" => has_conn = true,
            "content-length" => has_cl = true,
            "transfer-encoding" => has_te = true,
            _ => {}
        }
        buf.put_slice(lk.as_bytes());
        buf.put_slice(b": ");
        buf.put_slice(v.as_bytes());
        buf.put_slice(b"\r\n");
    }
    if !has_host {
        buf.put_slice(b"Host: ");
        buf.put_slice(host_header.as_bytes());
        buf.put_slice(b"\r\n");
    }
    if !has_ua {
        buf.put_slice(b"User-Agent: ");
        buf.put_slice(DEFAULT_USER_AGENT.as_bytes());
        buf.put_slice(b"\r\n");
    }
    if !has_accept {
        buf.put_slice(b"Accept: */*\r\n");
    }
    if !has_conn {
        if keep_alive {
            buf.put_slice(b"Connection: keep-alive\r\n");
        } else {
            buf.put_slice(b"Connection: close\r\n");
        }
    }
    if !body.is_empty() && !has_cl && !has_te {
        let mut cl_buf = itoa_u64(body.len() as u64);
        buf.put_slice(b"Content-Length: ");
        buf.put_slice(cl_buf.as_bytes());
        cl_buf.clear();
        buf.put_slice(b"\r\n");
    } else if body.is_empty() && !has_cl && !has_te && method_requires_length(method) {
        buf.put_slice(b"Content-Length: 0\r\n");
    }
    buf.put_slice(b"\r\n");
    buf.put_slice(body);
    buf.freeze()
}

fn method_requires_length(m: &str) -> bool {
    matches!(m, "QUERY" | "POST" | "PUT" | "PATCH" | "DELETE")
}

fn itoa_u64(n: u64) -> String {
    n.to_string()
}

// ========================================================================
// Response parser: httparse + chunked decoder + CL + close-framed.
// ========================================================================

struct ParsedResp {
    status: u16,
    body_len: u64,
    keep_alive: bool,
}

async fn read_more<R>(r: &mut R, buf: &mut Vec<u8>, deadline: Instant) -> Result<(), LtError>
where
    R: AsyncRead + Unpin,
{
    let now = Instant::now();
    if now >= deadline {
        return Err(LtError::Timeout);
    }
    let remaining = deadline - now;
    let len_before = buf.len();
    buf.resize(len_before + READ_CHUNK, 0);
    let n = match tokio::time::timeout(remaining, r.read(&mut buf[len_before..])).await {
        Ok(Ok(n)) => n,
        Ok(Err(e)) => {
            buf.truncate(len_before);
            return Err(LtError::Io(e.to_string()));
        }
        Err(_) => {
            buf.truncate(len_before);
            return Err(LtError::Timeout);
        }
    };
    buf.truncate(len_before + n);
    if n == 0 {
        return Err(LtError::Eof);
    }
    Ok(())
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

async fn read_response<R>(
    r: &mut R,
    buf: &mut Vec<u8>,
    timeout: Duration,
) -> Result<ParsedResp, LtError>
where
    R: AsyncRead + Unpin,
{
    let deadline = Instant::now() + timeout;

    // 1. Fill until we have complete headers.
    let (headers_end, status, content_length, chunked, keep_alive) = loop {
        let mut hdrs = [httparse::EMPTY_HEADER; MAX_HEADERS];
        let mut resp = httparse::Response::new(&mut hdrs);
        match resp.parse(buf) {
            Ok(httparse::Status::Complete(n)) => {
                let status = resp.code.unwrap_or(0);
                let mut cl: Option<u64> = None;
                let mut chunked = false;
                let mut keep_alive = true; // HTTP/1.1 default
                for h in resp.headers.iter() {
                    if h.name.eq_ignore_ascii_case("content-length") {
                        if let Ok(s) = std::str::from_utf8(h.value) {
                            cl = s.trim().parse().ok();
                        }
                    } else if h.name.eq_ignore_ascii_case("transfer-encoding") {
                        let v = std::str::from_utf8(h.value).unwrap_or("");
                        if v.split(',').any(|t| t.trim().eq_ignore_ascii_case("chunked")) {
                            chunked = true;
                        }
                    } else if h.name.eq_ignore_ascii_case("connection") {
                        let v = std::str::from_utf8(h.value).unwrap_or("");
                        if v.split(',').any(|t| t.trim().eq_ignore_ascii_case("close")) {
                            keep_alive = false;
                        }
                    }
                }
                break (n, status, cl, chunked, keep_alive);
            }
            Ok(httparse::Status::Partial) => {
                read_more(r, buf, deadline).await?;
            }
            Err(e) => return Err(LtError::Parse(e.to_string())),
        }
    };

    // Drop consumed header bytes.
    buf.drain(..headers_end);

    // 2. Decode body.
    let body_len: u64 = if let Some(cl) = content_length {
        drain_known_length(r, buf, cl, deadline).await?;
        cl
    } else if chunked {
        drain_chunked(r, buf, deadline).await?
    } else if !keep_alive {
        drain_until_eof(r, buf, deadline).await?
    } else {
        0
    };

    Ok(ParsedResp { status, body_len, keep_alive })
}

async fn drain_known_length<R>(
    r: &mut R,
    buf: &mut Vec<u8>,
    len: u64,
    deadline: Instant,
) -> Result<(), LtError>
where
    R: AsyncRead + Unpin,
{
    // Consume from buf first.
    let take = (len as usize).min(buf.len());
    buf.drain(..take);
    let mut remaining = len - take as u64;
    while remaining > 0 {
        read_more(r, buf, deadline).await?;
        let take = (remaining as usize).min(buf.len());
        buf.drain(..take);
        remaining -= take as u64;
    }
    Ok(())
}

async fn drain_chunked<R>(
    r: &mut R,
    buf: &mut Vec<u8>,
    deadline: Instant,
) -> Result<u64, LtError>
where
    R: AsyncRead + Unpin,
{
    let mut total: u64 = 0;
    loop {
        // Read chunk-size line.
        let line_end = loop {
            if let Some(p) = find_subslice(buf, b"\r\n") {
                break p;
            }
            read_more(r, buf, deadline).await?;
        };
        let line = std::str::from_utf8(&buf[..line_end])
            .map_err(|_| LtError::Parse("bad chunk size".into()))?;
        let hex = line.split(';').next().unwrap_or("").trim();
        let size = u64::from_str_radix(hex, 16)
            .map_err(|_| LtError::Parse("bad chunk hex".into()))?;
        buf.drain(..line_end + 2);

        if size == 0 {
            // Read trailer terminator (\r\n or headers + \r\n\r\n).
            loop {
                if buf.len() >= 2 && &buf[..2] == b"\r\n" {
                    buf.drain(..2);
                    return Ok(total);
                }
                if let Some(p) = find_subslice(buf, b"\r\n\r\n") {
                    buf.drain(..p + 4);
                    return Ok(total);
                }
                read_more(r, buf, deadline).await?;
            }
        }

        let need = size + 2; // +2 for trailing \r\n
        while (buf.len() as u64) < need {
            read_more(r, buf, deadline).await?;
        }
        buf.drain(..need as usize);
        total += size;
    }
}

async fn drain_until_eof<R>(
    r: &mut R,
    buf: &mut Vec<u8>,
    deadline: Instant,
) -> Result<u64, LtError>
where
    R: AsyncRead + Unpin,
{
    let mut total = buf.len() as u64;
    buf.clear();
    loop {
        match read_more(r, buf, deadline).await {
            Ok(()) => {
                total += buf.len() as u64;
                buf.clear();
            }
            Err(LtError::Eof) => return Ok(total),
            Err(e) => return Err(e),
        }
    }
}

// ========================================================================
// Connection establishment (TCP or TLS), split into read/write halves.
// ========================================================================

type BoxRead = Box<dyn AsyncRead + Unpin>;
type BoxWrite = Box<dyn AsyncWrite + Unpin>;

async fn connect(ctx: &TestCtx) -> Result<(BoxRead, BoxWrite), LtError> {
    let tcp = tokio::time::timeout(ctx.connect_timeout, TcpStream::connect(ctx.addr))
        .await
        .map_err(|_| LtError::Timeout)?
        .map_err(|e| LtError::Connect(e.to_string()))?;
    let _ = tcp.set_nodelay(true);

    if ctx.https {
        let connector = tokio_rustls::TlsConnector::from(
            ctx.tls_config
                .as_ref()
                .expect("tls_config set for https")
                .clone(),
        );
        let tls = tokio::time::timeout(
            ctx.connect_timeout,
            connector.connect(ctx.server_name.clone(), tcp),
        )
        .await
        .map_err(|_| LtError::Timeout)?
        .map_err(|e| LtError::Tls(e.to_string()))?;
        let (r, w) = tokio::io::split(tls);
        Ok((Box::new(r), Box::new(w)))
    } else {
        let (r, w) = tcp.into_split();
        Ok((Box::new(r), Box::new(w)))
    }
}

// ========================================================================
// Per-connection worker: pipelined writer + reader.
// ========================================================================

async fn run_connection(
    ctx: Arc<TestCtx>,
    data: &mut ResultData,
    is_end: Arc<AtomicBool>,
    cancel: CancellationToken,
) {
    while !is_end.load(Ordering::Relaxed) && !cancel.is_cancelled() {
        let (mut reader, mut writer) = match connect(&ctx).await {
            Ok(s) => s,
            Err(e) => {
                data.fail += 1;
                data.connects += 1;
                ctx.buckets[bucket_idx(&ctx)].requests.fetch_add(1, Ordering::Relaxed);
                ctx.buckets[bucket_idx(&ctx)].errors.fetch_add(1, Ordering::Relaxed);
                if data.errors.len() < 8 {
                    data.errors.push(e.display());
                }
                let sleep = tokio::time::sleep(Duration::from_millis(20));
                tokio::select! {
                    _ = sleep => {}
                    _ = cancel.cancelled() => return,
                }
                continue;
            }
        };

        // Pipeline queue: writer sends a timestamp each time a request hits
        // the wire; reader pulls timestamps in FIFO order as responses come
        // back. The channel capacity *is* the pipeline depth.
        let (tx, mut rx) = mpsc::channel::<Instant>(ctx.pipeline_depth);

        let ctx_w = ctx.clone();
        let is_end_w = is_end.clone();
        let cancel_w = cancel.clone();
        // Writer is a local Future; no spawn_local needed because we drive
        // both halves via select! below.
        let writer_fut = async move {
            loop {
                if is_end_w.load(Ordering::Relaxed) || cancel_w.is_cancelled() {
                    break;
                }
                let start = Instant::now();
                if tx.send(start).await.is_err() {
                    break;
                }
                if let Err(e) = writer.write_all(&ctx_w.request_bytes).await {
                    return Err(LtError::Io(e.to_string()));
                }
            }
            Ok::<_, LtError>(())
        };

        // Reader: pull timestamps, decode responses, record.
        let ctx_r = ctx.clone();
        let reader_fut = async {
            let mut rbuf: Vec<u8> = Vec::with_capacity(READ_CHUNK);
            loop {
                let start = match rx.recv().await {
                    Some(s) => s,
                    None => return Ok::<_, LtError>(()),
                };
                match read_response(&mut reader, &mut rbuf, ctx_r.timeout).await {
                    Ok(resp) => {
                        let latency_us = start.elapsed().as_micros() as u64;
                        let idx = bucket_idx(&ctx_r);
                        let b = &ctx_r.buckets[idx];
                        b.requests.fetch_add(1, Ordering::Relaxed);
                        b.latency_sum_us
                            .fetch_add(latency_us, Ordering::Relaxed);
                        data.latencies_us.push(latency_us);
                        *data.status_codes.entry(resp.status).or_insert(0) += 1;
                        let is_ok = (200..400).contains(&resp.status);
                        if is_ok {
                            data.success += 1;
                        } else {
                            data.fail += 1;
                            b.errors.fetch_add(1, Ordering::Relaxed);
                        }
                        data.bytes += resp.body_len;
                        if !resp.keep_alive {
                            return Ok(());
                        }
                    }
                    Err(e) => {
                        let idx = bucket_idx(&ctx_r);
                        let b = &ctx_r.buckets[idx];
                        b.requests.fetch_add(1, Ordering::Relaxed);
                        b.errors.fetch_add(1, Ordering::Relaxed);
                        data.fail += 1;
                        match e {
                            LtError::Timeout => data.timeouts += 1,
                            LtError::Connect(_) | LtError::Io(_) | LtError::Eof => {
                                data.connects += 1
                            }
                            _ => {}
                        }
                        if data.errors.len() < 8 {
                            data.errors.push(e.display());
                        }
                        return Err(e);
                    }
                }
            }
        };

        tokio::select! {
            w = writer_fut => { let _ = w; }
            r = reader_fut => { let _ = r; }
            _ = cancel.cancelled() => { return; }
        }
    }
}

// ========================================================================
// Scheduler: per-CPU OS threads with current-thread runtimes + LocalSet.
// ========================================================================

fn distribute(total: usize, threads: usize) -> Vec<usize> {
    (0..threads)
        .map(|i| total / threads + if total % threads > i { 1 } else { 0 })
        .filter(|n| *n > 0)
        .collect()
}

fn spawn_worker_thread(
    ctx: Arc<TestCtx>,
    num_conn: usize,
    is_end: Arc<AtomicBool>,
    cancel: CancellationToken,
    ramp_step_ms: u64,
    thread_idx: usize,
) -> std::thread::JoinHandle<Vec<ResultData>> {
    std::thread::spawn(move || {
        let Ok(rt) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return Vec::new();
        };
        let local = LocalSet::new();
        let collected: Arc<Mutex<Vec<ResultData>>> =
            Arc::new(Mutex::new(Vec::with_capacity(num_conn)));

        for conn_idx in 0..num_conn {
            let ctx = ctx.clone();
            let is_end = is_end.clone();
            let cancel = cancel.clone();
            let collected = collected.clone();
            let delay_ms = ramp_step_ms.saturating_mul(
                (thread_idx as u64).saturating_add(conn_idx as u64),
            );
            local.spawn_local(async move {
                if delay_ms > 0 {
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => {}
                        _ = cancel.cancelled() => {
                            collected.lock().unwrap().push(ResultData::default());
                            return;
                        }
                    }
                }
                let mut data = ResultData::default();
                run_connection(ctx, &mut data, is_end, cancel).await;
                collected.lock().unwrap().push(data);
            });
        }

        rt.block_on(local);
        let mut guard = collected.lock().unwrap();
        std::mem::take(&mut *guard)
    })
}

// ========================================================================
// Tauri command.
// ========================================================================

#[tauri::command]
pub async fn run_load_test(payload: LoadTestPayload) -> Result<LoadTestResult, String> {
    // --- validate + clamp -------------------------------------------------
    let raw_url = payload.url.trim().to_string();
    if raw_url.is_empty() {
        return Err("URL is required.".into());
    }
    let url = Url::parse(&raw_url).map_err(|e| format!("Invalid URL: {e}"))?;
    let scheme = url.scheme().to_string();
    if scheme != "http" && scheme != "https" {
        return Err(format!("Unsupported scheme: {scheme}"));
    }
    let host = url
        .host_str()
        .ok_or_else(|| "URL missing host".to_string())?
        .to_string();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "URL missing port".to_string())?;
    let path_and_query = {
        let p = url.path();
        match url.query() {
            Some(q) if !q.is_empty() => format!("{p}?{q}"),
            _ => {
                if p.is_empty() {
                    "/".to_string()
                } else {
                    p.to_string()
                }
            }
        }
    };
    let host_header = if (scheme == "https" && port == 443) || (scheme == "http" && port == 80) {
        host.clone()
    } else {
        format!("{host}:{port}")
    };

    let method = payload.method.trim().to_ascii_uppercase();
    let method = if method.is_empty() { "GET".into() } else { method };

    let n_conn = (payload.virtual_users as usize).clamp(1, 20_000);
    let duration_secs = (payload.duration_secs as u64).clamp(1, 600);
    let ramp_up_secs = payload.ramp_up_secs.unwrap_or(0).min(payload.duration_secs) as u64;
    let timeout_ms = payload.timeout_ms.unwrap_or(15_000).clamp(500, 300_000);
    let insecure = payload.insecure.unwrap_or(false);

    let pipeline_depth = payload
        .pipeline_depth
        .map(|d| d as usize)
        .unwrap_or_else(|| match method.as_str() {
            "GET" | "HEAD" | "OPTIONS" => 16,
            _ => 1,
        })
        .clamp(1, 128);

    let body_bytes = payload
        .body
        .filter(|b| !b.is_empty())
        .map(|b| Bytes::from(b.into_bytes()))
        .unwrap_or_default();

    // --- pre-build HTTP wire bytes (ONCE) ---------------------------------
    let request_bytes = build_request_bytes(
        &method,
        &path_and_query,
        &host_header,
        &payload.headers,
        &body_bytes,
        true,
    );

    // --- DNS resolve once -------------------------------------------------
    let addr: SocketAddr = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| format!("DNS lookup failed: {e}"))?
        .next()
        .ok_or_else(|| "DNS lookup returned no addresses".to_string())?;

    // --- TLS setup --------------------------------------------------------
    let tls_config = if scheme == "https" {
        Some(if insecure { tls_insecure() } else { tls_secure() })
    } else {
        None
    };
    let server_name: rustls::pki_types::ServerName<'static> =
        rustls::pki_types::ServerName::try_from(host.clone())
            .map_err(|e| format!("Invalid host for TLS SNI: {e}"))?;

    // --- shared state -----------------------------------------------------
    let bucket_count = duration_secs as usize + 2;
    let buckets: Arc<Vec<BucketStats>> =
        Arc::new((0..bucket_count).map(|_| BucketStats::new()).collect());
    let test_start = Instant::now();
    let deadline = test_start + Duration::from_secs(duration_secs);

    let ctx = Arc::new(TestCtx {
        host,
        port,
        https: scheme == "https",
        addr,
        server_name,
        tls_config,
        request_bytes,
        timeout: Duration::from_millis(timeout_ms),
        connect_timeout: Duration::from_millis(timeout_ms.min(10_000)),
        pipeline_depth,
        buckets: buckets.clone(),
        bucket_count,
        test_start,
    });

    // --- cancellation -----------------------------------------------------
    let test_id = if payload.test_id.trim().is_empty() {
        format!(
            "lt-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        )
    } else {
        payload.test_id.trim().to_string()
    };
    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    let _guard = CancelGuard::new(test_id.clone(), cancel_tx);

    let is_end = Arc::new(AtomicBool::new(false));
    let cancel_token = CancellationToken::new();

    // --- spawn worker threads --------------------------------------------
    let num_threads = num_cpus::get_physical().max(1).min(n_conn);
    let per_thread = distribute(n_conn, num_threads);
    let ramp_step_ms = if ramp_up_secs > 0 && n_conn > 1 {
        (ramp_up_secs * 1000) / (n_conn as u64 - 1).max(1)
    } else {
        0
    };

    let mut handles = Vec::with_capacity(per_thread.len());
    for (i, n) in per_thread.into_iter().enumerate() {
        handles.push(spawn_worker_thread(
            ctx.clone(),
            n,
            is_end.clone(),
            cancel_token.clone(),
            ramp_step_ms,
            i,
        ));
    }

    // --- wait for deadline or cancel -------------------------------------
    tokio::select! {
        _ = tokio::time::sleep_until(deadline.into()) => {}
        _ = async {
            loop {
                if cancel_rx.changed().await.is_err() { break; }
                if *cancel_rx.borrow() { break; }
            }
        } => {}
    }
    let was_cancelled = *cancel_rx.borrow();
    is_end.store(true, Ordering::Relaxed);
    cancel_token.cancel();

    // --- join threads off the async runtime ------------------------------
    let joined: Vec<Vec<ResultData>> = tokio::task::spawn_blocking(move || {
        handles.into_iter().map(|h| h.join().unwrap_or_default()).collect()
    })
    .await
    .unwrap_or_default();

    // --- merge + compute report ------------------------------------------
    let mut all_latencies_us: Vec<u64> = Vec::new();
    let mut merged_status: BTreeMap<u16, u64> = BTreeMap::new();
    let mut merged_errors: Vec<String> = Vec::new();
    let mut total_success: u64 = 0;
    let mut total_fail: u64 = 0;
    let mut total_bytes: u64 = 0;
    let mut total_timeouts: u64 = 0;
    let mut total_connects: u64 = 0;

    for thread_results in joined {
        for d in thread_results {
            all_latencies_us.extend(d.latencies_us);
            for (c, n) in d.status_codes {
                *merged_status.entry(c).or_insert(0) += n;
            }
            if merged_errors.len() < MAX_ERRORS_TOTAL {
                let remaining = MAX_ERRORS_TOTAL - merged_errors.len();
                merged_errors.extend(d.errors.into_iter().take(remaining));
            }
            total_success += d.success;
            total_fail += d.fail;
            total_bytes += d.bytes;
            total_timeouts += d.timeouts;
            total_connects += d.connects;
        }
    }

    let actual_duration_ms = test_start.elapsed().as_millis() as u64;
    let actual_duration_secs = (actual_duration_ms as f64 / 1000.0).max(0.001);

    all_latencies_us.sort_unstable();

    let avg_latency_us = if all_latencies_us.is_empty() {
        0.0
    } else {
        all_latencies_us.iter().sum::<u64>() as f64 / all_latencies_us.len() as f64
    };
    let min_us = all_latencies_us.first().copied().unwrap_or(0);
    let max_us = all_latencies_us.last().copied().unwrap_or(0);

    let histogram = LatencyHistogram {
        p50: us_to_ms(percentile(&all_latencies_us, 50.0)),
        p75: us_to_ms(percentile(&all_latencies_us, 75.0)),
        p90: us_to_ms(percentile(&all_latencies_us, 90.0)),
        p95: us_to_ms(percentile(&all_latencies_us, 95.0)),
        p99: us_to_ms(percentile(&all_latencies_us, 99.0)),
        p999: us_to_ms(percentile(&all_latencies_us, 99.9)),
    };

    let total_with_errors = total_success + total_fail;
    let rps = total_with_errors as f64 / actual_duration_secs;
    let error_rate = if total_with_errors > 0 {
        total_fail as f64 / total_with_errors as f64 * 100.0
    } else {
        0.0
    };

    let mut timeline = Vec::new();
    let mut peak_rps: f64 = 0.0;
    for (i, b) in buckets.iter().enumerate() {
        let reqs = b.requests.load(Ordering::Relaxed);
        if reqs == 0 {
            continue;
        }
        let errs = b.errors.load(Ordering::Relaxed);
        let lat_sum_us = b.latency_sum_us.load(Ordering::Relaxed);
        let avg = (lat_sum_us as f64 / reqs as f64) / 1000.0;
        if reqs as f64 > peak_rps {
            peak_rps = reqs as f64;
        }
        timeline.push(TimelineBucket {
            second: i as u64,
            requests: reqs,
            errors: errs,
            avg_latency_ms: round1(avg),
            rps: reqs as f64,
        });
    }

    let status_codes: HashMap<String, u64> = merged_status
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();

    Ok(LoadTestResult {
        total_requests: total_with_errors,
        successful: total_success,
        failed: total_fail,
        avg_latency_ms: round1(avg_latency_us / 1000.0),
        min_latency_ms: us_to_ms(min_us),
        max_latency_ms: us_to_ms(max_us),
        latency_histogram: histogram,
        requests_per_sec: round1(rps),
        peak_rps: round1(peak_rps),
        error_rate: round1(error_rate),
        status_codes,
        bytes_received: total_bytes,
        duration_ms: actual_duration_ms,
        timeline,
        errors: merged_errors,
        connection_errors: total_connects,
        timeout_errors: total_timeouts,
        was_cancelled,
    })
}

// ========================================================================
// Helpers.
// ========================================================================

fn percentile(sorted: &[u64], p: f64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    let rank = (p / 100.0 * sorted.len() as f64).ceil() as usize;
    sorted[rank.saturating_sub(1).min(sorted.len() - 1)]
}

fn us_to_ms(us: u64) -> u64 {
    (us + 500) / 1000
}

fn round1(v: f64) -> f64 {
    if v.is_finite() {
        (v * 10.0).round() / 10.0
    } else {
        0.0
    }
}
