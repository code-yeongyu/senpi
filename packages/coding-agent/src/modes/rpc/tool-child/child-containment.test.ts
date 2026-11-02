// senpi#3566 todo 4 (Windows half): how a tool child is held. The kernel is a recording fake, so the Windows decisions
// are checked on every OS; the real Job Object behavior is covered by the win32 tests on Windows CI.
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ChildContainmentError, containChild } from "./child-containment.ts";
import type { Kernel32Job } from "./windows-job.ts";

const child = (pid: number | undefined) => ({ pid }) as ChildProcess;

function fakeKernel(options: { assign?: boolean; inJob?: boolean } = {}) {
	const calls: string[] = [];
	const kernel: Kernel32Job = {
		CreateJobObjectW: () => {
			calls.push("create");
			return 1;
		},
		SetInformationJobObject: () => 1,
		QueryInformationJobObject: () => 0,
		OpenProcess: (_access, _inherit, pid) => {
			calls.push(`open:${pid}`);
			return 2;
		},
		AssignProcessToJobObject: () => {
			calls.push("assign");
			return options.assign === false ? 0 : 1;
		},
		IsProcessInJob: (_process, _job, result) => {
			new DataView(result.buffer).setInt32(0, options.inJob === false ? 0 : 1, true);
			return 1;
		},
		TerminateJobObject: () => {
			calls.push("terminate");
			return 1;
		},
		CloseHandle: (handle) => {
			calls.push(`close:${String(handle)}`);
			return 1;
		},
		GetLastError: () => 5,
		GetCurrentProcess: () => 0,
	};
	return { kernel, calls };
}

describe("containChild", () => {
	it("holds a POSIX child by its process group and never loads a kernel", () => {
		let loaded = false;
		const held = containChild(child(4242), {
			platform: "darwin",
			loadKernel: () => {
				loaded = true;
				return undefined;
			},
		});
		expect(held.kind).toBe("process-group");
		expect(loaded).toBe(false);
	});

	it("puts a Windows child into a fresh job and confirms membership before returning", () => {
		const { kernel, calls } = fakeKernel();
		const held = containChild(child(4242), { platform: "win32", loadKernel: () => kernel });
		expect(held.kind).toBe("job");
		expect(calls).toEqual(["create", "open:4242", "assign", "close:2"]);
		held.kill();
		held.close();
		expect(calls.slice(4)).toEqual(["terminate", "close:1"]);
	});

	it("fails typed and leaves no job behind when assignment or confirmation fails", () => {
		for (const failure of [{ assign: false }, { inJob: false }]) {
			const { kernel, calls } = fakeKernel(failure);
			let caught: unknown;
			try {
				containChild(child(4242), { platform: "win32", loadKernel: () => kernel });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(ChildContainmentError);
			expect((caught as ChildContainmentError).code).toBe("tool_child_job_assign_failed");
			expect(calls.slice(-2)).toEqual(["terminate", "close:1"]);
		}
	});

	it("refuses a Windows host without bun:ffi with tool_runtime_unsupported_host", () => {
		expect(() => containChild(child(4242), { platform: "win32", loadKernel: () => undefined })).toThrow(
			/^tool_runtime_unsupported_host: /,
		);
	});
});
