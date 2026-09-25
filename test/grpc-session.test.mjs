import test from "node:test";
import assert from "node:assert/strict";
import { applyGrpcEvent, createGrpcCapture, grpcCaptureBody } from "../src/lib/grpc-session.js";

test("gRPC live capture retains bounded messages, metadata and real status", () => {
  const capture = createGrpcCapture();
  applyGrpcEvent(capture, { kind: "ready", data: { mode: "bidi", inputOpen: true } });
  for (let n = 0; n < 600; n++) applyGrpcEvent(capture, { kind: "message", data: { n } });
  assert.equal(capture.messages.length, 500);
  assert.equal(capture.dropped, 100);
  assert.equal(JSON.parse(grpcCaptureBody(capture))[0].n, 100);
  applyGrpcEvent(capture, { kind: "trailers", data: [{ key: "trace", value: "abc" }] });
  applyGrpcEvent(capture, { kind: "status", data: { code: 4 } });
  assert.equal(capture.inputOpen, false);
  assert.equal(capture.headers["x-kivo-grpc-status"], "4");
  assert.match(capture.headers["x-kivo-grpc-trailers"], /abc/);
});

test("unary capture remains an object and oversize messages do not freeze capture", () => {
  const capture = createGrpcCapture();
  applyGrpcEvent(capture, { kind: "message", data: { ok: true } });
  assert.deepEqual(JSON.parse(grpcCaptureBody(capture)), { ok: true });
  applyGrpcEvent(capture, { kind: "message", data: "x".repeat(2_000_001) });
  assert.equal(capture.dropped, 1);
  assert.equal(capture.messages.length, 1);
});
