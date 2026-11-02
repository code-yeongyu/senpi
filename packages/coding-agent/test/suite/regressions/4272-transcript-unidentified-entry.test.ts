import { expect, it } from "vitest";
import { snapshotTranscript } from "../../../src/core/session-transcript-journal.ts";
import type { FileEntry } from "../../../src/core/session-manager.ts";

// Part of #4272: a journal line read from disk is not validated against FileEntry. One without a string id cannot be
// an ancestry node, so the compact transcript is unavailable instead of throwing while sizing its ancestry
// (Buffer.byteLength(undefined) on reopen).

const entry = (id: unknown, parentId: string | null): FileEntry =>
	({ type: "message", id, parentId, timestamp: "2026-11-01T00:00:00.000Z" }) as unknown as FileEntry;

it("an unpersisted entry without a string id makes the transcript unavailable", () => {
	const transitions = snapshotTranscript({
		base: null,
		unpersisted: [entry("a", null), entry(undefined, "a")],
		leafId: "a",
		own: (value) => JSON.stringify(value),
	});
	expect(transitions).toEqual([{ kind: "unavailable", reason: "transcript_entry_unidentified" }]);
});

it("identified entries still replay as appends", () => {
	const transitions = snapshotTranscript({
		base: null,
		unpersisted: [entry("a", null), entry("b", "a")],
		leafId: "b",
		own: (value) => JSON.stringify(value),
	});
	expect(transitions.map((transition) => transition.kind)).toEqual(["replace", "append", "append", "leaf"]);
});
