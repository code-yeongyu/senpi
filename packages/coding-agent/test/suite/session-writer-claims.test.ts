import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireWriterClaim,
	releaseWriterClaim,
	SessionWriterBusyError,
	SessionWriterClaimError,
	type WriterProbes,
	writerClaimIsCurrent,
} from "../../src/core/session-writer-claims.ts";

// senpi#3549: one writer per session file across processes (T47, T48; race R: two takeover contenders).

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
});

function claimsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "writer-claims-"));
	dirs.push(dir);
	return dir;
}

interface World {
	readonly alive: Set<number>;
	readonly starts: Map<number, number>;
	boot: number;
}

function probesFor(world: World, pid: number, host = "host-a"): WriterProbes {
	return {
		host: () => host,
		pidAlive: (candidate) => world.alive.has(candidate),
		readProcessStartMs: async (candidate) => world.starts.get(candidate),
		bootAtMs: () => world.boot,
		self: () => ({ pid, processStartedAtMs: world.starts.get(pid) ?? 0 }),
	};
}

function world(): World {
	return {
		alive: new Set([100, 200]),
		starts: new Map([
			[100, 1_000],
			[200, 2_000],
		]),
		boot: 50,
	};
}

describe("session writer claims", () => {
	it("refuses a second writer before recovery or delivery reservation (T47)", async () => {
		const dir = claimsDir();
		const w = world();
		await acquireWriterClaim(dir, "/s.jsonl", probesFor(w, 100));

		await expect(acquireWriterClaim(dir, "/s.jsonl", probesFor(w, 200))).rejects.toBeInstanceOf(
			SessionWriterBusyError,
		);
	});

	it("allows one takeover only after the prior writer cannot dispatch (T48)", async () => {
		const dir = claimsDir();
		const w = world();
		const first = await acquireWriterClaim(dir, "/s.jsonl", probesFor(w, 100));

		w.alive.delete(100);
		const second = await acquireWriterClaim(dir, "/s.jsonl", probesFor(w, 200));

		expect(second.generation).toBe(2);
		expect(await writerClaimIsCurrent(dir, first)).toBe(false);
		expect(await writerClaimIsCurrent(dir, second)).toBe(true);
	});

	it("hands over after the owner publishes its release marker", async () => {
		const dir = claimsDir();
		const w = world();
		const first = await acquireWriterClaim(dir, "/s.jsonl", probesFor(w, 100));

		await releaseWriterClaim(dir, first);

		expect(await writerClaimIsCurrent(dir, first)).toBe(false);
		expect((await acquireWriterClaim(dir, "/s.jsonl", probesFor(w, 200))).generation).toBe(2);
	});

	it("never displaces a live owner whose start time cannot be read", async () => {
		const dir = claimsDir();
		const w = world();
		await acquireWriterClaim(dir, "/s.jsonl", probesFor(w, 100));

		w.starts.delete(100);

		await expect(acquireWriterClaim(dir, "/s.jsonl", probesFor(w, 200))).rejects.toBeInstanceOf(
			SessionWriterBusyError,
		);
	});

	it("takes over from a reused pid and from an older boot", async () => {
		const reused = claimsDir();
		const w = world();
		await acquireWriterClaim(reused, "/s.jsonl", probesFor(w, 100));
		w.starts.set(100, 9_000_000);
		expect((await acquireWriterClaim(reused, "/s.jsonl", probesFor(w, 200))).generation).toBe(2);

		const rebooted = claimsDir();
		const w2 = world();
		await acquireWriterClaim(rebooted, "/s.jsonl", probesFor(w2, 100));
		w2.boot = 50 + 10_000_000;
		expect((await acquireWriterClaim(rebooted, "/s.jsonl", probesFor(w2, 200))).generation).toBe(2);
	});

	it("gives two takeover contenders one owner", async () => {
		const dir = claimsDir();
		const w = world();
		w.alive.add(300);
		w.starts.set(300, 3_000);
		await acquireWriterClaim(dir, "/s.jsonl", probesFor(w, 100));
		w.alive.delete(100);

		const outcomes = await Promise.allSettled([
			acquireWriterClaim(dir, "/s.jsonl", probesFor(w, 200)),
			acquireWriterClaim(dir, "/s.jsonl", probesFor(w, 300)),
		]);

		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		const refused = outcomes.find((outcome) => outcome.status === "rejected");
		expect(refused?.status === "rejected" && refused.reason).toBeInstanceOf(SessionWriterBusyError);
	});

	it("never takes over a writer on another host, whose pid and boot cannot be probed here", async () => {
		const dir = claimsDir();
		const w = world();
		await acquireWriterClaim(dir, "/s.jsonl", probesFor(w, 100, "host-b"));
		w.alive.delete(100);
		w.boot = 9_999_999;

		await expect(acquireWriterClaim(dir, "/s.jsonl", probesFor(w, 200, "host-a"))).rejects.toBeInstanceOf(
			SessionWriterBusyError,
		);
	});

	it("refuses a chain with a missing generation instead of guessing", async () => {
		const dir = claimsDir();
		const deadOwner = {
			generation: 2,
			nonce: "n",
			host: "host-a",
			pid: 999,
			bootAtMs: 50,
			processStartedAtMs: 1,
			canonicalPath: "/s.jsonl",
		};
		writeFileSync(join(dir, "2.json"), JSON.stringify(deadOwner));

		await expect(acquireWriterClaim(dir, "/s.jsonl", probesFor(world(), 200))).rejects.toBeInstanceOf(
			SessionWriterClaimError,
		);
	});
});
