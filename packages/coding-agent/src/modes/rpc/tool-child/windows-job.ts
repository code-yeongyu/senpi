/**
 * The Windows containment handle for one tool child generation (senpi#3566, plan todo 4): a Job Object the server
 * creates and keeps, so the child's process tree can be terminated even after the child itself is gone.
 *
 * The job is created with `KILL_ON_JOB_CLOSE | BREAKAWAY_OK`: closing the server's handle ends every member, and a
 * launch that explicitly asked to be detached can leave the job with `CREATE_BREAKAWAY_FROM_JOB`. Membership evidence
 * is creation-time (`command_started`); the process-id listing here only confirms, never refutes. kernel32 is reached
 * through `bun:ffi`, the same boundary `core/process-footprint.ts` uses; a host without it refuses `child` at startup.
 */

export const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0000_0800;
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
export const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
export const JOB_OBJECT_BASIC_PROCESS_ID_LIST_CLASS = 3;
/** `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` on a 64-bit Windows: 64-byte basic limits, 48-byte IO counters, 4 sizes. */
export const EXTENDED_LIMIT_INFORMATION_BYTES = 144;
/** `BasicLimitInformation.LimitFlags`: after two LARGE_INTEGER time limits. */
export const LIMIT_FLAGS_OFFSET = 16;
const PROCESS_ID_LIST_CAPACITY = 1024;
const PROCESS_ID_LIST_BYTES = 8 + PROCESS_ID_LIST_CAPACITY * 8;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

export interface Kernel32Job {
	CreateJobObjectW(attributes: null, name: null): unknown;
	SetInformationJobObject(job: unknown, infoClass: number, info: Uint8Array, length: number): number;
	QueryInformationJobObject(job: unknown, infoClass: number, info: Uint8Array, length: number, returned: null): number;
	OpenProcess(access: number, inherit: number, pid: number): unknown;
	AssignProcessToJobObject(job: unknown, process: unknown): number;
	IsProcessInJob(process: unknown, job: unknown, result: Uint8Array): number;
	TerminateJobObject(job: unknown, exitCode: number): number;
	CloseHandle(handle: unknown): number;
	GetLastError(): number;
	GetCurrentProcess(): unknown;
}

export class WindowsJobError extends Error {
	readonly code = "tool_child_job_assign_failed";
	readonly win32Error: number;
	constructor(step: string, win32Error: number) {
		super(`tool_child_job_assign_failed: ${step} failed (win32 error ${win32Error})`);
		this.name = "WindowsJobError";
		this.win32Error = win32Error;
	}
}

export function extendedLimitInformation(): Uint8Array {
	const info = new Uint8Array(EXTENDED_LIMIT_INFORMATION_BYTES);
	new DataView(info.buffer).setUint32(
		LIMIT_FLAGS_OFFSET,
		JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK,
		true,
	);
	return info;
}

export class WindowsJob {
	private closed = false;

	private readonly kernel: Kernel32Job;
	private readonly handle: unknown;

	private constructor(kernel: Kernel32Job, handle: unknown) {
		this.kernel = kernel;
		this.handle = handle;
	}

	static create(kernel: Kernel32Job): WindowsJob {
		const handle = kernel.CreateJobObjectW(null, null);
		if (!handle) throw new WindowsJobError("CreateJobObjectW", kernel.GetLastError());
		const info = extendedLimitInformation();
		if (
			kernel.SetInformationJobObject(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, info, info.byteLength) ===
			0
		) {
			const error = kernel.GetLastError();
			kernel.CloseHandle(handle);
			throw new WindowsJobError("SetInformationJobObject", error);
		}
		return new WindowsJob(kernel, handle);
	}

	assign(pid: number): void {
		const process = this.kernel.OpenProcess(
			PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
			0,
			pid,
		);
		if (!process) throw new WindowsJobError("OpenProcess", this.kernel.GetLastError());
		try {
			if (this.kernel.AssignProcessToJobObject(this.handle, process) === 0)
				throw new WindowsJobError("AssignProcessToJobObject", this.kernel.GetLastError());
			const inJob = new Uint8Array(4);
			if (
				this.kernel.IsProcessInJob(process, this.handle, inJob) === 0 ||
				new DataView(inJob.buffer).getInt32(0, true) === 0
			)
				throw new WindowsJobError("IsProcessInJob", this.kernel.GetLastError());
		} finally {
			this.kernel.CloseHandle(process);
		}
	}

