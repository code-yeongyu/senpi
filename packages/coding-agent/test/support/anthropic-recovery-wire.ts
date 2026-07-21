import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { Type } from "@earendil-works/pi-ai";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

export const RETRY_GUIDANCE = "Re-issue the tool call with complete arguments.";
export const TRUNCATION_ERROR = "Tool call stream ended before completion";

export type CapturedRequest = {
	headers: IncomingHttpHeaders;
	rawBody: string;
	body: Record<string, unknown>;
};

export type Scenario = "complete" | "truncated";

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

export function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), 2_000);
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function writeFragmented(response: ServerResponse, text: string, boundaries: number[]): void {
	let offset = 0;
	for (const boundary of boundaries) {
		response.write(text.slice(offset, boundary));
		offset = boundary;
	}
	response.write(text.slice(offset));
}

function writeSse(response: ServerResponse, event: string, payload: unknown): void {
	const wire = `event: ${event}\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`;
	const dataAt = wire.indexOf("data:") + 5;
	const payloadMiddle = dataAt + Math.max(1, Math.floor(JSON.stringify(payload).length / 2));
	writeFragmented(response, wire, [1, 7, dataAt, payloadMiddle]);
}

function writeMessageStart(response: ServerResponse, id: string): void {
	writeSse(response, "message_start", {
		type: "message_start",
		message: {
			id,
			usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	});
	writeSse(response, "content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	});
}

function finishMessage(response: ServerResponse, text: string, id: string): void {
	writeMessageStart(response, id);
	writeSse(response, "content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text },
	});
	writeSse(response, "content_block_stop", { type: "content_block_stop", index: 0 });
	writeSse(response, "message_delta", {
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: { input_tokens: 8, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	});
	writeSse(response, "message_stop", { type: "message_stop" });
	response.end();
}

async function readRequestBody(
	request: AsyncIterable<Uint8Array>,
): Promise<{ rawBody: string; body: Record<string, unknown> }> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of request) chunks.push(chunk);
	const rawBody = Buffer.concat(chunks).toString("utf8");
	return { rawBody, body: JSON.parse(rawBody) as Record<string, unknown> };
}

export async function startAnthropicServer(scenario: Scenario) {
	const requests: CapturedRequest[] = [];
	const openingWritten = deferred();
	const toolcallStarted = deferred();
	const closeWritten = deferred();
	const streamEndedWithoutClose = deferred();
	let requestNumber = 0;
	let closeEventCount = 0;

	const server = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/messages") {
			response.writeHead(404).end();
			return;
		}
		const captured = await readRequestBody(request);
		requests.push({ headers: request.headers, ...captured });
		requestNumber++;
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		response.flushHeaders();

		if (requestNumber === 2) {
			finishMessage(response, scenario === "complete" ? "complete final" : "corrective final", "msg_final");
			return;
		}

		writeMessageStart(response, "msg_leak");
		writeSse(response, "content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: 'I will check. <antml:invoke name="Echo">' },
		});
		openingWritten.resolve();
		try {
			await withTimeout(toolcallStarted.promise, "toolcall_start was not observed after the invoke opening");
		} catch (error) {
			response.destroy(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		writeSse(response, "content_block_delta", {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: '<antml:parameter name="value">hello</antml:parameter>' },
		});
		if (scenario === "complete") {
			writeSse(response, "content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "</antml:invoke>" },
			});
			closeEventCount++;
			closeWritten.resolve();
		} else {
			streamEndedWithoutClose.resolve();
		}
		writeSse(response, "content_block_stop", { type: "content_block_stop", index: 0 });
		writeSse(response, "message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 4, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		});
		writeSse(response, "message_stop", { type: "message_stop" });
		response.end();
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP server address");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		openingWritten,
		toolcallStarted,
		closeWritten,
		streamEndedWithoutClose,
		closeEventCount: () => closeEventCount,
		server,
	};
}

export async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

export function messages(request: CapturedRequest): Array<{ role: string; content: Array<Record<string, unknown>> }> {
	return request.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
}

export async function runScenario(scenario: Scenario) {
	const endpoint = await startAnthropicServer(scenario);
	let executeCount = 0;
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	await runtime.registerProvider("anthropic-recovery-wire", {
		name: "Anthropic recovery wire",
		api: "anthropic-messages",
		apiKey: "mock-anthropic-key",
		baseUrl: endpoint.baseUrl,
		models: [
			{
				id: "claude-recovery-model",
				name: "Claude recovery model",
				reasoning: false,
				recoverTextToolCalls: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 1_000,
			},
		],
	});
	const model = runtime.getModel("anthropic-recovery-wire", "claude-recovery-model");
	if (!model) throw new Error("Expected registered Anthropic model");
	const { session } = await createAgentSession({
		modelRuntime: runtime,
		model,
		cwd: process.cwd(),
		settingsManager: SettingsManager.inMemory(),
		sessionManager: SessionManager.inMemory(),
		tools: ["Echo"],
		customTools: [
			{
				name: "Echo",
				label: "Echo",
				description: "Echo a value",
				parameters: Type.Object({ value: Type.String() }),
				execute: async () => {
					executeCount++;
					return { content: [{ type: "text", text: "echo:hello" }], details: {} };
				},
			},
		],
	});
	const eventOrder: string[] = [];
	const unsubscribe = session.subscribe((event) => {
		if (event.type !== "message_update") return;
		eventOrder.push(event.assistantMessageEvent.type);
		if (event.assistantMessageEvent.type === "toolcall_start") endpoint.toolcallStarted.resolve();
	});
	try {
		await session.prompt("Use Echo once.");
		await withTimeout(endpoint.openingWritten.promise, "invoke opening was not written");
		if (scenario === "complete") await withTimeout(endpoint.closeWritten.promise, "invoke close was not written");
		else await withTimeout(endpoint.streamEndedWithoutClose.promise, "stream did not end without invoke close");
		return { endpoint, session, executeCount, eventOrder };
	} catch (error) {
		await closeServer(endpoint.server);
		session.dispose();
		throw error;
	} finally {
		unsubscribe();
	}
}
