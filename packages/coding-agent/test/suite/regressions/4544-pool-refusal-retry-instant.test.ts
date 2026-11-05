import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { AllSlotsBlockedError } from "@earendil-works/pi-ai/auth/pool/select";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CredentialFailoverError,
	type RunSlot,
	runCredentialFailover,
} from "../../../src/core/credential-pool/failover.ts";
import { providerRetryAt } from "../../../src/core/extensions/builtin/goal/provider-retry.ts";
import { collectTurnEndLivenessInput } from "../../../src/core/extensions/builtin/goal/turn-end-liveness-report.ts";
import type { AgentEndEvent, ExtensionContext } from "../../../src/core/extensions/types.ts";

// #4544 review: the pool refusals show local time to the reader, and the goal's provider-retry wake and
// turn-end liveness still read the unblock instant from the same text. Each shape's parsed instant must
// equal the instant the refusal carries as a typed field.
const NOW = Date.UTC(2027, 0, 15, 8, 0);
const SOON = NOW + 10 * 60_000;
const LATER = NOW + 45 * 60_000;

async function poolRefusal(slots: readonly RunSlot[]): Promise<{ text: string; retryAt: number | undefined }> {
	const stream = runCredentialFailover<{ type: string }, RunSlot>({
		listSlots: () => slots,
		select: (candidates) => {
			const slot = candidates[0];
			if (slot === undefined) throw new Error("no candidate slot");
			return slot;
		},
		runAttempt: async () => {
			throw new Error("no slot may run");
		},
		isCommittedOutput: () => true,
		persistBlock: () => {},
		now: () => NOW,
	});
	const outcome = await stream.next().then(
		() => undefined,
		(error: unknown) => error,
	);
	if (!(outcome instanceof CredentialFailoverError)) throw new Error("expected a pool refusal");
	expect(outcome.message.startsWith("No credential slots available")).toBe(true);
	return { text: outcome.message, retryAt: outcome.retryAt };
}

function allBlocked(soonest: number | undefined): { text: string; retryAt: number | undefined } {
	const error = new AllSlotsBlockedError(soonest);
	return { text: error.message, retryAt: error.soonestUnblockAt };
}

const SHAPES: ReadonlyArray<readonly [string, () => Promise<{ text: string; retryAt: number | undefined }>]> = [
	["a cooling slot", () => poolRefusal([{ name: "a", blockReason: "auth_error", blockedUntil: SOON }])],
	[
		"two cooling slots",
		() =>
			poolRefusal([
				{ name: "a", blockReason: "auth_error", blockedUntil: LATER },
				{ name: "b", blockReason: "auth_error", blockedUntil: SOON },
			]),
	],
	["a disabled slot", () => poolRefusal([{ name: "a", blockReason: "account_disabled" }])],
	["an empty pool", () => poolRefusal([])],
	["an all-blocked pool with a due-back time", async () => allBlocked(SOON)],
	["an all-blocked pool until re-login", async () => allBlocked(undefined)],
];

const livenessCtx = {
	mode: "tui",
	hasPendingMessages: () => false,
	sessionManager: { getBranch: () => [], getHeader: () => undefined, getSessionId: () => "s" },
} as unknown as ExtensionContext;
const livenessState = {
	goal: null,
	todoOutcome: undefined,
	deadlineStop: false,
	continuationPending: false,
	monitor: { liveWakeSources: () => [], scheduledContinuation: () => undefined, hasStagedRecovery: () => false },
};

describe("pool refusals keep the unblock instant their prose scanners read (#4544)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each(SHAPES)("%s: providerRetryAt and turn-end liveness read the typed retry instant", async (_label, refuse) => {
		const { text, retryAt } = await refuse();
		const messages = [fauxAssistantMessage("", { stopReason: "error", errorMessage: text })];
		const event: AgentEndEvent = { type: "agent_end", messages, willRetry: false };

		expect(providerRetryAt(messages, NOW)).toBe(retryAt);
		expect(collectTurnEndLivenessInput(livenessCtx, event, livenessState).providerRetryAtMs).toBe(retryAt);
	});
});
