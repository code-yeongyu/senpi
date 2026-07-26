import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/index.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

type Deferred = {
	promise: Promise<void>;
	resolve: () => void;
};

function createDeferred(): Deferred {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("Deferred resolver was not initialized");
	return { promise, resolve };
}

function customMessageEntries(harness: Harness, content: string) {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.content === content);
}

describe("synchronous manual compaction admission ownership", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each([
		{ origin: "session", outcome: "accepted" },
		{ origin: "session", outcome: "rejected" },
		{ origin: "session", outcome: "aborted" },
		{ origin: "extension", outcome: "accepted" },
		{ origin: "extension", outcome: "rejected" },
		{ origin: "extension", outcome: "aborted" },
	] as const)("claims admission synchronously when $origin compaction and a trigger-turn custom message share a tick ($outcome)", async ({
		origin,
		outcome,
	}) => {
		const marker = `${origin} trigger-turn after ${outcome} compaction`;
		const summary = `${origin} accepted compaction summary`;
		let extensionApi: ExtensionAPI | undefined;
		let extensionContext: ExtensionContext | undefined;
		const compactionStarted = createDeferred();
		const compactionFinished = createDeferred();
		const providerContexts: AgentMessage[][] = [];
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.on("session_start", (_event, ctx) => {
						extensionContext = ctx;
					});
					pi.on("session_before_compact", async (event) => {
						if (outcome === "accepted") {
							return {
								compaction: {
									summary,
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						}
						if (outcome === "rejected") {
							return { cancel: true, rejectionCause: "cancelled-by-extension" as const };
						}
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		if (!extensionApi || !extensionContext) throw new Error("Expected extension API and context");

		harness.setResponses([fauxAssistantMessage("seed response")]);
		await harness.session.prompt("seed manual compaction context");
		harness.setResponses([
			(context) => {
				providerContexts.push(context.messages);
				return fauxAssistantMessage("custom trigger-turn handled");
			},
		]);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") compactionStarted.resolve();
			if (event.type === "compaction_end") compactionFinished.resolve();
		});

		const sessionCompact =
			origin === "session"
				? harness.session.compact().then(
						() => undefined,
						() => undefined,
					)
				: undefined;
		if (origin === "extension") extensionContext.compact();
		const claimedAdmissionSynchronously = harness.session.isCompacting;
		const customTurn =
			origin === "session"
				? harness.session.sendCustomMessage(
						{ customType: "same-tick-compaction", content: marker, display: false },
						{ triggerTurn: true },
					)
				: undefined;
		if (origin === "extension") {
			extensionApi.sendMessage(
				{ customType: "same-tick-compaction", content: marker, display: false },
				{ triggerTurn: true },
			);
		}

		await compactionStarted.promise;
		if (outcome === "aborted") harness.session.abortCompaction();
		await compactionFinished.promise;
		await Promise.allSettled([sessionCompact ?? Promise.resolve(), customTurn ?? Promise.resolve()]);
		await harness.session.waitForSettledSessionWork();
		await harness.session.agent.waitForIdle();

		// Neither compaction entry point may yield before claiming the lifecycle;
		// otherwise same-tick trigger-turn messages race past the compaction boundary.
		expect(claimedAdmissionSynchronously).toBe(true);
		if (outcome === "accepted") {
			expect(harness.faux.state.callCount).toBe(2);
			expect(providerContexts).toHaveLength(1);
			const providerContext = providerContexts[0] ?? [];
			const summaryIndex = providerContext.findIndex(
				(message) => message.role === "user" && getMessageText(message).includes(summary),
			);
			const customIndex = providerContext.findIndex(
				(message) => message.role === "user" && getMessageText(message) === marker,
			);
			expect(summaryIndex).toBeGreaterThanOrEqual(0);
			expect(customIndex).toBeGreaterThan(summaryIndex);
			expect(customMessageEntries(harness, marker)).toHaveLength(1);
		} else {
			expect(harness.faux.state.callCount).toBe(1);
			expect(providerContexts).toEqual([]);
			expect(harness.session.agent.hasQueuedMessages()).toBe(true);
			expect(customMessageEntries(harness, marker)).toHaveLength(0);
		}
	});
});
