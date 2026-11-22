import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	ANTHROPIC_SUBSCRIPTION_COMPACT_BOUNDARY_DIAGNOSTIC,
	ANTHROPIC_SUBSCRIPTION_COMPACT_ENTRY_TYPE,
	collectCompactBoundaryEntries,
	createCompactionLanePolicy,
	isSdkNativeCompactionLane,
	parseCompactBoundaryMessage,
} from "../../src/core/extensions/builtin/compaction/lane-policy.ts";

function assistantMessageWithDiagnostics(diagnostics: AssistantMessage["diagnostics"]): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "claude-sdk-oauth",
		provider: "anthropic-subscription",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...(diagnostics ? { diagnostics } : {}),
	} as AssistantMessage;
}

describe("compaction lane policy — provider scoping", () => {
	// senpi owns the resident lane by default; only the explicit `sdk` owner hands it to the SDK.
	it("keeps senpi compaction on the resident lane when compactionOwner is unset or senpi", () => {
		const lane = { provider: "anthropic-subscription" };
		expect(isSdkNativeCompactionLane({ model: lane })).toBe(false);
		expect(isSdkNativeCompactionLane({ model: lane, resumeMode: "auto" })).toBe(false);
		expect(isSdkNativeCompactionLane({ model: lane, resumeMode: "auto", compactionOwner: "senpi" })).toBe(false);
	});

	it("treats the resident lane as SDK-native when compactionOwner is sdk", () => {
		const lane = { provider: "anthropic-subscription" };
		expect(isSdkNativeCompactionLane({ model: lane, compactionOwner: "sdk" })).toBe(true);
		expect(isSdkNativeCompactionLane({ model: lane, resumeMode: "auto", compactionOwner: "sdk" })).toBe(true);
	});

	it("keeps senpi compaction for the claude-sdk-oauth lane when the resumeMode escape hatch is off", () => {
		expect(
			isSdkNativeCompactionLane({
				model: { provider: "anthropic-subscription" },
				resumeMode: "off",
				compactionOwner: "sdk",
			}),
		).toBe(false);
	});

	it("never claims other providers", () => {
		expect(isSdkNativeCompactionLane({ model: { provider: "anthropic" }, resumeMode: "auto" })).toBe(false);
		expect(isSdkNativeCompactionLane({ model: { provider: "openai" } })).toBe(false);
	});

	it("does not claim an unknown model", () => {
		expect(isSdkNativeCompactionLane({ model: undefined })).toBe(false);
	});
});

describe("compaction lane policy — instance policy", () => {
	// The query options re-read provider settings every turn; the lane policy must read the same
	// live value, or a mid-session owner change leaves two owners (or none) for one transcript.
	it("reads the compaction owner on every call so a mid-session change applies to the next check", () => {
		let owner: "sdk" | "senpi" = "sdk";
		const policy = createCompactionLanePolicy({
			loadProviderSettings: () => ({ resumeMode: "auto", compactionOwner: owner }),
		});
		const ctx = { cwd: "/repo", model: { provider: "anthropic-subscription" } };

		expect(policy.disablesSenpiCompaction(ctx)).toBe(true);
		owner = "senpi";
		expect(policy.disablesSenpiCompaction(ctx)).toBe(false);
		expect(policy.ownsCompaction(ctx, "threshold")).toBe(true);
		owner = "sdk";
		expect(policy.disablesSenpiCompaction(ctx)).toBe(true);
		expect(policy.ownsCompaction(ctx, "threshold")).toBe(false);
	});

	it("leaves senpi compaction enabled for other providers without reading provider settings", () => {
		let loads = 0;
		const policy = createCompactionLanePolicy({
			loadProviderSettings: () => {
				loads++;
				return { resumeMode: "auto" };
			},
		});

		expect(policy.disablesSenpiCompaction({ cwd: "/repo", model: { provider: "anthropic" } })).toBe(false);
		expect(loads).toBe(0);
	});

	it("leaves senpi compaction enabled on the resident lane when compactionOwner is senpi", () => {
		const policy = createCompactionLanePolicy({
			loadProviderSettings: () => ({ resumeMode: "auto", compactionOwner: "senpi" }),
		});
		const ctx = { cwd: "/repo", model: { provider: "anthropic-subscription" } };

		expect(policy.disablesSenpiCompaction(ctx)).toBe(false);
		expect(policy.ownsCompaction(ctx, "threshold")).toBe(true);
	});

	it("reports an append-only transcript only for the resident lane", () => {
		const policy = createCompactionLanePolicy({
			loadProviderSettings: (cwd) => ({ resumeMode: cwd === "/off" ? "off" : "auto" }),
		});
		const lane = { provider: "anthropic-subscription" };

		expect(policy.hasAppendOnlyTranscript({ cwd: "/auto", model: lane })).toBe(true);
		expect(policy.hasAppendOnlyTranscript({ cwd: "/off", model: lane })).toBe(false);
		expect(policy.hasAppendOnlyTranscript({ cwd: "/auto", model: { provider: "anthropic" } })).toBe(false);
	});

	it("re-resolves when the cwd changes", () => {
		const seen: string[] = [];
		const policy = createCompactionLanePolicy({
			loadProviderSettings: (cwd) => {
				seen.push(cwd);
				return { resumeMode: cwd === "/off" ? "off" : "auto", compactionOwner: "sdk" };
			},
		});

		expect(policy.disablesSenpiCompaction({ cwd: "/auto", model: { provider: "anthropic-subscription" } })).toBe(
			true,
		);
		expect(policy.disablesSenpiCompaction({ cwd: "/off", model: { provider: "anthropic-subscription" } })).toBe(
			false,
		);
		expect(seen).toEqual(["/auto", "/off"]);
	});

	it("keeps senpi compaction enabled when provider settings cannot be read", () => {
		const policy = createCompactionLanePolicy({
			loadProviderSettings: () => {
				throw new Error("settings unavailable");
			},
		});

		expect(policy.disablesSenpiCompaction({ cwd: "/repo", model: { provider: "anthropic-subscription" } })).toBe(
			false,
		);
	});

	it("re-enables senpi compaction on the SDK-native lane when a compaction model override is set", () => {
		const policy = createCompactionLanePolicy({
			loadProviderSettings: () => ({ resumeMode: "auto", compactionOwner: "sdk" }),
		});
		const ctx = {
			cwd: "/repo",
			model: { provider: "anthropic-subscription" },
			getCompactionSettings: () => ({ model: "deepseek/deepseek-chat" }),
		};

		// The override makes senpi own summarization, so the stand-down lifts.
		expect(policy.disablesSenpiCompaction(ctx)).toBe(false);
	});

	it("still stands down on the SDK-native lane when the override resolves to no model", () => {
		const policy = createCompactionLanePolicy({
			loadProviderSettings: () => ({ resumeMode: "auto", compactionOwner: "sdk" }),
		});

		expect(
			policy.disablesSenpiCompaction({
				cwd: "/repo",
				model: { provider: "anthropic-subscription" },
				getCompactionSettings: () => ({ model: undefined }),
			}),
		).toBe(true);
		expect(
			policy.disablesSenpiCompaction({
				cwd: "/repo",
				model: { provider: "anthropic-subscription" },
				getCompactionSettings: () => ({}),
			}),
		).toBe(true);
	});
});

