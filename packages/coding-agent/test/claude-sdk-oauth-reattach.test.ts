import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { Options, SdkQueryHandle } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import {
	forgetBinding,
	getBinding,
	reattachSession,
	rememberBinding,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";
import {
	closeSession,
	getSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";

const SESSION_ID = "senpi-session-1";
const SDK_SESSION_ID = "sdk-session-1";

const capturedOptions: Options[] = [];

function fakeQuery(): SdkQueryHandle {
	return {
		async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {},
		async interrupt() {},
		close() {},
		initializationResult: async () => ({ session_id: SDK_SESSION_ID }),
	};
}

function binding() {
	return {
		senpiSessionId: SESSION_ID,
		sdkSessionId: SDK_SESSION_ID,
		sentCount: 2,
		sentHashes: ["h1", "h2"],
		lastAssistantUuid: "uuid-a2",
		accountName: "primary",
		modelId: "claude-opus-4-5",
		systemPromptHash: "prompt-v1",
		toolsetHash: "tools-v1",
	};
}

function options(): Options {
	return { cwd: "/repo", model: "claude-opus-4-5" } as Options;
}

afterEach(() => {
	closeSession(SESSION_ID, "test_cleanup");
	forgetBinding(SESSION_ID);
	capturedOptions.length = 0;
	resetSessionRegistryBoundary();
});

describe("claude-sdk-oauth session reattach", () => {
	it("resumes the same session without passing sessionId alongside resume", async () => {
		overrideSessionRegistryBoundary({
			queryFactory: (input) => {
				capturedOptions.push(input.options as Options);
				return fakeQuery();
			},
		});

		const entry = await reattachSession({ binding: binding(), options: options() });

		const used = capturedOptions[0];
		expect(used?.resume).toBe(SDK_SESSION_ID);
		expect(used && "sessionId" in used).toBe(false);
		expect(used?.forkSession).toBeUndefined();
		expect(entry.sdkSessionId).toBe(SDK_SESSION_ID);
	});

	it("forks at a boundary uuid when one is supplied", async () => {
		overrideSessionRegistryBoundary({
			queryFactory: (input) => {
				capturedOptions.push(input.options as Options);
				return fakeQuery();
			},
		});

		await reattachSession({ binding: binding(), options: options(), atUuid: "uuid-a1" });

		const used = capturedOptions[0];
		expect(used?.resume).toBe(SDK_SESSION_ID);
		expect(used?.resumeSessionAt).toBe("uuid-a1");
		expect(used?.forkSession).toBe(true);
	});

	it("keeps the binding when the live query is closed", () => {
		rememberBinding(binding());

		closeSession(SESSION_ID, "idle_ttl");

		expect(getBinding(SESSION_ID)).toMatchObject({ sdkSessionId: SDK_SESSION_ID, sentCount: 2 });
	});

	it("restores the synchronized prefix onto the reattached entry", async () => {
		overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });

		const entry = await reattachSession({ binding: binding(), options: options() });

		// The title promises the synchronized prefix is restored: assert the
		// restored assistant boundary, not just the count.
		expect(entry.sentCount).toBe(2);
		expect(entry.assistantUuidByIndex.get(2)).toBe("uuid-a2");
		expect(getSession(SESSION_ID)).toBeDefined();
	});

	it("carries the assistant boundary history across a reattach", async () => {
		overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });

		const entry = await reattachSession({
			binding: {
				...binding(),
				assistantUuidByIndex: [
					[1, "uuid-a1"],
					[2, "uuid-a2"],
				],
			},
			options: options(),
		});

		expect(entry.assistantUuidByIndex.get(1)).toBe("uuid-a1");
		expect(entry.assistantUuidByIndex.get(2)).toBe("uuid-a2");
	});

	it("propagates an initialization failure so the caller can fall back", async () => {
		overrideSessionRegistryBoundary({
			queryFactory: () => ({
				async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {},
				async interrupt() {},
				close() {},
				initializationResult: async () => {
					throw new Error("resume rejected");
				},
			}),
		});

		await expect(reattachSession({ binding: binding(), options: options() })).rejects.toThrow("resume rejected");
		expect(getSession(SESSION_ID)).toBeUndefined();
	});
});
