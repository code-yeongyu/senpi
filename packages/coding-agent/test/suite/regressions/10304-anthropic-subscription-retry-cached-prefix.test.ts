import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import {
	getSdkBoundary,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SdkQuery,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { forgetBinding } from "../../../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import {
	closeSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";

/**
 * oh-my-openagent#10304, prompt-byte contract: the retry of a timed-out or failed turn forks the
 * Claude Code session at the pre-turn boundary in a new Claude Code process, and only the request
 * that process sends proves the retry reads the prompt cache the failed request wrote. So this runs
 * the installed Claude Code against a loopback Messages endpoint and compares the two requests.
 */

const SESSION_ID = "omo-10304-retry-cached-prefix";
const MODEL_ID = "claude-opus-5-5";

const model: Model<Api> = {
	id: MODEL_ID,
	name: "Claude Opus 5.5",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
	contextWindow: 200_000,
	maxTokens: 32_000,
};

type Reply = { kind: "answer" } | { kind: "stall" } | { kind: "fail"; status: number };
type ProviderRequest = { body: Record<string, unknown>; betas: string | undefined };

function sse(events: Array<[string, unknown]>): string {
	return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function answer(id: string): string {
	const delta = (index: number, value: unknown): [string, unknown] => [
		"content_block_delta",
		{ type: "content_block_delta", index, delta: value },
	];
	return sse([
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id,
					type: "message",
					role: "assistant",
					model: MODEL_ID,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 1 },
				},
			},
		],
		[
			"content_block_start",
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		],
		delta(0, { type: "thinking_delta", thinking: `reasoning for ${id}` }),
		delta(0, { type: "signature_delta", signature: `signature-${id}` }),
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
		delta(1, { type: "text_delta", text: `answer ${id}` }),
		["content_block_stop", { type: "content_block_stop", index: 1 }],
		[
			"message_delta",
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 5 },
			},
		],
		["message_stop", { type: "message_stop" }],
	]);
}

