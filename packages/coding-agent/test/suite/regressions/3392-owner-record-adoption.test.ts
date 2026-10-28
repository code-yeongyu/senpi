import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// senpi#3392 / senpi#4645: the supervisor learns about a REPLACEMENT owner through an `fs.watch`
// event on owner.json, and node does not guarantee that event (senpi#4629 measured the loss on this
// machine class). With `watch` delivering nothing - exactly what a dropped event looks like - the
// exit decision must still adopt the record, so this file replaces it and nothing else.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, watch: () => ({ close: () => {}, once: () => {} }) };
});

/** The exit decision's own re-read of the record is the moment this regression is about. */
const recordReads = vi.hoisted(() => ({ count: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const readFile = ((path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
		if (String(path).endsWith("owner.json")) recordReads.count += 1;
		return (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest);
	}) as typeof actual.readFile;
	return { ...actual, readFile };
});

import type {
	SupervisorActivity,
	SupervisorOwner as SupervisorOwnerInstance,
} from "../../../src/modes/rpc/host-lifecycle-activity.ts";

const { OWNER_EXIT_GRACE_MS, SupervisorOwner } = await import("../../../src/modes/rpc/host-lifecycle-activity.ts");
const { writeHostOwner } = await import("../../../src/modes/rpc/host-daemon-state.ts");
const { readProcessIdentity } = await import("../../../src/utils/process-identity.ts");

const roots: string[] = [];
const children: ChildProcess[] = [];

/** The supervisor schedules its probe and its exit grace on `performance.now`, so the case owns it. */
let clockOffset = 0;
const realNow = performance.now.bind(performance);

beforeEach(() => {
	clockOffset = 0;
	vi.spyOn(performance, "now").mockImplementation(() => realNow() + clockOffset);
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** One tick: past the longest probe interval and the whole exit grace, with no wall-clock wait. */
function tick(): void {
	clockOffset += OWNER_EXIT_GRACE_MS + 10_000;
}

/** A real process to own the generation, with the OS start identity the product records. */
async function livingOwner(): Promise<{ child: ChildProcess; owner: { pid: number; startTime: string } }> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	children.push(child);
	const pid = child.pid;
	if (pid === undefined) throw new Error("owner process did not start");
	const observed = await readProcessIdentity(pid, process.platform, undefined, undefined, "UTC");
	if (observed.kind !== "present") throw new Error("owner identity unavailable");
	return { child, owner: { pid, startTime: observed.identity } };
}

/** Kills an owner and waits for the `exit` event, so the OS no longer reports it when probed. */
function kill(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		child.once("exit", () => resolve());
		child.kill("SIGKILL");
	});
}

function quiescentActivity(): SupervisorActivity {
	return { quiescent: () => true } as unknown as SupervisorActivity;
}

/**
 * Asks for the exit decision, advancing the supervisor's own clock between asks, until `until`
 * accepts the answer. Tick driven: no sleeps, and the case's timeout is never the thing that waits.
 */
async function decide(
	supervisor: SupervisorOwnerInstance,
	until: (decision: boolean) => boolean,
	what: string,
): Promise<boolean> {
	for (let asked = 0; asked < 50; asked += 1) {
		const decision = await supervisor.shouldExit(quiescentActivity());
		if (until(decision)) return decision;
		tick();
	}
	throw new Error(`the supervisor never ${what}`);
}

describe.skipIf(process.platform === "win32")("supervisor owner record adoption (#3392)", () => {
	it("adopts an owner record whose watch event never arrived, then exits when that owner dies", async () => {
		const generationDir = mkdtempSync(join(tmpdir(), "senpi-owner-adopt-"));
		roots.push(generationDir);
		const first = await livingOwner();
		await writeHostOwner(generationDir, first.owner);
		const supervisor = new SupervisorOwner(generationDir);
		await supervisor.start(undefined);
		expect(await supervisor.shouldExit(quiescentActivity())).toBe(false);

		// The replacement claims the generation; with no watch event, only the exit decision can see it.
		const replacement = await livingOwner();
		await writeHostOwner(generationDir, replacement.owner);
		await kill(first.child);

		// Drive past the owner probe and the exit grace, so the decision REACHES its record re-read
		// (senpi#4645): it finds the replacement there and refuses the exit the dead predecessor
		// would otherwise have authorized. Refusing is all the base did; adopting is the fix.
		const readsBefore = recordReads.count;
		expect(await decide(supervisor, () => recordReads.count > readsBefore, "re-read the owner record")).toBe(false);

		// Only an ADOPTED record lets the replacement's own death end the generation.
		await kill(replacement.child);
		expect(await decide(supervisor, (decision) => decision, "authorized the exit")).toBe(true);
		supervisor.stop();
	}, 30_000);

	it("never authorizes an exit while the adopted owner is alive", async () => {
		const generationDir = mkdtempSync(join(tmpdir(), "senpi-owner-adopt-"));
		roots.push(generationDir);
		const first = await livingOwner();
		await writeHostOwner(generationDir, first.owner);
		const supervisor = new SupervisorOwner(generationDir);
		await supervisor.start(undefined);

		const replacement = await livingOwner();
		await writeHostOwner(generationDir, replacement.owner);
		await kill(first.child);

		// Past the owner grace and several probe intervals, with the record adopted along the way:
		// a live owner is never permission to stop.
		const readsBefore = recordReads.count;
		for (let asked = 0; asked < 20; asked += 1) {
			expect(await supervisor.shouldExit(quiescentActivity())).toBe(false);
			tick();
		}
		expect(recordReads.count).toBeGreaterThan(readsBefore);
		supervisor.stop();
	}, 30_000);
});
