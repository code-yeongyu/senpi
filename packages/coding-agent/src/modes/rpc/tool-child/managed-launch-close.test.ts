// senpi#4230: a held bootstrap may not have installed its pipe reader yet.
import { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { prepareManagedLaunch } from "./managed-launch-process.ts";

const fixture = vi.hoisted(() => {
	const state: { child?: ChildProcess } = {};
	return state;
});
vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	return {
		...original,
		spawn: () => {
			if (fixture.child === undefined) throw new Error("bootstrap fixture missing");
			return fixture.child;
		},
	};
});

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("terminates an unreleased bootstrap without waiting for it to consume owner-pipe EOF", async () => {
	const dir = await mkdtemp(join(tmpdir(), "held-bootstrap-"));
	directories.push(dir);
	const child = new ChildProcess();
	Object.defineProperty(child, "pid", { value: 4321 });
	Object.defineProperty(child, "stdio", { value: [null, null, null, new Socket()] });
	const kill = vi.spyOn(child, "kill").mockImplementation((signal) => {
		child.emit("exit", null, signal);
		return true;
	});
	fixture.child = child;
	const held = await prepareManagedLaunch({
		command: "must-not-be-started",
		args: [],
		cwd: dir,
		env: {},
		logPath: join(dir, "output.log"),
	});

	const closed = held.close();
	try {
		expect(kill).toHaveBeenCalledWith("SIGKILL");
	} finally {
		// Settle the old implementation too: RED is the missing termination, never a lucky timeout.
		child.emit("exit", null, "SIGKILL");
		await closed;
	}
});
