use super::*;
use std::collections::VecDeque;
use tauri::Emitter;
use tokio::sync::mpsc;
use tonic::metadata::{KeyAndValueRef, MetadataMap};

const MAX_MESSAGES: usize = 500;
const MAX_BYTES: usize = 4 * 1024 * 1024;

fn inspect_method(proto: &str, method_path: &str, body: Option<&str>) -> Result<Value, String> {
    let pool = compile_descriptor_pool(proto)?;
    let path = method_path.trim_start_matches('/');
    let (service, name) = path.rsplit_once('/').ok_or("Select a gRPC method")?;
    let method = find_grpc_method_descriptor(&pool, service, name).ok_or("Method not found in descriptors")?;
    let input = method.input();
    let fields: Vec<Value> = input.fields().map(|field| serde_json::json!({
        "name": field.json_name(), "type": match field.kind() {
            prost_reflect::Kind::Message(message) => message.full_name().to_string(),
            prost_reflect::Kind::Enum(enumeration) => enumeration.full_name().to_string(),
            kind => format!("{kind:?}"),
        },
        "repeated": field.is_list(), "map": field.is_map(),
        "oneof": field.containing_oneof().map(|group| group.name().to_string())
    })).collect();
    let mut buffer = Vec::new();
    DynamicMessage::new(input.clone()).serialize_with_options(
        &mut serde_json::Serializer::new(&mut buffer),
        &prost_reflect::SerializeOptions::new().skip_default_fields(false),
    ).map_err(|error| error.to_string())?;
    let example: Value = serde_json::from_slice(&buffer).map_err(|error| error.to_string())?;
    let validation_error = body.and_then(|text| initial_messages(input.clone(), text, method.is_client_streaming()).err());
    Ok(serde_json::json!({ "inputType": input.full_name(), "outputType": method.output().full_name(),
        "fields": fields, "example": example, "validationError": validation_error,
        "validated": body.is_some(), "clientStreaming": method.is_client_streaming() }))
}

#[tauri::command]
pub async fn inspect_grpc_method(proto_file_path: String, method_path: String, body: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || inspect_method(&proto_file_path, &method_path, body.as_deref()))
        .await.map_err(|error| error.to_string())?
}

#[cfg(test)]
#[path = "grpc_tests.rs"]
mod transport_tests;

#[derive(Clone)]
struct InputSession {
    sender: mpsc::Sender<DynamicMessage>,
    descriptor: prost_reflect::MessageDescriptor,
    vars: HashMap<String, String>,
}

fn inputs() -> &'static Mutex<HashMap<String, InputSession>> {
    static INPUTS: OnceLock<Mutex<HashMap<String, InputSession>>> = OnceLock::new();
    INPUTS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct SessionGuard(String);
impl Drop for SessionGuard {
    fn drop(&mut self) {
        if let Ok(mut sessions) = inputs().lock() { sessions.remove(&self.0); }
        unregister_http_cancel(&self.0);
    }
}

#[tauri::command]
pub fn grpc_send_message(request_id: String, body: String) -> Result<(), String> {
    let session = inputs().lock().map_err(|_| "gRPC session lock failed")?
        .get(&request_id).cloned().ok_or("gRPC input is closed")?;
    let message = parse_message(session.descriptor, &resolve_payload_value(&body, &session.vars))?;
    session.sender.try_send(message).map_err(|_| "Input queue is full or closed; wait before sending again".to_string())
}

#[tauri::command]
pub fn grpc_finish_input(request_id: String) -> Result<(), String> {
    inputs().lock().map_err(|_| "gRPC session lock failed")?.remove(&request_id)
        .ok_or("gRPC input is already closed")?;
    Ok(())
}

fn parse_message(descriptor: prost_reflect::MessageDescriptor, body: &str) -> Result<DynamicMessage, String> {
    if body.len() > MAX_BYTES { return Err("gRPC message exceeds 4 MiB".into()); }
    let value: Value = serde_json::from_str(body).map_err(|e| format!("Invalid message JSON: {e}"))?;
    if !value.is_object() { return Err("Each gRPC message must be a JSON object".into()); }
    build_dynamic_request_message(descriptor, Some(body))
}

fn initial_messages(descriptor: prost_reflect::MessageDescriptor, body: &str, client_streaming: bool) -> Result<Vec<DynamicMessage>, String> {
    if body.len() > MAX_BYTES { return Err("gRPC payload exceeds 4 MiB".into()); }
    let value: Value = serde_json::from_str(if body.trim().is_empty() { "{}" } else { body })
        .map_err(|e| format!("Invalid message JSON: {e}"))?;
    let values = match value {
        Value::Array(values) if client_streaming => values,
        Value::Object(_) => vec![value],
        _ => return Err("This method expects one JSON object, or an array for client streaming".into()),
    };
    if values.len() > 64 { return Err("Start with at most 64 messages; send more during the session".into()); }
    values.iter().map(|v| parse_message(descriptor.clone(), &v.to_string())).collect()
}

