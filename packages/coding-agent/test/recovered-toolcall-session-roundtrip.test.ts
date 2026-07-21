import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, type Message, Type } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { closeServer, runScenario as runAnthropicScenario } from "./support/anthropic-recovery-wire.ts";
import { runScenario as runOpenAIScenario } from "./support/openai-recovery-wire.ts";

const INVOKE_XML = '<antml:invoke name="Echo"><antml:parameter name="value">hello</antml:parameter>';
const XML_PATTERN = /<\/?(?:antml:)?(?:invoke|parameter)/u;
const RETRY_GUIDANCE = "Re-issue the tool call with complete arguments.";
const servers: Server[] = [];
let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "senpi-recovered-roundtrip-"));
});

afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
	rmSync(tempDir, { recursive: true, force: true });
});

function isModelMessage(message: AgentMessage): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

async function recoveredMessages(api: Api, scenario: "complete" | "truncated") {
	const result =
		api === "anthropic-messages" ? await runAnthropicScenario(scenario) : await runOpenAIScenario(scenario);
	servers.push(result.endpoint.server);
	const toolResultIndex = result.session.messages.findIndex((message) => message.role === "toolResult");
	if (toolResultIndex < 0) throw new Error("Expected the agent loop to produce a tool result");
	const messages = result.session.messages.slice(0, toolResultIndex + 1).filter(isModelMessage);
	result.session.dispose();
	return messages;
}

function persistAndReload(messages: Awaited<ReturnType<typeof recoveredMessages>>) {
	const sessionDir = mkdtempSync(join(tempDir, "session-"));
	const session = SessionManager.create(sessionDir, tempDir);
	for (const message of messages) session.appendMessage(message);
	const sessionFile = session.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	const reloaded = SessionManager.open(sessionFile, tempDir);
	const reloadedMessages = reloaded
		.getEntries()
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message);
	expect(reloadedMessages).toEqual(messages);
	expect(JSON.stringify(reloadedMessages)).not.toMatch(XML_PATTERN);
	return reloaded;
}

