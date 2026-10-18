import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitSessionShutdownEvent } from "../../../src/core/extensions/runner.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";

type Body = Record<string, unknown>;

const SIGNAL_TIMEOUT_MS = 10_000;

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

function sse(events: Body[]): Response {
	const text = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function turnResponse(): Response {
	const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
	return sse([
		{
			type: "message_start",
			message: {
				id: "msg_turn",
				type: "message",
				role: "assistant",
				model: "claude-sonnet-4-5",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage,
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	]);
}

function warmResponse(): Response {
	const message = {
		id: "msg_warm",
		type: "message",
		role: "assistant",
		model: "claude-sonnet-4-5",
		content: [],
		stop_reason: "max_tokens",
		stop_sequence: null,
		usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 },
	};
	return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json" } });
}

function toolsIgnoringCacheControl(body: Body): unknown[] {
	return ((body.tools as Body[] | undefined) ?? []).map(({ cache_control: _cacheControl, ...tool }) => tool);
}

// Regression for code-yeongyu/senpi#2389: the keep-alive ping sends the tools of the turn it keeps warm.
describe("cache keep-alive ping matches the turn's tools (#2389)", () => {
	const roots: string[] = [];

	afterEach(() => {
		vi.unstubAllGlobals();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("sends the last turn's tools, order, and strict schemas", async () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-2389-keepalive-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "work");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd);
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-test" } }),
			{
				mode: 0o600,
			},
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ promptCache: { keepAlive: { enabled: true, marginSeconds: 3600 } } }),
		);

		const turns: Body[] = [];
		const pingSent = deferred<Body>();
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url.startsWith("https://api.anthropic.com/") && init?.body !== undefined) {
				const body = parseBody(init.body);
				if (body.stream === true) {
					turns.push(body);
					return turnResponse();
				}
				pingSent.resolve(body);
				return warmResponse();
			}
			return new Response("{}", { status: 404 });
		});

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5"),
			thinkingLevel: "off",
		});
		try {
			await session.bindExtensions({});
			await within(session.prompt("Reply with exactly: A"), "the turn");
			const ping = await within(pingSent.promise, "the keep-alive ping");

			const [turn] = turns;
			expect(turn).toBeDefined();
			expect(toolsIgnoringCacheControl(ping).length).toBeGreaterThan(0);
			expect(toolsIgnoringCacheControl(ping)).toEqual(
				turn === undefined ? undefined : toolsIgnoringCacheControl(turn),
			);
		} finally {
			await emitSessionShutdownEvent(session.extensionRunner, { type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});
});
