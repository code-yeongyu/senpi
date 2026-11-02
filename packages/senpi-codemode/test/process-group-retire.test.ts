import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// The worker imports this plain-JS module; .ts files may not import .js, so it is loaded by URL.
const processTreeUrl = pathToFileURL(join(process.cwd(), "src", "kernels", "js", "process-tree.js")).href;
type CellProcessGroup = { readonly pgid: number; readonly leaderExited: boolean };
type Retire = (groups: readonly CellProcessGroup[], options: { readonly graceMs: number }) => Promise<void>;
let terminateProcessGroups: Retire = async () => {
	throw new Error("process-tree.js not loaded");
};

beforeAll(async () => {
	const loaded: unknown = await import(processTreeUrl);
	if (
		typeof loaded !== "object" ||
		loaded === null ||
		!("terminateProcessGroups" in loaded) ||
		typeof loaded.terminateProcessGroups !== "function"
	) {
		throw new Error("process-tree.js does not export terminateProcessGroups");
	}
	const retire = loaded.terminateProcessGroups;
	terminateProcessGroups = async (groups, options) => {
		await retire(groups, options);
	};
});

const leaders: ChildProcess[] = [];

afterEach(() => {
	for (const leader of leaders.splice(0)) {
		if (leader.pid !== undefined) {
			try {
				process.kill(-leader.pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
	}
});

function ownProcessGroup(): number {
	return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
}

async function groupLeader(): Promise<number> {
	const leader = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	leaders.push(leader);
	await once(leader, "spawn");
	if (leader.pid === undefined) throw new Error("sleep did not start");
	return leader.pid;
}

// Membership checks (signal 0) reach the real kernel; every other signal is only recorded, so nothing is stopped.
async function recordedSignals(groups: readonly CellProcessGroup[]): Promise<Array<readonly [number, string]>> {
	const signals: Array<readonly [number, string]> = [];
	const realKill = process.kill;
	process.kill = ((pid: number, signal?: string | number) => {
		if (signal === 0) return realKill.call(process, pid, 0);
		signals.push([pid, String(signal)]);
		return true;
	}) as typeof process.kill;
	try {
		await terminateProcessGroups(groups, { graceMs: 50 });
	} finally {
		process.kill = realKill;
	}
	return signals;
}

describe.skipIf(process.platform === "win32")("cell process-group retirement (senpi#3020)", () => {
	it("Given the agent's own process group in the list when groups are retired then it is never signalled", async () => {
		// when
		const signals = await recordedSignals([{ pgid: ownProcessGroup(), leaderExited: false }]);

		// then
		expect(signals).toEqual([]);
	});

	it("Given a cell child's live group when groups are retired then it gets SIGTERM and then SIGKILL", async () => {
		// given
		const pgid = await groupLeader();

		// when
		const signals = await recordedSignals([{ pgid, leaderExited: false }]);

		// then
		expect(signals).toEqual([
			[-pgid, "SIGTERM"],
			[-pgid, "SIGKILL"],
		]);
	});

	it("Given a recorded leader that exited and a live process now holding its pid when groups are retired then that group is left alone", async () => {
		// given
		const reusedPid = await groupLeader();

		// when
		const signals = await recordedSignals([{ pgid: reusedPid, leaderExited: true }]);

		// then
		expect(signals).toEqual([]);
	});
});
