import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession } from "../../../src/core/sdk.ts";

type Body = Record<string, unknown>;
type Listener = (event: unknown) => void;

const SIGNAL_TIMEOUT_MS = 10_000;
const USAGE = { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 } };

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), SIGNAL_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function parseBody(raw: unknown): Body {
	const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
	return JSON.parse(text) as Body;
}

const turnFrames: Body[] = [];

class FakeResponsesWebSocket {
	readyState = 1;
	private readonly listeners = new Map<string, Set<Listener>>();
	// The provider subscribes to messages only after send() returns, so replies wait for it.
	private readonly pendingMessages: string[] = [];

	constructor(_url: string, _options?: unknown) {
		queueMicrotask(() => this.emit("open", {}));
	}

	send(data: string): void {
		turnFrames.push(parseBody(data));
		const message = { type: "message", id: "msg_1", role: "assistant" };
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { ...message, content: [], status: "in_progress" },
			},
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: "A" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { ...message, status: "completed", content: [{ type: "output_text", text: "A", annotations: [] }] },
			},
			{ type: "response.completed", response: { id: "resp_turn", status: "completed", usage: USAGE } },
		];
		this.pendingMessages.push(...events.map((event) => JSON.stringify(event)));
		this.flushMessages();
	}

	private flushMessages(): void {
		if ((this.listeners.get("message")?.size ?? 0) === 0) return;
		for (const data of this.pendingMessages.splice(0)) this.emit("message", { data });
	}

	close(): void {
		this.readyState = 3;
		this.emit("close", { code: 1000, reason: "done" });
	}

	addEventListener(type: string, listener: Listener): void {
		const listeners = this.listeners.get(type) ?? new Set<Listener>();
		listeners.add(listener);
		this.listeners.set(type, listeners);
		if (type === "message") queueMicrotask(() => this.flushMessages());
	}

	removeEventListener(type: string, listener: Listener): void {
		this.listeners.get(type)?.delete(listener);
	}

	private emit(type: string, event: unknown): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}
}

/** Everything the prompt cache keys on: the request minus the conversation and the transport framing. */
function cachedPrefix(body: Body): Body {
	const { input, stream: _stream, type: _type, prompt_cache_options, ...rest } = body;
	const { prewarm: _prewarm, ...cacheOptions } = (prompt_cache_options ?? {}) as Body;
	return { ...rest, developer: (input as unknown[])[0], prompt_cache_options: cacheOptions };
}

// senpi#2096: the session-start prewarm (HTTP) must write the exact prefix the first turn
// sends over the Responses WebSocket, or the platform never reads it.
describe("session-start prewarm matches the first WebSocket turn (#2096)", () => {
	const roots: string[] = [];

	afterEach(() => {
		vi.unstubAllGlobals();
		turnFrames.length = 0;
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("sends the first turn's developer message, tools, reasoning, include, and cache options", async () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-2096-prewarm-ws-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "work");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd);
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }), {
			mode: 0o600,
		});

		const prewarmSent = deferred<Body>();
		vi.stubGlobal("WebSocket", FakeResponsesWebSocket);
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url.startsWith("https://api.openai.com/") && init?.body !== undefined) {
				prewarmSent.resolve(parseBody(init.body));
				const response = { id: "resp_prewarm", object: "response", created_at: 1, status: "completed" };
				return new Response(JSON.stringify({ ...response, model: "gpt-6-luna", output: [], usage: USAGE }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return new Response("{}", { status: 404 });
		});

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: getModel("openai", "gpt-6-luna"),
			thinkingLevel: "low",
			noTools: "all",
		});
		try {
			await session.bindExtensions({});
			const prewarm = await within(prewarmSent.promise, "the prewarm request");
			await within(session.prompt("Reply with exactly: A"), "the first turn");

			const [turn] = turnFrames;
			expect(turn?.type).toBe("response.create");
			expect(prewarm.input).toEqual([
				expect.objectContaining({
					role: "developer",
					content: [expect.objectContaining({ prompt_cache_breakpoint: { mode: "explicit" } })],
				}),
			]);
			expect((prewarm.prompt_cache_options as Body | undefined)?.prewarm).toBe(true);
			expect(cachedPrefix(prewarm)).toEqual(turn === undefined ? undefined : cachedPrefix(turn));
		} finally {
			session.dispose();
		}
	});
});
