import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addAccount, emptyCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	overrideAuthLaneBoundary,
	queryWithAuthLane,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { classifySdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import { anthropicSubscriptionModels } from "../../../src/core/extensions/builtin/anthropic-subscription/index.ts";
import {
	classifyForRequest,
	LONG_CONTEXT_FALLBACK_DIAGNOSTIC,
	sdkFailure,
} from "../../../src/core/extensions/builtin/anthropic-subscription/long-context-retry.ts";
import {
	_resetLongContextForTesting,
	longContextAvailable,
} from "../../../src/core/extensions/builtin/anthropic-subscription/long-context.ts";
import { buildAnthropicSubscriptionQueryOptions } from "../../../src/core/extensions/builtin/anthropic-subscription/options.ts";
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { ContinuityNoticeTracker } from "../../../src/modes/interactive/components/continuity-notice.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { cliLaneEnv, cliSlot } from "../../support/claude-cli-test-slots.ts";

const EXHAUSTED = "API Error: 400 You're out of extra usage. Add more at claude.ai/settings/usage and keep going.";
const REQUIRED =
	"Extra usage is required for long context · enable extra usage at claude.ai/settings/usage (rate_limit)";
const LEGACY = "claude-opus-4-6";
const NATIVE = "claude-opus-5";
let directory: string;
let statePath: string;

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "senpi-4065-"));
	statePath = join(directory, "long-context.json");
	_resetLongContextForTesting(statePath);
});

afterEach(() => {
	resetAuthLaneBoundary();
	resetSdkBoundary();
	_resetLongContextForTesting();
	rmSync(directory, { recursive: true, force: true });
});

type FakeTurn = {
	body?: string;
	visible?: boolean;
	alwaysRefuse?: boolean;
	contextTokens?: number;
	outputReserveTokens?: number;
};

function catalogModel(id: string): Model<Api> {
	const model = getModels("anthropic").find((candidate) => candidate.id === id) as Model<Api> | undefined;
	if (!model) throw new Error(`Missing fixture model: ${id}`);
	return model;
}

/** An SDK fake whose first query (every query with `alwaysRefuse`) fails with `body`; later ones succeed. */
function refusingQuery({ body = EXHAUSTED, visible = false, alwaysRefuse = false }: FakeTurn) {
	const attempts: Options[] = [];
	const closed: number[] = [];
	const query: SdkQuery = (input) => {
		const options = input.options;
		if (!options) throw new Error("Expected SDK options");
		attempts.push(options);
		const attempt = attempts.length;
		if (attempt > 1) expect(closed).toContain(attempt - 1);
		return {
			async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
				if (visible) {
					yield { type: "stream_event", event: { type: "content_block_delta" } } as SDKMessage;
				}
				yield (
					attempt === 1 || alwaysRefuse
						? { type: "result", subtype: "error_during_execution", is_error: true, errors: [body] }
						: { type: "result", subtype: "success", result: "ok" }
				) as SDKMessage;
			},
			async interrupt() {},
			close() {
				closed.push(attempt);
			},
		};
	};
	return { attempts, query };
}

async function runTurn(lane: "ambient" | "oauth-slots", id: string, turn: FakeTurn = {}, standardWindow = false) {
	const store = new InMemoryCredentialStore();
	await store.modify("anthropic-subscription", async () => addAccount(emptyCredential(), cliSlot("main")));
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => cliLaneEnv(),
		getAgentDir: () => directory,
	});
	const model = catalogModel(id);
	const { attempts, query } = refusingQuery(turn);
	const messages: SDKMessage[] = [];
	let fallbacks = 0;
	let failure: unknown;
	try {
		for await (const message of queryWithAuthLane({
			prompt: "hi",
			query,
			buildOptions: (authLane) =>
				buildAnthropicSubscriptionQueryOptions({
					model: standardWindow ? { ...model, contextWindow: 200_000 } : model,
					context: { messages: [] },
					cwd: directory,
					providerSettings: { tokenInjection: lane },
					authLane,
				}),
			providerSettings: { tokenInjection: lane },
			model: id,
			contextTokens: () => turn.contextTokens ?? 0,
			outputReserveTokens: turn.outputReserveTokens,
			onLongContextFallback: () => {
				fallbacks++;
			},
		})) {
			messages.push(message);
			failure = sdkFailure(message) ?? failure;
		}
	} catch (error) {
		failure = error;
	}
	return { attempts, messages, failure, fallbacks, credential: await store.read("anthropic-subscription") };
}

