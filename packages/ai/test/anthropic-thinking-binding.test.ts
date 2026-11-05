import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stream } from "../src/api/anthropic-messages.ts";
import { THINKING_BINDING_RECOVERY_DIAGNOSTIC } from "../src/api/anthropic-thinking-binding.ts";
import { normalizeContext } from "../src/compat.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { AssistantMessage, Context, Message, Model } from "../src/types.ts";

// senpi#5587: the recorded 400 a replayed signed thinking block from another conversation prefix gets.
const RECORDED_400 = readFileSync(join(import.meta.dirname, "fixtures/anthropic-thinking-binding-400.json"), "utf8");
const BINDING_BETA = "thinking-binding-controls-2026-08-01";
const FOREIGN = "sig-foreign";

interface SentBody {
	model: string;
	messages: Array<{ role: string; content: unknown }>;
	thinking?: { type?: string; block_binding?: { prefix_mismatch_behavior?: string } };
}

interface Sent {
	betas: string[];
	body: SentBody;
	raw: string;
}

type Responder = (sent: Sent, index: number) => Response;

let responseCount = 0;

function sse(signature: string): Response {
	responseCount++;
	const id = `msg_${responseCount}`;
	const events = [
		{
			type: "message_start",
			message: { id, model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 0 } },
		},
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "fresh" } },
		{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 1 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 1 } },
		{ type: "message_stop" },
	];
	const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function rejection(body = RECORDED_400): Response {
	return new Response(body, { status: 400, headers: { "content-type": "application/json" } });
}

/** The API's behaviour: a foreign block fails the request unless the request asks for it to be dropped. */
const anthropicApi: Responder = (sent) => {
	const dropsMismatches = sent.body.thinking?.block_binding?.prefix_mismatch_behavior === "drop_block";
	return sent.raw.includes(FOREIGN) && !dropsMismatches ? rejection() : sse(`sig-fresh-${responseCount + 1}`);
};

function gatewayClaude(): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5 (gateway)",
		api: "anthropic-messages",
		provider: "custom-gateway",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

const user = (text: string, timestamp: number): Message => ({ role: "user", content: text, timestamp });

function assistant(model: Model<"anthropic-messages">, signature: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "earlier reasoning", thinkingSignature: signature },
			{ type: "toolCall", id: "toolu_read", name: "read", arguments: { path: "a.txt" } },
		],
		api: "anthropic-messages",
		provider: model.provider,
		model: model.id,
		responseId: `msg_persisted_${timestamp}`,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp,
	};
}

function poisonedHistory(model: Model<"anthropic-messages">): Message[] {
	return [
		user("read a.txt", 1),
		assistant(model, FOREIGN, 2),
		{
			role: "toolResult",
			toolCallId: "toolu_read",
			toolName: "read",
			content: [{ type: "text", text: "file body" }],
			isError: false,
			timestamp: 3,
		},
		user("summarize it", 4),
	];
}

async function run(
	model: Model<"anthropic-messages">,
	context: Context,
	respond: Responder,
	options: { sessionId?: string; headers?: Record<string, string | null> } = {},
): Promise<{ result: AssistantMessage; sent: Sent[] }> {
	const sent: Sent[] = [];
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		const header = request.headers.get("anthropic-beta") ?? "";
		const raw = await request.text();
		const entry = {
			betas: header ? header.split(",").map((beta) => beta.trim()) : [],
			body: JSON.parse(raw) as SentBody,
			raw,
		};
		sent.push(entry);
		return respond(entry, sent.length - 1);
	};
	const readTool = {
		name: "read",
		description: "Read a file",
		parameters: { type: "object", properties: {} } as never,
	};
	const result = await stream(model, normalizeContext({ tools: [readTool], ...context }), {
		apiKey: "test-key",
		cacheRetention: "none",
		thinkingEnabled: true,
		maxRetries: 0,
		fetch: fetchImpl,
		...(options.sessionId ? { sessionId: options.sessionId } : {}),
		...(options.headers ? { headers: options.headers } : {}),
	}).result();
	return { result, sent };
}

const assistantBlocks = (body: SentBody | undefined): string[] =>
	(body?.messages ?? [])
		.filter((message) => message.role === "assistant" && Array.isArray(message.content))
		.flatMap((message) => (message.content as Array<{ type: string }>).map((block) => block.type));

afterEach(() => cleanupSessionResources());