fn metadata_json(metadata: &MetadataMap) -> Value {
    let rows: Vec<Value> = metadata.iter().map(|entry| match entry {
        KeyAndValueRef::Ascii(key, value) => serde_json::json!({"key": key.as_str(), "value": value.to_str().unwrap_or("<invalid>")}),
        KeyAndValueRef::Binary(key, value) => serde_json::json!({"key": key.as_str(), "value": value.to_bytes().map(|b| BASE64_STANDARD.encode(b)).unwrap_or_default()}),
    }).collect();
    Value::Array(rows)
}

fn request_metadata(headers: &HashMap<String, String>, vars: &HashMap<String, String>) -> Result<MetadataMap, String> {
    let mut metadata = MetadataMap::new();
    for (key, value) in headers {
        let key = resolve_payload_value(key, vars).to_ascii_lowercase();
        if ["content-type", "te", "host", "grpc-timeout"].contains(&key.as_str()) { continue; }
        let value = resolve_payload_value(value, vars);
        if key.ends_with("-bin") {
            let key = tonic::metadata::MetadataKey::<tonic::metadata::Binary>::from_bytes(key.as_bytes()).map_err(|e| e.to_string())?;
            let bytes = BASE64_STANDARD.decode(value).map_err(|e| format!("Binary metadata requires base64: {e}"))?;
            metadata.insert_bin(key, tonic::metadata::MetadataValue::from_bytes(&bytes));
        } else {
            let key = tonic::metadata::MetadataKey::<tonic::metadata::Ascii>::from_bytes(key.as_bytes()).map_err(|e| e.to_string())?;
            let value = tonic::metadata::MetadataValue::try_from(value.as_str()).map_err(|e| e.to_string())?;
            metadata.insert(key, value);
        }
    }
    Ok(metadata)
}

struct Capture {
    messages: VecDeque<Value>,
    bytes: usize,
    dropped: usize,
}
impl Capture {
    fn push(&mut self, value: Value) {
        let size = value.to_string().len();
        if size > MAX_BYTES { self.dropped += 1; return; }
        while self.messages.len() >= MAX_MESSAGES || self.bytes + size > MAX_BYTES {
            if let Some(old) = self.messages.pop_front() { self.bytes -= old.to_string().len(); self.dropped += 1; }
        }
        self.bytes += size;
        self.messages.push_back(value);
    }
}

