import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	CLAUDE_SDK_OAUTH_COMPACT_BOUNDARY_DIAGNOSTIC,
	CLAUDE_SDK_OAUTH_COMPACT_ENTRY_TYPE,
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
		provider: "claude-sdk-oauth",
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
	it("treats the claude-sdk-oauth main lane as SDK-native when resume mode is auto", () => {
		expect(isSdkNativeCompactionLane({ model: { provider: "claude-sdk-oauth" }, resumeMode: "auto" })).toBe(true);
	});

	it("treats the claude-sdk-oauth lane as SDK-native when resume mode is unset (default auto)", () => {
		expect(isSdkNativeCompactionLane({ model: { provider: "claude-sdk-oauth" } })).toBe(true);
	});

	it("keeps senpi compaction for the claude-sdk-oauth lane when the resumeMode escape hatch is off", () => {
		expect(isSdkNativeCompactionLane({ model: { provider: "claude-sdk-oauth" }, resumeMode: "off" })).toBe(false);
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
	it("resolves resume mode once per cwd and disables senpi compaction for the lane", () => {
		let loads = 0;
		const policy = createCompactionLanePolicy({
			loadProviderSettings: () => {
				loads++;
				return { resumeMode: "auto" };
			},
		});
		const ctx = { cwd: "/repo", model: { provider: "claude-sdk-oauth" } };

		expect(policy.disablesSenpiCompaction(ctx)).toBe(true);
		expect(policy.disablesSenpiCompaction(ctx)).toBe(true);
		expect(loads).toBe(1);
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

	it("re-resolves when the cwd changes", () => {
		const seen: string[] = [];
		const policy = createCompactionLanePolicy({
			loadProviderSettings: (cwd) => {
				seen.push(cwd);
				return { resumeMode: cwd === "/off" ? "off" : "auto" };
			},
		});

		expect(policy.disablesSenpiCompaction({ cwd: "/auto", model: { provider: "claude-sdk-oauth" } })).toBe(true);
		expect(policy.disablesSenpiCompaction({ cwd: "/off", model: { provider: "claude-sdk-oauth" } })).toBe(false);
		expect(seen).toEqual(["/auto", "/off"]);
	});

	it("keeps senpi compaction enabled when provider settings cannot be read", () => {
		const policy = createCompactionLanePolicy({
			loadProviderSettings: () => {
				throw new Error("settings unavailable");
			},
		});

		expect(policy.disablesSenpiCompaction({ cwd: "/repo", model: { provider: "claude-sdk-oauth" } })).toBe(false);
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
				type: CLAUDE_SDK_OAUTH_COMPACT_BOUNDARY_DIAGNOSTIC,
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
		expect(CLAUDE_SDK_OAUTH_COMPACT_ENTRY_TYPE).toBe("claude-sdk-oauth-compact");
	});
});
