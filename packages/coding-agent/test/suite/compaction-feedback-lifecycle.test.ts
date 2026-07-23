import { afterEach, describe, expect, it } from "vitest";
import type { CompactionReason } from "../../src/core/extensions/types.ts";
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
});
