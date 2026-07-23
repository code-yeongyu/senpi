import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import type { CompactionReason, ExtensionContext } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

type BeginFeedback = (reason: CompactionReason) => AbortSignal;
type UpdateFeedback = (options: {
	reason: CompactionReason;
	signal?: AbortSignal;
	delta?: string;
	text?: string;
}) => void;
type EndFeedback = (options: {
	reason: CompactionReason;
	signal?: AbortSignal;
	aborted?: boolean;
	errorMessage?: string;
}) => void;

interface PostApplyFeedbackCapture {
	firstContext?: ExtensionContext;
	firstSignal?: AbortSignal;
	secondSignal?: AbortSignal;
}

/**
 * Drives the real extension surface: feedback begun in before_agent_start is
 * applied, and the accepted session_compact handler immediately begins the
 * next feedback operation (the builtin speculative path does this).
 */
function createPostApplyFeedbackExtension(capture: PostApplyFeedbackCapture) {
	return (pi: ExtensionAPI): void => {
		pi.on("before_agent_start", async (_event, ctx) => {
			if (capture.firstSignal) return undefined;
			const firstEntry = ctx.sessionManager.getEntries()[0];
			if (!firstEntry) return undefined;
			capture.firstSignal = ctx.beginCompaction?.({ reason: "extension" });
			capture.firstContext = ctx;
			await ctx.applyCompaction(
				{
					summary: "applied before the next feedback operation",
					firstKeptEntryId: firstEntry.id,
					tokensBefore: 42,
				},
				{ reason: "extension", expectedRevision: ctx.getMessageRevision() },
			);
			return undefined;
		});
		pi.on("session_compact", (event, ctx) => {
			if (!event.accepted) return;
			capture.secondSignal = ctx.beginCompaction?.({ reason: "extension" });
		});
	};
}

