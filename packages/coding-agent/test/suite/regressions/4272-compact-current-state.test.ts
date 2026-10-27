import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CompactContentStoreOptions,
	COMPACT_LEAF_CODE_UNITS as LEAF,
} from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactSessionState } from "../../../src/modes/rpc/compact-session-state.ts";
import type { CompactTransition } from "../../../src/modes/rpc/compact-transition.ts";
import { controlledIo, spoolRoot } from "../compact-storage-support.ts";

// senpi#4272 (R3.C6.4, T6/X07 S03 slice): the compact owner retains current content, not the
// cumulative prefixes a growing message has had, and rejects coverage it was never declared.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(options: Partial<CompactContentStoreOptions> = {}) {
	const root = await spoolRoot();
	cleanups.push(root.cleanup);
	const control = controlledIo();
	return { state: new CompactSessionState({ dir: root.dir, io: control.io, ...options }), control, dir: root.dir };
}

async function text(state: CompactSessionState, messageId = "m1"): Promise<string | undefined> {
	const cut = state.freeze();
	const view = await state.read(cut);
	state.release(cut);
	return view.messages.find((m) => m.messageId === messageId)?.blocks[0]?.text;
}

const MiB = 1024 * 1024;
const body = (chunks: number, size: number) =>
	Array.from({ length: chunks }, (_, i) => String.fromCharCode(97 + (i % 26)).repeat(size)).join("");

function streamBody(state: CompactSessionState, chunks: number, size: number): void {
	state.accept({ type: "block_start", messageId: "m1", contentIndex: 0, kind: "text", seed: "", coveredCodeUnits: 0 });
	const full = body(chunks, size);
	for (let i = 0; i < chunks; i++) {
		state.accept({
			type: "block_delta",
			messageId: "m1",
			contentIndex: 0,
			offset: i * size,
			text: full.slice(i * size, (i + 1) * size),
		});
	}
}

describe("4272 compact current state: 1 MiB over 1,024 updates with zero peers", () => {
	it("retains one copy of the current body, spilled once, regardless of delta granularity", async () => {
		const spill = { spillAboveBytes: 256 * 1024, spillTargetBytes: 128 * 1024 };
		const coarse = await setup(spill);
		streamBody(coarse.state, 1024, 1024);
		await coarse.state.idle();
		const status = coarse.state.storageStatus();

		expect(coarse.state.acceptedSequence).toBe(1025);
		expect(status.residentPayloadBytes + status.spilledLiveBytes + status.residentTailBytes).toBe(2 * MiB);
		expect(status.spillBytesWritten).toBe(status.spilledLiveBytes);
		expect(status.residentPayloadBytes).toBeLessThanOrEqual(spill.spillTargetBytes);
		expect(await text(coarse.state)).toBe(body(1024, 1024));

		const fine = await setup(spill);
		streamBody(fine.state, 4096, 256);
		await fine.state.idle();
		expect(fine.state.storageStatus()).toMatchObject({
			residentPayloadBytes: status.residentPayloadBytes,
			spilledLiveBytes: status.spilledLiveBytes,
			spillBytesWritten: status.spillBytesWritten,
		});
		expect((await readdir(fine.dir)).length).toBe((await readdir(coarse.dir)).length);
		expect(await text(fine.state)).toBe(body(4096, 256));
	});

	it("keeps the whole accepted body readable while the first spill write is held", async () => {
		const { state, control } = await setup({ spillAboveBytes: 256 * 1024, spillTargetBytes: 128 * 1024 });
		const write = control.hold("write");
		streamBody(state, 1024, 1024);
		await write.entered;
		expect(state.storageStatus()).toMatchObject({
			residentPayloadBytes: 2 * MiB,
			pendingIoCopyBytes: 65_536,
			spilledLiveBytes: 0,
		});
		expect(await text(state)).toBe(body(1024, 1024));
		write.release();
		await state.idle();
		expect(state.storageStatus().pendingIoCopyBytes).toBe(0);
		expect(await text(state)).toBe(body(1024, 1024));
	});
});

