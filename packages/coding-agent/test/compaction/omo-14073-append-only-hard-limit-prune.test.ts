/**
 * oh-my-openagent#14073: on the resident anthropic-subscription lane the transcript is
 * append-only. The hard-limit emergency prune dropped the oldest already-sent messages
 * on that lane, the next admission saw `sent_stream_diverged`, and the whole history was
 * re-sent as a cold seed right before every compaction. Its remedy is compaction, not a
 * rewrite of messages the SDK session already holds.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, type Model, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { sentMessageHashes, sentMessages } from "../../src/core/extensions/builtin/anthropic-subscription/session-sync.ts";
import { buildCompactionContext } from "../../src/core/extensions/builtin/compaction/context-pipeline.ts";
import { createEmergencyPruneLatch } from "../../src/core/extensions/builtin/compaction/emergency-prune.ts";
import type { ExtensionContext } from "../../src/core/extensions/index.ts";
import type { Message } from "@earendil-works/pi-ai";
import { SessionManager } from "../../src/core/session-manager.ts";

const WINDOW = 184_000;
const registrations: Array<{ unregister: () => void }> = [];
afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

function fauxModel(): Model<Api> {
	const registration = registerFauxProvider();
	registrations.push(registration);
	return registration.getModel();
}

function longConversation(turns: number): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let turn = 1; turn <= turns; turn++) {
		messages.push({ role: "user", content: [{ type: "text", text: `turn ${turn} ${"u".repeat(40_000)}` }], timestamp: turn * 2 });
		if (turn < turns) {
			messages.push({
				role: "assistant",
				content: [{ type: "text", text: `answer ${"a".repeat(2_000)}` }],
				api: "faux",
				provider: "faux",
				model: "faux",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: turn * 2 + 1,
			} as AgentMessage);
		}
	}
	return messages;
}

function outgoing(messages: AgentMessage[], appendOnlyTranscript: boolean) {
	const ctx = { model: fauxModel(), cwd: process.cwd(), sessionManager: SessionManager.inMemory() } as unknown as ExtensionContext;
	return buildCompactionContext({
		event: { type: "context", messages },
		ctx,
		contextWindow: WINDOW,
		promptContextWindow: WINDOW,
		toolAdmissionEnabled: false,
		breakerFallback: false,
		laneOwnsCompaction: false,
		appendOnlyTranscript,
		emergencyPruneLatch: createEmergencyPruneLatch(),
	});
}

function sentHashes(messages: readonly Message[]) {
	return sentMessageHashes(sentMessages({ messages: [...messages] }));
}

describe("oh-my-openagent#14073 hard-limit prune on an append-only transcript", () => {
	it("keeps every already-sent message so the next request stays a delta", () => {
		// Given four sent turns and a fifth that pushes the estimate past the hard limit.
		const sent = outgoing(longConversation(4), true);
		const next = outgoing(longConversation(5), true);

		// Then the sent prefix is unchanged: the SDK session receives only the new turn.
		expect(sentHashes(next).slice(0, sentHashes(sent).length)).toEqual(sentHashes(sent));
		expect(next).toHaveLength(9);
	});

	it("still prunes the same load on a lane that re-sends the full context", () => {
		expect(outgoing(longConversation(5), false).length).toBeLessThan(9);
	});
});
