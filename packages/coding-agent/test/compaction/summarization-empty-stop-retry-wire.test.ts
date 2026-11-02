import { createServer, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

/**
 * Wire-level counterpart of summarization-empty-stop-retry.test.ts. The faux
 * provider records the stream options the summarizer asked for; this test
 * drives the real openai-completions adapter over HTTP against a relay stub
 * that behaves like the 2026-09-17 incident: a summarization request carrying
 * `reasoning_effort` completes with a normal stop and only the role prelude,
 * one without it answers. The claim under test is that the retried request
 * differs on the wire, not just in the options object.
 */

type CapturedRequest = { body: Record<string, unknown> };
type RelayPhase = "agent-turns" | "summarization";

const WIRE_SUMMARY = "wire summary: parser refactored, tests green";

function writeChunk(response: ServerResponse, delta: Record<string, unknown>, finishReason: string | null): void {
	const payload = {
		id: "chatcmpl-empty-stop",
		object: "chat.completion.chunk",
		created: 0,
		model: "summarizer-wire",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
	response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function finishStream(response: ServerResponse, text: string | undefined): void {
	writeChunk(response, { role: "assistant" }, null);
	if (text !== undefined) writeChunk(response, { content: text }, null);
	writeChunk(response, {}, "stop");
	response.write("data: [DONE]\n\n");
	response.end();
}

async function readJsonBody(request: AsyncIterable<Uint8Array>): Promise<Record<string, unknown>> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of request) chunks.push(chunk);
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function startRelayStub() {
	const requests: CapturedRequest[] = [];
	const state: { phase: RelayPhase } = { phase: "agent-turns" };
	const server = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		const body = await readJsonBody(request);
		requests.push({ body });
		response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		response.flushHeaders();
		if (state.phase === "agent-turns") {
			finishStream(response, "done");
			return;
		}
		finishStream(response, body.reasoning_effort === undefined ? WIRE_SUMMARY : undefined);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP server address");
	return { baseUrl: `http://127.0.0.1:${address.port}`, requests, state, server };
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
});

describe("summarization empty-stop retry on the openai-completions wire", () => {
	it("Given a relay that answers only summarization requests without reasoning_effort When manual compaction runs Then the retried request omits reasoning_effort on the wire and its summary is applied", async () => {
		const relay = await startRelayStub();
		servers.push(relay.server);
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		await runtime.registerProvider("empty-stop-relay", {
			name: "Empty-stop relay",
			api: "openai-completions",
			apiKey: "mock-relay-key",
			baseUrl: relay.baseUrl,
			models: [
				{
					id: "summarizer-wire",
					name: "Summarizer wire",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200_000,
					maxTokens: 8_192,
				},
			],
		});
		const model = runtime.getModel("empty-stop-relay", "summarizer-wire");
		if (!model) throw new Error("Expected registered relay model");
		const sessionManager = SessionManager.inMemory();
		const { session } = await createAgentSession({
			modelRuntime: runtime,
			model,
			cwd: process.cwd(),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 1 } }),
			sessionManager,
			tools: ["read"],
		});
		try {
			await session.prompt("please refactor the parser");
			await session.prompt("now add tests");
			expect(relay.requests).toHaveLength(2);
			relay.state.phase = "summarization";

			const result = await session.compact();

			const summarization = relay.requests.slice(2);
			expect(summarization).toHaveLength(2);
			expect(Array.isArray(summarization[0]?.body.tools)).toBe(true);
			expect(summarization[0]?.body.reasoning_effort).toBe("low");
			expect("reasoning_effort" in (summarization[1]?.body ?? {})).toBe(false);
			expect(result.summary).toBe(WIRE_SUMMARY);
			const compactionEntry = sessionManager.getBranch().find((entry) => entry.type === "compaction");
			expect(compactionEntry && "summary" in compactionEntry ? compactionEntry.summary : undefined).toBe(
				WIRE_SUMMARY,
			);
		} finally {
			session.dispose();
		}
	});
});
