import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { Type } from "@earendil-works/pi-ai";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

export const RETRY_GUIDANCE = "Re-issue the tool call with complete arguments.";
export const TRUNCATION_ERROR = "Tool call stream ended before completion";
export type Scenario = "complete" | "truncated";
export type CapturedRequest = { headers: IncomingHttpHeaders; rawBody: string; body: Record<string, unknown> };
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

function writeFragmented(response: ServerResponse, text: string): void {
	const dataAt = text.indexOf("data:") + 5;
	const contentAt = text.indexOf('content\\":') + 10;
	const boundaries = [1, 7, dataAt, Math.max(dataAt + 1, contentAt), Math.max(dataAt + 2, contentAt + 4)];
	let offset = 0;
	for (const boundary of boundaries) {
		if (boundary > offset && boundary < text.length) response.write(text.slice(offset, boundary));
		offset = Math.max(offset, boundary);
	}
	response.write(text.slice(offset));
}

function writeChunk(
	response: ServerResponse,
	delta: Record<string, unknown>,
	finishReason: string | null = null,
): void {
	const payload = {
		id: "chatcmpl-recovery",
		object: "chat.completion.chunk",
		created: 0,
		model: "claude-recovery-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
	writeFragmented(response, `data: ${JSON.stringify(payload)}\r\n\r\n`);
}

function finish(response: ServerResponse, text: string): void {
	writeChunk(response, { role: "assistant", content: text });
	writeChunk(response, {}, "stop");
	writeFragmented(response, "data: [DONE]\r\n\r\n");
	response.end();
}

async function readBody(request: AsyncIterable<Uint8Array>) {
	const chunks: Uint8Array[] = [];
	for await (const chunk of request) chunks.push(chunk);
	const rawBody = Buffer.concat(chunks).toString("utf8");
	return { rawBody, body: JSON.parse(rawBody) as Record<string, unknown> };
}

export async function startOpenAIServer(scenario: Scenario) {
	const requests: CapturedRequest[] = [];
	const openingWritten = deferred();
	const toolcallStarted = deferred();
	const closeWritten = deferred();
	const endedWithoutClose = deferred();
	let requestNumber = 0;
	let closeCount = 0;
	const server = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		requests.push({ headers: request.headers, ...(await readBody(request)) });
		requestNumber++;
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		response.flushHeaders();
		if (requestNumber === 2) {
			finish(response, scenario === "complete" ? "complete final" : "corrective final");
			return;
		}
		writeChunk(response, { role: "assistant", content: 'I will check. <antml:invoke name="Echo">' });
		openingWritten.resolve();
		try {
			await withTimeout(toolcallStarted.promise, "toolcall_start was not observed after the invoke opening");
		} catch (error) {
			response.destroy(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		writeChunk(response, { content: '<antml:parameter name="value">hello</antml:parameter>' });
		if (scenario === "complete") {
			writeChunk(response, { content: "</antml:invoke>" });
			closeCount++;
			closeWritten.resolve();
		} else {
			endedWithoutClose.resolve();
		}
		writeChunk(response, {}, "stop");
		writeFragmented(response, "data: [DONE]\r\n\r\n");
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
		endedWithoutClose,
		closeCount: () => closeCount,
		server,
	};
}

export async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

export function messages(request: CapturedRequest): Array<Record<string, unknown>> {
	return request.body.messages as Array<Record<string, unknown>>;
}

export async function runScenario(scenario: Scenario) {
	const endpoint = await startOpenAIServer(scenario);
	let executeCount = 0;
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	await runtime.registerProvider("openai-recovery-wire", {
		name: "OpenAI recovery wire",
		api: "openai-completions",
		apiKey: "mock-openai-key",
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
	const model = runtime.getModel("openai-recovery-wire", "claude-recovery-model");
	if (!model) throw new Error("Expected registered OpenAI model");
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
		await withTimeout(
			scenario === "complete" ? endpoint.closeWritten.promise : endpoint.endedWithoutClose.promise,
			"stream terminal signal was not written",
		);
		return { endpoint, session, executeCount, eventOrder };
	} catch (error) {
		await closeServer(endpoint.server);
		session.dispose();
		throw error;
	} finally {
		unsubscribe();
	}
}
