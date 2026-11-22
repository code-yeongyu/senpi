// senpi#6125: the EcoQoS opt-out against the real kernel32 (runs in the Windows CI job, skipped with a reason elsewhere).
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
	installWindowsPowerThrottlingOptOut,
	loadKernel32PowerThrottling,
	PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
	type PowerThrottlingInstall,
	readPowerThrottlingState,
} from "./windows-power-throttling.ts";

const kernel = loadKernel32PowerThrottling();
const reason = process.platform !== "win32" ? "not win32" : kernel === undefined ? "bun:ffi unavailable" : undefined;
const moduleUrl = new URL("./windows-power-throttling.ts", import.meta.url).href;

const children: ChildProcess[] = [];
const bunChildren: { kill(): void; exited: Promise<number> }[] = [];
let install: PowerThrottlingInstall | undefined;

afterEach(async () => {
	if (install?.status === "installed") install.restore();
	install = undefined;
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill();
			await exited;
		}
	}
	for (const child of bunChildren.splice(0)) {
		child.kill();
		await child.exited;
	}
});

function idleChild(env: NodeJS.ProcessEnv = process.env): ChildProcess {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", env });
	children.push(child);
	return child;
}

/** A child that runs the opt-out itself, as a senpi entry does at startup, and reports the install status. */
async function startupChild(env: NodeJS.ProcessEnv): Promise<{ pid: number; status: string }> {
	const script = `import(${JSON.stringify(moduleUrl)}).then((m) => { const r = m.installWindowsPowerThrottlingOptOut(); process.stdout.write(r.status + ":" + (r.reason ?? "") + "\\n"); setInterval(() => {}, 1000); });`;
	const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"], env });
	children.push(child);
	const [line] = (await once(child.stdout ?? child, "data")) as [Buffer];
	return { pid: child.pid ?? -1, status: line.toString().trim() };
}

const executionSpeed = (pid: number) => {
	if (kernel === undefined) throw new Error("unreachable");
	const state = readPowerThrottlingState(kernel, pid);
	return {
		control: state.controlMask & PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
		state: state.stateMask & PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
	};
};

describe.skipIf(reason !== undefined)(`EcoQoS opt-out on kernel32${reason ? ` (skipped: ${reason})` : ""}`, () => {
	it("a child started without the hook stays on Windows' automatic policy (ControlMask=0)", () => {
		const child = idleChild();
		expect(executionSpeed(child.pid ?? -1)).toEqual({ control: 0, state: 0 });
	});

	it("opts this process out and every node:child_process and Bun.spawn child: ControlMask=EXECUTION_SPEED, StateMask=0", () => {
		install = installWindowsPowerThrottlingOptOut();
		expect(install.status).toBe("installed");
		if (install.status === "installed") expect(install.self).toEqual({ ok: true });
		expect(executionSpeed(process.pid)).toEqual({ control: 1, state: 0 });

		const nodeChild = idleChild();
		expect(executionSpeed(nodeChild.pid ?? -1)).toEqual({ control: 1, state: 0 });

		const bun = (
			globalThis as {
				Bun?: { spawn(cmd: string[], options: object): { pid: number; kill(): void; exited: Promise<number> } };
			}
		).Bun;
		if (bun === undefined) throw new Error("the Windows job runs this file under Bun");
		const bunChild = bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		bunChildren.push(bunChild);
		expect(executionSpeed(bunChild.pid)).toEqual({ control: 1, state: 0 });
	});

	it("a process that runs the startup opt-out leaves automatic throttling; SENPI_KEEP_POWER_THROTTLING=1 keeps it", async () => {
		const optedOut = await startupChild({ ...process.env, SENPI_KEEP_POWER_THROTTLING: "" });
		expect(optedOut.status).toBe("installed:");
		expect(executionSpeed(optedOut.pid)).toEqual({ control: 1, state: 0 });

		const kept = await startupChild({ ...process.env, SENPI_KEEP_POWER_THROTTLING: "1" });
		expect(kept.status).toBe("skipped:opted-out");
		expect(executionSpeed(kept.pid)).toEqual({ control: 0, state: 0 });
	});
});
