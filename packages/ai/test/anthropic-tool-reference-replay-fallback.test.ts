import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { demoteToolReferenceReplay } from "../src/api/anthropic-tool-references.ts";
import { getModel } from "../src/compat.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { Context, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { finalTextResponse, makeTool, nativeSearchTurn, userMessage } from "./anthropic-tool-reference-harness.ts";

/**
 * senpi #2568: an Anthropic-compatible endpoint ran a native tool search inside
 * one request, then rejected the next request that replayed the search result
 * with "Tool reference 'generate_image' not found in available tools" although
 * `tools` defined `generate_image`. Every later request replayed the same
 * history, so the session stayed wedged. The provider retries such a rejection
 * once with the reference replay demoted to text and keeps doing so for the
 * session.
 */

const REJECTION = "Tool reference 'generate_image' not found in available tools";

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

async function withRejectingEndpoint(
	rejects: (rawBody: string) => boolean,
	body: (model: Model<"anthropic-messages">) => Promise<void>,
): Promise<string[]> {
	const requests: string[] = [];
	const okBody = await finalTextResponse().text();
	const server = createServer(async (request, response) => {
		const raw = await readBody(request);
		requests.push(raw);
		if (rejects(raw)) {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: REJECTION } }));
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(okBody);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	const model = { ...getModel("anthropic", "claude-sonnet-4-6"), baseUrl: `http://127.0.0.1:${address.port}` };
	try {
		await body(model);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
	return requests;
}

async function run(model: Model<"anthropic-messages">, context: Context, sessionId: string) {
	const response = streamAnthropic(model, normalizeContext(context), {
		apiKey: "test-key",
		cacheRetention: "none",
		sessionId,
		maxRetries: 0,
	});
	for await (const event of response) {
		if (event.type === "done" || event.type === "error") break;
	}
	return response.result();
}

describe("Anthropic tool-reference replay fallback", () => {
	it("retries a rejected native search replay as text and keeps text replay for the session (#2568)", async () => {
		const context: Context = {
			messages: [userMessage("make an image"), nativeSearchTurn(["generate_image", "task"]), userMessage("go on")],
			tools: [makeTool("read"), makeTool("generate_image"), makeTool("task")],
		};
		const results: Array<{ stopReason: string; errorMessage?: string }> = [];

		const replaysReference = (raw: string) => raw.includes('"tool_reference"');
		const requests = await withRejectingEndpoint(replaysReference, async (model) => {
			try {
				results.push(await run(model, context, "replay-session"));
				results.push(await run(model, context, "replay-session"));
			} finally {
				cleanupSessionResources("replay-session");
			}
		});

		expect(results.map((result) => result.stopReason)).toEqual(["stop", "stop"]);
		expect(requests).toHaveLength(3);
		expect(requests[0]).toContain('"tool_reference"');
		for (const body of requests.slice(1)) {
			expect(body).not.toContain('"tool_reference"');
			expect(body).not.toContain('"server_tool_use"');
			expect(body).toContain("Tool search found: generate_image, task");
			expect(JSON.parse(body).tools.map((tool: { name: string }) => tool.name)).toContain("generate_image");
		}
	});

	it("does not retry the rejection when the history replays no tool reference", async () => {
		const context: Context = {
			messages: [userMessage("hello")],
			tools: [makeTool("read")],
		};
		let result: { stopReason: string; errorMessage?: string } | undefined;

		const requests = await withRejectingEndpoint(
			() => true,
			async (model) => {
				result = await run(model, context, "no-reference-session");
			},
		);

		expect(requests).toHaveLength(1);
		expect(result?.stopReason).toBe("error");
		expect(result?.errorMessage).toContain(REJECTION);
	});
});

describe("a demoted tool_reference replay keeps the found tools callable (senpi #2568)", () => {
	it("sends every tool a demoted reference named without defer_loading, and leaves other deferred tools deferred", () => {
		const params = {
			model: "claude-test",
			max_tokens: 1024,
			stream: true,
			tools: [
				{ name: "read", input_schema: { type: "object" } },
				{ name: "generate_image", input_schema: { type: "object" }, defer_loading: true },
				{ name: "task", input_schema: { type: "object" }, defer_loading: true },
				{ name: "web_fetch", input_schema: { type: "object" }, defer_loading: true },
			],
			messages: [
				{ role: "user", content: "make an image" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "call_1", name: "tool_search", input: { query: "image" } }],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "call_1",
							content: [
								{ type: "tool_reference", tool_name: "generate_image" },
								{ type: "tool_reference", tool_name: "task" },
							],
						},
					],
				},
			],
		} as unknown as Parameters<typeof demoteToolReferenceReplay>[0];

		const demoted = demoteToolReferenceReplay(params) as unknown as { tools: Array<Record<string, unknown>> };
		const byName = new Map(demoted.tools.map((tool) => [tool.name, tool]));

		expect(byName.get("generate_image")?.defer_loading).toBeUndefined();
		expect(byName.get("task")?.defer_loading).toBeUndefined();
		expect(byName.get("web_fetch")?.defer_loading).toBe(true);
		expect(byName.get("read")?.defer_loading).toBeUndefined();
	});

	it("leaves the tools untouched when the history replays no reference", () => {
		const params = {
			model: "claude-test",
			max_tokens: 1024,
			stream: true,
			tools: [{ name: "generate_image", input_schema: { type: "object" }, defer_loading: true }],
			messages: [{ role: "user", content: "hello" }],
		} as unknown as Parameters<typeof demoteToolReferenceReplay>[0];

		expect(demoteToolReferenceReplay(params)).toBe(params);
	});
});
