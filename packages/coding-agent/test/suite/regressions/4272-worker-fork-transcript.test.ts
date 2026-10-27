import { existsSync, readFileSync, realpathSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { readTranscriptRoot, type TranscriptRoot } from "../../../src/modes/rpc/accepted-transcript.ts";
import { type OutputFrame, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";

afterEach(() => {
	vi.unstubAllEnvs();
});

function recordType(frame: OutputFrame | undefined): unknown {
	return frame && "type" in frame.record ? frame.record.type : undefined;
}

function fileIds(path: string): string[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => String(JSON.parse(line).id));
}

function rootIds(root: TranscriptRoot): string[] {
	const read = readTranscriptRoot(root);
	if (!read.ok) throw new Error(`transcript read failed: ${read.error}`);
	return read.entries.map((entry) => entry.id);
}

function basePath(root: TranscriptRoot): string | null {
	return root.base ? realpathSync(root.base.fileIdentity.path) : null;
}

// Part of #4272, R3.C1.1 last sentence (X03) + ruling 10 Q2: persisted-but-not-ingested worker output is beyond the cut.
it("X03 persisted fork held at reconcile: the cut keeps the old epoch and transcript root with no fork file or entry, and the held frame's bootstrap makes the fork file the new epoch's base", async () => {
	vi.stubEnv(FLAG, "1");
	const host = await workerAcceptanceHost();
	try {
		const { sessionId, worker } = await host.open();
		const lane = worker.acceptance;
		if (!lane) throw new Error("flag on: the worker client owns an acceptance lane");
		const settled = host.next("agent_settled", (record) => record.type === "agent_settled");
		expect((await host.request({ type: "prompt", sessionId, message: "question" })).success).toBe(true);
		await settled;
		const original = realpathSync(String(host.registry.peek(sessionId)?.sessionPath));
		const beforeFork = lane.freeze();
		const beforeIds = rootIds(beforeFork.transcript);
		expect(beforeIds.length, "the turn's entries were accepted").toBeGreaterThan(2);
		expect(fileIds(original).slice(0, beforeIds.length), "the cut is a prefix of what is on disk").toEqual(beforeIds);

		const held = host.holdReconcile(
			(message) => message?.type === "output" && recordType(message) === "session_replaced",
		);
		const replaced = host.next("session_replaced", (record) => record.type === "session_replaced");
		const cloned = host.request({ type: "clone", sessionId });
		const forkPaths = await held.reached;
		const fork = realpathSync(forkPaths.find((path) => realpathSync(path) !== original) ?? "");
		expect(existsSync(fork), "the fork is on disk before its acceptance").toBe(true);
		const forkHeader = fileIds(fork)[0];

		const heldCut = lane.freeze();
		const heldIds = rootIds(heldCut.transcript);
		const heldObserved = host.frames.at(-1);
		const heldFrame = heldObserved?.frame;
		expect(recordType(heldFrame), "the worker is blocked on the replacement frame").toBe("session_replaced");
		expect(heldCut.sessionEpoch, "the held cut stays in the old epoch").toBe(beforeFork.sessionEpoch);
		expect(basePath(heldCut.transcript), "no fork file identity in the held cut").not.toBe(fork);
		expect(heldIds, "no fork entry in the held cut").not.toContain(forkHeader);
		expect(heldCut.transcript, "nothing past the held frame is accepted").toEqual(
			heldObserved?.atArrival?.transcript,
		);
		const bootstrap = heldFrame?.bootstrap?.transcript ?? [];
		expect(bootstrap[0]?.kind, "the held frame carries the fork's root, not yet accepted").toBe("replace");
		const carried = bootstrap[0]?.kind === "replace" ? bootstrap[0].base : null;
		expect(carried && realpathSync(carried.fileIdentity.path)).toBe(fork);

		held.release();
		await replaced;
		expect((await cloned).success).toBe(true);
		const after = lane.freeze();
		expect(after.sessionEpoch, "the bootstrap minted a new epoch").not.toBe(beforeFork.sessionEpoch);
		expect(basePath(after.transcript), "the fork file is the new epoch's persisted base").toBe(fork);
		const afterIds = rootIds(after.transcript);
		expect(afterIds[0]).toBe(forkHeader);
		expect(fileIds(fork).slice(0, afterIds.length)).toEqual(afterIds);
		expect(rootIds(heldCut.transcript), "the held cut is unchanged after the disk and lane moved on").toEqual(
			heldIds,
		);
		expect(heldCut.sessionEpoch).toBe(beforeFork.sessionEpoch);
		for (const root of [beforeFork, heldCut, after]) lane.release(root);
		expect(lane.liveRoots).toBe(0);
	} finally {
		await host.dispose();
	}
}, 120_000);
