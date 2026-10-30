import { expect, it } from "vitest";
import type { TranscriptFlow, TranscriptTransition } from "../../../src/core/session-transcript-journal.ts";
import { SESSION_WORKER_LIMITS, withinFrameLimit } from "../../../src/modes/rpc/session-worker-protocol.ts";

const OVER = { kind: "unavailable", reason: "transition_over_worker_frame_limit" } as const;
const BUDGET = SESSION_WORKER_LIMITS.outputBytes - 1024;

function branchOf(bytes: number): TranscriptFlow {
	const message = { role: "user" as const, content: "", timestamp: 1 };
	const envelope = Buffer.byteLength(
		JSON.stringify({ kind: "branch", removedIds: [], installed: [{ id: "b", message }] }),
	);
	return {
		kind: "branch",
		removedIds: [],
		installed: [{ id: "b", message: { ...message, content: "x".repeat(bytes - envelope) } }],
	};
}

// senpi#4460 LOW-1: the frame budget charges the flow payload a transition carries (every owned message copy of a
// branch or edit), so an oversize leaf move degrades to the typed reason instead of exceeding the worker frame.
it("a leaf move reinstalling a branch over the frame limit degrades to transition_over_worker_frame_limit", () => {
	const at: TranscriptTransition = { kind: "leaf", leafId: "b", flow: branchOf(BUDGET) };
	const over: TranscriptTransition = { kind: "leaf", leafId: "b", flow: branchOf(BUDGET + 1) };
	const bare: TranscriptTransition = { kind: "leaf", leafId: null };
	expect(withinFrameLimit([at, over, bare])).toEqual([at, OVER, bare]);
});

it("an append is charged its entry and its flow together", () => {
	const entry = "e".repeat(BUDGET - 4096);
	const flow: TranscriptFlow = {
		kind: "edit",
		targetId: "t",
		message: { role: "user", content: "c".repeat(4096), timestamp: 1 },
	};
	const edit: TranscriptTransition = { kind: "append", id: "a", entry, flow };
	const compaction: TranscriptTransition = {
		kind: "append",
		id: "a",
		entry,
		flow: { kind: "compaction", removedIds: [] },
	};
	expect(withinFrameLimit([edit, compaction])).toEqual([OVER, compaction]);
});
