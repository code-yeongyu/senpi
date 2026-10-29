import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AccountSlot,
	addAccount,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { forgetSessionBlocksFor } from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";
import {
	getSdkBoundary,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SDKUserMessage,
	type SdkQuery,
	type SdkQueryHandle,
	type SdkQueryInput,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	type ContinuityObservation,
	overrideContinuityObservabilityBoundary,
	resetContinuityObservabilityBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-observability.ts";
import {
	type ContinuityBinding,
	forgetBinding,
	getBinding,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import {
	closeSession,
	getOrCreateSession,
	getSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { createSessionTurnAttempt } from "../../../src/core/extensions/builtin/anthropic-subscription/session-turn-attempt.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";

/**
 * senpi#4304 (oh-my-openagent#10304): a prompt cache lives on the account that served the session.
 * A turn whose attempts all failed served nothing anywhere, so the next request must go back to the
 * account that served the session as soon as it is healthy, fork its lineage there and read its cache,
 * and must not be logged as a seat change. The installed Claude Code runs against a loopback Messages
 * endpoint that tells the two accounts apart by their OAuth token and records every request.
 */

const MODEL_ID = "claude-opus-5-5";
const HOUR_MS = 3_600_000;
const SEATS = { A: "seat-a", B: "seat-b" } as const;
type Seat = keyof typeof SEATS;

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

type Reply = { status: 200 } | { status: 429; retryAfterSeconds: number } | { status: "stalled" };
type ProviderRequest = {
	seat: Seat;
	status: Reply["status"];
	body: Record<string, unknown>;
	betas: string | undefined;
};

const served: Reply = { status: 200 };
const stalled: Reply = { status: "stalled" };
const limited = (retryAfterSeconds: number): Reply => ({ status: 429, retryAfterSeconds });

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

function seatOf(authorization: string | undefined): Seat | undefined {
	if (authorization === `Bearer ${SEATS.A}-token`) return "A";
	if (authorization === `Bearer ${SEATS.B}-token`) return "B";
	return undefined;
}

async function startProvider(script: Record<Seat, Reply[]>) {
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
			const seat = seatOf(request.headers.authorization);
			if (body.model !== MODEL_ID || seat === undefined) {
				response.writeHead(200, { "content-type": "text/event-stream" }).end(answer("msg_side"));
				return;
			}
			const reply = script[seat].shift() ?? served;
			const beta = request.headers["anthropic-beta"];
			requests.push({ seat, status: reply.status, body, betas: Array.isArray(beta) ? beta.join(",") : beta });
			for (const arrival of arrivals.splice(0)) {
				if (requests.length >= arrival.count) arrival.resolve();
				else arrivals.push(arrival);
			}
			if (reply.status === "stalled") {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.flushHeaders();
				held.push(response);
				return;
			}
			if (reply.status === 429) {
				response.writeHead(429, { "content-type": "application/json", "x-should-retry": "false" }).end(
					JSON.stringify({
						type: "error",
						error: { type: "rate_limit_error", message: `Rate limited, retry-after: ${reply.retryAfterSeconds}` },
					}),
				);
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream" }).end(answer(`msg_${requests.length}`));
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
const sessionIds: string[] = [];

async function exited(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await once(child, "exit");
}

type Pool = {
	sessionId: string;
	cwd: string;
	advance(ms: number): void;
	observations: ContinuityObservation[];
	logged: Array<Record<string, unknown>>;
};

/**
 * Two subscription accounts whose user order puts B first. B is rate-limited when the session starts,
 * so the session is served on A, and from then on only its affinity can keep it there.
 */
async function twoAccountPool(baseUrl: string): Promise<Pool> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-4304-"));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	let clock = Date.now();
	const slot = (seat: Seat): AccountSlot => ({
		name: SEATS[seat],
		access: `${SEATS[seat]}-token`,
		refresh: `${SEATS[seat]}-refresh`,
		expires: clock + 24 * HOUR_MS,
		source: "login",
		...(seat === "B" ? { blockedUntil: clock + 20_000, blockReason: "rate_limit", blockedAt: clock } : {}),
	});
	const store = new InMemoryCredentialStore();
	await store.modify("anthropic-subscription", async () => ({
		...addAccount(addAccount(emptyCredential(), slot("A")), slot("B")),
		order: [SEATS.B, SEATS.A],
	}));
	// Only what Claude Code needs to boot against the loopback endpoint: no inherited
	// credentials, proxies or provider routing, and no traffic beyond 127.0.0.1.
	const env = {
		PATH: process.env.PATH ?? "",
		HOME: join(dir, "home"),
		TMPDIR: dir,
		CLAUDE_CONFIG_DIR: join(dir, "claude-config"),
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	};
	overrideAuthLaneBoundary({ createStore: () => store, env: () => env, now: () => clock });
	// The managed lanes strip ANTHROPIC_BASE_URL from the subprocess, so it is added at the SDK boundary.
	// Each Claude Code process is spawned here so cleanup can wait for it to exit before removing its files.
	const realQuery = getSdkBoundary().query;
	const loopbackQuery: SdkQuery = (input) =>
		realQuery({
			...input,
			options: {
				...input.options,
				env: { ...input.options?.env, ANTHROPIC_BASE_URL: baseUrl },
				spawnClaudeCodeProcess: ({ command, args, cwd, env: childEnv, signal }) => {
					const child = spawn(command, args, { cwd, env: childEnv, signal, stdio: ["pipe", "pipe", "ignore"] });
					claudeCodeProcesses.push(child);
					return child;
				},
			},
		});
	overrideSdkBoundary({ query: loopbackQuery });
	overrideSessionRegistryBoundary({ queryFactory: loopbackQuery });
	const observations: ContinuityObservation[] = [];
	const logged: Array<Record<string, unknown>> = [];
	overrideContinuityObservabilityBoundary({
		emit: (observation) => observations.push(observation),
		log: (_event, data) => logged.push(data),
	});
	const sessionId = `omo-10304-cache-holder-${sessionIds.length + 1}`;
	sessionIds.push(sessionId);
	return {
		sessionId,
		cwd: dir,
		advance(ms: number): void {
			clock += ms;
		},
		observations,
		logged,
	};
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

const user = (content: string, timestamp: number) => ({ role: "user" as const, content, timestamp });
const turn1: Context = { messages: [user("first", 1)] };
const turn2: Context = { messages: [...turn1.messages, assistant("answer 1", 2), user("second", 3)] };
const turn3: Context = { messages: [...turn2.messages, assistant("answer 2", 4), user("third", 5)] };

async function runTurn(pool: Pool, context: Context, signal?: AbortSignal): Promise<AssistantMessage> {
	return await streamAnthropicSubscription(model, context, {
		cwd: pool.cwd,
		sessionId: pool.sessionId,
		streamKind: "main",
		reasoning: "high",
		...(signal ? { signal } : {}),
	}).result();
}

/** What the prompt cache is keyed on: everything but `metadata`, which names the Claude Code session. */
function cacheKey({ body, betas }: ProviderRequest): Record<string, unknown> {
	const { metadata: _session, ...prompt } = body;
	return { ...prompt, betas };
}

const trail = (requests: readonly ProviderRequest[]) => requests.map(({ seat, status }) => `${seat}:${status}`);

function sdkMessage(value: unknown): SDKMessage {
	return value as SDKMessage;
}

/**
 * A resident query whose turn completes just as it is interrupted: the interrupt returns a clean receipt
 * (nothing still queued), so the pump keeps the process, and only then does the turn's success arrive.
 */
class KeptAfterInterruptQuery implements SdkQueryHandle, AsyncIterator<SDKMessage> {
	private readonly queued: SDKMessage[] = [];
	private readonly readers: Array<(value: IteratorResult<SDKMessage>) => void> = [];
	private pushed: SDKUserMessage | undefined;
	private onSubmitted: () => void = () => {};
	readonly submitted = new Promise<void>((resolve) => {
		this.onSubmitted = resolve;
	});
	receipt: Promise<{ still_queued: string[] }> | undefined;

	consuming(prompt: SdkQueryInput["prompt"]): this {
		if (typeof prompt === "string") throw new Error("Expected streaming input");
		void (async () => {
			for await (const message of prompt) {
				this.pushed = message;
				this.emit(sdkMessage({ ...message, isReplay: true }));
				this.onSubmitted();
			}
		})();
		return this;
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
		return this;
	}

	next(): Promise<IteratorResult<SDKMessage>> {
		const value = this.queued.shift();
		if (value) return Promise.resolve({ value, done: false });
		return new Promise((resolve) => this.readers.push(resolve));
	}

	interrupt(): Promise<{ still_queued: string[] }> {
		this.receipt = Promise.resolve({ still_queued: [] });
		return this.receipt;
	}

	close(): void {
		for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
	}

	answerInterruptedTurn(): void {
		const uuid = this.pushed?.uuid;
		const session = this.pushed?.session_id;
		this.emit(
			sdkMessage({
				type: "assistant",
				message: { id: "m-interrupted", type: "message", role: "assistant", content: [] },
				parent_tool_use_id: null,
				uuid: "assistant-2",
				session_id: session,
			}),
		);
		this.emit(
			sdkMessage({
				type: "result",
				subtype: "success",
				result: "answer 2",
				user_message_uuid: uuid,
				uuid: "result-2",
				session_id: session,
			}),
		);
	}

	private emit(message: SDKMessage): void {
		const reader = this.readers.shift();
		if (reader) reader({ value: message, done: false });
		else this.queued.push(message);
	}
}

async function during<T>(pool: Pool, run: () => Promise<T>) {
	const [observed, logged] = [pool.observations.length, pool.logged.length];
	const result = await run();
	return { result, observations: pool.observations.slice(observed), logged: pool.logged.slice(logged) };
}

afterEach(async () => {
	for (const sessionId of sessionIds) {
		closeSession(sessionId, "test_cleanup");
		forgetBinding(sessionId);
	}
	// Claude Code writes its transcript until it exits, so its directory is removed only after that.
	await Promise.all(claudeCodeProcesses.splice(0).map(exited));
	for (const seat of Object.values(SEATS)) forgetSessionBlocksFor(seat);
	resetContinuityObservabilityBoundary();
	resetSessionRegistryBoundary();
	resetSdkBoundary();
	resetAuthLaneBoundary();
	for (const step of cleanup.splice(0).reverse()) await step();
}, 60_000);

describe("senpi#4304: a failover retry goes back to the account that holds the session's cache", () => {
	it.each([
		["once both accounts recover", 30, 2 * HOUR_MS],
		["while the other account is still limited", 3_600, 90_000],
	] as const)(
		"a turn that failed on A and then on B is retried on A %s",
		async (_case, retryBAfterSeconds, recoveryMs) => {
			const provider = await startProvider({ A: [served, limited(30)], B: [limited(retryBAfterSeconds)] });
			cleanup.push(() => provider.close());
			const pool = await twoAccountPool(provider.baseUrl);
			expect((await runTurn(pool, turn1)).stopReason).toBe("stop");
			pool.advance(30_000);
			expect((await runTurn(pool, turn2)).stopReason).toBe("error");

			pool.advance(recoveryMs);
			const retry = await during(pool, () => runTurn(pool, turn2));

			expect(retry.result.stopReason).toBe("stop");
			// A serves the retry and B never served this session, so B wrote nothing.
			expect(trail(provider.requests)).toEqual(["A:200", "A:429", "B:429", "A:200"]);
			// A receives exactly the prompt it was sent for this turn, so it reads the prefix it cached.
			const [, failedOnA, , retriedOnA] = provider.requests.map(cacheKey);
			expect(retriedOnA).toEqual(failedOnA);
			expect(retry.observations).toEqual([
				expect.objectContaining({ kind: "fork", reason: "timeout_retry", seatChanged: false }),
			]);
			expect(retry.logged.filter((line) => line.seatChanged === true)).toEqual([]);
		},
		120_000,
	);

	it("a turn whose attempt on B stalled and was aborted is retried on A once A recovers", async () => {
		const provider = await startProvider({ A: [served, limited(30)], B: [stalled] });
		cleanup.push(() => provider.close());
		const pool = await twoAccountPool(provider.baseUrl);
		expect((await runTurn(pool, turn1)).stopReason).toBe("stop");
		pool.advance(30_000);
		const abort = new AbortController();
		const attempt = runTurn(pool, turn2, abort.signal);
		await provider.arrived(3);
		abort.abort();
		expect((await attempt).stopReason).toBe("aborted");

		pool.advance(2 * HOUR_MS);
		const retry = await during(pool, () => runTurn(pool, turn2));

		expect(retry.result.stopReason).toBe("stop");
		expect(trail(provider.requests)).toEqual(["A:200", "A:429", "B:stalled", "A:200"]);
		const [, failedOnA, , retriedOnA] = provider.requests.map(cacheKey);
		expect(retriedOnA).toEqual(failedOnA);
		expect(retry.observations).toEqual([
			expect.objectContaining({ kind: "fork", reason: "timeout_retry", seatChanged: false }),
		]);
	}, 120_000);

	it("keeps the binding on a process on B that a clean interrupt kept, which holds the turn", async () => {
		const query = new KeptAfterInterruptQuery();
		overrideSessionRegistryBoundary({
			queryFactory: ({ prompt }) => query.consuming(prompt),
			scheduleReap: () => ({ cancel: () => {}, unref: () => {} }),
		});
		const sessionId = `omo-10304-cache-holder-${sessionIds.length + 1}`;
		sessionIds.push(sessionId);
		const entry = getOrCreateSession({
			senpiSessionId: sessionId,
			accountName: SEATS.B,
			modelId: MODEL_ID,
			toolsetHash: "toolset",
			systemPromptHash: "prompt",
			options: { cwd: tmpdir() },
		});
		entry.sdkSessionIdConfirmed = true;
		entry.sentCount = 1;
		entry.assistantUuidByIndex.set(1, "assistant-1");
		const servedOnA: ContinuityBinding = {
			senpiSessionId: sessionId,
			sdkSessionId: "served-on-a",
			sdkSessionIdConfirmed: true,
			sentCount: 1,
			sentHashes: ["hash-1"],
			lastAssistantUuid: "assistant-1",
			assistantUuidByIndex: [[1, "assistant-1"]],
			accountName: SEATS.A,
			modelId: MODEL_ID,
			systemPromptHash: "prompt",
			toolsetHash: "toolset",
		};
		const abort = new AbortController();
		const attempt = createSessionTurnAttempt(
			entry,
			{ role: "user", content: [{ type: "text", text: "second" }] } as SDKUserMessage["message"],
			["hash-1", "hash-2"],
			abort.signal,
			{ emit: () => {} },
			servedOnA,
		);
		const delivered: SDKMessage[] = [];
		const drained = (async () => {
			for await (const message of attempt.messages) delivered.push(message);
		})();

		await query.submitted;
		abort.abort();
		// The pump reads the receipt off the promise interrupt() returned, before the result arrives.
		await query.receipt;
		query.answerInterruptedTurn();
		await drained;

		expect(getSession(sessionId)?.accountName).toBe(SEATS.B);
		expect(getBinding(sessionId)).toMatchObject({
			accountName: SEATS.B,
			sdkSessionId: entry.sdkSessionId,
			unansweredTurnDigest: expect.any(String),
		});
	});

	it("moves to B while A stays down, logged as a seat change, and stays on B once A recovers", async () => {
		const provider = await startProvider({ A: [served, limited(3_600)], B: [served, served] });
		cleanup.push(() => provider.close());
		const pool = await twoAccountPool(provider.baseUrl);
		expect((await runTurn(pool, turn1)).stopReason).toBe("stop");
		pool.advance(30_000);

		const moved = await during(pool, () => runTurn(pool, turn2));
		expect(moved.result.stopReason).toBe("stop");
		expect(moved.observations).toContainEqual(
			expect.objectContaining({ kind: "fork", reason: "account_changed", seatChanged: true }),
		);
		expect(moved.logged.some((line) => line.seatChanged === true)).toBe(true);

		pool.advance(2 * HOUR_MS);
		const stayed = await during(pool, () => runTurn(pool, turn3));
		expect(stayed.result.stopReason).toBe("stop");
		expect(trail(provider.requests)).toEqual(["A:200", "A:429", "B:200", "B:200"]);
		expect(stayed.observations).toEqual([expect.objectContaining({ seatChanged: false })]);
	}, 120_000);
});
