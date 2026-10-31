import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hostCliSandbox, sweepHostCliSandboxes } from "./host-cli-support.ts";

const mocks = vi.hoisted(() => ({
	stop: vi.fn(),
	reap: vi.fn(),
	watch: vi.fn(),
	exits: new Map<number, Promise<unknown>>(),
}));
vi.mock("../../src/modes/rpc/host-stop.ts", () => ({ stopHost: mocks.stop }));
vi.mock("../helpers/spawned-host-reaper.ts", () => ({
	reapProcessesUnder: mocks.reap,
	waitForPidGone: vi.fn(async () => true),
}));
vi.mock("../helpers/windows-daemon-exit.ts", () => ({ waitForWindowsDaemonExit: mocks.watch }));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
beforeEach(() => {
	mocks.stop.mockReset().mockResolvedValue({ action: "refuse", reason: "unknown_owner" });
	mocks.reap.mockReset().mockResolvedValue([]);
	mocks.watch.mockReset().mockImplementation(async (pid: number, stop: () => Promise<void>) => {
		const exit = mocks.exits.get(pid);
		if (!exit) throw new Error("fixture has no owned child exit signal");
		await stop();
		await exit;
	});
});
afterEach(async () => {
	if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
	await sweepHostCliSandboxes();
	mocks.exits.clear();
});

it("awaits the test-owned Windows pid even when registration identity is unknown (#3064)", async () => {
	const sandbox = Object.assign(await hostCliSandbox("owned-pid"), { ownedPids: new Set<number>() });
	const child = spawn(process.execPath, ["-e", "process.send('ready'); process.on('message', () => {});"], {
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	const closed = once(child, "close");
	try {
		await once(child, "message", { signal: AbortSignal.timeout(10_000) });
		const pid = child.pid;
		if (pid === undefined) throw new Error("fixture did not spawn");
		mocks.exits.set(pid, closed);
		Object.defineProperty(process, "platform", { value: "win32" });
		// Same ownership receipt that runHostCli captures from ensure --json.
		sandbox.ownedPids.add(pid);
		await sweepHostCliSandboxes();
		expect(() => process.kill(pid, 0)).toThrow();
		expect(existsSync(sandbox.root)).toBe(false);
		expect(mocks.watch).toHaveBeenCalledOnce();
		expect(mocks.stop).not.toHaveBeenCalled();
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await closed;
		await rm(sandbox.root, { recursive: true, force: true });
	}
});

it("reaps POSIX sandboxes and continues after each stop error (#3064)", async () => {
	const first = await hostCliSandbox("first-error");
	const second = await hostCliSandbox("second-error");
	const third = await hostCliSandbox("after-errors");
	mocks.stop
		.mockRejectedValueOnce(new Error("first stop failed"))
		.mockRejectedValueOnce(new Error("second stop failed"));
	Object.defineProperty(process, "platform", { value: "linux" });
	try {
		await expect(sweepHostCliSandboxes()).rejects.toMatchObject({
			errors: [
				expect.objectContaining({ message: "first stop failed" }),
				expect.objectContaining({ message: "second stop failed" }),
			],
		});
		expect(mocks.stop).toHaveBeenCalledTimes(3);
		expect(mocks.reap.mock.calls.map(([root]) => root)).toEqual([first.root, second.root, third.root]);
		expect(existsSync(third.root)).toBe(false);
	} finally {
		await Promise.all([first, second, third].map(({ root }) => rm(root, { recursive: true, force: true })));
	}
});

it.skipIf(process.platform === "win32")(
	"awaits an unregistered POSIX sandbox child before removing its root (#3064)",
	async () => {
		const reaper = await vi.importActual<typeof import("../helpers/spawned-host-reaper.ts")>(
			"../helpers/spawned-host-reaper.ts",
		);
		mocks.reap.mockImplementation(reaper.reapProcessesUnder);
		const sandbox = await hostCliSandbox("unregistered-child");
		const child = spawn(
			process.execPath,
			["-e", "process.send('ready'); process.on('message', () => {});", sandbox.root],
			{
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			},
		);
		const closed = once(child, "close");
		try {
			await once(child, "message", { signal: AbortSignal.timeout(10_000) });
			const pid = child.pid;
			if (pid === undefined) throw new Error("fixture did not spawn");
			await sweepHostCliSandboxes();
			await closed;
			expect(() => process.kill(pid, 0)).toThrow();
			expect(existsSync(sandbox.root)).toBe(false);
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await closed;
			await rm(sandbox.root, { recursive: true, force: true });
		}
	},
);
