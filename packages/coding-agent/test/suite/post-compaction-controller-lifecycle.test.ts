import { setImmediate as waitForImmediate } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { SessionWorkBarrier } from "../../src/core/session-work-barrier.ts";
import { createHarness, type Harness } from "./harness.ts";

type Deferred = {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
};

function createDeferred(): Deferred {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("Deferred resolver was not initialized");
	return { promise, resolve };
}

function createAcceptedCompactionExtension(onCompactionAccepted?: () => void) {
	return (pi: ExtensionAPI): void => {
		pi.on("session_before_compact", (event) => ({
			compaction: {
				summary: "accepted lifecycle summary",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		}));
		pi.on("session_compact", () => {
			onCompactionAccepted?.();
		});
	};
}

async function createLifecycleHarness(onCompactionAccepted?: () => void): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: "lifecycle-context", contextWindow: 128_000, maxTokens: 64 }],
		settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
		extensionFactories: [createAcceptedCompactionExtension(onCompactionAccepted)],
	});
	harness.setResponses([fauxAssistantMessage("initial assistant"), fauxAssistantMessage("fresh assistant")]);
	await harness.session.prompt("initial prompt ".repeat(40));
	return harness;
}

function getRunAutoCompaction(harness: Harness) {
	const runAutoCompaction = Reflect.get(harness.session, "_runAutoCompaction");
	if (typeof runAutoCompaction !== "function") {
		throw new Error("Expected AgentSession._runAutoCompaction");
	}
	return (reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> =>
		Promise.resolve(runAutoCompaction.call(harness.session, reason, willRetry));
}

function getSessionWorkBarrier(harness: Harness): SessionWorkBarrier {
	const barrier = Reflect.get(harness.session, "_sessionWorkBarrier");
	if (!(barrier instanceof SessionWorkBarrier)) {
		throw new Error("Expected AgentSession._sessionWorkBarrier");
	}
	return barrier;
}

describe("post-compaction controller lifecycle", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.restoreAllMocks();
	});

	it("releases compaction classification before held recovery while retaining the session barrier", async () => {
		const harness = await createLifecycleHarness();
		harnesses.push(harness);
		const recoveryStarted = createDeferred();
		const releaseRecovery = createDeferred();
		vi.spyOn(harness.session.agent, "continue").mockImplementation(async () => {
			recoveryStarted.resolve();
			await releaseRecovery.promise;
		});

		const recovery = getRunAutoCompaction(harness)("overflow", true);
		await recoveryStarted.promise;
		const barrier = getSessionWorkBarrier(harness);
		let freshPrompt: Promise<void> | undefined;
		try {
			expect(harness.session.isCompacting).toBe(false);
			expect(barrier.hasActiveWork).toBe(true);
			freshPrompt = harness.session.prompt("fresh prompt during held recovery");
			await waitForImmediate();
			expect(harness.faux.state.callCount).toBe(1);
		} finally {
			releaseRecovery.resolve();
			await Promise.allSettled([recovery, ...(freshPrompt ? [freshPrompt] : [])]);
		}

		expect(barrier.hasActiveWork).toBe(false);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("does not let stale cleanup clear a newer auto-compaction controller", async () => {
		let activeHarness: Harness | undefined;
		const replacementController = new AbortController();
		const harness = await createLifecycleHarness(() => {
			if (!activeHarness) throw new Error("Expected active lifecycle harness");
			Reflect.set(activeHarness.session, "_autoCompactionAbortController", replacementController);
		});
		activeHarness = harness;
		harnesses.push(harness);

		try {
			await getRunAutoCompaction(harness)("threshold", false);
			expect(Reflect.get(harness.session, "_autoCompactionAbortController")).toBe(replacementController);
			expect(harness.session.isCompacting).toBe(true);
		} finally {
			Reflect.set(harness.session, "_autoCompactionAbortController", undefined);
		}
	});
});