describe("a replayed thinking block bound to a different conversation (senpi#5587)", () => {
	it("asks the API to drop a mismatched block on a Claude model without supportsMidConvoEffort", async () => {
		const model = gatewayClaude();
		const { result, sent } = await run(model, { messages: poisonedHistory(model) }, anthropicApi);

		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.body.thinking?.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
		expect(sent[0]?.betas).toContain(BINDING_BETA);
	});

	it("sends no binding on a first turn or on a non-Claude model", async () => {
		const model = gatewayClaude();
		const first = await run(model, { messages: [user("hi", 1)] }, anthropicApi);
		expect(first.sent[0]?.body.thinking?.block_binding).toBeUndefined();
		expect(first.sent[0]?.betas).not.toContain(BINDING_BETA);

		const glm = { ...model, id: "glm-5.3", name: "GLM" };
		const other = await run(glm, { messages: poisonedHistory(glm) }, () => sse("sig"));
		expect(other.sent[0]?.body.thinking?.block_binding).toBeUndefined();
	});

	it("rebuilds once without the binding when the transport refuses the control", async () => {
		const model = gatewayClaude();
		const refused = JSON.stringify({
			type: "error",
			error: { type: "invalid_request_error", message: "thinking.block_binding: Extra inputs are not permitted" },
		});
		const { result, sent } = await run(model, { messages: poisonedHistory(model) }, (request) =>
			request.body.thinking?.block_binding ? rejection(refused) : sse("sig-fresh"),
		);

		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(sent).toHaveLength(2);
		expect(sent[1]?.body.thinking?.block_binding).toBeUndefined();
	});

	it("on exactly this 400 retries once on the same model without replayed thinking, with a diagnostic and a log line", async () => {
		const model = gatewayClaude();
		const dir = mkdtempSync(join(tmpdir(), "thinking-binding-"));
		const logPath = join(dir, "shape.jsonl");
		process.env.SENPI_DEBUG_REQUEST_SHAPE = logPath;
		try {
			const { result, sent } = await run(model, { messages: poisonedHistory(model) }, anthropicApi, {
				headers: { "anthropic-beta": null },
			});

			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(sent).toHaveLength(2);
			expect(sent.map((request) => request.body.model)).toEqual([model.id, model.id]);
			expect(sent[0]?.raw).toContain(FOREIGN);
			expect(sent[1]?.raw).not.toContain(FOREIGN);
			expect(assistantBlocks(sent[1]?.body)).toEqual(["tool_use"]);
			expect(sent[1]?.raw).toContain("file body");
			expect(sent[1]?.raw).toContain("summarize it");
			expect(
				result.diagnostics?.find((entry) => entry.type === THINKING_BINDING_RECOVERY_DIAGNOSTIC)?.details,
			).toEqual(expect.objectContaining({ removedThinkingBlocks: 1 }));
			const log = readFileSync(logPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { recovery?: string });
			expect(log.filter((line) => line.recovery === "thinking_binding_mismatch")).toHaveLength(1);
		} finally {
			delete process.env.SENPI_DEBUG_REQUEST_SHAPE;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ends with one actionable error when the rebuilt request is refused the same way", async () => {
		const model = gatewayClaude();
		const { result, sent } = await run(model, { messages: poisonedHistory(model) }, () => rejection(), {
			headers: { "anthropic-beta": null },
		});

		expect(sent).toHaveLength(2);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Start a new session to continue.");
		expect(result.providerDiagnostic).toMatchObject({ category: "invalid_request", httpStatus: 400 });
	});

	it("does not retry an unrelated 400", async () => {
		const model = gatewayClaude();
		const other = JSON.stringify({
			type: "error",
			error: { type: "invalid_request_error", message: "max_tokens: too large" },
		});
		const { result, sent } = await run(model, { messages: poisonedHistory(model) }, () => rejection(other), {
			headers: { "anthropic-beta": null },
		});

		expect(sent).toHaveLength(1);
		expect(result.stopReason).toBe("error");
	});

	it("strips the rejected turns before send on later beta-suppressed turns of the same session", async () => {
		const model = gatewayClaude();
		const options = { sessionId: "session-b", headers: { "anthropic-beta": null } };
		const history = poisonedHistory(model);
		const firstTurn = await run(model, { messages: history }, anthropicApi, options);
		expect(firstTurn.sent).toHaveLength(2);

		const next = await run(
			model,
			{ messages: [...history, firstTurn.result, user("and now?", 5)] },
			anthropicApi,
			options,
		);

		expect(next.result.stopReason, next.result.errorMessage).toBe("stop");
		expect(next.sent).toHaveLength(1);
		expect(next.sent[0]?.raw).not.toContain(FOREIGN);
		expect(next.sent[0]?.raw).toContain(
			firstTurn.result.content.find((block) => block.type === "thinking")?.thinkingSignature,
		);
		expect(next.sent[0]?.betas).toEqual([]);
	});

	it("lets a revived session whose stored history holds the rejected block finish its next turn", async () => {
		for (const headers of [undefined, { "anthropic-beta": null }]) {
			const model = gatewayClaude();
			const { result } = await run(model, { messages: poisonedHistory(model) }, anthropicApi, {
				sessionId: `revived-${headers === undefined ? "bound" : "suppressed"}`,
				...(headers ? { headers } : {}),
			});
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(result.content.some((block) => block.type === "text" && block.text === "ok")).toBe(true);
		}
	});
});
