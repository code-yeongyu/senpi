import { afterEach, describe, expect, it, vi } from "vitest";
import {
	killTrackedDetachedChildren,
	listTrackedDetachedChildren,
	noteDetachedChildExited,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../src/utils/shell.ts";

/**
 * Shutdown cleanup owns a detached child's whole process group, not its pid
 * ([#1697](https://github.com/code-yeongyu/senpi/issues/1697)): the leader may exit while the
 * descendants it backgrounded keep running in that group, and once the leader is gone its pid
 * may be recycled, so it must never be signalled directly.
 */

type KillCall = [number, NodeJS.Signals | number | undefined];

const ESRCH = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });

/** Install a fake `process.kill` and record every signal it is asked to deliver. */
function mockKill(behavior: (target: number, signal: NodeJS.Signals | number | undefined) => void): KillCall[] {
	const calls: KillCall[] = [];
	vi.spyOn(process, "kill").mockImplementation(((target: number, signal?: NodeJS.Signals | number) => {
		calls.push([target, signal]);
		behavior(target, signal);
		return true;
	}) as typeof process.kill);
	return calls;
}

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

afterEach(() => {
	vi.restoreAllMocks();
	if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	for (const entry of listTrackedDetachedChildren()) untrackDetachedChildPid(entry.pid);
});

describe("tracked detached children", () => {
	it("keeps owning the group when the leader exits with surviving members", () => {
		// The group still answers a probe, so the entry stays tracked as leader-exited.
		const calls = mockKill(() => {});
		trackDetachedChildPid(4242);

		noteDetachedChildExited(4242);

		expect(listTrackedDetachedChildren()).toEqual([{ pid: 4242, pgid: 4242, leaderExited: true }]);
		expect(calls).toEqual([[-4242, 0]]);

		killTrackedDetachedChildren();

		expect(calls).toContainEqual([-4242, "SIGKILL"]);
		// The leader is gone: its pid may already belong to an unrelated process.
		expect(calls.filter(([target]) => target === 4242)).toEqual([]);
		expect(listTrackedDetachedChildren()).toEqual([]);
	});

	it("drops the entry when the leader exits and its group is empty", () => {
		const calls = mockKill(() => {
			throw ESRCH;
		});
		trackDetachedChildPid(4243);

		noteDetachedChildExited(4243);

		expect(listTrackedDetachedChildren()).toEqual([]);
		expect(calls).toEqual([[-4243, 0]]);
	});

	it("prunes a drained group at shutdown instead of signalling its recycled pid", () => {
		const groupAlive = { value: true };
		const calls = mockKill((target) => {
			if (target < 0 && !groupAlive.value) throw ESRCH;
		});
		trackDetachedChildPid(4244);
		noteDetachedChildExited(4244);
		expect(listTrackedDetachedChildren()).toEqual([{ pid: 4244, pgid: 4244, leaderExited: true }]);

		// The last descendant exits between the shell's exit and shutdown.
		groupAlive.value = false;
		calls.length = 0;
		killTrackedDetachedChildren();

		expect(calls).toEqual([[-4244, 0]]);
		expect(listTrackedDetachedChildren()).toEqual([]);
	});

	it("keeps the group-then-pid fallback while the leader is still alive", () => {
		// Group signalling fails (the child never became a group leader), but the pid is
		// still ours, so the direct kill remains correct.
		const calls = mockKill((target) => {
			if (target < 0) throw ESRCH;
		});
		trackDetachedChildPid(4245);

		killTrackedDetachedChildren();

		expect(calls).toEqual([
			[-4245, 0],
			[4245, 0],
			[-4245, "SIGKILL"],
			[4245, "SIGKILL"],
		]);
		expect(listTrackedDetachedChildren()).toEqual([]);
	});

	it("still untracks on exit on win32, where there is no process group to own", () => {
		const calls = mockKill(() => {});
		setPlatform("win32");
		trackDetachedChildPid(4246);

		noteDetachedChildExited(4246);

		expect(listTrackedDetachedChildren()).toEqual([]);
		expect(calls).toEqual([]);
	});
});
