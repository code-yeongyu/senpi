import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";
import { parseRetryAfterMsMarker } from "../src/utils/retry-hint.ts";

const activeServers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		activeServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
	);
});

const REQUESTED_WAIT_MS = 3_968_000;

describe("OpenAI completions terminal errors keep the provider Retry-After", () => {
	it.each([
		{ status: 429, form: "seconds" },
		{ status: 429, form: "http-date" },
		{ status: 503, form: "seconds" },
		{ status: 503, form: "http-date" },
	] as const)("HTTP $status with a $form Retry-After header", async ({ status, form }) => {
		const retryAfter =
			form === "seconds" ? String(REQUESTED_WAIT_MS / 1000) : new Date(Date.now() + REQUESTED_WAIT_MS).toUTCString();
		const baseUrl = await startServer(status, retryAfter);

		const response = await streamSimple(testModel(baseUrl), userContext(), {
			apiKey: "test",
			maxRetries: 0,
		}).result();

		expect(response.stopReason).toBe("error");
		const hintMs = parseRetryAfterMsMarker(response.errorMessage ?? "");
		expect(hintMs).toBeDefined();
		// HTTP-date has one-second resolution and the request takes real time.
		expect(hintMs).toBeGreaterThan(REQUESTED_WAIT_MS - 5_000);
		expect(hintMs).toBeLessThanOrEqual(REQUESTED_WAIT_MS);
	});

	it("adds no marker when the error response carries no Retry-After", async () => {
		const baseUrl = await startServer(503, undefined);

		const response = await streamSimple(testModel(baseUrl), userContext(), {
			apiKey: "test",
			maxRetries: 0,
		}).result();

		expect(response.stopReason).toBe("error");
		expect(parseRetryAfterMsMarker(response.errorMessage ?? "")).toBeUndefined();
	});
});

function testModel(baseUrl: string): Model<"openai-completions"> {
	const model = getModel("openai", "gpt-4o-mini");
	if (model === undefined) throw new Error("Missing gpt-4o-mini test model");
	return { ...model, api: "openai-completions", provider: "test", baseUrl };
}

function userContext(): Context {
	return { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
}

async function startServer(status: number, retryAfter: string | undefined): Promise<string> {
	const server = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(status, {
				"content-type": "application/json",
				...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
			});
			response.end(
				JSON.stringify({
					error: { type: status === 429 ? "rate_limit_error" : "server_error", message: "Provider unavailable" },
				}),
			);
		});
	});
	activeServers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Expected TCP server address");
	return `http://127.0.0.1:${address.port}/v1`;
}