describe("compaction lane policy — compact_boundary mirroring", () => {
	it("parses an SDK compact_boundary system message into a session entry payload", () => {
		const entry = parseCompactBoundaryMessage({
			type: "system",
			subtype: "compact_boundary",
			uuid: "11111111-1111-4111-8111-111111111111",
			session_id: "sdk-session-1",
			compact_metadata: { trigger: "auto", pre_tokens: 120_000, post_tokens: 20_000 },
		});

		expect(entry).toEqual({
			schema: "senpi.claude-sdk-oauth.compact-boundary.v1",
			sdkSessionId: "sdk-session-1",
			uuid: "11111111-1111-4111-8111-111111111111",
			compactMetadata: { trigger: "auto", pre_tokens: 120_000, post_tokens: 20_000 },
		});
	});

	it("rejects system messages that are not compact boundaries", () => {
		expect(
			parseCompactBoundaryMessage({
				type: "system",
				subtype: "init",
				uuid: "u",
				session_id: "s",
			}),
		).toBeUndefined();
		expect(parseCompactBoundaryMessage(undefined)).toBeUndefined();
		expect(parseCompactBoundaryMessage({ type: "system", subtype: "compact_boundary" })).toBeUndefined();
	});

	it("collects boundary entries carried as assistant-message diagnostics", () => {
		const message = assistantMessageWithDiagnostics([
			{
				type: ANTHROPIC_SUBSCRIPTION_COMPACT_BOUNDARY_DIAGNOSTIC,
				timestamp: 5,
				details: {
					type: "system",
					subtype: "compact_boundary",
					uuid: "22222222-2222-4222-8222-222222222222",
					session_id: "sdk-session-2",
					compact_metadata: { trigger: "manual", pre_tokens: 90_000 },
				},
			},
		]);

		expect(collectCompactBoundaryEntries(message)).toEqual([
			{
				schema: "senpi.claude-sdk-oauth.compact-boundary.v1",
				sdkSessionId: "sdk-session-2",
				uuid: "22222222-2222-4222-8222-222222222222",
				compactMetadata: { trigger: "manual", pre_tokens: 90_000 },
			},
		]);
	});

	it("ignores messages without boundary diagnostics", () => {
		expect(collectCompactBoundaryEntries(assistantMessageWithDiagnostics(undefined))).toEqual([]);
		expect(
			collectCompactBoundaryEntries(
				assistantMessageWithDiagnostics([
					{ type: "claude_sdk_oauth_session_continuity", timestamp: 1, details: { kind: "delta" } },
				]),
			),
		).toEqual([]);
		expect(collectCompactBoundaryEntries({ role: "user", content: "hi", timestamp: 1 })).toEqual([]);
	});

	it("names the senpi custom entry type used for mirrored boundaries", () => {
		expect(ANTHROPIC_SUBSCRIPTION_COMPACT_ENTRY_TYPE).toBe("claude-sdk-oauth-compact");
	});
});
