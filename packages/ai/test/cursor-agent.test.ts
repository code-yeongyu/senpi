import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentClientMessageSchema,
	AgentServerMessageSchema,
	ReadResultSchema,
} from "../src/api/cursor-agent/gen/agent_pb.ts";
import { composeShellCommand, omitUndefinedArgs, piReadArgs, piTimeout } from "../src/api/cursor-agent/pi-args.ts";
import type { CursorAgentOptions } from "../src/api/cursor-agent/types.ts";
import {
	buildCursorHistoryForTest,
	buildCursorSystemPromptJsons,
	buildMcpToolDefinitions,
	emptyGrepPatternRejection,
	frameConnectMessage,
	mergeCursorMcpToolCallArgs,
	resolveExecHandler,
	sanitizeCursorCallerHeaders,
	stream as streamCursorAgent,
} from "../src/api/cursor-agent.ts";
import type { AssistantMessageEvent, Message, Model, ToolResultMessage } from "../src/types.ts";
import { isCursorExecResolved } from "../src/utils/block-symbols.ts";
import { registerCursorExecLifecycleTests } from "./cursor-agent-exec-lifecycle.cases.ts";

const neverAbortedSignal = new AbortController().signal;

function buildModel(baseUrl: string): Model<"cursor-agent"> {
	return {
		id: "claude-4.6-opus-high",
		name: "Opus 4.6",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
}

function serverFrame(init: Parameters<typeof create<typeof AgentServerMessageSchema>>[1]): Buffer {
	return frameConnectMessage(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, init)));
}

function textDeltaFrame(text: string): Buffer {
	return serverFrame({
		message: { case: "interactionUpdate", value: { message: { case: "textDelta", value: { text } } } },
	});
}

function thinkingDeltaFrame(text: string): Buffer {
	return serverFrame({
		message: { case: "interactionUpdate", value: { message: { case: "thinkingDelta", value: { text } } } },
	});
}

function tokenDeltaFrame(tokens: number): Buffer {
	return serverFrame({
		message: { case: "interactionUpdate", value: { message: { case: "tokenDelta", value: { tokens } } } },
	});
}

function turnEndedFrame(): Buffer {
	return serverFrame({
		message: { case: "interactionUpdate", value: { message: { case: "turnEnded", value: {} } } },
	});
}

const CONNECT_END_STREAM_FLAG = 0b00000010;

function endStreamErrorFrame(code: string, message: string): Buffer {
	return frameConnectMessage(
		new TextEncoder().encode(JSON.stringify({ error: { code, message } })),
		CONNECT_END_STREAM_FLAG,
	);
}

/** Parses framed AgentClientMessages arriving from the client under test. */
class ClientFrameReader {
	#buffer: Buffer = Buffer.alloc(0);
	readonly messages: ReturnType<typeof fromBinary<typeof AgentClientMessageSchema>>[] = [];
	#waiters: Array<() => void> = [];