async function startReplayServer(api: Api) {
	let rawBody = "";
	const server = createServer(async (request, response) => {
		const chunks: Uint8Array[] = [];
		for await (const chunk of request) chunks.push(chunk);
		rawBody = Buffer.concat(chunks).toString("utf8");
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (api === "anthropic-messages") {
			const events = [
				[
					"message_start",
					{ type: "message_start", message: { id: "replay", usage: { input_tokens: 1, output_tokens: 0 } } },
				],
				[
					"content_block_start",
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				],
				[
					"content_block_delta",
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
				],
				["content_block_stop", { type: "content_block_stop", index: 0 }],
				[
					"message_delta",
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
				],
				["message_stop", { type: "message_stop" }],
			] as const;
			for (const [event, data] of events) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
		} else {
			const chunk = {
				id: "replay",
				object: "chat.completion.chunk",
				created: 0,
				model: "replay-model",
				choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
			};
			response.write(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
		}
		response.end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	servers.push(server);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected replay server address");
	return { baseUrl: `http://127.0.0.1:${address.port}`, rawBody: () => rawBody };
}

async function replay(api: Api, session: SessionManager): Promise<string> {
	const endpoint = await startReplayServer(api);
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	await runtime.registerProvider(`replay-${api}`, {
		name: "Recovered history replay",
		api,
		apiKey: "mock-key",
		baseUrl: endpoint.baseUrl,
		models: [
			{
				id: "replay-model",
				name: "Replay model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 10_000,
				maxTokens: 100,
			},
		],
	});
	const model = runtime.getModel(`replay-${api}`, "replay-model");
	if (!model) throw new Error("Expected replay model");
	await runtime.complete(model, {
		messages: session.buildSessionContext().messages.filter(isModelMessage),
		tools: [{ name: "Echo", description: "Echo a value", parameters: Type.Object({ value: Type.String() }) }],
	});
	return endpoint.rawBody();
}

function recoveredAssistant(session: SessionManager): AssistantMessage {
	const message = session
		.buildSessionContext()
		.messages.find(
			(candidate) => candidate.role === "assistant" && candidate.content.some((block) => block.type === "toolCall"),
		);
	if (message?.role !== "assistant") throw new Error("Expected recovered assistant message");
	return message;
}

function expectNativeReplay(api: Api, rawBody: string, incomplete: boolean): void {
	const body = JSON.parse(rawBody) as { messages: Array<Record<string, unknown>> };
	expect(rawBody).not.toMatch(XML_PATTERN);
	if (api === "anthropic-messages") {
		const assistant = body.messages.find((message) => message.role === "assistant")!;
		const result = body.messages.find(
			(message) => message.role === "user" && JSON.stringify(message).includes("tool_result"),
		)!;
		expect(assistant.content).toContainEqual({
			type: "tool_use",
			id: "recovered-antml-0",
			name: "Echo",
			input: incomplete ? {} : { value: "hello" },
		});
		expect(result.content).toContainEqual(
			expect.objectContaining({
				type: "tool_result",
				tool_use_id: "recovered-antml-0",
				...(incomplete ? { is_error: true } : {}),
			}),
		);
	} else {
		const assistant = body.messages.find((message) => Array.isArray(message.tool_calls))!;
		const result = body.messages.find((message) => message.role === "tool")!;
		expect(assistant.tool_calls).toEqual([
			{
				id: "recovered-antml-0",
				type: "function",
				function: { name: "Echo", arguments: incomplete ? "{}" : '{"value":"hello"}' },
			},
		]);
		expect(result).toMatchObject({ role: "tool", tool_call_id: "recovered-antml-0" });
	}
	if (incomplete) expect(rawBody).toContain(RETRY_GUIDANCE);
}

describe("recovered tool-call session round-trip", () => {
	it("persists actual complete recovery output and replays native wire calls after reload", async () => {
		for (const api of ["anthropic-messages", "openai-completions"] as const) {
			const actual = await recoveredMessages(api, "complete");
			const original = actual.find((message) => message.role === "assistant") as AssistantMessage;
			const reloaded = persistAndReload(actual);
			const assistant = recoveredAssistant(reloaded);
			expect(assistant.content).toContainEqual(
				expect.objectContaining({ type: "toolCall", arguments: { value: "hello" } }),
			);
			expect(assistant.diagnostics).toEqual(original.diagnostics);
			expectNativeReplay(api, await replay(api, reloaded), false);
		}
	});

	it("persists actual truncated recovery flags and replays safe-fail results", async () => {
		for (const api of ["anthropic-messages", "openai-completions"] as const) {
			const actual = await recoveredMessages(api, "truncated");
			const original = actual.find((message) => message.role === "assistant") as AssistantMessage;
			const reloaded = persistAndReload(actual);
			const assistant = recoveredAssistant(reloaded);
			expect(assistant.content).toContainEqual(
				expect.objectContaining({
					type: "toolCall",
					arguments: {},
					incomplete: true,
					errorMessage: "Tool call stream ended before completion",
				}),
			);
			expect(assistant.diagnostics).toEqual(original.diagnostics);
			expectNativeReplay(api, await replay(api, reloaded), true);
		}
	});

	it("does not rewrite legacy plain invoke history on open or resume", () => {
		const sessionDir = mkdtempSync(join(tempDir, "legacy-"));
		const session = SessionManager.create(sessionDir, tempDir);
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: INVOKE_XML }],
			api: "anthropic-messages",
			provider: "legacy",
			model: "claude-legacy",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected legacy session file");
		const before = readFileSync(sessionFile);
		const opened = SessionManager.open(sessionFile, tempDir);
		expect(readFileSync(sessionFile)).toEqual(before);
		expect(opened.buildSessionContext().messages[0]).toMatchObject({
			content: [{ type: "text", text: INVOKE_XML }],
		});
		SessionManager.continueRecent(tempDir, sessionDir);
		expect(readFileSync(sessionFile)).toEqual(before);
	});
});
