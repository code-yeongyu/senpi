import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import {
	type Options,
	overrideSdkBoundary,
	resetSdkBoundary,
	type SdkQuery,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	closeSession,
	resetSessionRegistryBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { ScriptedResidentQuery, sdkMessage, streamEvent } from "../../helpers/anthropic-subscription-scripted-sdk.ts";
import { createHarness, type Harness, type HarnessOptions } from "../harness.ts";

const harnesses: Harness[] = [];

export function captureSdkRequests(): Options[] {
	const captured: Options[] = [];
	overrideAuthLaneBoundary({
		createStore: () => new InMemoryCredentialStore(),
		env: () => ({ PATH: "/usr/bin" }),
	});
	const query: SdkQuery = ({ prompt, options }) => {
		captured.push(options ?? {});
		if (typeof prompt !== "string" && (options?.sessionId || options?.resume)) {
			return new ScriptedResidentQuery(
				prompt,
				(sessionId, userUuid) => [
					streamEvent(sessionId, {
						type: "content_block_start",
						index: 0,
						content_block: { type: "text", text: "" },
					}),
					streamEvent(sessionId, {
						type: "content_block_delta",
						index: 0,
						delta: { type: "text_delta", text: "<title>Cwd Fixture Answer</title>" },
					}),
					streamEvent(sessionId, { type: "content_block_stop", index: 0 }),
					sdkMessage({
						type: "assistant",
						uuid: `assistant-${userUuid}`,
						session_id: sessionId,
						parent_tool_use_id: null,
						message: {
							id: `answer-${userUuid}`,
							type: "message",
							role: "assistant",
							content: [{ type: "text", text: "<title>Cwd Fixture Answer</title>" }],
						},
					}),
					sdkMessage({
						type: "result",
						subtype: "success",
						result: "",
						user_message_uuid: userUuid,
						session_id: sessionId,
					}),
				],
				options,
			);
		}
		return {
			async *[Symbol.asyncIterator]() {
				yield streamEvent("cwd-capture", {
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				});
				yield streamEvent("cwd-capture", {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "<title>Cwd Fixture Answer</title>" },
				});
				yield streamEvent("cwd-capture", { type: "content_block_stop", index: 0 });
				yield sdkMessage({
					type: "assistant",
					session_id: "cwd-capture",
					parent_tool_use_id: null,
					message: {
						id: "cwd-answer",
						type: "message",
						role: "assistant",
						content: [{ type: "text", text: "<title>Cwd Fixture Answer</title>" }],
						stop_reason: "end_turn",
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				});
				yield sdkMessage({ type: "result", subtype: "success", result: "", session_id: "cwd-capture" });
			},
			async interrupt() {},
			close() {},
		};
	};
	overrideSdkBoundary({ query });
	return captured;
}

export async function sdkPathHarness(
	extensions: ExtensionFactory[] = [],
	options: HarnessOptions = {},
): Promise<Harness> {
	const harness = await createHarness({
		models: [
			{ id: "faux-1", input: ["text"] },
			{ id: "vision", input: ["text", "image"] },
		],
		settings: { images: { autoResize: false } },
		...options,
		extensionFactories: extensions,
	});
	harnesses.push(harness);
	const model = harness.getModel();
	await harness.modelRegistry.modelRuntime.registerProvider(model.provider, {
		api: model.api,
		apiKey: "cwd-fixture",
		baseUrl: model.baseUrl,
		models: harness.models,
		streamSimple: streamAnthropicSubscription,
	});
	await harness.session.bindExtensions({});
	return harness;
}

export function cleanupSdkPaths(): void {
	for (const harness of harnesses.splice(0)) {
		closeSession(harness.sessionManager.getSessionId(), "test_cleanup");
		harness.cleanup();
	}
	resetSessionRegistryBoundary();
	resetSdkBoundary();
	resetAuthLaneBoundary();
}
