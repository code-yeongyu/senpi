import { type Api, type AssistantMessage, type Context, isContextOverflow, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	COLD_SEED_OVERFLOW_DIAGNOSTIC,
	coldSeedCalibration,
	coldSeedOverflow,
	estimateColdSeedTokens,
	forgetColdSeedCalibration,
	markColdSeedOverflow,
	parseReportedOverflowTokens,
	restoreColdSeedCalibration,
} from "../src/core/extensions/builtin/anthropic-subscription/cold-seed-budget.ts";
import { forgetBinding } from "../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import { closeSession, getSession } from "../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { streamAnthropicSubscription } from "../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import {
	installScriptedSdk,
	installSingleAccountLane,
	resetScriptedSdk,
	sdkMessage,
} from "./helpers/anthropic-subscription-scripted-sdk.ts";

const SESSION_ID = "cold-seed-budget";

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function priorAnswer(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

/** A second-turn context with no resident session: the next dispatch is a cold-seed. */
function coldSeedContext(history: string): Context {
	return {
		systemPrompt: "SYSTEM",
		messages: [
			{ role: "user", content: "first", timestamp: 1 },
			priorAnswer(history),
			{ role: "user", content: "next", timestamp: 3 },
		],
	};
}

afterEach(() => {
	closeSession(SESSION_ID, "test_cleanup");
	forgetBinding(SESSION_ID);
	forgetColdSeedCalibration();
	resetScriptedSdk();
});

function rejectedColdSeed(errorMessage: string): AssistantMessage {
	return { ...priorAnswer(""), stopReason: "error", errorMessage };
}

describe("anthropic-subscription cold-seed budget", () => {
	it("counts UTF-8 bytes, so CJK history is not under-counted like chars/4", () => {
		const hangul = estimateColdSeedTokens({}, [{ type: "text", text: "가".repeat(4_000) }]);
		const ascii = estimateColdSeedTokens({}, [{ type: "text", text: "a".repeat(4_000) }]);
		expect(hangul).toBeGreaterThan(ascii * 2.9);
	});

	it("counts the system prompt and tool schemas the re-send carries", () => {
		const blocks = [{ type: "text" as const, text: "history" }];
		const bare = estimateColdSeedTokens({}, blocks);
		const dressed = estimateColdSeedTokens(
			{
				systemPrompt: "s".repeat(4_000),
				tools: [{ name: "read", description: "d".repeat(4_000), parameters: {} as never }],
			},
			blocks,
		);
		expect(dressed - bare).toBeGreaterThanOrEqual(2_000);
	});

	it("reads the token counts a rejection reports, in each wording the lane sees", () => {
		expect(
			parseReportedOverflowTokens(
				"Prompt is too long · the request is ~1119185 tokens (limit 1000000) but this conversation is only ~659662 tokens — the rest is system prompt",
			),
		).toEqual({ reportedTokens: 1_119_185, reportedLimit: 1_000_000 });
		expect(parseReportedOverflowTokens("prompt is too long: 213,462 tokens > 200,000 maximum")).toEqual({
			reportedTokens: 213_462,
			reportedLimit: 200_000,
		});
		expect(
			parseReportedOverflowTokens(
				"The conversation is too long to resend (about 1200 tokens, limit 1000). Compacting it and retrying.",
			),
		).toEqual({ reportedTokens: 1_200, reportedLimit: 1_000 });
		expect(parseReportedOverflowTokens("Prompt is too long (invalid_request)")).toBeUndefined();
		expect(parseReportedOverflowTokens(undefined)).toBeUndefined();
	});

	it("learns how far bytes/4 under-counted from a rejection's count and sizes the next re-send with it", () => {
		expect(coldSeedCalibration(SESSION_ID)).toBe(1);
		expect(coldSeedOverflow(model, 150_000)).toBeUndefined();

		const bare = rejectedColdSeed("Prompt is too long (invalid_request)");
		markColdSeedOverflow(bare, model, true, 150_000, SESSION_ID);
		expect(bare.diagnostics).toEqual([
			expect.objectContaining({ type: COLD_SEED_OVERFLOW_DIAGNOSTIC, details: { estimatedTokens: 150_000 } }),
		]);
		expect(coldSeedCalibration(SESSION_ID)).toBe(1);

		const counted = rejectedColdSeed(
			"Prompt is too long · the request is ~300000 tokens (limit 200000) but this conversation",
		);
		markColdSeedOverflow(counted, model, true, 150_000, SESSION_ID);
		expect(counted.diagnostics?.[0]).toMatchObject({
			details: { estimatedTokens: 150_000, reportedTokens: 300_000, reportedLimit: 200_000 },
		});
		expect(coldSeedCalibration(SESSION_ID)).toBe(2);
		expect(coldSeedCalibration("another-session")).toBe(1);

		expect(coldSeedOverflow(model, 150_000, coldSeedCalibration(SESSION_ID))?.message).toBe(
			"The conversation is too long to resend (about 300000 tokens, limit 200000). Compacting it and retrying.",
		);
		expect(coldSeedOverflow(model, 90_000, coldSeedCalibration(SESSION_ID))).toBeUndefined();

		const lower = rejectedColdSeed(
			"Prompt is too long · the request is ~210000 tokens (limit 200000) but this conversation",
		);
		markColdSeedOverflow(lower, model, true, 150_000, SESSION_ID);
		expect(coldSeedCalibration(SESSION_ID)).toBe(2);

		const notAboutThePayload = rejectedColdSeed("Prompt is too long · the request is ~9000000 tokens (limit 200000)");
		markColdSeedOverflow(notAboutThePayload, model, true, 150_000, SESSION_ID);
		expect(coldSeedCalibration(SESSION_ID)).toBe(8);

		forgetColdSeedCalibration(SESSION_ID);
		expect(coldSeedCalibration(SESSION_ID)).toBe(1);
	});

	it("never learns from its own pre-dispatch refusal, which only restates the current calibration", () => {
		const counted = rejectedColdSeed("prompt is too long: 300000 tokens > 200000 maximum");
		markColdSeedOverflow(counted, model, true, 150_000, SESSION_ID);
		expect(coldSeedCalibration(SESSION_ID)).toBe(2);

		const refusal = coldSeedOverflow(model, 100_001, coldSeedCalibration(SESSION_ID));
		expect(refusal?.message).toBe(
			"The conversation is too long to resend (about 200002 tokens, limit 200000). Compacting it and retrying.",
		);
		const ownRefusal = rejectedColdSeed(refusal?.message ?? "");
		markColdSeedOverflow(ownRefusal, model, true, 90_000, SESSION_ID);
		expect(coldSeedCalibration(SESSION_ID)).toBe(2);
		expect(ownRefusal.diagnostics?.[0]).toMatchObject({ details: { estimatedTokens: 90_000 } });
		expect(ownRefusal.diagnostics?.[0]?.details).not.toHaveProperty("reportedTokens");
	});

	it("restores a restarted session's calibration from the newest marker that carries a count", () => {
		const marked = (details: Record<string, number>) => ({
			type: "message",
			message: {
				role: "assistant",
				diagnostics: [{ type: COLD_SEED_OVERFLOW_DIAGNOSTIC, timestamp: 1, details }],
			},
		});
		const branch = [
			marked({ estimatedTokens: 100_000, reportedTokens: 150_000, reportedLimit: 200_000 }),
			{ type: "compaction" },
			marked({ estimatedTokens: 100_000, reportedTokens: 300_000, reportedLimit: 200_000 }),
			marked({ estimatedTokens: 120_000 }),
		];
		restoreColdSeedCalibration(SESSION_ID, branch);
		expect(coldSeedCalibration(SESSION_ID)).toBe(3);

		forgetColdSeedCalibration(SESSION_ID);
		restoreColdSeedCalibration(SESSION_ID, [marked({ estimatedTokens: 100_000 })]);
		expect(coldSeedCalibration(SESSION_ID)).toBe(1);
	});

	it("keeps a bounded number of calibrated sessions, dropping the oldest", () => {
		const counted = () => rejectedColdSeed("prompt is too long: 300000 tokens > 200000 maximum");
		for (let index = 0; index <= 256; index += 1)
			markColdSeedOverflow(counted(), model, true, 150_000, `session-${index}`);
		expect(coldSeedCalibration("session-0")).toBe(1);
		expect(coldSeedCalibration("session-1")).toBe(2);
		expect(coldSeedCalibration("session-256")).toBe(2);
	});

	it("refuses an oversized cold-seed before dispatch and marks it as a cold-seed overflow", async () => {
		await installSingleAccountLane();
		const queries = installScriptedSdk(() => {
			throw new Error("an oversized cold-seed must never be submitted");
		});
		const tight = { ...model, contextWindow: 1_000 };

		const result = await streamAnthropicSubscription(tight, coldSeedContext("x".repeat(8_000)), {
			sessionId: SESSION_ID,
			streamKind: "main",
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(
			/^The conversation is too long to resend \(about \d+ tokens, limit 1000\)\. Compacting it and retrying\.$/,
		);
		expect(isContextOverflow(result, tight.contextWindow)).toBe(true);
		expect(result.diagnostics?.map((diagnostic) => diagnostic.type)).toContain(COLD_SEED_OVERFLOW_DIAGNOSTIC);
		expect(queries.flatMap((query) => query.submitted)).toEqual([]);
		expect(getSession(SESSION_ID)).toBeUndefined();
	});

	it("still dispatches a cold-seed that fits and leaves a successful turn unmarked", async () => {
		await installSingleAccountLane();
		const queries = installScriptedSdk((sessionId, userUuid) => [
			sdkMessage({
				type: "result",
				subtype: "success",
				result: "fits",
				user_message_uuid: userUuid,
				session_id: sessionId,
				usage: { input_tokens: 10, output_tokens: 1 },
			}),
		]);

		const result = await streamAnthropicSubscription(model, coldSeedContext("x".repeat(8_000)), {
			sessionId: SESSION_ID,
			streamKind: "main",
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.diagnostics?.map((diagnostic) => diagnostic.type) ?? []).not.toContain(
			COLD_SEED_OVERFLOW_DIAGNOSTIC,
		);
		expect(queries.flatMap((query) => query.submitted)).toHaveLength(1);
	});
});