	feed(chunk: Buffer): void {
		this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
		while (this.#buffer.length >= 5) {
			const length = this.#buffer.readUInt32BE(1);
			if (this.#buffer.length < 5 + length) break;
			const bytes = this.#buffer.subarray(5, 5 + length);
			this.#buffer = this.#buffer.subarray(5 + length);
			this.messages.push(fromBinary(AgentClientMessageSchema, bytes));
			for (const waiter of this.#waiters.splice(0)) waiter();
		}
	}

	async waitFor<T>(select: () => T | undefined, timeoutMs = 5000): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		while (true) {
			const found = select();
			if (found !== undefined) return found;
			if (Date.now() > deadline) throw new Error("Timed out waiting for client frame");
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 25);
				this.#waiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	}
}

type ServerHandler = (
	stream: http2.ServerHttp2Stream,
	headers: http2.IncomingHttpHeaders,
	reader: ClientFrameReader,
) => void;

let server: http2.Http2Server | undefined;

async function startServer(handler: ServerHandler): Promise<string> {
	server = http2.createServer();
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		const reader = new ClientFrameReader();
		stream.on("data", (chunk: Buffer) => reader.feed(chunk));
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		handler(stream, headers, reader);
	});
	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server!.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}`;
}

async function collectStream(baseUrl: string, options: CursorAgentOptions, context?: { messages: Message[] }) {
	const events: AssistantMessageEvent[] = [];
	const stream = streamCursorAgent(
		buildModel(baseUrl),
		context ?? { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
		{ signal: neverAbortedSignal, ...options },
	);
	for await (const event of stream) {
		events.push(event);
	}
	return { events, message: await stream.result() };
}

describe("cursor-agent wire protocol", () => {
	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server!.close(() => resolve()));
			server = undefined;
		}
	});

	it("streams text, thinking, and usage, ending on turnEnded", async () => {
		const baseUrl = await startServer((stream) => {
			stream.write(thinkingDeltaFrame("pondering"));
			stream.write(textDeltaFrame("Hello "));
			stream.write(textDeltaFrame("world"));
			stream.write(tokenDeltaFrame(7));
			stream.write(turnEndedFrame());
			stream.end();
		});

		const { events, message } = await collectStream(baseUrl, { apiKey: "test-token" });

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([
			expect.objectContaining({ type: "thinking", thinking: "pondering" }),
			expect.objectContaining({ type: "text", text: "Hello world" }),
		]);
		expect(message.usage.output).toBe(7);
		expect(events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"thinking_end",
			"done",
		]);
	});

	it("sends protocol headers and sanitizes caller-supplied ones", async () => {
		let seenHeaders: http2.IncomingHttpHeaders | undefined;
		const baseUrl = await startServer((stream, headers) => {
			seenHeaders = headers;
			stream.write(textDeltaFrame("ok"));
			stream.write(turnEndedFrame());
			stream.end();
		});

		await collectStream(baseUrl, {
			apiKey: "test-token",
			headers: {
				Authorization: "Bearer attacker-token",
				Connection: "keep-alive",
				Host: "evil.example",
				"X-Trace-Id": "trace-123",
			},
		});

		expect(seenHeaders?.authorization).toBe("Bearer test-token");
		expect(seenHeaders?.["x-trace-id"]).toBe("trace-123");
		expect(seenHeaders?.["content-type"]).toBe("application/connect+proto");
		expect(seenHeaders?.["connect-protocol-version"]).toBe("1");
		expect(seenHeaders?.["x-ghost-mode"]).toBe("true");
		expect(seenHeaders?.["x-cursor-client-type"]).toBe("cli");
	});

	it("executes a server-requested read on the exec channel and pairs the transcript", async () => {
		const baseUrl = await startServer((stream, _headers, reader) => {
			void (async () => {
				// Wait for the run request, then ask the client to read a file.
				await reader.waitFor(() => reader.messages.find((message) => message.message.case === "runRequest"));
				stream.write(
					serverFrame({
						message: {
							case: "execServerMessage",
							value: {
								id: 7,
								execId: "exec-7",
								message: {
									case: "readArgs",
									value: { path: "src/main.ts", toolCallId: "call-42", offset: 5, limit: 10 },
								},
							},
						},
					}),
				);
				// Wait for the exec reply, then finish the turn.
				const reply = await reader.waitFor(() =>
					reader.messages.find(
						(message) =>
							message.message.case === "execClientMessage" &&
							message.message.value.message.case === "readResult",
					),
				);
				expect(reply.message.case).toBe("execClientMessage");
				if (reply.message.case === "execClientMessage") {
					expect(reply.message.value.id).toBe(7);
					const readResult = reply.message.value.message;
					if (readResult.case === "readResult" && readResult.value.result.case === "success") {
						expect(readResult.value.result.value.output).toEqual({
							case: "content",
							value: "file contents here",
						});
						expect(readResult.value.result.value.rangeApplied).toBe(true);
					} else {
						throw new Error("Expected a successful readResult");
					}
				}
				stream.write(textDeltaFrame("done reading"));
				stream.write(turnEndedFrame());
				stream.end();
			})();
		});

		const readCalls: unknown[] = [];
		const pairedResults: ToolResultMessage[] = [];
		const { message } = await collectStream(baseUrl, {
			apiKey: "test-token",
			execHandlers: {
				read: async (args) => {
					readCalls.push({ path: args.path, offset: args.offset, limit: args.limit });
					return {
						role: "toolResult",
						toolCallId: args.toolCallId,
						toolName: "read",
						content: [{ type: "text", text: "file contents here" }],
						isError: false,
						timestamp: Date.now(),
					};
				},
			},
			onToolResult: (result) => {
				pairedResults.push(result);
			},
		});

		expect(readCalls).toEqual([{ path: "src/main.ts", offset: 5, limit: 10 }]);
		expect(pairedResults).toHaveLength(1);
		expect(pairedResults[0].toolCallId).toBe("call-42");

		// The assistant message carries a synthesized, already-resolved toolCall
		// block so the agent loop never re-executes it.
		const toolCall = message.content.find((block) => block.type === "toolCall");
		expect(toolCall).toMatchObject({ id: "call-42", name: "read", arguments: { path: "src/main.ts" } });
		expect(isCursorExecResolved(toolCall as object)).toBe(true);
		expect(message.stopReason).toBe("stop");
	});

	it("advertises non-native tools through the requestContext handshake", async () => {
		const baseUrl = await startServer((stream, _headers, reader) => {
			void (async () => {
				await reader.waitFor(() => reader.messages.find((message) => message.message.case === "runRequest"));
				stream.write(
					serverFrame({
						message: {
							case: "execServerMessage",
							value: { id: 1, execId: "exec-1", message: { case: "requestContextArgs", value: {} } },
						},
					}),
				);
				const reply = await reader.waitFor(() =>
					reader.messages.find(
						(message) =>
							message.message.case === "execClientMessage" &&
							message.message.value.message.case === "requestContextResult",
					),
				);
				if (
					reply.message.case === "execClientMessage" &&
					reply.message.value.message.case === "requestContextResult" &&
					reply.message.value.message.value.result.case === "success"
				) {
					const tools = reply.message.value.message.value.result.value.requestContext?.tools ?? [];
					expect(tools.map((tool) => tool.name)).toEqual(["my_custom_tool"]);
					expect(tools[0].providerIdentifier).toBe("pi-agent");
				} else {
					throw new Error("Expected a successful requestContextResult");
				}
				stream.write(turnEndedFrame());
				stream.end();
			})();
		});

		const { message } = await collectStream(baseUrl, { apiKey: "test-token" }, {
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
			tools: [
				{ name: "bash", description: "native", parameters: Type.Object({}) },
				{ name: "my_custom_tool", description: "custom", parameters: Type.Object({ value: Type.String() }) },
			],
		} as never);
		expect(message.stopReason).toBe("stop");
	});

	it("surfaces Connect end-stream errors", async () => {
		const baseUrl = await startServer((stream) => {
			stream.write(endStreamErrorFrame("resource_exhausted", "quota exceeded"));
			stream.end();
		});

		const { message } = await collectStream(baseUrl, { apiKey: "test-token" });
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Connect error resource_exhausted: quota exceeded");
	});

	it("treats a stream that ends without turnEnded as incomplete", async () => {
		const baseUrl = await startServer((stream) => {
			stream.write(textDeltaFrame("partial"));
			stream.end();
		});

		const { message } = await collectStream(baseUrl, { apiKey: "test-token" });
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("ended before turnEnded");
		// Partial content is preserved on the error message.
		expect(message.content).toEqual([expect.objectContaining({ type: "text", text: "partial" })]);
	});

	it("aborts cleanly when the caller cancels mid-stream", async () => {
		const baseUrl = await startServer((stream) => {
			stream.write(textDeltaFrame("started"));
			// Then hang: the client aborts.
		});

		const controller = new AbortController();
		const events: AssistantMessageEvent[] = [];
		const stream = streamCursorAgent(
			buildModel(baseUrl),
			{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
			{ apiKey: "test-token", signal: controller.signal },
		);
		for await (const event of stream) {
			events.push(event);
			if (event.type === "text_delta") controller.abort();
		}
		const message = await stream.result();
		expect(message.stopReason).toBe("aborted");
	});

	it("fails fast without an access token", async () => {
		const { message } = await collectStream("http://127.0.0.1:1", {});
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("access token");
	});
});

describe("resolveExecHandler", () => {
	const buildFrom = (toolResult: ToolResultMessage) => `from-tool-result:${toolResult.content.length}`;
	const buildRejected = (reason: string) => `rejected:${reason}`;
	const buildError = (error: string) => `error:${error}`;
	const pairing = { toolCallId: "id-1", toolName: "read" };

	it("answers rejected and pairs an error result when no handler is installed", async () => {
		const paired: ToolResultMessage[] = [];
		const { execResult, toolResult } = await resolveExecHandler(
			{},
			undefined,
			(result) => {
				paired.push(result);
				return undefined;
			},
			buildFrom,
			buildRejected,
			buildError,
			pairing,
		);
		expect(execResult).toBe("rejected:Tool not available");
		expect(toolResult?.isError).toBe(true);
		expect(paired).toHaveLength(1);
	});

	it("derives the wire result from a returned ToolResultMessage", async () => {
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "id-1",
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 0,
		};
		const resolved = await resolveExecHandler(
			{},
			async () => toolResult,
			undefined,
			buildFrom,
			buildRejected,
			buildError,
			pairing,
		);
		expect(resolved.execResult).toBe("from-tool-result:1");
		expect(resolved.toolResult).toBe(toolResult);
	});

	it("converts a thrown handler into a typed error and pairs it", async () => {
		const paired: ToolResultMessage[] = [];
		const resolved = await resolveExecHandler(
			{},
			async () => {
				throw new Error("boom");
			},
			(result) => {
				paired.push(result);
				return undefined;
			},
			buildFrom,
			buildRejected,
			buildError,
			pairing,
		);
		expect(resolved.execResult).toBe("error:boom");
		expect(paired[0]?.isError).toBe(true);
		expect(paired[0]?.content).toEqual([{ type: "text", text: "boom" }]);
	});

	it("lets the onToolResult transformer rewrite the paired result", async () => {
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "id-1",
			toolName: "read",
			content: [{ type: "text", text: "original" }],
			isError: false,
			timestamp: 0,
		};
		const resolved = await resolveExecHandler(
			{},
			async () => toolResult,
			(result) => ({ ...result, content: [{ type: "text", text: "rewritten" }] }),
			buildFrom,
			buildRejected,
			buildError,
			pairing,
		);
		expect(resolved.toolResult?.content).toEqual([{ type: "text", text: "rewritten" }]);
	});
});

describe("cursor-agent helpers", () => {
	it("merges streamed and completion MCP args per key", () => {
		expect(
			mergeCursorMcpToolCallArgs(
				{ tasks: [{ id: 1 }], name: "streamed", keep: "streamed-only" },
				{ tasks: "[object Object]", name: "completion" },
			),
		).toEqual({
			// A string completion must not downgrade a structured streamed value.
			tasks: [{ id: 1 }],
			name: "completion",
			keep: "streamed-only",
		});
	});

	it("rejects empty grep patterns with a glob-aware hint", () => {
		expect(emptyGrepPatternRejection("real-pattern", undefined)).toBeNull();
		expect(emptyGrepPatternRejection("", "*.ts")).toContain('"*.ts"');
		expect(emptyGrepPatternRejection("  ", undefined)).toContain("pattern is required");
	});

	it("builds root prompt history with paired tool calls and results", () => {
		const messages: Message[] = [
			{ role: "user", content: "read the file", timestamp: 0 },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "reading" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } },
				],
				api: "cursor-agent",
				provider: "cursor",
				model: "m",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "contents" }],
				isError: false,
				timestamp: 0,
			},
			{ role: "user", content: "now summarize", timestamp: 0 },
		];

		const history = buildCursorHistoryForTest(messages);
		expect(history.rootPromptMessagesJson).toEqual([
			{ role: "user", content: [{ type: "text", text: "read the file" }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "reading" },
					{ type: "tool-call", toolCallId: "call-1", toolName: "read", args: { path: "a.ts" } },
				],
			},
			{
				role: "tool",
				id: "call-1",
				content: [{ type: "tool-result", toolName: "read", toolCallId: "call-1", result: "contents" }],
			},
		]);
		expect(history.turnUserMessagesJson).toHaveLength(1);
		expect(history.turnUserMessagesJson[0]).toMatchObject({ text: "read the file" });
		// One text step + one toolCall step with an embedded result.
		expect(history.turnStepMessagesJson[0]).toHaveLength(2);
	});

	it("keeps orphan tool results as bracketed assistant steps", () => {
		const messages: Message[] = [
			{ role: "user", content: "hi", timestamp: 0 },
			{
				role: "toolResult",
				toolCallId: "orphan-1",
				toolName: "bash",
				content: [{ type: "text", text: "stray output" }],
				isError: true,
				timestamp: 0,
			},
			{ role: "user", content: "next", timestamp: 0 },
		];
		const history = buildCursorHistoryForTest(messages);
		expect(JSON.stringify(history.turnStepMessagesJson)).toContain("[Tool Error]");
	});

	it("builds one default system prompt blob when none is provided", () => {
		expect(buildCursorSystemPromptJsons(undefined)).toEqual([
			JSON.stringify({ role: "system", content: "You are a helpful assistant." }),
		]);
		expect(buildCursorSystemPromptJsons("Be terse.")).toEqual([
			JSON.stringify({ role: "system", content: "Be terse." }),
		]);
	});

	it("filters Cursor-native tools out of the MCP catalog", () => {
		const tools = [
			{ name: "bash", description: "", parameters: Type.Object({}) },
			{ name: "read", description: "", parameters: Type.Object({}) },
			{ name: "edit", description: "edits", parameters: Type.Object({ path: Type.String() }) },
		];
		const definitions = buildMcpToolDefinitions(tools);
		expect(definitions.map((definition) => definition.name)).toEqual(["edit"]);
	});

	it("sanitizes caller headers for HTTP/2", () => {
		expect(
			sanitizeCursorCallerHeaders({
				":authority": "x",
				Connection: "keep-alive",
				AUTHORIZATION: "Bearer nope",
				host: "evil",
				"content-length": "5",
				"X-Custom": "keep",
			}),
		).toEqual({ "x-custom": "keep" });
	});

	it("maps pi frame args onto local tool kwargs", () => {
		expect(piReadArgs("a.ts", 3, 10)).toEqual({ path: "a.ts", offset: 3, limit: 10 });
		expect(piReadArgs("a.ts", undefined, 0)).toBeNull();
		expect(piReadArgs("a.ts", 0, undefined)).toEqual({ path: "a.ts", offset: 1, limit: undefined });
		expect(piTimeout(0)).toBe(0);
		expect(piTimeout(-5)).toBeUndefined();
		expect(piTimeout(undefined)).toBeUndefined();
		expect(composeShellCommand("ls", undefined)).toBe("ls");
		expect(composeShellCommand("ls", "/tmp/it's here")).toBe("cd '/tmp/it'\\''s here' && { ls\n}");
		expect(omitUndefinedArgs({ a: 1, b: undefined, c: "x" })).toEqual({ a: 1, c: "x" });
	});

	it("builds a read exec result envelope from a tool result", () => {
		// Sanity-check the generated schema round-trip used by result builders.
		const encoded = toBinary(
			ReadResultSchema,
			create(ReadResultSchema, {
				result: { case: "error", value: { path: "a.ts", error: "nope" } },
			}),
		);
		const decoded = fromBinary(ReadResultSchema, encoded);
		expect(decoded.result.case).toBe("error");
	});
});

registerCursorExecLifecycleTests();