pub async fn run(app: AppHandle, payload: GrpcRequestPayload) -> Result<ResponsePayload, String> {
    let request_id = payload.request_id.trim().to_string();
    if request_id.is_empty() { return Err("gRPC request ID is required".into()); }
    let mut cancel = register_http_cancel(&request_id).ok_or("Cannot register gRPC cancellation")?;
    let _guard = SessionGuard(request_id.clone());
    let started = Instant::now();
    let deadline = Duration::from_millis(payload.timeout_ms.unwrap_or(60_000).clamp(100, 3_600_000));
    let mut capture = Capture { messages: VecDeque::new(), bytes: 0, dropped: 0 };
    let mut headers = HashMap::from([("content-type".into(), "application/json".into())]);
    let emit = |kind: &str, data: Value| {
        let _ = app.emit("kivo:grpc", serde_json::json!({"requestId": request_id, "kind": kind, "data": data, "elapsedMs": started.elapsed().as_millis()}));
    };
    let execution = async {
        let vars = get_env_context(&app, &payload.workspace_name, &payload.collection_name).map_err(Status::invalid_argument)?;
        let target = normalize_grpc_target(&resolve_payload_value(&payload.url, &vars)).map_err(Status::invalid_argument)?;
        let proto = resolve_payload_value(&payload.grpc_proto_file_path, &vars);
        let pool = compile_descriptor_pool(&proto).map_err(Status::invalid_argument)?;
        let (service, method) = parse_grpc_method_parts(&payload.grpc_method_path).map_err(Status::invalid_argument)?;
        let descriptor = find_grpc_method_descriptor(&pool, &service, &method).ok_or_else(|| Status::invalid_argument("Method not found in descriptors"))?;
        let client_streaming = descriptor.is_client_streaming();
        let server_streaming = descriptor.is_server_streaming();
        let mode = match (client_streaming, server_streaming) { (true,true) => "bidi", (true,false) => "client_stream", (false,true) => "server_stream", _ => "unary" };
        headers.insert("x-kivo-grpc-mode".into(), mode.into());
        let body = resolve_payload_value(payload.body.as_deref().unwrap_or("{}"), &vars);
        let messages = initial_messages(descriptor.input(), &body, client_streaming).map_err(Status::invalid_argument)?;
        let metadata = request_metadata(&payload.headers, &vars).map_err(Status::invalid_argument)?;
        let mut endpoint = Endpoint::from_shared(target.clone()).map_err(|e| Status::invalid_argument(e.to_string()))?
            .connect_timeout(Duration::from_secs(10));
        if target.starts_with("https:") {
            endpoint = endpoint.tls_config(tonic::transport::ClientTlsConfig::new().with_native_roots()).map_err(|e| Status::invalid_argument(e.to_string()))?;
        }
        let channel = endpoint.connect().await.map_err(|e| Status::unavailable(e.to_string()))?;
        let (sender, receiver) = mpsc::channel(64);
        for message in messages { sender.try_send(message).map_err(|e| Status::resource_exhausted(e.to_string()))?; }
        if client_streaming {
            inputs().lock().map_err(|_| Status::internal("Session lock failed"))?.insert(request_id.clone(), InputSession { sender, descriptor: descriptor.input(), vars });
        } else { drop(sender); }
        emit("ready", serde_json::json!({"mode": mode, "inputOpen": client_streaming}));
        let outgoing = futures_util::stream::unfold(receiver, |mut receiver| async move { receiver.recv().await.map(|message| (message, receiver)) });
        let mut request = Request::new(outgoing);
        *request.metadata_mut() = metadata;
        request.set_timeout(deadline.saturating_sub(started.elapsed()));
        let mut client = tonic::client::Grpc::new(channel).max_decoding_message_size(MAX_BYTES).max_encoding_message_size(MAX_BYTES);
        client.ready().await.map_err(|e| Status::unavailable(e.to_string()))?;
        let path = tonic::codegen::http::uri::PathAndQuery::from_str(&format!("/{service}/{method}")).map_err(|e| Status::invalid_argument(e.to_string()))?;
        let response = client.streaming(request, path, DynamicCodec::new(descriptor.input(), descriptor.output())).await?;
        let metadata = metadata_json(response.metadata());
        headers.insert("x-kivo-grpc-headers".into(), metadata.to_string());
        emit("headers", metadata);
        let mut stream = response.into_inner();
        while let Some(message) = stream.message().await? {
            let value = serde_json::to_value(message).map_err(|e| Status::internal(e.to_string()))?;
            capture.push(value.clone());
            emit("message", value);
        }
        if let Some(trailers) = stream.trailers().await? {
            let trailers = metadata_json(&trailers);
            headers.insert("x-kivo-grpc-trailers".into(), trailers.to_string());
            emit("trailers", trailers);
        }
        Ok::<(), Status>(())
    };
    let outcome = tokio::select! {
        _ = cancel.changed() => Err(Status::cancelled("Cancelled by user")),
        result = timeout(deadline, execution) => result.unwrap_or_else(|_| Err(Status::deadline_exceeded("Request deadline exceeded"))),
    };
    let status = outcome.err().unwrap_or_else(|| Status::ok("OK"));
    let code = status.code() as i32;
    let status_text = format!("{code} {:?}: {}", status.code(), status.message());
    headers.insert("x-kivo-grpc-status".into(), code.to_string());
    headers.insert("x-kivo-grpc-dropped".into(), capture.dropped.to_string());
    if code != 0 {
        headers.insert("x-kivo-grpc-trailers".into(), metadata_json(status.metadata()).to_string());
    }
    emit("status", serde_json::json!({"code": code, "message": status.message(), "dropped": capture.dropped}));
    let streamed = matches!(headers.get("x-kivo-grpc-mode").map(String::as_str), Some("server_stream" | "bidi"));
    let body = if streamed { serde_json::to_string_pretty(&capture.messages) } else { serde_json::to_string_pretty(&capture.messages.front().cloned().unwrap_or(Value::Null)) }.map_err(|e| e.to_string())?;
    Ok(ResponsePayload { status: if code == 0 { 200 } else { 500 }, status_text, headers, cookies: vec![], body, body_base64: String::new(), is_binary: false, content_type: "application/json".into(), duration_ms: started.elapsed().as_millis() })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_is_bounded() {
        let mut capture = Capture { messages: VecDeque::new(), bytes: 0, dropped: 0 };
        for n in 0..600 { capture.push(serde_json::json!({"n": n})); }
        assert_eq!(capture.messages.len(), 500);
        assert_eq!(capture.dropped, 100);
        capture.push(Value::String("x".repeat(MAX_BYTES)));
        assert_eq!(capture.dropped, 101);
    }
    #[test]
    fn metadata_roundtrips_binary_and_rejects_invalid_values() {
        let mut rows = HashMap::from([("trace-bin".into(), "aGk=".into())]);
        let meta = request_metadata(&rows, &HashMap::new()).unwrap();
        assert_eq!(metadata_json(&meta)[0]["value"], "aGk=");
        rows.insert("bad".into(), "bad\nvalue".into());
        assert!(request_metadata(&rows, &HashMap::new()).is_err());
    }
}
