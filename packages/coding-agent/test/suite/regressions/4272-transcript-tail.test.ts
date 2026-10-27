import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { readTranscriptRoot } from "../../../src/modes/rpc/accepted-transcript.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";

let dir = "";
beforeEach(async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	dir = await mkdtemp(join(tmpdir(), "senpi-4272-tail-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

function fresh() {
	const manager = SessionManager.create(dir, dir);
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: manager.beginTranscriptJournal() });
	return { manager, lane };
}

// Part of #4272, RULING-21(4): persistence releases content even from an already frozen cut.
it("R21.4 persisted tail releases retained bytes back to ids-only, including held cuts", async () => {
	const { manager, lane } = fresh();
	manager.appendCustomEntry("tail", { text: "한".repeat(128 * 1024) });
	lane.applyTranscript(manager.drainTranscript());
	const held = lane.freeze();
	expect(held.transcript.tail.retainedBytes).toBeGreaterThan(384 * 1024);
	await manager.persistHeaderNow();
	lane.applyTranscript(manager.drainTranscript());
	expect(held.transcript.tail.retainedBytes).toBe(0);
	expect(lane.freeze().transcript.tail.retainedBytes).toBe(0);
	expect(JSON.stringify(held.transcript).length).toBeLessThan(2048);
	manager.dispose();
});

// Part of #4272, RULING-21(5): bytes from an unwritten cut agree exactly with the persisted JSONL prefix.
it("R21.5 the same cut served from tail and file after persistence is byte-identical", async () => {
	const { manager, lane } = fresh();
	manager.appendCustomEntry("tail", { unicode: "한😀", escaped: '"\n\\', nested: [1, null, true] });
	lane.applyTranscript(manager.drainTranscript());
	const held = lane.freeze();
	const before = readTranscriptRoot(held.transcript);
	if (!before.ok) throw new Error(before.error);
	const bytes = Buffer.from(before.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	await manager.persistHeaderNow();
	lane.applyTranscript(manager.drainTranscript());
	const after = readTranscriptRoot(held.transcript);
	if (!after.ok) throw new Error(after.error);
	expect(Buffer.from(after.entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n")).toEqual(bytes);
	expect(readFileSync(String(manager.getSessionFile()))).toEqual(bytes);
	manager.dispose();
});

// Part of #4272, RULING-21(2): only the new entry is serialized, and persistence consumes those very bytes.
it("R21.2 journal bytes are reused by the writer and the host never stringifies a transcript root", async () => {
	const { manager, lane } = fresh();
	const stringify = vi.spyOn(JSON, "stringify");
	const id = manager.appendCustomEntry("tail", { text: "reuse".repeat(8192) });
	const transitions = manager.drainTranscript();
	const append = transitions.find((transition) => transition.kind === "append" && transition.id === id);
	if (!append || append.kind !== "append") throw new Error("append journaled");
	const entryCalls = stringify.mock.calls.filter(([value]) => typeof value === "object" && value?.id === id);
	expect(entryCalls).toHaveLength(1);
	const beforeHost = stringify.mock.calls.length;
	lane.applyTranscript(transitions);
	const root = lane.freeze();
	expect(stringify.mock.calls.length).toBe(beforeHost);
	expect(root.transcript.tail.entries.get(1)).toBe(append.entry);
	await manager.persistHeaderNow();
	lane.applyTranscript(manager.drainTranscript());
	expect(stringify.mock.calls.filter(([value]) => typeof value === "object" && value?.id === id)).toHaveLength(1);
	expect(readFileSync(String(manager.getSessionFile()), "utf8").split("\n")[1]).toBe(append.entry);
	manager.dispose();
});

// Part of #4272, RULING-21(3,6): UTF-8 bytes, not string length or entry count, bound the accepted tail.
it("R21.3 R21.6 an over-cap accepted tail is typed unavailable, never a partial transcript", () => {
	const { manager, lane } = fresh();
	const diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true);
	manager.appendCustomEntry("oversize-tail", { text: "한".repeat(6 * 1024 * 1024) });
	lane.applyTranscript(manager.drainTranscript());
	const root = lane.freeze();
	expect(root.transcript.unavailable).toBe("transcript_tail_over_byte_limit");
	expect(readTranscriptRoot(root.transcript)).toEqual({ ok: false, error: "transcript_tail_over_byte_limit" });
	expect(root.transcript.tail.retainedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
	expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining("transcript_tail_over_byte_limit"));
	manager.dispose();
});

// #4347 LOW-2: an in-memory manager has no writer that can consume a serialized-byte cache.
it("non-persisted journals retain no duplicate serialized cache across many appends", () => {
	const manager = SessionManager.inMemory(dir);
	const lane = new SessionAcceptanceLane();
	const cache = vi.spyOn(WeakMap.prototype, "set");
	lane.bootstrap({ transcript: manager.beginTranscriptJournal() });
	for (let index = 0; index < 80; index++) {
		manager.appendCustomEntry("memory-tail", { text: "x".repeat(256 * 1024), index });
		lane.applyTranscript(manager.drainTranscript());
	}
	const retained = cache.mock.calls
		.filter(([key, value]) => typeof value === "string" && typeof key === "object" && key !== null && "id" in key)
		.reduce((bytes, [, value]) => bytes + Buffer.byteLength(String(value)), 0);
	expect(retained).toBe(0);
	expect(lane.freeze().transcript.tail.retainedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
	manager.dispose();
});