describe("4272 compact current state: declared coverage and exact UTF-16 content", () => {
	it("discards only the declared replay overlap and appends the uncovered suffix", async () => {
		const { state } = await setup();
		state.accept({
			type: "block_start",
			messageId: "m1",
			contentIndex: 0,
			kind: "text",
			seed: "Hello",
			coveredCodeUnits: 5,
		});
		expect(state.storageStatus().hotWitnessBytes).toBe(10);
		for (const [offset, delta] of [
			[0, "Hel"],
			[3, "lo wor"],
			[9, "ld"],
		] as const) {
			state.accept({ type: "block_delta", messageId: "m1", contentIndex: 0, offset, text: delta });
		}
		expect(state.storageStatus().hotWitnessBytes).toBe(0);
		expect(await text(state)).toBe("Hello world");
	});

	it("rejects backwards, partially covered and conflicting overlap with a typed error and no partial apply", async () => {
		const { state } = await setup();
		const seed = (messageId: string, value: string, covered: number): CompactTransition => ({
			type: "block_start",
			messageId,
			contentIndex: 0,
			kind: "tool_arguments",
			seed: value,
			coveredCodeUnits: covered,
		});
		state.accept(seed("plain", "abc", 0));
		state.accept({ type: "block_delta", messageId: "plain", contentIndex: 0, offset: 3, text: "def" });
		state.accept(seed("replay", "abc", 3));

		const rejected: [CompactTransition, string][] = [
			[{ type: "block_delta", messageId: "plain", contentIndex: 0, offset: 1, text: "bcdefg" }, "non_contiguous"],
			[seed("partial", "abcdef", 3), "invalid_coverage"],
			[
				{ type: "block_delta", messageId: "replay", contentIndex: 0, offset: 0, text: "abXd" },
				"conflicting_overlap",
			],
			[{ type: "block_delta", messageId: "missing", contentIndex: 0, offset: 0, text: "x" }, "unknown_block"],
			[seed("plain", "again", 0), "duplicate_block"],
			[seed("bad", "ab", 3), "invalid_coverage"],
		];
		const sequence = state.acceptedSequence;
		const before = { plain: await text(state, "plain"), replay: await text(state, "replay") };
		const resident = state.storageStatus().residentTailBytes;
		for (const [transition, reason] of rejected) {
			expect(() => state.accept(transition)).toThrow(
				expect.objectContaining({ name: "CompactTransitionError", reason }),
			);
		}
		expect(state.acceptedSequence).toBe(sequence);
		expect(state.storageStatus().residentTailBytes).toBe(resident);
		expect({ plain: await text(state, "plain"), replay: await text(state, "replay") }).toEqual(before);
		expect(await text(state, "bad")).toBeUndefined();
		expect(await text(state, "partial")).toBeUndefined();
	});

	it("refuses partial seed coverage at start, so no accepted block can refuse every later delta", async () => {
		const { state } = await setup();
		const start = (messageId: string, covered: number): CompactTransition => ({
			type: "block_start",
			messageId,
			contentIndex: 0,
			kind: "text",
			seed: "abcdef",
			coveredCodeUnits: covered,
		});
		const delta = (messageId: string, offset: number, value: string): CompactTransition => ({
			type: "block_delta",
			messageId,
			contentIndex: 0,
			offset,
			text: value,
		});

		expect(() => state.accept(start("probe", 3))).toThrow(
			expect.objectContaining({ name: "CompactTransitionError", reason: "invalid_coverage" }),
		);
		expect(state.acceptedSequence).toBe(0);
		expect(await text(state, "probe")).toBeUndefined();

		state.accept(start("full", 6));
		for (const [offset, value] of [
			[0, "abc"],
			[3, "def"],
			[6, "g"],
		] as const) {
			state.accept(delta("full", offset, value));
		}
		expect(await text(state, "full")).toBe("abcdefg");
	});

	it("preserves a surrogate pair split by a leaf boundary and a lone surrogate through spill", async () => {
		const { state } = await setup({ spillAboveBytes: 0, spillTargetBytes: 0 });
		const value = `${"a".repeat(LEAF - 1)}\u{1F600}b\uD800`;
		state.accept({
			type: "block_start",
			messageId: "m1",
			contentIndex: 0,
			kind: "thinking",
			seed: value,
			coveredCodeUnits: 0,
		});
		state.accept({ type: "message_status", messageId: "m1", persistence: "pending" });
		await state.idle();
		expect(state.storageStatus()).toMatchObject({ residentPayloadBytes: 0, spilledLiveBytes: value.length * 2 });
		expect(await text(state)).toBe(value);
	});
});