async function startProvider(script: Reply[]) {
	const requests: ProviderRequest[] = [];
	const held: ServerResponse[] = [];
	const arrivals: Array<{ count: number; resolve: () => void }> = [];
	const server = createServer((request, response) => {
		let raw = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			raw += chunk;
		});
		request.on("end", () => {
			if (request.method !== "POST" || !request.url?.startsWith("/v1/messages")) {
				response.writeHead(200, { "content-type": "application/json" }).end("{}");
				return;
			}
			if (request.url.startsWith("/v1/messages/count_tokens")) {
				response.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":1}');
				return;
			}
			const body = JSON.parse(raw) as Record<string, unknown>;
			if (body.model !== MODEL_ID) {
				response.writeHead(200, { "content-type": "text/event-stream" }).end(answer("msg_side"));
				return;
			}
			const beta = request.headers["anthropic-beta"];
			requests.push({ body, betas: Array.isArray(beta) ? beta.join(",") : beta });
			for (const arrival of arrivals.splice(0)) {
				if (requests.length >= arrival.count) arrival.resolve();
				else arrivals.push(arrival);
			}
			const reply = script.shift() ?? { kind: "answer" };
			if (reply.kind === "stall") {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.flushHeaders();
				held.push(response);
			} else if (reply.kind === "fail") {
				response
					.writeHead(reply.status, { "content-type": "application/json", "x-should-retry": "false" })
					.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Internal server error" } }));
			} else {
				response.writeHead(200, { "content-type": "text/event-stream" }).end(answer(`msg_${requests.length}`));
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		requests,
		arrived(count: number): Promise<void> {
			if (requests.length >= count) return Promise.resolve();
			return new Promise((resolve) => arrivals.push({ count, resolve }));
		},
		async close(): Promise<void> {
			for (const response of held.splice(0)) response.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

const cleanup: Array<() => Promise<void>> = [];
const claudeCodeProcesses: ChildProcess[] = [];

async function exited(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await once(child, "exit");
}

async function hermeticClaudeCode(baseUrl: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-10304-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	// Only what Claude Code needs to boot against the loopback endpoint: no inherited
	// credentials, proxies or provider routing, and no traffic beyond 127.0.0.1.
	const env = {
		PATH: process.env.PATH ?? "",
		HOME: join(dir, "home"),
		TMPDIR: dir,
		CLAUDE_CONFIG_DIR: join(dir, "claude-config"),
		ANTHROPIC_BASE_URL: baseUrl,
		ANTHROPIC_API_KEY: "omo-10304-probe-key",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	};
	overrideAuthLaneBoundary({ env: () => env });
	// Each Claude Code process is spawned here so cleanup can wait for it to exit before removing its files.
	const realQuery = getSdkBoundary().query;
	const trackedQuery: SdkQuery = (input) =>
		realQuery({
			...input,
			options: {
				...input.options,
				spawnClaudeCodeProcess: ({ command, args, cwd, env: childEnv, signal }) => {
					const child = spawn(command, args, { cwd, env: childEnv, signal, stdio: ["pipe", "pipe", "ignore"] });
					claudeCodeProcesses.push(child);
					return child;
				},
			},
		});
	overrideSdkBoundary({ query: trackedQuery });
	overrideSessionRegistryBoundary({ queryFactory: trackedQuery });
	return dir;
}

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "claude-sdk-oauth",
		provider: "anthropic-subscription",
		model: MODEL_ID,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

async function runTurn(cwd: string, context: Context, signal?: AbortSignal): Promise<AssistantMessage> {
	return await streamAnthropicSubscription(model, context, {
		cwd,
		sessionId: SESSION_ID,
		streamKind: "main",
		reasoning: "high",
		...(signal ? { signal } : {}),
	}).result();
}

/** What the prompt cache is keyed on: everything but `metadata`, which names the Claude Code session a fork renews. */
function cacheKey({ body, betas }: ProviderRequest): Record<string, unknown> {
	const { metadata: _session, ...prompt } = body;
	return { ...prompt, betas };
}

afterEach(async () => {
	closeSession(SESSION_ID, "test_cleanup");
	forgetBinding(SESSION_ID);
	// Claude Code writes its transcript until it exits, so its directory is removed only after that.
	await Promise.all(claudeCodeProcesses.splice(0).map(exited));
	resetSessionRegistryBoundary();
	resetSdkBoundary();
	resetAuthLaneBoundary();
	for (const step of cleanup.splice(0).reverse()) await step();
}, 60_000);

describe("oh-my-openagent#10304: a same-turn retry reuses the prompt cache", () => {
	it.each([
		["the turn timed out on a stalled request", { kind: "stall" }, "aborted"],
		["the provider failed the request", { kind: "fail", status: 500 }, "error"],
	] as const)(
		"after %s, the retry sends the failed request's prefix and breakpoints",
		async (_case, failure, outcome) => {
			const provider = await startProvider([{ kind: "answer" }, { kind: "answer" }, failure, { kind: "answer" }]);
			cleanup.push(() => provider.close());
			const cwd = await hermeticClaudeCode(provider.baseUrl);
			const user = (content: string, timestamp: number) => ({ role: "user" as const, content, timestamp });
			const turn1: Context = { messages: [user("first", 1)] };
			const turn2: Context = { messages: [...turn1.messages, assistant("answer 1", 2), user("second", 3)] };
			const turn3: Context = { messages: [...turn2.messages, assistant("answer 2", 4), user("third", 5)] };
			expect((await runTurn(cwd, turn1)).stopReason).toBe("stop");
			expect((await runTurn(cwd, turn2)).stopReason).toBe("stop");

			const abort = new AbortController();
			const attempt = runTurn(cwd, turn3, abort.signal);
			await provider.arrived(3);
			if (failure.kind === "stall") abort.abort();
			expect((await attempt).stopReason).toBe(outcome);
			expect((await runTurn(cwd, turn3)).stopReason).toBe("stop");

			expect(provider.requests).toHaveLength(4);
			const [, , failed, retried] = provider.requests.map(cacheKey);
			expect(retried).toEqual(failed);
		},
		120_000,
	);
});