describe("compaction feedback lifecycle", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("ignores stale feedback completion after a newer operation begins", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const begin = Reflect.get(harness.session, "_beginExtensionCompactionFeedback");
		const update = Reflect.get(harness.session, "_updateExtensionCompactionFeedback");
		const end = Reflect.get(harness.session, "_endExtensionCompactionFeedback");
		if (typeof begin !== "function" || typeof update !== "function" || typeof end !== "function") {
			throw new Error("Compaction feedback lifecycle methods unavailable");
		}

		const oldSignal = (begin as BeginFeedback).call(harness.session, "extension");
		(end as EndFeedback).call(harness.session, {
			reason: "extension",
			signal: oldSignal,
			aborted: true,
		});
		const freshSignal = (begin as BeginFeedback).call(harness.session, "extension");
		const freshState = harness.session.compactionState;
		const progressBeforeStaleUpdate = harness.eventsOfType("compaction_progress").length;
		(update as UpdateFeedback).call(harness.session, {
			reason: "extension",
			signal: oldSignal,
			delta: "late progress",
		});
		(end as EndFeedback).call(harness.session, {
			reason: "extension",
			signal: oldSignal,
			errorMessage: "late failure",
		});

		expect(harness.session.compactionState).toBe(freshState);
		expect(harness.session.compactionState).toMatchObject({
			status: "running",
			generation: 2,
			stage: "feedback",
		});
		expect(harness.session.isCompacting).toBe(true);
		expect(harness.eventsOfType("compaction_progress")).toHaveLength(progressBeforeStaleUpdate);

		(update as UpdateFeedback).call(harness.session, {
			reason: "extension",
			signal: freshSignal,
			delta: "current progress",
		});
		expect(harness.eventsOfType("compaction_progress").at(-1)).toMatchObject({
			reason: "extension",
			delta: "current progress",
		});

		(end as EndFeedback).call(harness.session, {
			reason: "extension",
			signal: freshSignal,
			errorMessage: "current failure",
		});
		expect(harness.session.compactionState).toMatchObject({
			status: "failed",
			generation: 2,
			errorMessage: "current failure",
		});
		expect(harness.session.isCompacting).toBe(false);
	});

	it("clears feedback ownership on abort before a later operation begins", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const begin = Reflect.get(harness.session, "_beginExtensionCompactionFeedback");
		const end = Reflect.get(harness.session, "_endExtensionCompactionFeedback");
		if (typeof begin !== "function" || typeof end !== "function") {
			throw new Error("Compaction feedback lifecycle methods unavailable");
		}

		const abortedSignal = (begin as BeginFeedback).call(harness.session, "extension");
		harness.session.abortCompaction();

		expect(abortedSignal.aborted).toBe(true);
		expect(harness.session.compactionState.status).toBe("aborted");
		expect(harness.session.isCompacting).toBe(false);

		const freshSignal = (begin as BeginFeedback).call(harness.session, "extension");
		expect(freshSignal.aborted).toBe(false);
		expect(harness.session.compactionState).toMatchObject({
			status: "running",
			generation: 2,
			stage: "feedback",
		});

		(end as EndFeedback).call(harness.session, {
			reason: "extension",
			signal: freshSignal,
			errorMessage: "current failure",
		});
	});

	it("emits exactly one aborted compaction_end when abortCompaction cancels feedback-only compaction", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const begin = Reflect.get(harness.session, "_beginExtensionCompactionFeedback");
		const end = Reflect.get(harness.session, "_endExtensionCompactionFeedback");
		if (typeof begin !== "function" || typeof end !== "function") {
			throw new Error("Compaction feedback lifecycle methods unavailable");
		}

		const signal = (begin as BeginFeedback).call(harness.session, "extension");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.session.compactionState).toMatchObject({
			status: "running",
			generation: 1,
			stage: "feedback",
		});

		harness.session.abortCompaction();

		expect(signal.aborted).toBe(true);
		expect(harness.session.compactionState).toMatchObject({ status: "aborted", generation: 1 });
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.eventsOfType("compaction_end")).toEqual([
			expect.objectContaining({ reason: "extension", aborted: true }),
		]);

		// The owning extension's late end after the abort must not emit a second public end.
		(end as EndFeedback).call(harness.session, { reason: "extension", signal, aborted: true });
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
	});

	it("gives feedback begun from session_compact a distinct controller and its own compaction_start", async () => {
		const capture: PostApplyFeedbackCapture = {};
		const harness = await createHarness({ extensionFactories: [createPostApplyFeedbackExtension(capture)] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		expect(capture.secondSignal).toBeDefined();
		expect(capture.secondSignal?.aborted).toBe(false);
		expect(capture.secondSignal).not.toBe(capture.firstSignal);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(2);
		expect(harness.session.compactionState).toMatchObject({
			status: "running",
			generation: 2,
			stage: "feedback",
		});
		expect(harness.session.isCompacting).toBe(true);
	});

	it("keeps post-apply feedback running when the superseded operation ends", async () => {
		const capture: PostApplyFeedbackCapture = {};
		const harness = await createHarness({ extensionFactories: [createPostApplyFeedbackExtension(capture)] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		expect(capture.secondSignal).toBeDefined();
		expect(harness.session.compactionState).toMatchObject({ status: "running", generation: 2 });
		const endCountBeforeLateEnd = harness.eventsOfType("compaction_end").length;

		// The old operation's terminal end must not terminate the newer feedback operation.
		capture.firstContext?.endCompaction?.({
			reason: "extension",
			signal: capture.firstSignal,
			errorMessage: "superseded operation ended late",
		});

		expect(harness.session.compactionState).toMatchObject({
			status: "running",
			generation: 2,
			stage: "feedback",
		});
		expect(harness.session.isCompacting).toBe(true);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(endCountBeforeLateEnd);
	});

	it("binds an omitted endCompaction signal to the operation begun by the same context", async () => {
		const contexts: ExtensionContext[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("agent_settled", (_event, ctx) => {
						contexts.push(ctx);
					});
				},
			],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();

		await runner.emit({ type: "agent_settled" });
		const legacyContext = contexts[0];
		if (!legacyContext) throw new Error("Expected legacy extension context");
		const legacySignal = legacyContext.beginCompaction?.({ reason: "extension" });
		expect(legacySignal?.aborted).toBe(false);
		expect(harness.session.compactionState).toMatchObject({
			status: "running",
			generation: 1,
			stage: "feedback",
		});

		legacyContext.endCompaction?.({
			reason: "extension",
			signal: legacySignal,
			errorMessage: "legacy work finished",
		});
		expect(harness.session.compactionState).toMatchObject({ status: "failed", generation: 1 });
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);

		await runner.emit({ type: "agent_settled" });
		const newerContext = contexts[1];
		if (!newerContext) throw new Error("Expected newer extension context");
		const newerSignal = newerContext.beginCompaction?.({ reason: "extension" });
		expect(newerSignal?.aborted).toBe(false);
		expect(harness.session.compactionState).toMatchObject({
			status: "running",
			generation: 2,
			stage: "feedback",
		});

		// Legacy context ends without an explicit signal; it must not terminate the newer operation.
		legacyContext.endCompaction?.({ reason: "extension" });

		expect(harness.session.compactionState).toMatchObject({
			status: "running",
			generation: 2,
			stage: "feedback",
		});
		expect(harness.session.isCompacting).toBe(true);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
	});
});