// senpi#4065: the billing text alone does not prove that the request asked for [1m].
describe.each(["ambient", "oauth-slots"] as const)("%s: extra usage exhaustion", (lane) => {
	it.each([EXHAUSTED, REQUIRED])("retries a refused [1m] request once at 200k: %s", async (body) => {
		const result = await runTurn(lane, LEGACY, { body });

		expect(result.attempts.map((options) => options.model)).toEqual([`${LEGACY}[1m]`, LEGACY]);
		expect(result.attempts.map((options) => options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS)).toEqual([
			"1000000",
			"200000",
		]);
		expect(result.failure).toBeUndefined();
		expect(result.messages).toEqual([{ type: "result", subtype: "success", result: "ok" }]);
		expect(result.fallbacks).toBe(1);
		expect(longContextAvailable()).toBe(body === EXHAUSTED);
		expect(existsSync(statePath)).toBe(body !== EXHAUSTED);
		expect(result.credential).not.toHaveProperty("accounts.0.blockReason");
		expect(anthropicSubscriptionModels().find((model) => model.id === LEGACY)?.contextWindow).toBe(
			body === EXHAUSTED ? 1_000_000 : 200_000,
		);
	});

	it("asks for [1m] again on the next request after exhaustion", async () => {
		await runTurn(lane, LEGACY);
		const second = await runTurn(lane, LEGACY);
		expect(second.attempts[0].model).toBe(`${LEGACY}[1m]`);
		expect(second.attempts[0].env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("1000000");
		expect(second.attempts[0].env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
	});

	it.each([
		{ contextTokens: 200_001, outputReserveTokens: 0 },
		{ contextTokens: 195_000, outputReserveTokens: 8_192 },
	])("keeps Claude's reason when prompt and output cannot fit 200k: %j", async (budget) => {
		const result = await runTurn(lane, LEGACY, budget);
		expect(result.attempts.map((options) => options.model)).toEqual([`${LEGACY}[1m]`]);
		expect(String(result.failure)).toContain(EXHAUSTED);
		expect(String(result.failure)).toMatch(/top up|extra usage/i);
		expect(String(result.failure)).toMatch(/new|compact/i);
		expect(result.fallbacks).toBe(0);
		expect(longContextAvailable()).toBe(true);
		expect(existsSync(statePath)).toBe(false);
	});

	it("uses coded billing to fail over without a 200k retry", async () => {
		const result = await runTurn(lane, LEGACY, { body: `${EXHAUSTED} (billing_error)` });
		expect(result.attempts).toHaveLength(1);
		expect(result.fallbacks).toBe(0);
		expect(longContextAvailable()).toBe(true);
	});

	// senpi#4066: admit the exact boundary, but never send a retry whose actual output cap exceeds it.
	it.each([
		{ contextTokens: 191_808, outputReserveTokens: undefined, cap: 8_192 },
		{ contextTokens: 191_809, outputReserveTokens: undefined, cap: undefined },
		{ contextTokens: 175_000, outputReserveTokens: undefined, cap: 25_000 },
		{ contextTokens: 150_000, outputReserveTokens: undefined, cap: 32_000 },
		{ contextTokens: 183_616, outputReserveTokens: 16_384, cap: 16_384 },
		{ contextTokens: 183_617, outputReserveTokens: 16_384, cap: undefined },
	])("budgets the output actually requested at 200k: %j", async ({ cap, ...budget }) => {
		const result = await runTurn(lane, LEGACY, budget);
		expect(result.attempts).toHaveLength(cap === undefined ? 1 : 2);
		if (cap !== undefined) {
			expect(result.failure).toBeUndefined();
			expect(result.attempts[1].env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(String(cap));
		} else {
			expect(String(result.failure)).toContain(EXHAUSTED);
		}
	});

	it.each([NATIVE, LEGACY])("does not retry exhaustion on a plain %s request", async (id) => {
		const result = await runTurn(lane, id, {}, true);

		expect(result.attempts.map((options) => options.model)).toEqual([id]);
		expect(String(result.failure)).toContain(EXHAUSTED);
		expect(classifyForRequest(result.failure, false)).toEqual({ kind: "billing", retryable: false });
		expect(result.fallbacks).toBe(0);
		expect(longContextAvailable()).toBe(true);
		expect(existsSync(statePath)).toBe(false);
	});

	it("does not downgrade after visible content", async () => {
		const result = await runTurn(lane, LEGACY, { visible: true });

		expect(result.attempts).toHaveLength(1);
		expect(String(result.failure)).toContain(EXHAUSTED);
		expect(result.fallbacks).toBe(0);
		expect(longContextAvailable()).toBe(true);
	});

	it("does not repeat the standard-window retry when billing still fails", async () => {
		const result = await runTurn(lane, LEGACY, { alwaysRefuse: true });

		expect(result.attempts.map((options) => options.model)).toEqual([`${LEGACY}[1m]`, LEGACY]);
		expect(String(result.failure)).toContain(EXHAUSTED);
		expect(result.fallbacks).toBe(1);
	});
});

describe("the turn a refused [1m] request produces", () => {
	async function streamTurn(model: Model<Api>) {
		overrideAuthLaneBoundary({
			createStore: () => new InMemoryCredentialStore(),
			env: () => ({ PATH: "/usr/bin" }),
			getAgentDir: () => directory,
		});
		const fake = refusingQuery({});
		overrideSdkBoundary({ query: fake.query });
		const message = await streamAnthropicSubscription(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{ cwd: directory },
		).result();
		return { message, attempts: fake.attempts };
	}

	it("answers on the same model and carries a visible 200k notice", async () => {
		const { message, attempts } = await streamTurn(catalogModel(LEGACY));

		expect(attempts.map((options) => options.model)).toEqual([`${LEGACY}[1m]`, LEGACY]);
		expect(message.stopReason).toBe("stop");
		expect(message.model).toBe(LEGACY);
		expect(message.diagnostics?.map((diagnostic) => diagnostic.type)).toContain(LONG_CONTEXT_FALLBACK_DIAGNOSTIC);
		expect(new ContinuityNoticeTracker().noticeFor(message)).toBeDefined();
	});

	it("fails a plain request with Claude's own reason and no 200k notice", async () => {
		const { message, attempts } = await streamTurn({ ...catalogModel(LEGACY), contextWindow: 200_000 });

		expect(attempts.map((options) => options.model)).toEqual([LEGACY]);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("claude.ai/settings/usage");
		expect(message.diagnostics?.map((diagnostic) => diagnostic.type) ?? []).not.toContain(
			LONG_CONTEXT_FALLBACK_DIAGNOSTIC,
		);
		expect(new ContinuityNoticeTracker().noticeFor(message)).toBeUndefined();
	});
});

it("classifies the exhaustion as billing without request context", () => {
	expect(classifySdkError(new Error(EXHAUSTED))).toEqual({ kind: "billing", retryable: false });
});

it("reads the exhaustion from Claude's assistant error shape too, keeping the SDK's account verdict without [1m]", () => {
	const failure = new Error(`${EXHAUSTED} (billing_error)`);

	expect(classifyForRequest(failure, true)).toEqual({ kind: "billing", retryable: true });
	expect(classifyForRequest(failure, false)).toEqual({ kind: "billing", retryable: true });
});
