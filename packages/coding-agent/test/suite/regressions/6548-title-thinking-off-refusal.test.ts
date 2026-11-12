import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import { generateSessionTitle } from "../../../src/core/session-title-generator.ts";

// senpi#6548: an always-thinking model refuses a thinking-off title request in its own words (here Chinese,
// "this model always thinks; thinking cannot be disabled; use low, high or max"). The title must retry with
// reasoning instead of failing, as it does for the English "reasoning is mandatory" refusal (#2163).
const ALWAYS_THINKS = "该模型始终思考，不支持关闭思考；请使用 low、high 或 max。";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
	await close?.();
	close = undefined;
});

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>));
		request.on("error", reject);
	});
}

it("retries a refused thinking-off title request with reasoning when the refusal is not in English", async () => {
	const efforts: Array<string | undefined> = [];
	const server = createServer(async (request, response) => {
		const body = await readJson(request);
		const effort = (body.reasoning as { effort?: string } | undefined)?.effort;
		efforts.push(effort);
		if (effort === "none") {
			response.writeHead(400, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: ALWAYS_THINKS, code: 400 } }));
			return;
		}
		const chunk = (delta: Record<string, unknown>, finish: string | null) =>
			`data: ${JSON.stringify({ id: "t", object: "chat.completion.chunk", created: 0, model: String(body.model), choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write(chunk({ role: "assistant", content: "<title>Fix Login Bug</title>" }, null));
		response.write(chunk({}, "stop"));
		response.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	close = () => new Promise<void>((resolve) => server.close(() => resolve()));
	const { port } = server.address() as AddressInfo;
	const model = {
		id: "glm-5.3",
		name: "glm-5.3",
		api: "openai-completions",
		provider: "custom-gateway",
		baseUrl: `http://127.0.0.1:${port}/v1`,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 32_000,
		compat: { supportsDeveloperRole: false, thinkingFormat: "openrouter" },
	} as Model<Api>;

	const title = await generateSessionTitle({
		firstPrompt: "Fix the login bug in the auth service",
		model,
		auth: { apiKey: "test-key" },
		sessionId: "issue-6548",
		retry: { enabled: false, maxRetries: 0, baseDelayMs: 0 },
	});

	expect(title).toBe("Fix Login Bug");
	expect(efforts).toEqual(["none", "low"]);
});
