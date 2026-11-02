import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	defaultExecutableDeps,
	resolveClaudeCodeExecutable,
} from "../../../src/core/extensions/builtin/anthropic-subscription/executable.ts";
import { CONTINUE_TURN_INSTRUCTION } from "../../../src/core/extensions/builtin/anthropic-subscription/prompt-bridge.ts";
import { forgetBinding } from "../../../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import { closeSession } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { installAmbientLane, resetScriptedSdk } from "../../helpers/anthropic-subscription-scripted-sdk.ts";

// A cold seed against the real Claude Code binary and a local fake Messages endpoint that records every request.
// No account and no model: the endpoint answers each request with a fixed one-text turn (or a scripted 400).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const executable = (() => {
	try {
		return resolveClaudeCodeExecutable({ ...defaultExecutableDeps(), env: () => undefined });
	} catch {
		return undefined;
	}
})();

type Block = {
	type: string;
	text?: string;
	id?: string;
	tool_use_id?: string;
	content?: unknown;
	cache_control?: unknown;
};
type WireMessage = { role: string; content: string | Block[] };

const model: Model<Api> = {
	id: "claude-sonnet-4-5",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "claude-sdk-oauth",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function assistant(
	content: AssistantMessage["content"],
	timestamp: number,
	from: Pick<AssistantMessage, "api" | "provider" | "model"> = {
		api: model.api,
		provider: model.provider,
		model: model.id,
	},
): AssistantMessage {
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
	return {
		role: "assistant",
		content,
		...from,
		usage: { ...zero, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp,
	};
}

function screenshotHistory(finalUser: boolean): Context {
	const messages: Message[] = [
		{ role: "user", content: "U1 inspect the page", timestamp: 1 },
		assistant(
			[
				{ type: "text", text: "A1 taking a screenshot" },
				{ type: "toolCall", id: "call_x|fc_y", name: "screenshot", arguments: {} },
			],
			2,
			// The session switched from another provider, whose tool call ids the Anthropic API does not accept.
			{ api: "openai-responses", provider: "openai", model: "gpt-5" },
		),
		{
			role: "toolResult",
			toolCallId: "call_x|fc_y",
			toolName: "screenshot",
			content: [
				{ type: "text", text: "TR1 page captured" },
				{ type: "image", mimeType: "image/png", data: PNG },
			],
			isError: false,
			timestamp: 3,
		},
	];
	if (finalUser) messages.push(assistant([{ type: "text", text: "A2 the page is blank" }], 4));
	if (finalUser) messages.push({ role: "user", content: "NEW QUESTION", timestamp: 5 });
	return { systemPrompt: "SYSTEM", messages };
}

function sse(text: string): string {
	const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
	const usage = { input_tokens: 1, output_tokens: 1 };
	return [
		event("message_start", {
			type: "message_start",
			message: { id: "msg_fake", type: "message", role: "assistant", model: model.id, content: [], usage },
		}),
		event("content_block_start", {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
		event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
		event("content_block_stop", { type: "content_block_stop", index: 0 }),
		event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage }),
		event("message_stop", { type: "message_stop" }),
	].join("");
}

const servers: Server[] = [];
const roots: string[] = [];
const sessionIds: string[] = [];

async function fakeMessagesApi(reject: (messages: WireMessage[]) => boolean = () => false) {
	const requests: WireMessage[][] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf8");
		});
		request.on("end", () => {
			const parsed = body ? (JSON.parse(body) as { messages?: WireMessage[] }) : {};
			if (request.method !== "POST" || !request.url?.startsWith("/v1/messages") || !parsed.messages) {
				response.writeHead(200, { "content-type": "application/json" }).end("{}");
				return;
			}
			requests.push(parsed.messages);
			if (reject(parsed.messages)) {
				const error = { type: "invalid_request_error", message: "messages.1.content.1: unexpected tool_use block" };
				response
					.writeHead(400, { "content-type": "application/json" })
					.end(JSON.stringify({ type: "error", error }));
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream" }).end(sse("PROBE-OK"));
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

async function laneAgainst(url: string, provider: Record<string, unknown> = {}): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), "senpi-1977-frames-"));
	roots.push(root);
	const cwd = join(root, "work");
	mkdirSync(cwd);
	installAmbientLane({
		PATH: process.env.PATH ?? "",
		HOME: join(root, "home"),
		CLAUDE_CONFIG_DIR: join(root, "claude-config"),
		ANTHROPIC_BASE_URL: url,
		ANTHROPIC_API_KEY: "sk-ant-fake-1977",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
	});
	process.env.CLAUDE_CODE_EXECUTABLE = executable;
	writeFileSync(
		join(process.env.SENPI_CODING_AGENT_DIR ?? "", "settings.json"),
		JSON.stringify({ claudeSdkOauthProvider: { tokenInjection: "ambient", ...provider } }),
	);
	return cwd;
}

async function turn(context: Context, cwd: string, sessionId: string) {
	sessionIds.push(sessionId);
	return streamAnthropicSubscription(model, context, { cwd, sessionId, streamKind: "main" }).result();
}

