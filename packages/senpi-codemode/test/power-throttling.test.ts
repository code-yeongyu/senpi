// senpi#6125: the eval kernel realms' EcoQoS opt-out, against a fake kernel32 (any platform).
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
interface KernelPowerThrottling {
	OpenProcess(access: number, inherit: number, pid: number): unknown;
	SetProcessInformation(handle: unknown, infoClass: number, info: Uint8Array, length: number): number;
	CloseHandle(handle: unknown): number;
}
interface PowerThrottlingModule {
	disableExecutionSpeedThrottling(kernel: KernelPowerThrottling, pid: number): boolean;
	installKernelPowerThrottlingOptOut(options: object): {
		status: string;
		reason?: string;
		self?: boolean;
		restore?(): void;
	};
}

// The kernel entries import the plain-JS module (typed by power-throttling.d.ts); .ts files may not import .js, so it is
// loaded by URL.
const moduleUrl = pathToFileURL(join(process.cwd(), "src", "kernels", "js", "power-throttling.js")).href;
const { disableExecutionSpeedThrottling, installKernelPowerThrottlingOptOut } = (await import(
	moduleUrl
)) as PowerThrottlingModule;

function fakeKernel(options: { throws?: boolean } = {}) {
	const set: { pid: number; info: number[] }[] = [];
	const closed: number[] = [];
	const kernel: KernelPowerThrottling = {
		OpenProcess: (_access, _inherit, pid) => {
			if (options.throws) throw new Error("kernel32 has no OpenProcess");
			return { pid };
		},
		SetProcessInformation: (handle, infoClass, info, length) => {
			expect([infoClass, length]).toEqual([4, 12]);
			set.push({ pid: (handle as { pid: number }).pid, info: Array.from(info) });
			return 1;
		},
		CloseHandle: (handle) => {
			closed.push((handle as { pid: number }).pid);
			return 1;
		},
	};
	return { kernel, set, closed };
}

function surfaces() {
	let next = 500;
	return {
		childProcessPrototype: {
			spawn(this: { pid?: number }): string {
				this.pid = next++;
				return "spawned";
			},
		},
		bun: { spawn: (): { pid?: number } => ({ pid: next++ }) },
	};
}

describe("installKernelPowerThrottlingOptOut", () => {
	it("loads nothing off Windows or with SENPI_KEEP_POWER_THROTTLING=1", () => {
		const load = vi.fn();
		expect(installKernelPowerThrottlingOptOut({ platform: "linux", env: {}, load })).toEqual({
			status: "skipped",
			reason: "not-windows",
		});
		expect(
			installKernelPowerThrottlingOptOut({ platform: "win32", env: { SENPI_KEEP_POWER_THROTTLING: "1" }, load }),
		).toEqual({ status: "skipped", reason: "opted-out" });
		expect(load).not.toHaveBeenCalled();
	});

	it("opts the kernel process and every child of both launchers out with ControlMask=EXECUTION_SPEED, StateMask=0", () => {
		const { kernel, set, closed } = fakeKernel();
		const launchers = surfaces();
		const install = installKernelPowerThrottlingOptOut({
			platform: "win32",
			env: {},
			pid: 7,
			load: () => kernel,
			...launchers,
		});
		expect(install).toMatchObject({ status: "installed", self: true });
		const child: { pid?: number } = {};
		expect(launchers.childProcessPrototype.spawn.call(child)).toBe("spawned");
		const bunChild = launchers.bun.spawn();
		expect(set.map((entry) => entry.pid)).toEqual([7, child.pid, bunChild.pid]);
		expect(set[0]?.info).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
		expect(closed).toEqual([7, child.pid, bunChild.pid]);
		if (install.status === "installed") install.restore?.();
		launchers.childProcessPrototype.spawn.call({});
		expect(set).toHaveLength(3);
	});

	it("never turns a launch into an exception when kernel32 throws", () => {
		const launchers = surfaces();
		installKernelPowerThrottlingOptOut({
			platform: "win32",
			env: {},
			load: () => fakeKernel({ throws: true }).kernel,
			...launchers,
		});
		expect(launchers.childProcessPrototype.spawn.call({})).toBe("spawned");
		expect(launchers.bun.spawn().pid).toBeGreaterThan(0);
		expect(disableExecutionSpeedThrottling(fakeKernel({ throws: true }).kernel, 1)).toBe(false);
	});
});
