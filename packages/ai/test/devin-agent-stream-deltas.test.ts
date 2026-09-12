import { afterEach, describe, expect, it } from "vitest";
import { StopReason } from "../src/api/devin-agent/gen/cascade_pb.ts";
import { stream as devinStream } from "../src/api/devin-agent.ts";
import {
	CONTEXT,
	closeStubServers,
	collect,
	deltas,
	frame,
	MODEL,
	serveEdge,
	trailer,
} from "./devin-agent-stream-harness.ts";

afterEach(closeStubServers);

describe.sequential("devin-agent stream: deltas, stop reasons and failures", () => {
	it("keeps one tool call when later chunks carry the arguments without the id", async () => {
		const { baseUrl } = await serveEdge({
			chat: (_req, res) => {
				res.writeHead(200, { "content-type": "application/connect+proto" });
				res.write(
					frame({ messageId: "m1", deltaToolCalls: [{ id: "call-1", name: "read", argumentsJson: '{"pa' }] }),
				);
				res.write(frame({ messageId: "m1", deltaToolCalls: [{ id: "", name: "", argumentsJson: 'th":"a.' }] }));
				res.write(frame({ messageId: "m1", deltaToolCalls: [{ id: "", name: "", argumentsJson: 'ts"}' }] }));
				res.write(frame({ messageId: "m1", stopReason: StopReason.FUNCTION_CALL }));
				res.write(trailer());
				res.end();
			},
		});

		const events = await collect(devinStream({ ...MODEL, baseUrl }, CONTEXT, { apiKey: "session-abc" } as never));
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type !== "done") throw new Error("expected done");
		const toolCalls = done.message.content.filter((c) => c.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]).toMatchObject({ id: "call-1", name: "read", arguments: { path: "a.ts" } });
		expect(events.filter((e) => e.type === "toolcall_start")).toHaveLength(1);
		expect(deltas(events, "toolcall_delta")).toEqual(['{"pa', 'th":"a.', 'ts"}']);
		expect(events.filter((e) => e.type === "toolcall_end")).toHaveLength(1);
	});

	it("emits only the new suffix when a chunk repeats the accumulated arguments", async () => {
		const { baseUrl } = await serveEdge({
			chat: (_req, res) => {
				res.writeHead(200, { "content-type": "application/connect+proto" });
				res.write(
					frame({ messageId: "m1", deltaToolCalls: [{ id: "call-1", name: "read", argumentsJson: '{"pa' }] }),
				);
				res.write(
					frame({
						messageId: "m1",
						deltaToolCalls: [{ id: "call-1", name: "read", argumentsJson: '{"path":"a.ts"}' }],
					}),
				);
				res.write(trailer());
				res.end();
			},
		});

		const events = await collect(devinStream({ ...MODEL, baseUrl }, CONTEXT, { apiKey: "session-abc" } as never));
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type !== "done") throw new Error("expected done");
		expect(done.message.content.find((c) => c.type === "toolCall")).toMatchObject({ arguments: { path: "a.ts" } });
		expect(deltas(events, "toolcall_delta")).toEqual(['{"pa', 'th":"a.ts"}']);
	});

	it("surfaces a Connect error trailer as an error event instead of an empty done", async () => {
		const { baseUrl } = await serveEdge({
			chat: (_req, res) => {
				res.writeHead(200, { "content-type": "application/connect+proto" });
				res.write(
					trailer('{"error":{"code":"invalid_argument","message":"an internal error occurred (trace ID: abc)"}}'),
				);
				res.end();
			},
		});

		const events = await collect(devinStream({ ...MODEL, baseUrl }, CONTEXT, { apiKey: "session-abc" } as never));
		const last = events.at(-1);
		expect(last?.type).toBe("error");
		if (last?.type !== "error") throw new Error("expected error");
		expect(last.reason).toBe("error");
		expect(last.error.errorMessage).toMatch(/invalid_argument/);
		expect(last.error.errorMessage).toMatch(/an internal error occurred/);
		expect(events.some((e) => e.type === "done")).toBe(false);
	});

	it("maps Cascade stop reasons that carry no tool call", async () => {
		const { baseUrl } = await serveEdge({
			chat: (_req, res) => {
				res.writeHead(200, { "content-type": "application/connect+proto" });
				res.write(frame({ messageId: "m2", deltaText: "cut" }));
				res.write(frame({ messageId: "m2", stopReason: StopReason.MAX_TOKENS }));
				res.write(trailer());
				res.end();
			},
		});

		const events = await collect(devinStream({ ...MODEL, baseUrl }, CONTEXT, { apiKey: "session-abc" } as never));
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type !== "done") throw new Error("expected done");
		expect(done.reason).toBe("length");
	});

	it("keeps toolUse from the Cascade stop reason even when no tool call block arrived", async () => {
		const { baseUrl } = await serveEdge({
			chat: (_req, res) => {
				res.writeHead(200, { "content-type": "application/connect+proto" });
				res.write(frame({ messageId: "m3", deltaText: "calling" }));
				res.write(frame({ messageId: "m3", stopReason: StopReason.FUNCTION_CALL }));
				res.write(trailer());
				res.end();
			},
		});

		const events = await collect(devinStream({ ...MODEL, baseUrl }, CONTEXT, { apiKey: "session-abc" } as never));
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type !== "done") throw new Error("expected done");
		expect(done.reason).toBe("toolUse");
	});

	it("keeps a truncated turn as length even when a tool call block arrived", async () => {
		const { baseUrl } = await serveEdge({
			chat: (_req, res) => {
				res.writeHead(200, { "content-type": "application/connect+proto" });
				res.write(
					frame({
						messageId: "m4",
						deltaToolCalls: [{ id: "tc-9", name: "read", argumentsJson: '{"path":"a.ts"' }],
						stopReason: StopReason.MAX_TOKENS,
					}),
				);
				res.write(trailer());
				res.end();
			},
		});

		const events = await collect(devinStream({ ...MODEL, baseUrl }, CONTEXT, { apiKey: "session-abc" } as never));
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type !== "done") throw new Error("expected done");
		expect(done.reason).toBe("length");
	});

	it("terminates a Cascade server-error stop as an error event, not a done event", async () => {
		const { baseUrl } = await serveEdge({
			chat: (_req, res) => {
				res.writeHead(200, { "content-type": "application/connect+proto" });
				res.write(frame({ messageId: "m5", deltaText: "partial" }));
				res.write(frame({ messageId: "m5", stopReason: StopReason.ERROR }));
				res.write(trailer());
				res.end();
			},
		});

		const events = await collect(devinStream({ ...MODEL, baseUrl }, CONTEXT, { apiKey: "session-abc" } as never));
		const terminal = events.at(-1);
		expect(terminal?.type).toBe("error");
		if (terminal?.type !== "error") throw new Error("expected error");
		expect(terminal.reason).toBe("error");
		expect(terminal.error.errorMessage).toBeTruthy();
	});

	it("reports an HTTP failure as a typed error message instead of throwing", async () => {
		const { baseUrl } = await serveEdge({
			chat: (_req, res) => {
				res.writeHead(403, { "content-type": "application/json" });
				res.end('{"code":"permission_denied","message":"seat required"}');
			},
		});

		const events = await collect(devinStream({ ...MODEL, baseUrl }, CONTEXT, { apiKey: "session-abc" } as never));
		const last = events.at(-1);

		expect(last?.type).toBe("error");
		if (last?.type !== "error") throw new Error("expected error");
		expect(last.reason).toBe("error");
		expect(last.error.errorMessage).toMatch(/403|seat required/);
	});

	it("ends as aborted when the caller aborts mid-stream", async () => {
		const controller = new AbortController();
		const { baseUrl } = await serveEdge({
			chat: (_req, res) => {
				res.writeHead(200, { "content-type": "application/connect+proto" });
				res.write(frame({ messageId: "m1", deltaText: "partial" }));
				setTimeout(() => controller.abort(), 10);
			},
		});

		const events = await collect(
			devinStream({ ...MODEL, baseUrl }, CONTEXT, { apiKey: "session-abc", signal: controller.signal } as never),
		);
		const last = events.at(-1);

		expect(last?.type).toBe("error");
		if (last?.type !== "error") throw new Error("expected error");
		expect(last.reason).toBe("aborted");
	});
});
