import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reclaimLockState } from "../../../src/core/extensions/builtin/terminal/lease-file.ts";
import { processBootAtMs } from "../../../src/core/extensions/builtin/terminal/process-identity.ts";
import {
	acquireWriterClaim,
	SessionWriterBusyError,
	type WriterProbes,
} from "../../../src/core/session-writer-claims.ts";
import { type ResidentWriter, residentWriterProbe } from "../../../src/modes/rpc/host-handover-resident-writer.ts";

// senpi#3152 follow-up: a wall-clock step moves the kernel's recorded boot instant. A live peer whose record predates a
// step of more than the boot tolerance reads as another boot to a process holding the moved instant, so on the same
// host a live pid is judged by its start time first, and the boot instant decides only when the start time is unknown.

const STEP_MS = 600_000;
const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "same-host-liveness-"));
	dirs.push(dir);
	return dir;
}

/** Probes for a process that holds the moved boot instant, on the host the peer recorded. */
function movedProbes(world: { readonly alive: Set<number>; readonly starts: Map<number, number> }): WriterProbes & {
	readonly freshReads: () => number;
} {
	let fresh = 0;
	return {
		host: () => "host-a",
		pidAlive: (pid) => world.alive.has(pid),
		readProcessStartMs: async (pid) => world.starts.get(pid),
		bootAtMs: async (options) => {
			if (options?.fresh === true) fresh += 1;
			return 50 + STEP_MS;
		},
		self: () => ({ pid: 200, processStartedAtMs: 2_000 }),
		freshReads: () => fresh,
	};
}

describe("same-host liveness after a wall-clock step", () => {
	it("keeps a live writer whose claim predates the step, and still takes over from a dead one", async () => {
		const live = tempDir();
		const world = { alive: new Set([100, 200]), starts: new Map([[100, 1_000]]) };
		await acquireWriterClaim(live, "/s.jsonl", {
			...movedProbes(world),
			bootAtMs: async () => 50,
			self: () => ({ pid: 100, processStartedAtMs: 1_000 }),
		});

		await expect(acquireWriterClaim(live, "/s.jsonl", movedProbes(world))).rejects.toBeInstanceOf(
			SessionWriterBusyError,
		);

		world.alive.delete(100);
		const takeover = await acquireWriterClaim(live, "/s.jsonl", movedProbes(world));
		expect(takeover.generation).toBe(2);
	});

	it("keeps a live resident writer recorded before the step, and calls a dead one gone", async () => {
		const world = { alive: new Set([100]), starts: new Map([[100, 1_000]]) };
		const writer: ResidentWriter = { host: "host-a", pid: 100, bootAtMs: 50, processStartedAtMs: 1_000 };
		const probe = residentWriterProbe(movedProbes(world));

		expect(await probe(writer)).toBe(true);

		world.alive.delete(100);
		expect(await residentWriterProbe(movedProbes(world))(writer)).toBe(false);
	});

	it("never re-reads the boot record for a resident writer it already found gone", async () => {
		const world = { alive: new Set<number>(), starts: new Map<number, number>() };
		const probes = movedProbes(world);
		const probe = residentWriterProbe(probes);
		// A writer from another boot whose pid is dead: the dead pid alone records it gone, so no poll reads a boot record.
		const writer: ResidentWriter = { host: "host-a", pid: 100, bootAtMs: 50, processStartedAtMs: 1_000 };

		const verdicts: boolean[] = [];
		for (let poll = 0; poll < 5; poll += 1) verdicts.push(await probe(writer));

		expect({ verdicts, freshReads: probes.freshReads() }).toEqual({
			verdicts: [false, false, false, false, false],
			freshReads: 0,
		});
	});

	it("re-checks a verified live resident writer by its pid alone, with no boot or start read per poll", async () => {
		const reads = { boot: 0, start: 0 };
		const probes: WriterProbes = {
			host: () => "host-a",
			pidAlive: () => true,
			readProcessStartMs: async () => {
				reads.start += 1;
				return 1_000;
			},
			bootAtMs: async () => {
				reads.boot += 1;
				return 50;
			},
			self: () => ({ pid: 200, processStartedAtMs: 2_000 }),
		};
		const probe = residentWriterProbe(probes);
		const writer: ResidentWriter = { host: "host-a", pid: 100, bootAtMs: 50 - STEP_MS, processStartedAtMs: 1_000 };

		const verdicts: boolean[] = [];
		for (let poll = 0; poll < 5; poll += 1) verdicts.push(await probe(writer));

		expect({ verdicts, reads }).toEqual({ verdicts: [true, true, true, true, true], reads: { boot: 0, start: 1 } });
	});

	it("holds a reclaim lock whose live holder predates the step, and frees one whose holder is dead", async () => {
		const dir = tempDir();
		const lock = join(dir, "s.lease.lock");
		const holder = { pid: 4_242, bootAtMs: (await processBootAtMs()) - STEP_MS, processStartedAtMs: 1_000 };
		writeFileSync(lock, JSON.stringify(holder));

		const held = await reclaimLockState(lock, { isProcessAlive: () => true, readProcessStartMs: async () => 1_000 });
		const dead = await reclaimLockState(lock, { isProcessAlive: () => false, readProcessStartMs: async () => 1_000 });

		expect({ held: held.state, dead: dead.state }).toEqual({ held: "held", dead: "stale" });
	});
});
