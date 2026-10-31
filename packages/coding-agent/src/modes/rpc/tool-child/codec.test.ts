import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFrame, FRAME_HEADER_BYTES, FrameDecoder, ToolChildCodecError } from "./codec.ts";
import { narrowContext } from "./context.ts";
import { LAUNCH_CONTAINMENTS, TOOL_CHILD_LIMITS, type ToolChildMessage } from "./protocol.ts";
import { TOOL_CHILD_MESSAGE_TYPES } from "./protocol-guard.ts";

const ref = { refId: "r-1", generation: 3, bytes: 10, sha256: "a".repeat(64) };

const SAMPLES: ToolChildMessage[] = [
	...LAUNCH_CONTAINMENTS.map(
		(containment): ToolChildMessage => ({
			type: "launch",
			launchId: `l-${containment}`,
			jobId: "j1",
			origin: "tool",
			api: "bun.spawn",
			containment,
			lifetime: "owned",
			pid: 10,
			pgid: 10,
		}),
	),
	{
		type: "launch",
		launchId: "l-det",
		jobId: "j1",
		origin: "kernel",
		api: "cp.spawn",
		containment: "breakaway",
		lifetime: "detached",
	},
	{ type: "launch_ack", launchId: "l-1" },
	{ type: "launch_proof", launchId: "l-1", ackTick: 4, invokeTick: 5 },
	{ type: "launch_proof", launchId: "l-2", ackTick: null, invokeTick: 6 },
	{ type: "ping", seq: 1 },
	{ type: "pong", seq: 1 },
	{ type: "cancel_ack", jobId: "j1" },
	{ type: "launch_done", launchId: "l-1", exitCode: 0 },
	{ type: "launch_done", launchId: "l-2", signal: "SIGTERM" },
	{ type: "command_started", launchId: "l-1", pid: 77, startedAtMs: 1234, creatorInJob: true, breakaway: false },
	{ type: "slot_query", launchId: "l-1" },
	{ type: "slot_state", launchId: "l-1", ackTick: null, invokeTick: null, invocations: 0 },
	{ type: "slot_state", launchId: "l-1", ackTick: 4, invokeTick: 5, invocations: 1 },
	{ type: "trace", atMs: 1, event: "job_start", detail: { kind: "grep", ok: true, n: 3 } },
	{ type: "trace", atMs: 2, event: "idle" },
	{
		type: "batch",
		jobId: "j-parse",
		done: false,
		entries: [
			{ id: "e1", parentId: null, lineOffset: 0, lineBytes: 120, lineDelta: 0, entry: { type: "message" } },
			{ id: "e2", parentId: "e1", lineOffset: 121, lineBytes: 4096, lineDelta: -3500 },
		],
	},
	{ type: "hello", generation: 3, pid: 99, protocol: 2, jobKinds: ["module"] },
	{ type: "update", jobId: "j1", seq: 1, value: { index: 1 } },
	{ type: "update_ack", jobId: "j1", seq: 1 },
	{ type: "hello_ack", generation: 3 },
	{ type: "heartbeat", seq: 7 },
	{ type: "job", jobId: "j1", kind: "read", args: { path: "a\nb.txt" } },
	{ type: "job", jobId: "j2", kind: "write", parentJobId: "j1", argsRef: ref },
	{ type: "cancel", jobId: "j1" },
	{ type: "result", jobId: "j1", value: { content: [{ type: "text", text: "line\n" }] } },
	{ type: "result", jobId: "j3", value: null },
	{ type: "result_ref", jobId: "j1", ref },
	{ type: "job_error", jobId: "j1", code: "tool_failed", message: "boom" },
	{ type: "job_refused", jobId: "j9", code: "tool_child_jobs_full" },
	{ type: "host_call", callId: "c1", jobId: "j1", kind: "tool", name: "read", args: { path: "x" } },
	{ type: "host_call", callId: "c2", jobId: "j1", kind: "tool", name: "write", argsRef: ref },
	{ type: "host_call", callId: "c3", jobId: "j1", kind: "list_tools" },
	{ type: "host_reply", callId: "c1", value: [1, 2] },
	{ type: "host_reply", callId: "c2", valueRef: ref },
	{ type: "host_reply", callId: "c3", error: "denied" },
	{ type: "host_call_refused", callId: "c265", code: "host_call_capacity" },
	{ type: "wake", wakeId: "w1", source: "monitor", bytes: 12 },
	{ type: "wake_ack", wakeId: "w1" },
	{ type: "ref_ack", refId: "r-1" },
	{ type: "ref_nack", refId: "r-1", reason: "cancelled" },
	{ type: "shutdown" },
];

