import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// senpi#3392: the supervisor learns about a REPLACEMENT owner through an `fs.watch` event on
// owner.json, and node does not guarantee that event (senpi#4629 measured the loss on this machine
// class). With `watch` delivering nothing - exactly what a dropped event looks like - the exit
// decision must still adopt the record, so this file replaces it and nothing else.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, watch: () => ({ close: () => {}, once: () => {} }) };
});

import type {
	SupervisorActivity,
	SupervisorOwner as SupervisorOwnerInstance,
} from "../../../src/modes/rpc/host-lifecycle-activity.ts";

const { SupervisorOwner } = await import("../../../src/modes/rpc/host-lifecycle-activity.ts");
const { callerHostOwner, writeHostOwner } = await import("../../../src/modes/rpc/host-daemon-state.ts");
const { readProcessIdentity } = await import("../../../src/utils/process-identity.ts");

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

function quiescentActivity(): SupervisorActivity {
	return { quiescent: () => true } as unknown as SupervisorActivity;
}

/** The decider needs continuous quiet; ask until it settles or the case's own timeout ends it. */
async function exitsEventually(owner: SupervisorOwnerInstance): Promise<boolean> {
	for (;;) {
		if (await owner.shouldExit(quiescentActivity())) return true;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
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
		first.child.kill("SIGKILL");
		expect(await supervisor.shouldExit(quiescentActivity())).toBe(false);

		replacement.child.kill("SIGKILL");
		await expect(exitsEventually(supervisor)).resolves.toBe(true);
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
		first.child.kill("SIGKILL");

		// Past the owner grace and several probe intervals: a live owner is never permission to stop.
		const deadline = Date.now() + 8_000;
		while (Date.now() < deadline) {
			expect(await supervisor.shouldExit(quiescentActivity())).toBe(false);
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		supervisor.stop();
	}, 30_000);

	it("keeps the caller's own identity readable for the records this adoption compares", async () => {
		const owner = await callerHostOwner();
		expect(owner.pid).toBe(process.pid);
		expect(owner.startTime.length).toBeGreaterThan(0);
	}, 20_000);
});
