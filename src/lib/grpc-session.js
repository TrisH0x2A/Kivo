const MAX_MESSAGES = 500;
const MAX_CHARS = 2_000_000;

export function createGrpcCapture() {
  return { messages: [], chars: 0, dropped: 0, headers: {}, mode: "unary", inputOpen: false };
}

export function applyGrpcEvent(capture, event) {
  const { kind, data } = event;
  if (kind === "ready") {
    capture.mode = data.mode;
    capture.inputOpen = data.inputOpen;
    capture.headers["x-kivo-grpc-mode"] = data.mode;
  } else if (kind === "headers" || kind === "trailers") {
    capture.headers[`x-kivo-grpc-${kind}`] = JSON.stringify(data);
  } else if (kind === "message") {
    const chars = JSON.stringify(data).length;
    if (chars > MAX_CHARS) { capture.dropped += 1; return; }
    while (capture.messages.length >= MAX_MESSAGES || capture.chars + chars > MAX_CHARS) {
      capture.chars -= JSON.stringify(capture.messages.shift()).length;
      capture.dropped += 1;
    }
    capture.messages.push(data);
    capture.chars += chars;
  } else if (kind === "status") {
    capture.inputOpen = false;
    capture.headers["x-kivo-grpc-status"] = String(data.code);
  }
}

export function grpcCaptureBody(capture) {
  return JSON.stringify(["server_stream", "bidi"].includes(capture.mode) ? capture.messages : capture.messages.at(-1) ?? null, null, 2);
}
