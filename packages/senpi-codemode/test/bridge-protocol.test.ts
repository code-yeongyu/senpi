import { describe, expect, it } from "vitest";
import {
	BRIDGE_FRAME_MAX_BYTES,
	decodeBridgeFrame,
	encodeBridgeFrame,
	generateBridgeToken,
	generateCorrelationId,
	type HostToKernelMessage,
	type KernelToHostMessage,
	parseBridgeJsonLine,
	verifyBridgeToken,
} from "../src/bridge/protocol.ts";

const hostMessages: HostToKernelMessage[] = [
	{ type: "init", sessionId: "session-1", connection: { port: 4317, token: "secret-token" } },
	{ type: "run", cellId: "cell-1", code: "1 + 1", timeoutMs: 1_000 },
	{ type: "tool-reply", callId: "call-1", ok: true, value: { nested: ["value"] } },
	{ type: "tool-reply", callId: "call-2", ok: false, error: { message: "failed", name: "ToolError" } },
	{ type: "interrupt", reason: "user" },
	{ type: "close" },
];

const kernelMessages: KernelToHostMessage[] = [
	{ type: "ready" },
	{ type: "init-failed", error: { message: "bad init" } },
	{ type: "text", stream: "stdout", data: "hello" },
	{ type: "text", stream: "stderr", data: "warn" },
	{ type: "display", mimeType: "image/png", dataBase64: "aGVsbG8=" },
	{ type: "tool-call", callId: "call-3", toolName: "dynamic.tool/name", args: { path: "x" } },
	{ type: "log", message: "diagnostic" },
	{ type: "phase", title: "Running" },
	{ type: "result", cellId: "cell-2", ok: true, valueRepr: "2", durationMs: 12 },
	{ type: "result", cellId: "cell-3", ok: false, error: { message: "boom", stack: "stack" }, durationMs: 15 },
	{ type: "closed" },
];

describe("bridge protocol JSONL framing", () => {
	it("round-trips every host and kernel message kind", () => {
		for (const message of [...hostMessages, ...kernelMessages]) {
			const encoded = encodeBridgeFrame(message);
			expect(encoded.endsWith("\n")).toBe(true);
			expect(decodeBridgeFrame(encoded)).toEqual({ ok: true, message });
		}
	});

	it("returns typed decode errors for malformed and oversized frames", () => {
		expect(decodeBridgeFrame('{"type":"tool-call"')).toEqual({
			ok: false,
			error: { code: "malformed_json", message: expect.any(String) },
		});
		expect(decodeBridgeFrame('{"type":"ready"}\n', { maxBytes: 4 })).toEqual({
			ok: false,
			error: { code: "frame_too_large", message: expect.any(String) },
		});
		expect(decodeBridgeFrame('{"type":"run","cellId":"cell"}\n')).toEqual({
			ok: false,
			error: { code: "invalid_message", message: expect.any(String) },
		});
	});

	it("parses LF-delimited records without accepting extra records", () => {
		expect(parseBridgeJsonLine('{"type":"ready"}\n{"type":"closed"}')).toEqual({
			ok: false,
			error: { code: "multiple_frames", message: expect.any(String) },
		});
		expect(parseBridgeJsonLine('{"type":"ready"}\n')).toEqual({
			ok: true,
			value: { type: "ready" },
		});
	});

	it("generates correlation ids and bearer tokens, then rejects mismatches", () => {
		const token = generateBridgeToken();
		expect(token.length).toBeGreaterThanOrEqual(32);
		expect(generateCorrelationId()).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
		);
		expect(verifyBridgeToken(token, token)).toEqual({ ok: true });
		expect(verifyBridgeToken(token, `${token}x`)).toEqual({
			ok: false,
			error: { code: "token_mismatch", message: expect.any(String) },
		});
	});

	it("documents the default frame size", () => {
		expect(BRIDGE_FRAME_MAX_BYTES).toBe(10 * 1024 * 1024);
	});
});
