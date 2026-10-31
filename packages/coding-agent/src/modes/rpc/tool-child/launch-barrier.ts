/**
 * Ack-gated launch paths for the tool child's own (main-thread) launches (senpi#3566, plan todo 4).
 *
 * `launchOwnGroup` (POSIX; `lifetime: "detached"` for an explicitly detached launch) starts the go-line shim
 * (`go-shim.ts`), which leads a new process group and blocks on a go-line read from a control descriptor (it exits 127 if
 * that closes first, e.g. when the child died); stdin stays the caller's. Its pid and group are sent as the containment
 * handle; only after the server acknowledged does the gate store the invoke tick and write the go-line, and only then
 * does the shim `exec` the real command, keeping pid and group. `gateInherited` is the same barrier for a call that stays in the child's own group: wait for the ack, record
 * the invoke tick, then call. Kernel-worker launches and Windows breakaway launches live in their own modules.
 */
import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { once } from "node:events";
import { Socket } from "node:net";
import { controlFd, goShimScript, withControlPipe } from "./go-shim.ts";
import type { LaunchGate } from "./launch-gate.ts";
import type { LaunchApi, LaunchOrigin } from "./protocol.ts";

export interface GatedChild {
	readonly launchId: string;
	readonly child: ChildProcess;
	readonly exited: Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>;
}

export interface OwnGroupLaunch {
	readonly gate: LaunchGate;
	readonly jobId: string;
	readonly origin: LaunchOrigin;
	readonly api: LaunchApi;
	readonly program: string;
	readonly args: readonly string[];
	readonly options?: Omit<SpawnOptions, "detached" | "stdio"> & {
		readonly stdio?: readonly [
			"pipe" | "ignore" | "inherit",
			"pipe" | "ignore" | "inherit",
			"pipe" | "ignore" | "inherit",
		];
	};
	readonly lifetime?: "owned" | "detached";
}

export async function launchOwnGroup(launch: OwnGroupLaunch): Promise<GatedChild> {
	if (process.platform === "win32")
		throw new Error("launchOwnGroup is POSIX-only; Windows launches are contained by the job");
	const callerStdio = [...(launch.options?.stdio ?? ["ignore", "pipe", "pipe"])];
	const fd = controlFd(callerStdio);
	const shim = spawn("/bin/sh", ["-c", goShimScript(fd), launch.program, ...launch.args], {
		...launch.options,
		detached: true,
		stdio: withControlPipe<"pipe" | "ignore" | "inherit">(callerStdio, fd, "ignore", "pipe"),
	});
	const pid = shim.pid;
	const exited = once(shim, "exit").then(([exitCode, signal]) => ({
		exitCode: exitCode as number | null,
		signal: signal as NodeJS.Signals | null,
	}));
	if (pid === undefined) throw new Error(`could not start ${launch.program}`);
	const gated = launch.gate.request({
		jobId: launch.jobId,
		origin: launch.origin,
		api: launch.api,
		containment: "own-group",
		lifetime: launch.lifetime ?? "owned",
		pid,
		pgid: pid,
	});
	void exited.then(({ exitCode, signal }) =>
		launch.gate.done(gated.launchId, {
			...(exitCode === null ? {} : { exitCode }),
			...(signal === null ? {} : { signal }),
		}),
	);
	if (!launch.gate.skipsAckWait) await Promise.race([gated.acked, exited]);
	if (shim.exitCode === null && shim.signalCode === null) {
		launch.gate.invokeNow(gated.launchId);
		const control: unknown = shim.stdio[fd];
		if (control instanceof Socket) {
			control.on("error", () => {});
			void exited.then(() => control.destroy());
			control.unref();
			control.write("go\n");
		}
	}
	return { launchId: gated.launchId, child: shim, exited };
}

/** A call that stays in the child's own group: ack first, then the invoke tick, then the call. */
export async function gateInherited<T>(
	gate: LaunchGate,
	request: { readonly jobId: string; readonly origin: LaunchOrigin; readonly api: LaunchApi },
	call: () => T,
): Promise<{ readonly launchId: string; readonly value: T }> {
	const gated = gate.request({ ...request, containment: "inherited", lifetime: "owned" });
	if (!gate.skipsAckWait) await gated.acked;
	gate.invokeNow(gated.launchId);
	return { launchId: gated.launchId, value: call() };
}
