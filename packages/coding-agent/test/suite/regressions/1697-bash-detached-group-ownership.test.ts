import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createLocalBashOperations } from "../../../src/core/tools/bash.ts";
import { killTrackedDetachedChildren, listTrackedDetachedChildren } from "../../../src/utils/shell.ts";

/**
 * A shell that exits while it still owns background descendants
 * ([#1697](https://github.com/code-yeongyu/senpi/issues/1697)): `sleep 30 &` keeps running in
 * the shell's process group after `bash -c` returns, so shutdown cleanup must still own that
 * group instead of forgetting it the moment the leader exits.
 */

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM proves the process exists under another uid; only ESRCH proves it is gone.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** SIGKILL delivery and reaping are kernel events with no in-process signal to await, so this
 * real OS boundary is polled under an explicit deadline. */
async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (isAlive(pid)) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return true;
}

describe.skipIf(process.platform === "win32")("bash process-group ownership outlives the shell", () => {
	it("still kills a backgrounded descendant after the shell that started it exited", async () => {
		const ops = createLocalBashOperations();
		let output = "";

		// `$!` is the backgrounded sleep, `$$` the shell itself (the detached group leader).
		const { exitCode } = await ops.exec('sleep 30 & echo "$! $$"', tmpdir(), {
			onData: (data) => {
				output += data.toString();
			},
		});

		expect(exitCode).toBe(0);
		const [sleepPid, shellPid] = output.trim().split(/\s+/).map(Number);
		expect(Number.isInteger(sleepPid)).toBe(true);
		expect(Number.isInteger(shellPid)).toBe(true);

		try {
			expect(isAlive(sleepPid)).toBe(true);
			expect(listTrackedDetachedChildren()).toContainEqual({
				pid: shellPid,
				pgid: shellPid,
				leaderExited: true,
			});

			killTrackedDetachedChildren();

			expect(await waitUntilGone(sleepPid, 5_000)).toBe(true);
			expect(listTrackedDetachedChildren()).toEqual([]);
		} finally {
			try {
				process.kill(sleepPid, "SIGKILL");
			} catch {
				// Already dead: the assertions above are what this test is about.
			}
		}
	});
});
