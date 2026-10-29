import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProcessStartMs } from "../../src/core/extensions/builtin/terminal/process-start-probe.ts";
import {
	acquireWriterClaim,
	realWriterProbes,
	releaseWriterClaim,
	SessionWriterBusyError,
	SessionWriterClaimError,
	type WriterClaim,
	type WriterProbes,
	writerClaimIsCurrent,
	writerClaimsDir,
} from "../../src/core/session-writer-claims.ts";

// Characterization X3 (plan P0-03b): today's writer claims, the cross-process "one writer per session
// file" rule in src/core/session-writer-claims.ts. This pins the on-disk layout, the takeover decision
// table, the chain rules and the real-process probes exactly as origin/main behaves; any change here is
// a Z1 diff.

const TOLERANCE_MS = 120_000;
const EXIT_TIMEOUT_MS = 10_000;

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit", { signal: AbortSignal.timeout(EXIT_TIMEOUT_MS) });
			child.kill("SIGKILL");
			await exited;
		}
	}
	while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "x3-writer-claims-"));
	dirs.push(dir);
	return dir;
}

interface Machine {
	host: string;
	boot: number;
	readonly alive: Set<number>;
	readonly starts: Map<number, number>;
}

function machine(): Machine {
	return {
		host: "host-a",
		boot: 1_000_000,
		alive: new Set([100, 200]),
		starts: new Map([
			[100, 5_000_000],
			[200, 6_000_000],
		]),
	};
}

function probes(m: Machine, pid: number, host = m.host): WriterProbes {
	return {
		host: () => host,
		pidAlive: (candidate) => m.alive.has(candidate),
		readProcessStartMs: async (candidate) => m.starts.get(candidate),
		bootAtMs: () => m.boot,
		self: () => ({ pid, processStartedAtMs: m.starts.get(pid) ?? 0 }),
	};
}

async function startIdleChild(): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
	children.push(child);
	await once(child, "spawn", { signal: AbortSignal.timeout(EXIT_TIMEOUT_MS) });
	return child;
}

