import type { Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { Options } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import {
	type ContinuityDecisionInput,
	decideNativeContinuity,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";
import {
	configFingerprint,
	sentHashPrefixDigest,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-sync.ts";

// oh-my-openagent#7884: restart-binding fingerprint drift flattened the whole
// conversation with a bare `options_changed`; the live path reattaches on the same drift.

const FINGERPRINT = { systemPromptHash: "prompt-v1", toolsetHash: "tools-v1" };

function binding(overrides: Partial<NonNullable<ContinuityDecisionInput["binding"]>> = {}) {
	return {
		sdkSessionId: "sdk-1",
		sentCount: 2,
		sentHashes: ["h1", "h2"],
		lastAssistantUuid: "uuid-a2",
		accountName: "primary",
		modelId: "claude-opus-4-5",
		systemPromptHash: FINGERPRINT.systemPromptHash,
		toolsetHash: FINGERPRINT.toolsetHash,
		...overrides,
	} satisfies NonNullable<ContinuityDecisionInput["binding"]>;
}

function input(overrides: Partial<ContinuityDecisionInput> = {}): ContinuityDecisionInput {
	return {
		entry: undefined,
		binding: binding(),
		currentHashes: ["h1", "h2", "h3"],
		accountName: "primary",
		modelId: "claude-opus-4-5",
		fingerprint: FINGERPRINT,
		transcriptAvailable: true,
		...overrides,
	};
}

describe("claude-sdk-oauth restart binding drift (#7884)", () => {
	it("reattaches with system_prompt_changed when only the prompt hash drifted", () => {
		const decision = decideNativeContinuity(
			input({ fingerprint: { systemPromptHash: "prompt-v2", toolsetHash: FINGERPRINT.toolsetHash } }),
		);

		expect(decision).toEqual({
			kind: "reattach",
			sdkSessionId: "sdk-1",
			from: 2,
			reason: "system_prompt_changed",
		});
	});

	it("reattaches with toolset_changed when only the toolset hash drifted", () => {
		const decision = decideNativeContinuity(
			input({ fingerprint: { systemPromptHash: FINGERPRINT.systemPromptHash, toolsetHash: "tools-v2" } }),
		);

		expect(decision).toEqual({
			kind: "reattach",
			sdkSessionId: "sdk-1",
			from: 2,
			reason: "toolset_changed",
		});
	});

	it("reports the prompt first when both fingerprint halves drifted", () => {
		const decision = decideNativeContinuity(
			input({ fingerprint: { systemPromptHash: "prompt-v2", toolsetHash: "tools-v2" } }),
		);

		expect(decision).toMatchObject({ kind: "reattach", reason: "system_prompt_changed" });
	});

	it("reattaches with the drift reason instead of registry_miss behind a prefix digest", () => {
		const decision = decideNativeContinuity(
			input({
				binding: binding({ sentPrefixHash: sentHashPrefixDigest(["h1", "h2"]) }),
				fingerprint: { systemPromptHash: "prompt-v2", toolsetHash: FINGERPRINT.toolsetHash },
			}),
		);

		expect(decision).toEqual({
			kind: "reattach",
			sdkSessionId: "sdk-1",
			from: 2,
			reason: "system_prompt_changed",
		});
	});

	it("lets a sent-stream divergence dominate the drift reason", () => {
		const decision = decideNativeContinuity(
			input({
				currentHashes: ["h1", "h2-rewritten", "h3"],
				fingerprint: { systemPromptHash: "prompt-v2", toolsetHash: "tools-v2" },
			}),
		);

		expect(decision.kind).not.toBe("flatten");
		expect(decision.kind === "reattach" && decision.reason).not.toBe("system_prompt_changed");
	});

	it.each([
		["account", { accountName: "secondary" }, "account_changed"],
		["model", { modelId: "claude-sonnet-5" }, "model_changed"],
	] as const)("still flattens fail-closed when the %s drifts", (_label, override, reason) => {
		expect(decideNativeContinuity(input(override))).toEqual({ kind: "flatten", reason });
	});

	it("still flattens transcript_missing before any drift is considered", () => {
		const decision = decideNativeContinuity(
			input({
				transcriptAvailable: false,
				fingerprint: { systemPromptHash: "prompt-v2", toolsetHash: "tools-v2" },
			}),
		);

		expect(decision).toEqual({ kind: "flatten", reason: "transcript_missing" });
	});
});

describe("claude-sdk-oauth fingerprint midnight stability (#7884)", () => {
	const STABLE = ["You are senpi, a coding agent.", "", "## Available Tools", "- read: Read file contents"].join("\n");
	const APPEND = [
		"",
		"<Task_Management>",
		"## Todo Management",
		"",
		"Use the todo tool for multi-step work.",
		"</Task_Management>",
		"",
	].join("\n");

	function omoPrompt(date: string, append = APPEND): string {
		return `${STABLE}\n\nCurrent date: ${date}\nCurrent working directory: /repo\n${append}`;
	}

	function options(systemPrompt: string): Options {
		return {
			cwd: "/repo",
			model: "claude-opus-4-5",
			tools: ["Read"],
			permissionMode: "dontAsk",
			includePartialMessages: true,
			systemPrompt,
			settingSources: [],
		} as Options;
	}

	function context(): Context {
		return { systemPrompt: "", messages: [], tools: [] } as unknown as Context;
	}

	it("stays stable across midnight when extension appends follow the cwd line", () => {
		const before = configFingerprint(options(omoPrompt("2026-09-06")), context(), "oauth-slots", "primary");
		const after = configFingerprint(options(omoPrompt("2026-09-07")), context(), "oauth-slots", "primary");

		expect(after.systemPromptHash).toBe(before.systemPromptHash);
	});

	it("stays stable across midnight for the bare generated prompt shape", () => {
		const bare = (date: string): string => `${STABLE}\n\nCurrent date: ${date}\nCurrent working directory: /repo`;
		const before = configFingerprint(options(bare("2026-09-06")), context(), "oauth-slots", "primary");
		const after = configFingerprint(options(bare("2026-09-07")), context(), "oauth-slots", "primary");

		expect(after.systemPromptHash).toBe(before.systemPromptHash);
	});

	it("stays fail-closed when a trailing append changes content", () => {
		const before = configFingerprint(options(omoPrompt("2026-09-07")), context(), "oauth-slots", "primary");
		const after = configFingerprint(
			options(omoPrompt("2026-09-07", "\nAlways respond in Korean.\n")),
			context(),
			"oauth-slots",
			"primary",
		);

		expect(after.systemPromptHash).not.toBe(before.systemPromptHash);
	});
});
