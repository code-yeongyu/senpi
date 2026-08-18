import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import type { SdkQueryHandle } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import {
	BINDING_ENTRY_TYPE,
	checkpointFromBinding,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-binding.ts";
import {
	type ContinuityBinding,
	forgetBinding,
	getBinding,
	rememberBinding,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";
import {
	closeSession,
	getOrCreateSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { registerSessionRegistry } from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry-wiring.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function fakeQuery(): SdkQueryHandle {
	return {
		async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {},
		async interrupt() {},
		close() {},
	};
}

function fakeExtension() {
	const handlers = new Map<string, EventHandler[]>();
	const persisted: Array<{ customType: string; data: unknown }> = [];
	const api = {
		on(event: string, handler: EventHandler): void {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry(customType: string, data: unknown): void {
			persisted.push({ customType, data });
		},
	} as unknown as ExtensionAPI;
	return { api, handlers, persisted };
}

function binding(sdkSessionId: string): ContinuityBinding {
	return {
		senpiSessionId: "binding-persistence",
		sdkSessionId,
		sentCount: 1,
		sentHashes: ["hash-1"],
		lastAssistantUuid: "assistant-1",
		accountName: "default",
		modelId: "claude-test",
		systemPromptHash: "1".repeat(64),
		toolsetHash: "2".repeat(64),
	};
}

function persistedBranch(sdkSessionId: string) {
	return [
		{
			type: "custom",
			customType: BINDING_ENTRY_TYPE,
			data: checkpointFromBinding(binding(sdkSessionId)),
		},
		{ type: "message", message: { role: "assistant" } },
	];
}

function context(branch: ReturnType<typeof persistedBranch> | [] = []) {
	return {
		sessionManager: {
			getSessionId: () => "binding-persistence",
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext;
}

async function emit(
	handlers: Map<string, EventHandler[]>,
	eventName: string,
	event: unknown,
	eventContext = context(),
): Promise<void> {
	const registered = handlers.get(eventName) ?? [];
	expect(registered).toHaveLength(1);
	for (const handler of registered) await handler(event, eventContext);
}

afterEach(() => {
	closeSession("binding-persistence", "test_cleanup");
	forgetBinding("binding-persistence");
	resetSessionRegistryBoundary();
});

describe("Claude SDK OAuth persisted binding lifecycle", () => {
	it.each(["startup", "resume"] as const)("restores a valid checkpoint on %s", async (reason) => {
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);

		await emit(
			extension.handlers,
			"session_start",
			{ type: "session_start", reason },
			context(persistedBranch("persisted-sdk")),
		);

		expect(getBinding("binding-persistence")).toMatchObject({ sdkSessionId: "persisted-sdk" });
	});

	it.each(["new", "fork"] as const)("does not inherit a persisted checkpoint on %s", async (reason) => {
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);

		await emit(
			extension.handlers,
			"session_start",
			{ type: "session_start", reason },
			context(persistedBranch("parent-sdk")),
		);

		expect(getBinding("binding-persistence")).toBeUndefined();
	});

	it("keeps the fresher process binding on reload", async () => {
		rememberBinding(binding("live-sdk"));
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);

		await emit(
			extension.handlers,
			"session_start",
			{ type: "session_start", reason: "reload" },
			context(persistedBranch("older-disk-sdk")),
		);

		expect(getBinding("binding-persistence")).toMatchObject({ sdkSessionId: "live-sdk" });
	});

	it("clears a stale process-local binding when startup has no valid checkpoint", async () => {
		rememberBinding(binding("stale-sdk"));
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);

		await emit(extension.handlers, "session_start", { type: "session_start", reason: "resume" });

		expect(getBinding("binding-persistence")).toBeUndefined();
	});

	it.each([
		["accepted compaction", "session_compact", { type: "session_compact", accepted: true }, "compaction"],
		["explicit fork", "session_before_fork", { type: "session_before_fork" }, "fork"],
		["tree navigation", "session_tree", { type: "session_tree", oldLeafId: "old", newLeafId: "new" }, "tree_changed"],
	])("invalidates the checkpoint after %s", async (_label, eventName, event, reason) => {
		overrideSessionRegistryBoundary({ queryFactory: () => fakeQuery() });
		getOrCreateSession({
			senpiSessionId: "binding-persistence",
			accountName: "default",
			modelId: "claude-test",
			systemPromptHash: "1".repeat(64),
			toolsetHash: "2".repeat(64),
			options: {},
		});
		const extension = fakeExtension();
		registerSessionRegistry(extension.api);

		await emit(extension.handlers, eventName, event);

		expect(extension.persisted).toEqual([
			{
				customType: BINDING_ENTRY_TYPE,
				data: { schemaVersion: 1, invalidated: true, reason },
			},
		]);
	});
});
