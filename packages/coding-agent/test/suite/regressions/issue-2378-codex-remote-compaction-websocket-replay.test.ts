import { zstdDecompressSync } from "node:zlib";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

// senpi#2378: a remote compaction on the ChatGPT subscription lane must be replayed on the
// next turn over the lane's default WebSocket transport, not reduced to its placeholder summary.

const PROVIDER = "chatgpt-subscription";
const MODEL_ID = "gpt-5.5";
const COMPACTION_ITEM = { type: "compaction", id: "cmp_2378", encrypted_content: "encrypted-2378" };

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account_2378" } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

type SentFrame = { type?: string; input?: unknown[] };
type FetchCall = { url: string; body: { input?: unknown[] } | undefined };

function decodeBody(body: RequestInit["body"] | undefined): FetchCall["body"] {
	if (typeof body === "string") return JSON.parse(body) as FetchCall["body"];
	if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
		const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
		return JSON.parse(Buffer.from(zstdDecompressSync(bytes)).toString("utf8")) as FetchCall["body"];
	}
	return undefined;
}

function sse(events: unknown[]): Response {
	const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function installFetch(calls: FetchCall[]): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, body: decodeBody(init?.body) });
			if (!url.endsWith("/codex/responses")) return new Response('{"detail":"Not Found"}', { status: 404 });
			return sse([
				{ type: "response.output_item.added", output_index: 0, item: COMPACTION_ITEM },
				{ type: "response.output_item.done", output_index: 0, item: COMPACTION_ITEM },
				{
					type: "response.completed",
					response: {
						id: "resp_compaction_2378",
						status: "completed",
						usage: {
							input_tokens: 50,
							output_tokens: 5,
							total_tokens: 55,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]);
		}),
	);
}

function installWebSocket(frames: SentFrame[]): void {
	class MockWebSocket {
		readonly readyState = 1;
		private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
		constructor() {
			queueMicrotask(() => this.dispatch("open", {}));
		}
		addEventListener(type: string, listener: (event: unknown) => void): void {
			const set = this.listeners.get(type) ?? new Set<(event: unknown) => void>();
			set.add(listener);
			this.listeners.set(type, set);
		}
		removeEventListener(type: string, listener: (event: unknown) => void): void {
			this.listeners.get(type)?.delete(listener);
		}
		send(data: string): void {
			frames.push(JSON.parse(data) as SentFrame);
			const id = `resp_turn_${frames.length}`;
			const message = { type: "message", id: `msg_${id}`, role: "assistant" };
			const events = [
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { ...message, status: "in_progress", content: [] },
				},
				{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
				{ type: "response.output_text.delta", delta: "continued" },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { ...message, status: "completed", content: [{ type: "output_text", text: "continued" }] },
				},
				{
					type: "response.completed",
					response: {
						id,
						status: "completed",
						usage: {
							input_tokens: 5,
							output_tokens: 3,
							total_tokens: 8,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			];
			queueMicrotask(() => {
				for (const event of events) this.dispatch("message", { data: JSON.stringify(event) });
			});
		}
		close(): void {}
		private dispatch(type: string, event: unknown): void {
			for (const listener of this.listeners.get(type) ?? []) listener(event);
		}
	}
	vi.stubGlobal("WebSocket", MockWebSocket);
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-codex-responses",
		provider: PROVIDER,
		model: MODEL_ID,
		content: [{ type: "text", text }],
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("issue #2378: ChatGPT subscription remote compaction replay over WebSocket", () => {
	it("compacts through responses-v2 and sends the compaction item on the next WebSocket turn", async () => {
		const fetchCalls: FetchCall[] = [];
		const frames: SentFrame[] = [];
		installFetch(fetchCalls);
		installWebSocket(frames);

		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				[PROVIDER]: { type: "oauth", access: codexToken(), refresh: "", expires: Date.now() + 3_600_000 },
			}),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const model = runtime.getModel(PROVIDER, MODEL_ID);
		if (!model) throw new Error("Expected the builtin ChatGPT subscription model");

		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange(PROVIDER, MODEL_ID);
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Inspect the build." }],
			timestamp: 1,
		});
		sessionManager.appendMessage(assistant("I found the failure."));
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Keep the diagnosis." }],
			timestamp: 3,
		});
		sessionManager.appendMessage(assistant("Diagnosis kept."));

		const { session } = await createAgentSession({
			modelRuntime: runtime,
			model,
			cwd: process.cwd(),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 } }),
			sessionManager,
			noTools: "all",
			autoTitleSessions: false,
		});
		let compactionSummary = "";
		try {
			compactionSummary = (await session.compact()).summary;
			await session.prompt("Continue after compaction.");
		} finally {
			session.dispose();
		}

		expect(fetchCalls.map((call) => new URL(call.url).pathname)).toEqual(["/backend-api/codex/responses"]);
		expect(fetchCalls[0]?.body?.input).toContainEqual({ type: "compaction_trigger" });
		const turn = frames.find((frame) => frame.type === "response.create");
		expect(turn, "the next turn must go out over the WebSocket transport").toBeDefined();
		expect(turn?.input).toContainEqual(COMPACTION_ITEM);
		expect(JSON.stringify(turn?.input)).not.toContain(compactionSummary);
	});
});
