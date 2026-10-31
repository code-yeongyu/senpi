import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { finalTextResponse } from "./anthropic-tool-reference-harness.ts";

/**
 * senpi #3201: a web search result's `encrypted_content` is only valid for the
 * account that ran the search, and every same-model request another account
 * serves fails with "Invalid `encrypted_content` in `search_result` block". The
 * provider retries with the expired pair demoted to text, keeps newer pairs
 * verbatim, and remembers the demotion for the session.
 */

const MODEL_ID = "claude-sonnet-4-6";
const EXPIRED = "messages.1.content.0: Invalid `encrypted_content` in `search_result` block";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function searchTurn(id: string, query: string, ciphertext: string): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: MODEL_ID,
		content: [
			{
				type: "providerNative",
				subtype: "server_tool_use",
				raw: { type: "server_tool_use", id, name: "web_search", input: { query } },
			},
			{
				type: "providerNative",
				subtype: "web_search_tool_result",
				raw: {
					type: "web_search_tool_result",
					tool_use_id: id,
					content: [
						{
							type: "web_search_result",
							title: `${query} docs`,
							url: `https://example.com/${id}`,
							page_age: null,
							encrypted_content: ciphertext,
						},
					],
				},
			},
			{ type: "text", text: `answered ${query}` },
		],
		usage,
		stopReason: "stop",
		timestamp: 1,
	};
}

const context: Context = {
	messages: [
		{ role: "user", content: "search old", timestamp: 1 },
		searchTurn("srvtoolu_old", "old query", "stale-ciphertext"),
		{ role: "user", content: "search new", timestamp: 2 },
		searchTurn("srvtoolu_new", "new query", "fresh-ciphertext"),
		{ role: "user", content: "go on", timestamp: 3 },
	],
};

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

async function withEndpoint(
	rejection: (rawBody: string) => string | undefined,
	body: (model: Model<"anthropic-messages">) => Promise<void>,
): Promise<string[]> {
	const requests: string[] = [];
	const okBody = await finalTextResponse().text();
	const server = createServer(async (request, response) => {
		const raw = await readBody(request);
		requests.push(raw);
		const message = rejection(raw);
		if (message !== undefined) {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(okBody);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	const base = getModel("anthropic", MODEL_ID);
	const model = {
		...base,
		baseUrl: `http://127.0.0.1:${address.port}`,
		compat: { ...base.compat, supportsWebSearch: true },
	};
	try {
		await body(model);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
	return requests;
}

async function run(model: Model<"anthropic-messages">, sessionId: string) {
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

function assistantContent(rawBody: string, index: number): unknown {
	return JSON.parse(rawBody).messages[index].content;
}

describe("Anthropic expired web search replay (#3201)", () => {
	it("retries with the expired search demoted to text, keeps the newer search verbatim, and remembers it", async () => {
		const stalePayload = (raw: string) => (raw.includes("stale-ciphertext") ? EXPIRED : undefined);
		const results: Array<{ stopReason: string }> = [];
		const requests = await withEndpoint(stalePayload, async (model) => {
			try {
				results.push(await run(model, "expired-search-session"));
				results.push(await run(model, "expired-search-session"));
			} finally {
				cleanupSessionResources("expired-search-session");
			}
		});

		expect(results.map((result) => result.stopReason)).toEqual(["stop", "stop"]);
		expect(requests).toHaveLength(3);
		expect(requests[0]).toContain("stale-ciphertext");
		for (const body of requests.slice(1)) {
			expect(body).not.toContain("stale-ciphertext");
			expect(assistantContent(body, 1)).toEqual([
				{ type: "text", text: "Searched the web for: old query" },
				{
					type: "text",
					text: "Web search results (page contents no longer available):\n- old query docs (https://example.com/srvtoolu_old)",
				},
				{ type: "text", text: "answered old query" },
			]);
			expect(assistantContent(body, 3)).toEqual(assistantContent(requests[0], 3));
			expect(body).toContain('"encrypted_content":"fresh-ciphertext"');
		}
	});

	it("does not retry another 400 and keeps replaying the search verbatim", async () => {
		let result: { stopReason: string; errorMessage?: string } | undefined;
		const requests = await withEndpoint(
			() => "messages.1.content.0: some other validation failure",
			async (model) => {
				result = await run(model, "other-400-session");
			},
		);

		expect(requests).toHaveLength(1);
		expect(result?.stopReason).toBe("error");
		expect(requests[0]).toContain("stale-ciphertext");
	});
});
