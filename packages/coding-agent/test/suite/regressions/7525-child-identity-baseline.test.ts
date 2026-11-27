import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { HostChildIdentity, signalProvenChild } from "../../../src/modes/rpc/host-child-identity.ts";

// senpi#7525 delta review: on macOS the child's start baseline once came only from the child-record write, so a failed
// write left every later check `unknown` and an ordinary stop of a healthy child sent no signal. The identity now
// owns its baseline: a live read of a non-zombie process whose parent is this process adopts it. Both clocks run here
// (`ps` is the macOS clock and also answers on Linux); no metadata file is involved at all.
const children: ChildProcess[] = [];
afterEach(() => {
	for (const child of children.splice(0))
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

/** A live child of this process that exits only on a signal; stdin is held open so it never ends on its own. */
async function liveChild(): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdout.write('up\\n')"], {
		stdio: ["pipe", "pipe", "ignore"],
	});
	children.push(child);
	await once(child.stdout, "data");
	return child;
}

const clocks = process.platform === "linux" ? (["linux", "darwin"] as const) : (["darwin"] as const);

describe.skipIf(process.platform === "win32").each(clocks)("host child identity on the %s clock", (clock) => {
	it("proves a live child with no recorded baseline, and an ordinary stop terminates it", async () => {
		const child = await liveChild();
		const identity = new HostChildIdentity(child.pid, clock);
		const exited = once(child, "exit");

		expect(await identity.presence()).toBe("ours");
		expect(await signalProvenChild(child, identity, "SIGTERM")).toBe("ours");
		expect(await exited).toEqual([null, "SIGTERM"]);
	});

	it("never claims a process that is not its child", async () => {
		const stranger = new HostChildIdentity(process.pid, clock);
		expect(await stranger.presence()).toBe("gone");
	});
});
