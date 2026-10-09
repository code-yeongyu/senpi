import type { Api, AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { coldSeedImageText } from "../../../src/core/extensions/builtin/anthropic-subscription/cold-seed-images.ts";
import { mapPiToolNameToSdk } from "../../../src/core/extensions/builtin/anthropic-subscription/prompt-bridge.ts";
import type { SDKUserMessage } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { forgetBinding } from "../../../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import { closeSession } from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import {
	installScriptedSdk,
	installSingleAccountLane,
	resetScriptedSdk,
	sdkMessage,
} from "../../helpers/anthropic-subscription-scripted-sdk.ts";

const SCREENSHOT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8ioAAAAASUVORK5CYII=";
const READ = mapPiToolNameToSdk("read");
const sessionIds: string[] = [];

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

function readCall(id: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: "screenshot.png" } }],
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
		stopReason: "toolUse",
		timestamp,
	};
}

function sessionWithRereads(rereads: number): Context {
	const messages: Message[] = [
		{
			role: "user",
			content: [
				{ type: "text", text: "Here is a screenshot" },
				{ type: "image", mimeType: "image/png", data: SCREENSHOT },
			],
			timestamp: 0,
		},
	];
	for (let n = 0; n < rereads; n++) {
		messages.push(readCall(`read-${n}`, n + 1), {
			role: "toolResult",
			toolCallId: `read-${n}`,
			toolName: "read",
			content: [{ type: "image", mimeType: "image/png", data: SCREENSHOT }],
			isError: false,
			timestamp: n + 1,
		});
	}
	messages.push({ role: "user", content: "What changed?", timestamp: 100 });
	return { systemPrompt: "SYSTEM", messages };
}

function frameBlocks(submitted: SDKUserMessage | undefined): readonly { type: string; text?: string }[] {
	const content = submitted?.message.content;
	return Array.isArray(content) ? content : [];
}

function submittedImageCount(submitted: SDKUserMessage | undefined): number {
	return frameBlocks(submitted).filter((block) => block.type === "image").length;
}

function readReferences(submitted: SDKUserMessage | undefined): number {
	const reference = coldSeedImageText.duplicate(
		{ kind: "tool", toolName: READ, toolCallId: "read-0" },
		{ kind: "user" },
	);
	return frameBlocks(submitted).filter((block) => block.type === "text" && block.text === reference).length;
}

afterEach(() => {
	for (const id of sessionIds.splice(0)) {
		closeSession(id, "test_cleanup");
		forgetBinding(id);
	}
	resetScriptedSdk();
});

describe("senpi#2490: cold seeds through the Claude subscription stream", () => {
	it("hands the SDK one image however many times the agent re-read the user's screenshot", async () => {
		await installSingleAccountLane();
		const queries = installScriptedSdk((sessionId, userUuid) => [
			sdkMessage({
				type: "result",
				subtype: "success",
				result: "ok",
				user_message_uuid: userUuid,
				session_id: sessionId,
				usage: { input_tokens: 10, output_tokens: 1 },
			}),
		]);

		for (const rereads of [0, 1, 3, 5]) {
			const sessionId = `cold-seed-images-${rereads}`;
			sessionIds.push(sessionId);
			await streamAnthropicSubscription(model, sessionWithRereads(rereads), {
				sessionId,
				streamKind: "main",
			}).result();
		}

		const frames = queries.map((query) => query.submitted[0]);
		expect(frames).toHaveLength(4);
		expect(frames.map(submittedImageCount)).toEqual([1, 1, 1, 1]);
		expect(frames.map(readReferences)).toEqual([0, 1, 3, 5]);
	});
});