describe("X3 writer claims (characterization)", () => {
	it("lays claims out beside the session file as <generation>.json plus a nonce release marker", async () => {
		const sessionFile = join(tempDir(), "sessions", "proj", "s.jsonl");
		const dir = writerClaimsDir(sessionFile, "id/with space");
		expect(dir).toBe(join(dirname(sessionFile), "session-writers", "id%2Fwith%20space"));

		const m = machine();
		const claim = await acquireWriterClaim(dir, "/canonical/s.jsonl", probes(m, 100));
		expect(claim).toEqual({
			generation: 1,
			nonce: expect.stringMatching(/^[0-9a-f-]{36}$/),
			host: "host-a",
			pid: 100,
			bootAtMs: 1_000_000,
			processStartedAtMs: 5_000_000,
			canonicalPath: "/canonical/s.jsonl",
		});
		expect(readdirSync(dir)).toEqual(["1.json"]);
		expect(JSON.parse(readFileSync(join(dir, "1.json"), "utf8"))).toEqual(claim);

		await releaseWriterClaim(dir, claim);
		await releaseWriterClaim(dir, claim);
		expect(readdirSync(dir).sort()).toEqual(["1.json", "1.released"]);
		expect(readFileSync(join(dir, "1.released"), "utf8")).toBe(claim.nonce);
	});

	it("refuses a second writer with session_writer_busy naming the holder", async () => {
		const dir = tempDir();
		const m = machine();
		const holder = await acquireWriterClaim(dir, "/s.jsonl", probes(m, 100));

		await expect(acquireWriterClaim(dir, "/s.jsonl", probes(m, 200))).rejects.toMatchObject({
			code: "session_writer_busy",
			name: "SessionWriterBusyError",
			holder,
			message: "Session is already open for writing by process 100; close it there or open it read-only.",
		});
		expect(await writerClaimIsCurrent(dir, holder)).toBe(true);
	});

	type Case = {
		readonly name: string;
		readonly change: (m: Machine) => void;
		readonly claimHost?: string;
		readonly takeover: boolean;
	};
	const table: readonly Case[] = [
		{ name: "live owner, same start", change: () => {}, takeover: false },
		{ name: "owner pid gone", change: (m) => m.alive.delete(100), takeover: true },
		{ name: "owner start time unreadable", change: (m) => m.starts.delete(100), takeover: false },
		{
			name: "pid reused: start differs by more than the tolerance",
			change: (m) => m.starts.set(100, 5_000_000 + TOLERANCE_MS + 1),
			takeover: true,
		},
		{
			name: "start differs by exactly the tolerance",
			change: (m) => m.starts.set(100, 5_000_000 + TOLERANCE_MS),
			takeover: false,
		},
		{ name: "new boot (beyond the tolerance)", change: (m) => (m.boot += TOLERANCE_MS + 1), takeover: true },
		{ name: "boot shift within the tolerance", change: (m) => (m.boot += TOLERANCE_MS), takeover: false },
		{
			name: "owner on another host, even when dead and on another boot",
			claimHost: "host-b",
			change: (m) => {
				m.alive.delete(100);
				m.starts.delete(100);
				m.boot += 10 * TOLERANCE_MS;
			},
			takeover: false,
		},
	];

	for (const row of table) {
		it(`takeover decision: ${row.name} -> ${row.takeover ? "takes generation 2" : "busy"}`, async () => {
			const dir = tempDir();
			const m = machine();
			const first = await acquireWriterClaim(dir, "/s.jsonl", probes(m, 100, row.claimHost));
			row.change(m);

			const attempt = acquireWriterClaim(dir, "/s.jsonl", probes(m, 200));
			if (row.takeover) {
				const second = await attempt;
				expect(second.generation).toBe(2);
				expect(second.pid).toBe(200);
				expect(await writerClaimIsCurrent(dir, first)).toBe(false);
				expect(await writerClaimIsCurrent(dir, second)).toBe(true);
				expect(readdirSync(dir).sort()).toEqual(["1.json", "2.json"]);
			} else {
				await expect(attempt).rejects.toBeInstanceOf(SessionWriterBusyError);
				expect(await writerClaimIsCurrent(dir, first)).toBe(true);
				expect(readdirSync(dir)).toEqual(["1.json"]);
			}
		});
	}

	it("hands over on the nonce-matched release marker, even across hosts; a foreign nonce is ignored", async () => {
		const dir = tempDir();
		const m = machine();
		const first = await acquireWriterClaim(dir, "/s.jsonl", probes(m, 100, "host-b"));

		writeFileSync(join(dir, "1.released"), "some-other-nonce");
		expect(await writerClaimIsCurrent(dir, first)).toBe(true);
		await expect(acquireWriterClaim(dir, "/s.jsonl", probes(m, 200))).rejects.toBeInstanceOf(SessionWriterBusyError);

		rmSync(join(dir, "1.released"));
		await releaseWriterClaim(dir, first);
		expect(await writerClaimIsCurrent(dir, first)).toBe(false);
		await expect(acquireWriterClaim(dir, "/s.jsonl", probes(m, 200))).resolves.toMatchObject({
			generation: 2,
			host: "host-a",
		});
	});

	it("gives concurrent takeover contenders exactly one owner", async () => {
		const dir = tempDir();
		const m = machine();
		for (const pid of [300, 400, 500]) {
			m.alive.add(pid);
			m.starts.set(pid, pid * 10_000);
		}
		await acquireWriterClaim(dir, "/s.jsonl", probes(m, 100));
		m.alive.delete(100);

		const outcomes = await Promise.allSettled(
			[200, 300, 400, 500].map((pid) => acquireWriterClaim(dir, "/s.jsonl", probes(m, pid))),
		);
		const won = outcomes.filter(
			(outcome): outcome is PromiseFulfilledResult<WriterClaim> => outcome.status === "fulfilled",
		);
		expect(won).toHaveLength(1);
		expect(won[0]?.value.generation).toBe(2);
		for (const outcome of outcomes) {
			if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(SessionWriterBusyError);
		}
		expect(
			readdirSync(dir)
				.filter((name) => name.endsWith(".json"))
				.sort(),
		).toEqual(["1.json", "2.json"]);
	});

	it("refuses a chain with a gap and a malformed newest claim instead of guessing", async () => {
		const gap = tempDir();
		const claim = {
			generation: 2,
			nonce: "n",
			host: "host-a",
			pid: 999,
			bootAtMs: 1,
			processStartedAtMs: 1,
			canonicalPath: "/s.jsonl",
		};
		writeFileSync(join(gap, "2.json"), JSON.stringify(claim));
		const gapError = acquireWriterClaim(gap, "/s.jsonl", probes(machine(), 200));
		await expect(gapError).rejects.toBeInstanceOf(SessionWriterClaimError);
		await expect(gapError).rejects.toMatchObject({
			code: "session_writer_claim_invalid",
			message: `Writer claims in ${gap} have a gap before 2.`,
		});
		await expect(writerClaimIsCurrent(gap, { ...claim })).rejects.toBeInstanceOf(SessionWriterClaimError);

		const malformed = tempDir();
		writeFileSync(join(malformed, "1.json"), JSON.stringify({ ...claim, generation: 1, host: undefined }));
		const malformedError = acquireWriterClaim(malformed, "/s.jsonl", probes(machine(), 200));
		await expect(malformedError).rejects.toBeInstanceOf(SessionWriterClaimError);
		await expect(malformedError).rejects.toMatchObject({ message: `A writer claim in ${malformed} is malformed.` });
	});

	it("with the real probes, a live process holds the claim and its exit frees it", async () => {
		const dir = tempDir();
		const child = await startIdleChild();
		const childPid = child.pid;
		if (childPid === undefined) throw new Error("child has no pid");
		const childStart = await readProcessStartMs(childPid);
		expect(childStart).toBeTypeOf("number");

		const childClaim = await acquireWriterClaim(dir, "/s.jsonl", {
			...realWriterProbes,
			self: () => ({ pid: childPid, processStartedAtMs: childStart ?? 0 }),
		});

		const refused = acquireWriterClaim(dir, "/s.jsonl");
		await expect(refused).rejects.toBeInstanceOf(SessionWriterBusyError);
		await expect(refused).rejects.toMatchObject({ holder: { pid: childPid } });

		const exited = once(child, "exit", { signal: AbortSignal.timeout(EXIT_TIMEOUT_MS) });
		child.kill("SIGKILL");
		await exited;

		const mine = await acquireWriterClaim(dir, "/s.jsonl");
		expect(mine.generation).toBe(2);
		expect(mine.pid).toBe(process.pid);
		expect(mine.host).toBe(hostname());
		expect(await writerClaimIsCurrent(dir, childClaim)).toBe(false);
		expect(await writerClaimIsCurrent(dir, mine)).toBe(true);
	});
});
