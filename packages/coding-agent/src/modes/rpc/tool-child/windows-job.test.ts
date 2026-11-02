// senpi#3566 todo 4: the Job Object's limit flags and assignment proof, checked against a recorded kernel32.
import { describe, expect, it } from "vitest";
import {
	currentProcessInJob,
	EXTENDED_LIMIT_INFORMATION_BYTES,
	JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
	type Kernel32Job,
	LIMIT_FLAGS_OFFSET,
	WindowsJob,
	WindowsJobError,
} from "./windows-job.ts";

function recordedKernel(overrides: Partial<Kernel32Job> = {}) {
	const calls: string[] = [];
	let limits: Uint8Array | undefined;
	const kernel: Kernel32Job = {
		CreateJobObjectW: () => {
			calls.push("CreateJobObjectW");
			return "job";
		},
		SetInformationJobObject: (_job, infoClass, info, length) => {
			calls.push(`SetInformationJobObject:${infoClass}:${length}`);
			limits = info.slice();
			return 1;
		},
		QueryInformationJobObject: (_job, _cls, info) => {
			const view = new DataView(info.buffer);
			view.setUint32(0, 2, true);
			view.setUint32(4, 2, true);
			view.setBigUint64(8, 101n, true);
			view.setBigUint64(16, 202n, true);
			return 1;
		},
		OpenProcess: (_access, _inherit, pid) => {
			calls.push(`OpenProcess:${pid}`);
			return `proc${pid}`;
		},
		AssignProcessToJobObject: () => {
			calls.push("Assign");
			return 1;
		},
		IsProcessInJob: (_process, _job, result) => {
			calls.push("IsProcessInJob");
			new DataView(result.buffer).setInt32(0, 1, true);
			return 1;
		},
		TerminateJobObject: (_job, code) => {
			calls.push(`Terminate:${code}`);
			return 1;
		},
		CloseHandle: (handle) => {
			calls.push(`Close:${String(handle)}`);
			return 1;
		},
		GetLastError: () => 5,
		GetCurrentProcess: () => "self",
		...overrides,
	};
	return { kernel, calls, limits: () => limits };
}

describe("WindowsJob", () => {
	it("creates the job with KILL_ON_JOB_CLOSE and BREAKAWAY_OK in the extended limits", () => {
		const { kernel, calls, limits } = recordedKernel();
		WindowsJob.create(kernel);
		expect(calls).toEqual([
			"CreateJobObjectW",
			`SetInformationJobObject:${JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS}:${EXTENDED_LIMIT_INFORMATION_BYTES}`,
		]);
		const info = limits();
		expect(info?.byteLength).toBe(144);
		expect(new DataView((info ?? new Uint8Array(144)).buffer).getUint32(LIMIT_FLAGS_OFFSET, true)).toBe(0x2800);
	});

	it("assigns a pid, proves it with IsProcessInJob, and closes the process handle", () => {
		const { kernel, calls } = recordedKernel();
		WindowsJob.create(kernel).assign(42);
		expect(calls.slice(2)).toEqual(["OpenProcess:42", "Assign", "IsProcessInJob", "Close:proc42"]);
	});

	it("fails the assignment when IsProcessInJob reports the process outside the job", () => {
		const { kernel, calls } = recordedKernel({ IsProcessInJob: () => 1 });
		expect(() => WindowsJob.create(kernel).assign(42)).toThrow(WindowsJobError);
		expect(calls.at(-1)).toBe("Close:proc42");
	});

	it("closes the job handle when the limits cannot be set", () => {
		const { kernel, calls } = recordedKernel({ SetInformationJobObject: () => 0 });
		expect(() => WindowsJob.create(kernel)).toThrow(/SetInformationJobObject failed \(win32 error 5\)/);
		expect(calls).toEqual(["CreateJobObjectW", "Close:job"]);
	});

	it("lists member pids, terminates, and closes once", () => {
		const { kernel, calls } = recordedKernel();
		const job = WindowsJob.create(kernel);
		expect(job.memberPids()).toEqual([101, 202]);
		job.terminate(9);
		job.close();
		job.close();
		job.terminate();
		expect(calls.slice(2)).toEqual(["Terminate:9", "Close:job"]);
	});

	it("reports whether this process is in a job, from IsProcessInJob on the current process", () => {
		const answer = (inside: boolean) =>
			recordedKernel({
				IsProcessInJob: (process, job, result) => {
					new DataView(result.buffer).setInt32(0, inside && process === "self" && job === null ? 1 : 0, true);
					return 1;
				},
			}).kernel;
		expect(currentProcessInJob(answer(true))).toBe(true);
		expect(currentProcessInJob(answer(false))).toBe(false);
	});
});
