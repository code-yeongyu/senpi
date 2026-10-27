import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { TranscriptTransition } from "../../../src/core/session-transcript-journal.ts";
import { readTranscriptRoot } from "../../../src/modes/rpc/accepted-transcript.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SESSION_WORKER_LIMITS, withinFrameLimit } from "../../../src/modes/rpc/session-worker-protocol.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// #4347 LOW-1: raw journal UTF-8 bytes, not JSON's escaping of those bytes, consume the frame budget.
it("frame accounting uses journal bytes at the limit without serializing transitions again", () => {
	const overhead = 1024;
	const budget = SESSION_WORKER_LIMITS.outputBytes - overhead;
	const entry = '"\\\n'.repeat(Math.floor(budget / 3)) + "x".repeat(budget % 3);
	expect(Buffer.byteLength(entry) + overhead).toBe(SESSION_WORKER_LIMITS.outputBytes);
	const at: TranscriptTransition = { kind: "append", id: "at-limit", entry };
	const over: TranscriptTransition = { kind: "append", id: "over-limit", entry: `${entry}한` };
	const stringify = vi.spyOn(JSON, "stringify");
	const frames = withinFrameLimit([at, over]);
	expect(stringify).not.toHaveBeenCalled();
	expect(frames[0]).toBe(at);
	expect(frames[1]).toEqual({ kind: "unavailable", reason: "transition_over_worker_frame_limit" });
});

/** A new session's entries stay owned until its first message, so each one is a pre-bind transition. */
async function bootstrappedWith(blobBytes: number) {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	const dir = await mkdtemp(join(tmpdir(), "senpi-4272-q5-"));
	const manager = SessionManager.create(dir, dir);
	manager.appendCustomEntry("q5-blob", { blob: "x".repeat(blobBytes) });
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: withinFrameLimit(manager.beginTranscriptJournal()) });
	return { lane, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// Part of #4272, ruling 10 Q5: one pre-bind transition over the worker frame limit; S12 transfers it in fragments.
it("Q5 a single pre-bind transition over the 16 MiB worker frame limit makes the transcript component unavailable with a typed reason through the host diagnostic seam, and records keep their order", async () => {
	const diagnostics: string[] = [];
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		diagnostics.push(String(chunk));
		return true;
	});
	const over = await bootstrappedWith(SESSION_WORKER_LIMITS.outputBytes + 1);
	const under = await bootstrappedWith(1024 * 1024);
	try {
		const root = over.lane.freeze();
		expect(root.transcript.unavailable).toBe("transition_over_worker_frame_limit");
		expect(readTranscriptRoot(root.transcript), "no partial transcript is read").toEqual({
			ok: false,
			error: "transition_over_worker_frame_limit",
		});
		expect(diagnostics).toEqual([
			"senpi rpc acceptance: transcript component unavailable: transition_over_worker_frame_limit\n",
		]);
		expect(root.sequence, "the bootstrap itself is unchanged").toBe(0);
		expect(over.lane.accept({ type: "agent_start" }, undefined)?.sequence, "records are still accepted").toBe(1);
		expect(over.lane.retired).toBe(false);

		const control = under.lane.freeze();
		expect(control.transcript.unavailable, "a transition under the limit stays available").toBeNull();
		const read = readTranscriptRoot(control.transcript);
		expect(read.ok && read.entries.map((entry) => entry.type)).toContain("custom");
		over.lane.release(root);
		under.lane.release(control);
	} finally {
		await over.cleanup();
		await under.cleanup();
	}
});
