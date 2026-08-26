import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SdkBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import {
	type ContinuityDecisionInput,
	decideNativeContinuity,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";
import {
	type ContinuityBinding,
	verifyRestoredTranscript,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";

const SDK_SESSION_ID = "sdk-session-1";
const SENPI_SESSION_ID = "senpi-session-1";
const CWD = "/repo";
const ASSISTANT_UUID = "uuid-a2";

function persistedBinding(): ContinuityBinding {
	return {
		senpiSessionId: SENPI_SESSION_ID,
		sdkSessionId: SDK_SESSION_ID,
		sentCount: 2,
		sentHashes: ["h1", "h2"],
		lastAssistantUuid: ASSISTANT_UUID,
		accountName: "primary",
		modelId: "claude-opus-4-5",
		systemPromptHash: "prompt-v1",
		toolsetHash: "tools-v1",
	};
}

function baseInput(overrides: Partial<ContinuityDecisionInput> = {}): ContinuityDecisionInput {
	return {
		entry: undefined,
		binding: {
			sdkSessionId: SDK_SESSION_ID,
			sentCount: 2,
			sentHashes: ["h1", "h2"],
			lastAssistantUuid: ASSISTANT_UUID,
			accountName: "primary",
			modelId: "claude-opus-4-5",
			systemPromptHash: "prompt-v1",
			toolsetHash: "tools-v1",
		},
		currentHashes: ["h1", "h2", "h3"],
		accountName: "primary",
		modelId: "claude-opus-4-5",
		fingerprint: { systemPromptHash: "prompt-v1", toolsetHash: "tools-v1" },
		transcriptAvailable: true,
		...overrides,
	};
}

function liveEntry(): NonNullable<ContinuityDecisionInput["entry"]> {
	return {
		sdkSessionId: SDK_SESSION_ID,
		accountName: "primary",
		modelId: "claude-opus-4-5",
		systemPromptHash: "prompt-v1",
		toolsetHash: "tools-v1",
		sentCount: 2,
		sentHashes: ["h1", "h2"],
		lastAssistantUuid: ASSISTANT_UUID,
		assistantUuidByIndex: new Map([
			[1, "uuid-a1"],
			[2, ASSISTANT_UUID],
		]),
		pendingForkReason: null,
	};
}

function sdkMessage(
	fields: Partial<SessionMessage> & Pick<SessionMessage, "type" | "uuid" | "session_id">,
): SessionMessage {
	return {
		message: {},
		parent_tool_use_id: null,
		parent_agent_id: null,
		...fields,
	};
}

afterEach(() => {
	resetSdkBoundary();
});

describe("claude-sdk-oauth restored security", () => {
	describe("decideNativeContinuity", () => {
		it.each([
			["account", { accountName: "secondary" }, "account_changed"],
			["model", { modelId: "claude-sonnet-5" }, "model_changed"],
			[
				"system-prompt",
				{ fingerprint: { systemPromptHash: "prompt-v2", toolsetHash: "tools-v1" } },
				"options_changed",
			],
			["toolset", { fingerprint: { systemPromptHash: "prompt-v1", toolsetHash: "tools-v2" } }, "options_changed"],
		] as const)("cold-seeds a persisted binding when %s drifts", (_label, override, reason) => {
			const decision = decideNativeContinuity(baseInput(override));
			expect(decision).toEqual({ kind: "flatten", reason });
		});

		it.each([
			["account", { accountName: "secondary" }, "account_changed"],
			["model", { modelId: "claude-sonnet-5" }, "model_changed"],
			[
				"system-prompt",
				{ fingerprint: { systemPromptHash: "prompt-v2", toolsetHash: "tools-v1" } },
				"options_changed",
			],
			["toolset", { fingerprint: { systemPromptHash: "prompt-v1", toolsetHash: "tools-v2" } }, "options_changed"],
		] as const)("keeps live-entry reattach behavior when %s drifts", (_label, override, reason) => {
			const decision = decideNativeContinuity(baseInput({ entry: liveEntry(), ...override }));
			expect(decision).toMatchObject({ kind: "reattach", reason, sdkSessionId: SDK_SESSION_ID, from: 2 });
		});
	});

	describe("verifyRestoredTranscript", () => {
		async function runVerify(messages: SessionMessage[]): Promise<boolean> {
			const boundary: Partial<SdkBoundary> = {
				getSessionMessages: async () => messages,
			};
			overrideSdkBoundary(boundary);
			return verifyRestoredTranscript(persistedBinding(), CWD, "oauth-slots");
		}

		it("returns false for an empty lookup", async () => {
			expect(await runVerify([])).toBe(false);
		});

		it("returns false when messages belong to a different session_id", async () => {
			expect(
				await runVerify([sdkMessage({ type: "assistant", uuid: ASSISTANT_UUID, session_id: "other-session" })]),
			).toBe(false);
		});

		it("returns false when the stored assistant UUID is missing from the transcript", async () => {
			expect(
				await runVerify([sdkMessage({ type: "assistant", uuid: "uuid-other", session_id: SDK_SESSION_ID })]),
			).toBe(false);
		});

		it("returns false when the only assistant is nested under a tool-use", async () => {
			expect(
				await runVerify([
					sdkMessage({
						type: "assistant",
						uuid: ASSISTANT_UUID,
						session_id: SDK_SESSION_ID,
						parent_tool_use_id: "tool-1",
					}),
				]),
			).toBe(false);
		});

		it("returns false when lookup throws", async () => {
			const boundary: Partial<SdkBoundary> = {
				getSessionMessages: async () => {
					throw new Error("lookup failed");
				},
			};
			overrideSdkBoundary(boundary);
			expect(await verifyRestoredTranscript(persistedBinding(), CWD, "oauth-slots")).toBe(false);
		});

		it("returns false for the config-dir auth lane", async () => {
			const boundary: Partial<SdkBoundary> = {
				getSessionMessages: async () => {
					throw new Error("lookup should not be attempted for config-dir");
				},
			};
			overrideSdkBoundary(boundary);
			expect(await verifyRestoredTranscript(persistedBinding(), CWD, "config-dir")).toBe(false);
		});

		it("returns true for a matching top-level assistant", async () => {
			expect(
				await runVerify([sdkMessage({ type: "assistant", uuid: ASSISTANT_UUID, session_id: SDK_SESSION_ID })]),
			).toBe(true);
		});
	});
});