function blocks(message: WireMessage | undefined): Block[] {
	if (message === undefined) return [];
	return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

function texts(messages: readonly WireMessage[]): string {
	return messages.flatMap((message) => blocks(message).map((block) => block.text ?? "")).join("\n");
}

function shape(messages: readonly WireMessage[]): string[] {
	return messages.map((message) => `${message.role}[${blocks(message).map((block) => block.type)}]`);
}

function continuityDetails(result: AssistantMessage): Record<string, unknown>[] {
	return (result.diagnostics ?? [])
		.filter((diagnostic) => diagnostic.type === "claude_sdk_oauth_session_continuity")
		.map((diagnostic) => diagnostic.details as Record<string, unknown>);
}

function expectNativeHistory(messages: readonly WireMessage[]): void {
	expect(shape(messages.slice(0, 3))).toEqual(["user[text]", "assistant[text,tool_use]", "user[tool_result]"]);
	const toolUse = blocks(messages[1]).find((block) => block.type === "tool_use");
	const toolResult = blocks(messages[2])[0];
	expect(toolUse?.id).toMatch(/^[a-zA-Z0-9_-]+$/);
	expect(toolResult?.tool_use_id).toBe(toolUse?.id);
	expect((toolResult?.content as Block[] | undefined)?.map((block) => block.type)).toEqual(["text", "image"]);
	expect(texts(messages)).not.toContain("<conversation_history>");
	expect(texts(messages)).not.toContain("[Image: source");
}

afterEach(async () => {
	for (const id of sessionIds.splice(0)) {
		closeSession(id, "test_cleanup");
		forgetBinding(id);
	}
	resetScriptedSdk();
	await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(executable !== undefined)("senpi#1977: a cold seed replays the history as native frames", () => {
	it("resident lane: native turns in order, the image inside its tool_result, one senpi tail breakpoint", async () => {
		const api = await fakeMessagesApi();
		const cwd = await laneAgainst(api.url);

		const result = await turn(screenshotHistory(true), cwd, "frames-resident");

		expect(result.errorMessage).toBeUndefined();
		expect(api.requests).toHaveLength(1);
		const messages = api.requests[0] ?? [];
		expectNativeHistory(messages);
		expect(shape(messages.slice(3, 4))).toEqual(["assistant[text]"]);
		expect(blocks(messages[3]).filter((block) => block.cache_control)).toEqual([
			{ type: "text", text: "A2 the page is blank", cache_control: { type: "ephemeral", ttl: "1h" } },
		]);
		expect(blocks(messages.at(-1)).some((block) => block.text === "NEW QUESTION")).toBe(true);
		expect(blocks(messages.at(-1)).some((block) => block.type === "image")).toBe(false);
	}, 60_000);

	it("one-shot lane: the same native frames through the session store", async () => {
		const api = await fakeMessagesApi();
		const cwd = await laneAgainst(api.url, { resumeMode: "off" });

		const result = await turn(screenshotHistory(true), cwd, "frames-one-shot");

		expect(result.errorMessage).toBeUndefined();
		expect(api.requests).toHaveLength(1);
		expectNativeHistory(api.requests[0] ?? []);
	}, 60_000);

	it("a history ending on a tool result keeps the image there and sends only the continue-turn instruction", async () => {
		const api = await fakeMessagesApi();
		const cwd = await laneAgainst(api.url);

		await turn(screenshotHistory(false), cwd, "frames-continue");

		const messages = api.requests[0] ?? [];
		expectNativeHistory(messages);
		const last = blocks(messages.at(-1));
		expect(last.some((block) => block.text === CONTINUE_TURN_INSTRUCTION)).toBe(true);
		expect(last.some((block) => block.type === "image")).toBe(false);
	}, 60_000);

	it("coldSeedReplay flat keeps the single conversation_history message", async () => {
		const api = await fakeMessagesApi();
		const cwd = await laneAgainst(api.url, { coldSeedReplay: "flat" });

		await turn(screenshotHistory(true), cwd, "frames-flatten");

		expect(api.requests).toHaveLength(1);
		expect(api.requests[0]?.map((message) => message.role)).toEqual(["user"]);
		expect(texts(api.requests[0] ?? [])).toContain("<conversation_history>");
	}, 60_000);

	it("a frames seed the API rejects before any output falls back to the flat replay once", async () => {
		const api = await fakeMessagesApi((messages) => messages.length > 1);
		const cwd = await laneAgainst(api.url);

		const result = await turn(screenshotHistory(true), cwd, "frames-rejected");

		// Claude Code retries the rejected request once itself; then senpi re-sends flat, which is answered.
		const framesRequests = api.requests.map((messages) => messages.length > 1);
		expect(result.errorMessage).toBeUndefined();
		expect(framesRequests.indexOf(false)).toBeGreaterThan(0);
		expect(framesRequests.slice(framesRequests.indexOf(false))).toEqual([false]);
		expect(texts(api.requests[framesRequests.indexOf(false)] ?? [])).toContain("<conversation_history>");
		expect(continuityDetails(result)).toEqual([
			expect.objectContaining({ kind: "flatten", reason: "frames_seed_rejected", replayMode: "flat" }),
		]);
	}, 60_000);

	it("a flat replay that is rejected too ends the turn: no second fallback", async () => {
		const api = await fakeMessagesApi(() => true);
		const cwd = await laneAgainst(api.url);

		const result = await turn(screenshotHistory(true), cwd, "frames-rejected-twice");

		// Claude Code may retry a rejected request on its own; senpi switches from frames to flat exactly once.
		const framesRequests = api.requests.map((messages) => messages.length > 1);
		expect(result.stopReason).toBe("error");
		expect(framesRequests[0]).toBe(true);
		expect(framesRequests.slice(framesRequests.indexOf(false))).not.toContain(true);
		expect(framesRequests).toContain(false);
	}, 60_000);
});
