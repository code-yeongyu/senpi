// senpi#3566 todo 4 (review HIGH 2): no launched command outlives its host. A host killed with SIGKILL leaves its child
// to sweep the owned group the ledger names and end its own group (inherited commands); a server starting a session
// sweeps whatever a crashed predecessor's ledger still names.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { generationLedgerPath } from "./descendants.ts";
import { defaultGroupProbes } from "./group-ownership.ts";
import { recordGenerationChild, sweepStaleGenerations } from "./orphan-sweep.ts";

const resolver = pathToFileURL(resolve(import.meta.dirname, "../../../experimental/source-resolver.ts")).href;
const hostFixture = resolve(import.meta.dirname, "../../../../test/fixtures/tool-child-host-fixture.ts");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Bounded wait on another process's state: there is no event for a foreign process ending. */
async function goneWithin(pids: readonly number[], ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (pids.some(alive) && Date.now() < deadline) await new Promise((resolveTick) => setTimeout(resolveTick, 50));
	return !pids.some(alive);
}

function killLater(pids: readonly number[]) {
	cleanups.push(async () => {
		for (const pid of pids) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
	});
}

describe.skipIf(process.platform === "win32")("orphan sweep", () => {
	it("leaves no launched command behind when the host is killed with SIGKILL", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tos-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const host = spawn(process.execPath, ["--import", resolver, hostFixture, dir], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		const line = await new Promise<string>((resolveLine, rejectLine) => {
			createInterface({ input: host.stdout }).once("line", resolveLine);
			host.once("exit", (code) => rejectLine(new Error(`host exited early (${code})`)));
		});
		const { childPid, owned, inherited } = JSON.parse(line) as { childPid: number; owned: number; inherited: number };
		killLater([owned, inherited, childPid]);
		expect([alive(owned), alive(inherited), defaultGroupProbes.groupHasMembers(owned)]).toEqual([true, true, true]);
		host.kill("SIGKILL");
		expect(await goneWithin([owned, inherited, childPid], 5_000)).toBe(true);
		expect(defaultGroupProbes.groupHasMembers(owned)).toBe(false);
	}, 60_000);

	it("sweeps the owned groups a crashed predecessor's ledger names, and removes that ledger", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tos-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const owned = spawn("/bin/sleep", ["300"], { detached: true, stdio: "ignore" });
		const detached = spawn("/bin/sleep", ["300"], { detached: true, stdio: "ignore" });
		const ownedPid = owned.pid ?? -1;
		const detachedPid = detached.pid ?? -1;
		killLater([ownedPid, detachedPid]);
		const entry = (pid: number, lifetime: "owned" | "detached") => ({
			launchId: `W1-${pid}`,
			generation: 1,
			origin: "tool",
			api: "cp.spawn",
			containment: "own-group",
			lifetime,
			pid,
			pgid: pid,
			atMs: Date.now(),
		});
		const startOf = async (pid: number) => (await defaultGroupProbes.startOf(pid)) ?? "";
		const ledger = generationLedgerPath(dir, 1);
		await mkdir(dirname(ledger), { recursive: true });
		await writeFile(
			ledger,
			`${JSON.stringify({ ...entry(ownedPid, "owned"), leaderStart: await startOf(ownedPid) })}\n${JSON.stringify({ ...entry(detachedPid, "detached"), leaderStart: await startOf(detachedPid) })}\n`,
		);
		const outcomes = await sweepStaleGenerations(dir);
		expect(outcomes.map((outcome) => [outcome.pgid, outcome.verdict])).toEqual([
			[ownedPid, "sweep"],
			[detachedPid, "detached"],
		]);
		expect(await goneWithin([ownedPid], 3_000)).toBe(true);
		expect(alive(detachedPid)).toBe(true);
		expect(
			await stat(dirname(ledger)).then(
				() => "present",
				() => "removed",
			),
		).toBe("removed");
	}, 30_000);

	it("leaves a generation whose child still runs - another host on the same session - untouched", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tos-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));
		const liveChild = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
		const owned = spawn("/bin/sleep", ["300"], { detached: true, stdio: "ignore" });
		const ownedPid = owned.pid ?? -1;
		killLater([liveChild.pid ?? -1, ownedPid]);
		const ledger = generationLedgerPath(dir, 4);
		await recordGenerationChild(dir, 4, liveChild.pid ?? -1);
		await writeFile(
			ledger,
			`${JSON.stringify({
				launchId: `W1-${ownedPid}`,
				generation: 4,
				origin: "tool",
				api: "cp.spawn",
				containment: "own-group",
				lifetime: "owned",
				pid: ownedPid,
				pgid: ownedPid,
				atMs: Date.now(),
				leaderStart: (await defaultGroupProbes.startOf(ownedPid)) ?? "",
			})}\n`,
		);
		expect(await sweepStaleGenerations(dir)).toEqual([]);
		expect(alive(ownedPid)).toBe(true);
		expect(await stat(ledger).then(() => "present")).toBe("present");
	}, 30_000);
});
