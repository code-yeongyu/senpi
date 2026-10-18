import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { MIN_ANSWER_TOKENS } from "../src/api/simple-options.ts";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Model } from "../src/types.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import {
	CONTEXT_WINDOW,
	contextWithEstimate,
	FIRST_EXHAUSTED_ESTIMATE,
	LAST_ADMITTED_ESTIMATE,
} from "./context-exhaustion-fixtures.ts";

const activeServers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		activeServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
});

describe("context exhaustion guard through streamSimple", () => {
	it("returns an overflow error without calling the provider once the window is exhausted", async () => {
		const server = await startRecordingServer();
		const model = testModel(server.baseUrl);

		const response = await streamSimple(model, contextWithEstimate(FIRST_EXHAUSTED_ESTIMATE), {
			apiKey: "test",
			maxRetries: 0,
		}).result();

		expect(server.requests).toHaveLength(0);
		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).toMatch(/^Context window exhausted/);
		expect(response.usage.totalTokens).toBe(0);
		expect(isContextOverflow(response, model.contextWindow)).toBe(true);
	});

	it("still sends the request with the clamped max tokens while answer room remains", async () => {
		const server = await startRecordingServer();
		const model = testModel(server.baseUrl);

		const response = await streamSimple(model, contextWithEstimate(LAST_ADMITTED_ESTIMATE), {
			apiKey: "test",
			maxRetries: 0,
		}).result();

		expect(server.requests).toHaveLength(1);
		expect(server.requests[0]?.max_completion_tokens ?? server.requests[0]?.max_tokens).toBe(MIN_ANSWER_TOKENS);
		expect(response.stopReason).toBe("stop");
		expect(response.errorMessage).toBeUndefined();
	});
});

function testModel(baseUrl: string): Model<"openai-completions"> {
	const model = getModel("openai", "gpt-4o-mini");
	if (model === undefined) throw new Error("Missing gpt-4o-mini test model");
	return { ...model, api: "openai-completions", provider: "test", baseUrl, contextWindow: CONTEXT_WINDOW };
}

interface RecordingServer {
	readonly baseUrl: string;
	readonly requests: Array<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function startRecordingServer(): Promise<RecordingServer> {
	const requests: Array<Record<string, unknown>> = [];
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			if (!isRecord(body)) throw new Error("expected a JSON object request body");
			requests.push(body);
			writeCompletion(response);
		});
	});
	activeServers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
	return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

function writeCompletion(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.write(
		`data: ${JSON.stringify({
			id: "chatcmpl-guard",
			choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
			usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
		})}\n\n`,
	);
	response.write("data: [DONE]\n\n");
	response.end();
}