function concat(parts: readonly Uint8Array[]): Uint8Array {
	return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

function codecError(run: () => unknown): string | undefined {
	try {
		run();
	} catch (error) {
		if (error instanceof ToolChildCodecError) return error.code;
		throw error;
	}
	return undefined;
}

function frameWithBody(body: string): Uint8Array {
	const bytes = Buffer.from(body, "utf8");
	const header = Buffer.alloc(FRAME_HEADER_BYTES);
	header.writeUInt32BE(bytes.length, 0);
	return concat([header, bytes]);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("tool-child codec", () => {
	it("round-trips every message type through one chunked stream", () => {
		expect(new Set(SAMPLES.map((message) => message.type))).toEqual(new Set(TOOL_CHILD_MESSAGE_TYPES));
		const stream = concat(SAMPLES.map(encodeFrame));
		const decoder = new FrameDecoder();
		const decoded: ToolChildMessage[] = [];
		for (let offset = 0; offset < stream.length; offset += 7) {
			decoded.push(...decoder.push(stream.subarray(offset, offset + 7)));
		}
		decoder.end();
		expect(decoded).toEqual(SAMPLES);
	});

	it("frames with a big-endian length prefix, not NDJSON", () => {
		const frame = Buffer.from(encodeFrame({ type: "job", jobId: "j1", kind: "read", args: { text: "a\nb" } }));
		const bodyBytes = frame.readUInt32BE(0);
		expect(frame.length).toBe(FRAME_HEADER_BYTES + bodyBytes);
		expect(frame.at(-1)).not.toBe(0x0a);
	});

	it("accepts a body of exactly the cap and refuses one byte more on encode", () => {
		const overhead = JSON.stringify({ type: "result", jobId: "j", value: "" }).length;
		const fits = "x".repeat(TOOL_CHILD_LIMITS.frameBytes - overhead);
		const frame = encodeFrame({ type: "result", jobId: "j", value: fits });
		expect(new FrameDecoder().push(frame)).toEqual([{ type: "result", jobId: "j", value: fits }]);
		expect(codecError(() => encodeFrame({ type: "result", jobId: "j", value: `${fits}x` }))).toBe(
			"tool_child_frame_too_large",
		);
	});

	it("refuses a 16 MiB+1 length header before allocating its body, and stays failed", () => {
		const alloc = vi.spyOn(Buffer, "alloc");
		const allocUnsafe = vi.spyOn(Buffer, "allocUnsafe");
		const header = Buffer.alloc(FRAME_HEADER_BYTES);
		header.writeUInt32BE(TOOL_CHILD_LIMITS.frameBytes + 1, 0);
		alloc.mockClear();
		const decoder = new FrameDecoder();
		expect(codecError(() => decoder.push(header))).toBe("tool_child_frame_too_large");
		const large = (spy: typeof alloc) => spy.mock.calls.filter(([size]) => Number(size) > 1024);
		expect(large(alloc)).toEqual([]);
		expect(large(allocUnsafe)).toEqual([]);
		expect(decoder.bufferedBytes).toBe(0);
		expect(codecError(() => decoder.push(encodeFrame({ type: "shutdown" })))).toBe("tool_child_frame_too_large");
	});

	it("reports a truncated stream as tool_child_truncated", () => {
		const frame = encodeFrame({ type: "heartbeat", seq: 1 });
		const partialBody = new FrameDecoder();
		expect(partialBody.push(frame.subarray(0, frame.length - 1))).toEqual([]);
		expect(codecError(() => partialBody.end())).toBe("tool_child_truncated");
		const partialHeader = new FrameDecoder();
		partialHeader.push(frame.subarray(0, 2));
		expect(codecError(() => partialHeader.end())).toBe("tool_child_truncated");
		const clean = new FrameDecoder();
		clean.push(frame);
		expect(codecError(() => clean.end())).toBeUndefined();
	});

	it("refuses malformed frames instead of dropping them", () => {
		const cases = [
			"not json",
			JSON.stringify({ type: "unknown_type" }),
			JSON.stringify({ type: "launch_proof", launchId: "l", ackTick: 1 }),
			JSON.stringify({ type: "trace", atMs: 1, event: "e", value: { result: 1 } }),
			JSON.stringify({ type: "trace", atMs: 1, event: "e", detail: { ackTick: 4 } }),
			JSON.stringify({
				type: "launch",
				launchId: "l",
				jobId: "j",
				origin: "tool",
				api: "bun.spawn",
				containment: "pid",
				lifetime: "owned",
			}),
		];
		for (const body of cases) {
			expect(codecError(() => new FrameDecoder().push(frameWithBody(body)))).toBe("tool_child_malformed");
		}
	});
});

describe("ChildToolContext", () => {
	it("narrowContext keeps plain data only: no functions, no ui, no sessionManager", () => {
		const extensionContext = {
			ui: { notify: () => undefined },
			sessionManager: { getEntries: () => [] },
			cwd: "/work",
			agentDir: "/agent",
			mode: "rpc" as const,
			model: { provider: "anthropic", id: "claude", api: "messages", compat: () => true },
			thinkingLevel: "medium" as const,
			isProjectTrusted: () => true,
			isIdle: () => false,
			goalStoreFile: "/agent/goal.json",
		};
		const narrowed = narrowContext(extensionContext, { sessionId: "s1", toolCallId: "t1" });
		const keys: string[] = [];
		const functions: string[] = [];
		const walk = (value: unknown, path: string): void => {
			if (typeof value === "function") functions.push(path);
			if (typeof value !== "object" || value === null) return;
			for (const [key, item] of Object.entries(value)) {
				keys.push(key);
				walk(item, `${path}.${key}`);
			}
		};
		walk(narrowed, "ctx");
		expect(functions).toEqual([]);
		expect(keys).not.toContain("ui");
		expect(keys).not.toContain("sessionManager");
		expect(narrowed).toEqual({
			cwd: "/work",
			agentDir: "/agent",
			mode: "rpc",
			sessionId: "s1",
			toolCallId: "t1",
			projectTrusted: true,
			model: { provider: "anthropic", id: "claude" },
			thinkingLevel: "medium",
			goalStoreFile: "/agent/goal.json",
		});
		const [decoded] = new FrameDecoder().push(encodeFrame({ type: "job", jobId: "j", kind: "read", args: narrowed }));
		expect(decoded).toEqual({ type: "job", jobId: "j", kind: "read", args: narrowed });
	});
});

describe("encode-time normalization (senpi#3569 review)", () => {
	it("a job result of undefined encodes as an explicit null the decoder accepts", () => {
		const [decoded] = new FrameDecoder().push(encodeFrame({ type: "result", jobId: "j", value: undefined } as never));
		expect(decoded).toMatchObject({ type: "result", jobId: "j", value: null });
	});

	it("a NaN job result encodes as null instead of killing the channel", () => {
		const [decoded] = new FrameDecoder().push(
			encodeFrame({ type: "result", jobId: "j", value: Number.NaN } as never),
		);
		expect(decoded).toMatchObject({ type: "result", jobId: "j", value: null });
	});

	it("optional fields set to undefined keep stringify's default drop and still encode (delta review HIGH 1)", () => {
		const [decoded] = new FrameDecoder().push(
			encodeFrame({ type: "launch_done", launchId: "l1", signal: "SIGTERM" } as never),
		);
		expect(decoded).toEqual({ type: "launch_done", launchId: "l1", signal: "SIGTERM" });
		expect("exitCode" in (decoded as Record<string, unknown>)).toBe(false);
	});

	it("nested undefined payload keys stay dropped, matching the ref path (delta review MEDIUM 2)", () => {
		const [decoded] = new FrameDecoder().push(
			encodeFrame({ type: "result", jobId: "j", value: { content: "x", details: undefined } } as never),
		);
		expect((decoded as { value: Record<string, unknown> }).value).toEqual({ content: "x" });
	});

	it("a non-finite required number is refused at encode with a typed error, never as a frame", () => {
		expect(() => encodeFrame({ type: "heartbeat", seq: Number.POSITIVE_INFINITY })).toThrow(ToolChildCodecError);
	});
});
