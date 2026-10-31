/**
 * How a tool child's whole tree is held and ended (senpi#3566, plan todo 4). POSIX: the child leads its own process
 * group, signalled as one. Windows: the child is assigned to its generation's Job Object right after spawn - before it
 * can send `hello` - and membership is confirmed with `IsProcessInJob`; ending the tree terminates the job.
 */
import type { ChildProcess } from "node:child_process";
import { TOOL_RUNTIME_UNSUPPORTED_HOST } from "../../../cli/tool-runtime.ts";
import { type Kernel32Job, loadKernel32Job, WindowsJob, WindowsJobError } from "./windows-job.ts";

export interface ChildContainment {
	readonly kind: "process-group" | "job";
	/** Ends the child and everything it started (its group, or every job member). */
	kill(): void;
	/** Releases the handle; the job's kill-on-close ends any member still running. */
	close(): void;
	/** Windows: whether a running pid is listed in the job right now (confirmation only, never a refutation). */
	readonly isMember?: (pid: number) => boolean;
}

export interface ContainmentHost {
	readonly platform: NodeJS.Platform;
	readonly loadKernel: () => Kernel32Job | undefined;
}

const DEFAULT_HOST: ContainmentHost = { platform: process.platform, loadKernel: loadKernel32Job };

export class ChildContainmentError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "ChildContainmentError";
		this.code = code;
	}
}

export function containChild(child: ChildProcess, host: ContainmentHost = DEFAULT_HOST): ChildContainment {
	const pid = child.pid;
	if (pid === undefined) throw new ChildContainmentError("tool_child_bootstrap_failed", "the tool child has no pid");
	if (host.platform !== "win32") return processGroup(pid);
	const kernel = host.loadKernel();
	if (kernel === undefined)
		throw new ChildContainmentError(
			TOOL_RUNTIME_UNSUPPORTED_HOST,
			"Windows tool children need bun:ffi for their Job Object",
		);
	const job = WindowsJob.create(kernel);
	try {
		job.assign(pid);
	} catch (error) {
		job.terminate();
		job.close();
		if (error instanceof WindowsJobError) throw new ChildContainmentError(error.code, error.message);
		throw error;
	}
	return {
		kind: "job",
		kill: () => job.terminate(),
		close: () => job.close(),
		isMember: (pid) => job.memberPids().includes(pid),
	};
}

function processGroup(pid: number): ChildContainment {
	return {
		kind: "process-group",
		kill: () => {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// The group is already gone.
			}
		},
		close: () => {},
	};
}
