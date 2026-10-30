import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnthropicMessagesCompat } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import type { Settings } from "../../../src/core/settings-manager.ts";

// senpi#2553: a gateway that spreads one session over several upstream accounts needs a stable,
// non-identifying session key on every Anthropic Messages request, or each hop re-writes the whole
// cached prefix on another account.

const PROVIDER = "anthropic-affinity-wire";
const MODEL_ID = "claude-affinity-wire";
const USER_ID_SHAPE =
	/^user_([0-9a-f]{64})_account__session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type RecordedRequest = { headers: IncomingHttpHeaders; body: Record<string, unknown> };

function writeSse(response: ServerResponse, event: string, payload: unknown): void {
	response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function replyText(response: ServerResponse): void {
	const usage = { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	response.writeHead(200, { "content-type": "text/event-stream" });
	writeSse(response, "message_start", { type: "message_start", message: { id: "msg_affinity", usage } });
	writeSse(response, "content_block_start", {
		type: "content_block_start",
		index: 0,
		content_block: { type: "text", text: "" },
	});
	writeSse(response, "content_block_delta", {
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: "ok" },
	});
	writeSse(response, "content_block_stop", { type: "content_block_stop", index: 0 });
	writeSse(response, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage });
	writeSse(response, "message_stop", { type: "message_stop" });
	response.end();
}

async function startRecorder(): Promise<{ baseUrl: string; requests: RecordedRequest[]; server: Server }> {
	const requests: RecordedRequest[] = [];
	const server = createServer(async (request, response) => {
		const chunks: Uint8Array[] = [];
		for await (const chunk of request) chunks.push(chunk);
		requests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
		replyText(response);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected TCP server address");
	return { baseUrl: `http://127.0.0.1:${address.port}`, requests, server };
}

async function openSession(
	baseUrl: string,
	sessionManager: SessionManager,
	options: { settings?: Partial<Settings>; compat?: AnthropicMessagesCompat } = {},
) {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	await runtime.registerProvider(PROVIDER, {
		name: "Anthropic affinity wire",
		api: "anthropic-messages",
		apiKey: "mock-anthropic-key",
		baseUrl,
		models: [
			{
				id: MODEL_ID,
				name: "Claude affinity wire",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 1_000,
				...(options.compat ? { compat: options.compat } : {}),
			},
		],
	});
	const model = runtime.getModel(PROVIDER, MODEL_ID);
	if (!model) throw new Error("Expected registered Anthropic model");
	const { session } = await createAgentSession({
		modelRuntime: runtime,
		model,
		cwd: process.cwd(),
		settingsManager: SettingsManager.inMemory(options.settings ?? {}),
		sessionManager,
		tools: [],
	});
	return session;
}

function userId(request: RecordedRequest | undefined): string | undefined {
	const metadata = request?.body.metadata as { user_id?: unknown } | undefined;
	return typeof metadata?.user_id === "string" ? metadata.user_id : undefined;
}

function withoutMetadata(request: RecordedRequest | undefined): string {
	const { metadata: _metadata, ...rest } = request?.body ?? {};
	return JSON.stringify(rest);
}

describe("senpi#2553 Anthropic session affinity key", () => {
	const cleanups: Array<() => void | Promise<void>> = [];

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	async function recorder() {
		const endpoint = await startRecorder();
		cleanups.push(() => new Promise<void>((resolve) => endpoint.server.close(() => resolve())));
		return endpoint;
	}

	it("sends one hashed key for every turn of a session, again after resume, and a different key for another session", async () => {
		// Given
		const endpoint = await recorder();
		const sessionDir = mkdtempSync(join(tmpdir(), "senpi-2553-"));
		cleanups.push(() => rmSync(sessionDir, { recursive: true, force: true }));
		const firstManager = SessionManager.create(process.cwd(), sessionDir);
		const rawSessionId = firstManager.getSessionId();
		const first = await openSession(endpoint.baseUrl, firstManager);

		// When
		await first.prompt("first turn");
		await first.prompt("second turn");
		const sessionFile = firstManager.getSessionFile();
		first.dispose();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const resumed = await openSession(endpoint.baseUrl, SessionManager.open(sessionFile, sessionDir));
		await resumed.prompt("after resume");
		resumed.dispose();
		const other = await openSession(endpoint.baseUrl, SessionManager.inMemory());
		await other.prompt("another session");
		other.dispose();

		// Then
		const keys = endpoint.requests.map(userId);
		expect(keys).toHaveLength(4);
		expect(keys[0]).toMatch(USER_ID_SHAPE);
		expect(keys[1]).toBe(keys[0]);
		expect(keys[2]).toBe(keys[0]);
		expect(keys[3]).toMatch(USER_ID_SHAPE);
		expect(keys[3]).not.toBe(keys[0]);
		const rawForms = [rawSessionId, rawSessionId.replaceAll("-", "")];
		for (const request of endpoint.requests) {
			const wire = JSON.stringify({ headers: request.headers, body: request.body });
			for (const raw of rawForms) expect(wire).not.toContain(raw);
		}
	});

	it("carries the hashed key, not the session id, in the affinity header where the provider sends one", async () => {
		// Given
		const endpoint = await recorder();
		const manager = SessionManager.inMemory();
		const session = await openSession(endpoint.baseUrl, manager, { compat: { sendSessionAffinityHeaders: true } });

		// When
		await session.prompt("hello");
		session.dispose();

		// Then
		const [request] = endpoint.requests;
		const header = request?.headers["x-session-affinity"];
		expect(header).toMatch(/^[0-9a-f]{64}$/);
		expect(header).not.toBe(manager.getSessionId());
		expect(userId(request)?.match(USER_ID_SHAPE)?.[1]).toBe(header);
	});

	it("sends no key when the setting opts out, and the key leaves every other request byte unchanged", async () => {
		// Given
		const endpoint = await recorder();
		const keyed = await openSession(endpoint.baseUrl, SessionManager.inMemory());
		const optedOut = await openSession(endpoint.baseUrl, SessionManager.inMemory(), {
			settings: { promptCache: { sessionAffinity: false } },
		});

		// When
		await keyed.prompt("same prompt");
		await optedOut.prompt("same prompt");
		keyed.dispose();
		optedOut.dispose();

		// Then
		const [keyedRequest, optedOutRequest] = endpoint.requests;
		expect(userId(keyedRequest)).toMatch(USER_ID_SHAPE);
		expect(optedOutRequest?.body).not.toHaveProperty("metadata");
		expect(optedOutRequest?.headers["x-session-affinity"]).toBeUndefined();
		expect(withoutMetadata(keyedRequest)).toBe(withoutMetadata(optedOutRequest));
	});

	it("sends no key to a model whose compat explicitly disables session affinity", async () => {
		// Given
		const endpoint = await recorder();
		const session = await openSession(endpoint.baseUrl, SessionManager.inMemory(), {
			compat: { sendSessionAffinityHeaders: false },
		});

		// When
		await session.prompt("hello");
		session.dispose();

		// Then
		const [request] = endpoint.requests;
		expect(request?.body).not.toHaveProperty("metadata");
		expect(request?.headers["x-session-affinity"]).toBeUndefined();
	});
});