	/** Confirmation only: a running pid listed here is a member; absence never proves a creation-time member left. */
	memberPids(): number[] {
		const list = new Uint8Array(PROCESS_ID_LIST_BYTES);
		if (
			this.kernel.QueryInformationJobObject(
				this.handle,
				JOB_OBJECT_BASIC_PROCESS_ID_LIST_CLASS,
				list,
				list.byteLength,
				null,
			) === 0
		)
			return [];
		const view = new DataView(list.buffer);
		const count = Math.min(view.getUint32(4, true), PROCESS_ID_LIST_CAPACITY);
		return Array.from({ length: count }, (_, index) => Number(view.getBigUint64(8 + index * 8, true)));
	}

	terminate(exitCode = 1): void {
		if (!this.closed) this.kernel.TerminateJobObject(this.handle, exitCode);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.kernel.CloseHandle(this.handle);
	}
}

interface BunFfi {
	dlopen(
		library: string,
		symbols: Record<string, { args: readonly string[]; returns: string }>,
	): { symbols: Record<string, (...args: unknown[]) => unknown> };
	ptr(value: Uint8Array): unknown;
}

export function loadKernel32Job(): Kernel32Job | undefined {
	if (process.platform !== "win32") return undefined;
	const ffi = process.getBuiltinModule("bun:ffi") as BunFfi | undefined;
	if (ffi === undefined) return undefined;
	const lib = ffi.dlopen("kernel32.dll", {
		CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
		SetInformationJobObject: { args: ["ptr", "i32", "ptr", "u32"], returns: "i32" },
		QueryInformationJobObject: { args: ["ptr", "i32", "ptr", "u32", "ptr"], returns: "i32" },
		OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
		AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
		IsProcessInJob: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
		TerminateJobObject: { args: ["ptr", "u32"], returns: "i32" },
		CloseHandle: { args: ["ptr"], returns: "i32" },
		GetLastError: { args: [], returns: "u32" },
		GetCurrentProcess: { args: [], returns: "ptr" },
	});
	const call = (name: string, ...args: unknown[]): unknown => {
		const fn = lib.symbols[name];
		if (fn === undefined) throw new Error(`kernel32 has no ${name}`);
		return fn(...args.map((arg) => (arg instanceof Uint8Array ? ffi.ptr(arg) : arg)));
	};
	return {
		CreateJobObjectW: () => call("CreateJobObjectW", null, null),
		SetInformationJobObject: (job, infoClass, info, length) =>
			Number(call("SetInformationJobObject", job, infoClass, info, length)),
		QueryInformationJobObject: (job, infoClass, info, length) =>
			Number(call("QueryInformationJobObject", job, infoClass, info, length, null)),
		OpenProcess: (access, inherit, pid) => call("OpenProcess", access, inherit, pid),
		AssignProcessToJobObject: (job, process) => Number(call("AssignProcessToJobObject", job, process)),
		IsProcessInJob: (process, job, result) => Number(call("IsProcessInJob", process, job, result)),
		TerminateJobObject: (job, exitCode) => Number(call("TerminateJobObject", job, exitCode)),
		CloseHandle: (handle) => Number(call("CloseHandle", handle)),
		GetLastError: () => Number(call("GetLastError")),
		GetCurrentProcess: () => call("GetCurrentProcess"),
	};
}

let defaultInJob: boolean | undefined;

/**
 * Whether this process runs inside any Job Object (`IsProcessInJob(GetCurrentProcess(), NULL)`). Off Windows, or
 * without bun:ffi, it is false: there is no job to be in. The answer for this host's own kernel is computed once.
 */
export function currentProcessInJob(kernel?: Kernel32Job): boolean {
	if (kernel !== undefined) return queryInJob(kernel);
	if (defaultInJob === undefined) {
		const loaded = loadKernel32Job();
		defaultInJob = loaded === undefined ? false : queryInJob(loaded);
	}
	return defaultInJob;
}

function queryInJob(kernel: Kernel32Job): boolean {
	const result = new Uint8Array(4);
	return (
		kernel.IsProcessInJob(kernel.GetCurrentProcess(), null, result) !== 0 &&
		new DataView(result.buffer).getInt32(0, true) !== 0
	);
}
