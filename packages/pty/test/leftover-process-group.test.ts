import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LeftoverProcessGroup, stopLeftoverGroup } from "../src/process-tree.ts";

// senpi#6203 review: a recorded leftover pgid must not stay armed until some later stop call. POSIX never hands an
// id out as a pid while a process group with that id exists, so it can only be reused after the group empties; the
// record therefore probes on its own and disarms the moment the group is gone.

const PROBE_MS = 1000;
const posixIt = it.skipIf(process.platform === "win32");

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("LeftoverProcessGroup", () => {
	it("disarms within one probe interval after the group empties, with no stop call", () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		let members = true;
		const group = new LeftoverProcessGroup({ hasMembers: () => members, probeIntervalMs: PROBE_MS });

		group.arm(4242);
		expect(group.armedGroup).toBe(4242);
		members = false;
		vi.advanceTimersByTime(PROBE_MS - 1);
		expect(group.armedGroup).toBe(4242);
		vi.advanceTimersByTime(1);

		expect(group.armedGroup).toBeUndefined();
		// The probe clears itself on disarm: nothing is left ticking.
		expect(vi.getTimerCount()).toBe(0);
	});

	it("arms nothing, and starts no probe, for a group that is already empty", () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const group = new LeftoverProcessGroup({ hasMembers: () => false, probeIntervalMs: PROBE_MS });

		group.arm(4242);

		expect(group.armedGroup).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("after the disarm, stopping sends no signal at all", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		let members = true;
		const group = new LeftoverProcessGroup({ hasMembers: () => members, probeIntervalMs: PROBE_MS });
		group.arm(4242);
		members = false;
		vi.advanceTimersByTime(PROBE_MS);
		// The id now names a stranger's live group: no probe, no TERM, no KILL may reach it.
		members = true;
		const kill = vi.spyOn(process, "kill");

		expect(group.signal("SIGTERM")).toBeUndefined();
		await stopLeftoverGroup(
			{
				write: () => undefined,
				resize: () => undefined,
				kill: (signal) => {
					group.signal(signal ?? "SIGTERM");
					return undefined;
				},
				leftoverAlive: () => group.alive(),
				waitLeftoverGone: (graceMs) => group.waitGone(graceMs),
			},
			"SIGTERM",
			100,
			100,
		);

		expect(kill).not.toHaveBeenCalled();
	});

	posixIt("the default probe disarms a real group once its last member has exited and been reaped", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const leader = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
		const pgid = leader.pid;
		if (pgid === undefined) throw new Error("sleep did not start");
		const exited = once(leader, "exit");
		try {
			const group = new LeftoverProcessGroup({ probeIntervalMs: PROBE_MS });
			group.arm(pgid);
			expect(group.armedGroup).toBe(pgid);

			leader.kill("SIGKILL");
			// Node emits 'exit' after it reaped the child, so the group is empty from here.
			await exited;
			vi.advanceTimersByTime(PROBE_MS);

			expect(group.armedGroup).toBeUndefined();
		} finally {
			leader.kill("SIGKILL");
		}
	});
});
