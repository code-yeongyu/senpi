import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { stream } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

const adapters = [
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
] as const;

function sse(data: unknown): string {
	return `data: ${JSON.stringify(data)}\n\n`;
}

const completionsAnswer =
	sse({
		id: "chatcmpl-test",
		choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" }],
	}) + "data: [DONE]\n\n";

const responseItem = { type: "message", id: "msg_test", role: "assistant" };
const responsesAnswer = [
	{ type: "response.output_item.added", item: { ...responseItem, status: "in_progress", content: [] } },
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "Hello" },
	{
		type: "response.output_item.done",
		item: { ...responseItem, status: "completed", content: [{ type: "output_text", text: "Hello" }] },
	},
	{ type: "response.completed", response: { id: "resp_test", status: "completed" } },
]
	.map(sse)
	.join("");

it.each(adapters)("%s reports each SSE keep-alive chunk before the first data event", async (api) => {
	const firstActivity = Promise.withResolvers<void>();
	const secondActivity = Promise.withResolvers<void>();
	let activityCount = 0;
	let activityBeforeData = 0;
	const server = createServer((request, response) => {
		request.resume();
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(": first keep-alive\n\n");
		// Wait for each chunk to be observed before writing the next one, so they can't coalesce.
		void firstActivity.promise.then(() => response.write(": second keep-alive\n\n"));
		void secondActivity.promise.then(() => {
			activityBeforeData = activityCount;
			response.end(api === "openai-completions" ? completionsAnswer : responsesAnswer);
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected a local TCP address");
		const baseUrl = `http://127.0.0.1:${address.port}/v1`;
		const model: Model<(typeof adapters)[number]> = {
			id: "test-model",
			name: "Test Model",
			api,
			provider: "test-openai",
			baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 1024,
		};
		const result = await stream(
			model,
			{ messages: [{ role: "user", content: "Hi", timestamp: 0 }] },
			{
				apiKey: "test-key",
				azureBaseUrl: baseUrl,
				transport: "sse",
				maxRetries: 0,
				signal: AbortSignal.timeout(3000),
				onTransportActivity: () => {
					activityCount++;
					if (activityCount === 1) firstActivity.resolve();
					if (activityCount === 2) secondActivity.resolve();
				},
			},
		).result();

		expect(activityBeforeData, "activity from comment-only chunks").toBe(2);
		expect(activityCount).toBeGreaterThan(activityBeforeData);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "Hello" })]);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
