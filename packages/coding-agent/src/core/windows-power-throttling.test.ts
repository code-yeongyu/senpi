// senpi#6125: the EcoQoS opt-out's call shapes and install policy, against a fake kernel32 (any platform).
import { describe, expect, it, vi } from "vitest";
import {
	disableExecutionSpeedThrottling,
	installWindowsPowerThrottlingOptOut,
	type Kernel32PowerThrottling,
	PROCESS_POWER_THROTTLING_CLASS,
	PROCESS_QUERY_INFORMATION,
	PROCESS_SET_INFORMATION,
	readPowerThrottlingState,
	type SpawnSurfaces,
} from "./windows-power-throttling.ts";

interface Call {
	name: string;
	args: unknown[];
}

function fakeKernel(options: { openFails?: boolean; setFails?: boolean } = {}) {
	const calls: Call[] = [];
	const states = new Map<number, Uint8Array>();
	const kernel: Kernel32PowerThrottling = {
		OpenProcess: (access, inherit, pid) => {
			calls.push({ name: "OpenProcess", args: [access, inherit, pid] });
			return options.openFails ? null : { pid };
		},
		SetProcessInformation: (handle, infoClass, info, length) => {
			calls.push({ name: "SetProcessInformation", args: [handle, infoClass, Array.from(info), length] });
			if (options.setFails) return 0;
			states.set((handle as { pid: number }).pid, info.slice());
			return 1;
		},
		GetProcessInformation: (handle, infoClass, info, length) => {
			calls.push({ name: "GetProcessInformation", args: [handle, infoClass, length] });
			const stored = states.get((handle as { pid: number }).pid);
			if (stored !== undefined) info.set(stored);
			return 1;
		},
		CloseHandle: (handle) => {
			calls.push({ name: "CloseHandle", args: [handle] });
			return 1;
		},
		GetLastError: () => 5,
	};
	return { kernel, calls };
}

function fakeSurfaces(): SpawnSurfaces & { nextPid: number } {
	const surfaces = {
		nextPid: 4000,
		childProcessPrototype: {
			spawn(this: { pid?: number }): string {
				this.pid = surfaces.nextPid++;
				return "node-spawn-result";
			},
		},
		bun: {
			spawn(): { pid?: number } {
				return { pid: surfaces.nextPid++ };
			},
		},
	};
	return surfaces;
}

describe("disableExecutionSpeedThrottling", () => {
	it("sets ControlMask=EXECUTION_SPEED, StateMask=0 (version 1, 12 bytes) on a handle opened for that pid, then closes it", () => {
		const { kernel, calls } = fakeKernel();
		expect(disableExecutionSpeedThrottling(kernel, 1234)).toEqual({ ok: true });
		expect(calls.map((call) => call.name)).toEqual(["OpenProcess", "SetProcessInformation", "CloseHandle"]);
		expect(calls[0]?.args).toEqual([PROCESS_SET_INFORMATION, 0, 1234]);
		expect(calls[1]?.args).toEqual([
			{ pid: 1234 },
			PROCESS_POWER_THROTTLING_CLASS,
			[1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
			12,
		]);
	});

	it("reports the failing step with the win32 error and still closes the handle", () => {
		expect(disableExecutionSpeedThrottling(fakeKernel({ openFails: true }).kernel, 1)).toEqual({
			ok: false,
			step: "OpenProcess",
			win32Error: 5,
		});
		const failing = fakeKernel({ setFails: true });
		expect(disableExecutionSpeedThrottling(failing.kernel, 1)).toEqual({
			ok: false,
			step: "SetProcessInformation",
			win32Error: 5,
		});
		expect(failing.calls.at(-1)?.name).toBe("CloseHandle");
	});
});

describe("readPowerThrottlingState", () => {
	it("reads ControlMask and StateMask through a query handle", () => {
		const { kernel, calls } = fakeKernel();
		expect(readPowerThrottlingState(kernel, 7)).toEqual({ controlMask: 0, stateMask: 0 });
		disableExecutionSpeedThrottling(kernel, 7);
		expect(readPowerThrottlingState(kernel, 7)).toEqual({ controlMask: 1, stateMask: 0 });
		expect(calls[0]?.args).toEqual([PROCESS_QUERY_INFORMATION, 0, 7]);
	});
});

describe("installWindowsPowerThrottlingOptOut", () => {
	it("never loads kernel32 or patches a launcher off Windows", () => {
		for (const platform of ["linux", "darwin", "freebsd"] as const) {
			const load = vi.fn();
			const surfaces = fakeSurfaces();
			const spawn = surfaces.childProcessPrototype.spawn;
			expect(installWindowsPowerThrottlingOptOut({ platform, env: {}, load, surfaces })).toEqual({
				status: "skipped",
				reason: "not-windows",
			});
			expect(load).not.toHaveBeenCalled();
			expect(surfaces.childProcessPrototype.spawn).toBe(spawn);
		}
	});

	it("keeps Windows' default policy when SENPI_KEEP_POWER_THROTTLING=1", () => {
		const load = vi.fn();
		const result = installWindowsPowerThrottlingOptOut({
			platform: "win32",
			env: { SENPI_KEEP_POWER_THROTTLING: "1" },
			load,
			surfaces: fakeSurfaces(),
		});
		expect(result).toEqual({ status: "skipped", reason: "opted-out" });
		expect(load).not.toHaveBeenCalled();
	});

	it("skips without bun:ffi (Node) and patches nothing", () => {
		const surfaces = fakeSurfaces();
		const spawn = surfaces.childProcessPrototype.spawn;
		const result = installWindowsPowerThrottlingOptOut({
			platform: "win32",
			env: {},
			load: () => undefined,
			surfaces,
		});
		expect(result).toEqual({ status: "skipped", reason: "no-ffi" });
		expect(surfaces.childProcessPrototype.spawn).toBe(spawn);
	});

	it("opts itself out, then every child of both launchers right after its pid is known, and restores them", () => {
		const { kernel, calls } = fakeKernel();
		const surfaces = fakeSurfaces();
		const install = installWindowsPowerThrottlingOptOut({
			platform: "win32",
			env: { SENPI_KEEP_POWER_THROTTLING: "0" },
			pid: 99,
			load: () => kernel,
			surfaces,
		});
		if (install.status !== "installed") throw new Error(`not installed: ${install.reason}`);
		expect(install.self).toEqual({ ok: true });

		const child: { pid?: number } = {};
		expect(surfaces.childProcessPrototype.spawn.call(child)).toBe("node-spawn-result");
		const bunChild = surfaces.bun?.spawn();
		const optedOut = calls.filter((call) => call.name === "OpenProcess").map((call) => call.args[2]);
		expect(optedOut).toEqual([99, child.pid, bunChild?.pid]);
		expect(readPowerThrottlingState(kernel, child.pid ?? -1)).toEqual({ controlMask: 1, stateMask: 0 });

		install.restore();
		const before = calls.length;
		surfaces.childProcessPrototype.spawn.call({});
		surfaces.bun?.spawn();
		expect(calls.length).toBe(before);
	});

	it("never fails a launch whose child cannot be opened", () => {
		const surfaces = fakeSurfaces();
		const install = installWindowsPowerThrottlingOptOut({
			platform: "win32",
			env: {},
			load: () => fakeKernel({ openFails: true }).kernel,
			surfaces,
		});
		expect(install.status).toBe("installed");
		expect(surfaces.childProcessPrototype.spawn.call({})).toBe("node-spawn-result");
		expect(surfaces.bun?.spawn().pid).toBeGreaterThan(0);
	});
});
