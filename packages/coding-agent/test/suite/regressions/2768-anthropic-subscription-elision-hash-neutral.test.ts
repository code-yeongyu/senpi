import type { Context, Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type ContinuityEntrySnapshot,
	decideNativeContinuity,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-continuity.ts";
import {
	sentMessageHashes,
	sentMessages,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-sync.ts";
import { elideOldImages, TRANSPORT_IMAGE_BUDGET_BYTES } from "../../../src/core/messages.ts";

const ACCOUNT = "default";
const MODEL = "claude-sonnet-5-5";
const FINGERPRINT = { systemPromptHash: "system-prompt-hash", toolsetHash: "toolset-hash" };

function entryFrom(sentHashes: readonly string[]): ContinuityEntrySnapshot {
	return {
		sdkSessionId: "sdk-session",
		accountName: ACCOUNT,
		modelId: MODEL,
		systemPromptHash: FINGERPRINT.systemPromptHash,
		toolsetHash: FINGERPRINT.toolsetHash,
		sentCount: sentHashes.length,
		sentHashes,
		lastAssistantUuid: "assistant-uuid",
		assistantUuidByIndex: new Map([[1, "assistant-uuid"]]),
		pendingForkReason: null,
		taintedReason: null,
	};
}

function decide(sentHashes: readonly string[], currentHashes: readonly string[]) {
	const decision = decideNativeContinuity({
		entry: entryFrom(sentHashes),
		binding: undefined,
		currentHashes,
		accountName: ACCOUNT,
		modelId: MODEL,
		fingerprint: FINGERPRINT,
		transcriptAvailable: true,
		crossAccountResumeSupported: true,
		idleExpired: false,
	});
	return { kind: decision.kind, reason: "reason" in decision ? decision.reason : null };
}

function transportHashes(messages: readonly Message[]): string[] {
	const transport = elideOldImages([...messages], { budgetBytes: TRANSPORT_IMAGE_BUDGET_BYTES, alwaysKeepNewest: 1 });
	return sentMessageHashes(sentMessages({ messages: transport } as Context));
}

function appendScreenshotTurn(
	messages: Message[],
	turn: number,
	base64Bytes: number,
	caption = `screenshot ${turn}`,
): void {
	messages.push({
		role: "assistant",
		content: [{ type: "toolCall", id: `call-${turn}`, name: "computer", arguments: { action: "screenshot" } }],
		timestamp: turn,
	} as unknown as Message);
	messages.push({
		role: "toolResult",
		toolCallId: `call-${turn}`,
		toolName: "computer",
		content: [
			{ type: "text", text: caption },
			{ type: "image", mimeType: "image/png", data: String.fromCharCode(65 + (turn % 26)).repeat(base64Bytes) },
		],
		isError: false,
		timestamp: turn,
	} as unknown as Message);
}

describe("anthropic-subscription: transport image elision must not read as a diverged sent stream (#2768)", () => {
	for (const megabytes of [1, 2, 4]) {
		it(`keeps every computer-use turn on the delta path with ${megabytes} MB screenshots`, () => {
			const messages: Message[] = [
				{ role: "user", content: [{ type: "text", text: "use the computer" }], timestamp: 0 },
			];
			let sent = transportHashes(messages);
			const flattened: number[] = [];
			for (let turn = 1; turn <= 30; turn++) {
				appendScreenshotTurn(messages, turn, megabytes * 1024 * 1024);
				const current = transportHashes(messages);
				if (decide(sent, current).kind !== "delta") flattened.push(turn);
				sent = current;
			}

			expect(flattened).toEqual([]);
		});
	}

	it("still reports a real rewrite of an already-sent tool result as sent_stream_diverged", () => {
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: "use the computer" }], timestamp: 0 },
		];
		appendScreenshotTurn(messages, 1, 1024);
		appendScreenshotTurn(messages, 2, 1024);
		const sent = transportHashes(messages);
		const rewritten = structuredClone(messages);
		const firstResult = rewritten[2] as { content: { type: string; text?: string }[] };
		firstResult.content[0] = { type: "text", text: "a different caption" };
		appendScreenshotTurn(rewritten, 3, 1024);

		const decision = decide(sent, transportHashes(rewritten));
		expect(decision.kind).not.toBe("delta");
		expect(decision.reason).toBe("sent_stream_diverged");
	});

	for (const [change, edit] of [
		[
			"replaced by different bytes",
			(content: { type: string; data?: string }[]) =>
				content.splice(1, 1, { type: "image", data: "Z".repeat(1024) }),
		],
		["removed", (content: { type: string; data?: string }[]) => content.splice(1, 1)],
	] as const) {
		it(`still reports an already-sent image ${change} as sent_stream_diverged`, () => {
			const messages: Message[] = [
				{ role: "user", content: [{ type: "text", text: "use the computer" }], timestamp: 0 },
			];
			appendScreenshotTurn(messages, 1, 1024);
			appendScreenshotTurn(messages, 2, 1024);
			const sent = transportHashes(messages);
			const changed = structuredClone(messages);
			edit((changed[2] as unknown as { content: { type: string; data?: string }[] }).content);
			appendScreenshotTurn(changed, 3, 1024);

			const decision = decide(sent, transportHashes(changed));
			expect(decision.kind).not.toBe("delta");
			expect(decision.reason).toBe("sent_stream_diverged");
		});
	}
});
