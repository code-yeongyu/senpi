// senpi#3566 todo 4 (Windows half): the breakaway launch hands CreateProcessW the x64 struct layouts and reads the pid
// and exit code back from the right offsets. The kernel is a recording fake; the win32 suite runs the real call.
import { describe, expect, it } from "vitest";
import { BreakawayError, type Kernel32Process, startBreakaway } from "./windows-breakaway.ts";

function decodeBlock(block: Uint8Array): string[] {
	return String.fromCharCode(...new Uint16Array(block.buffer))
		.split("\0")
		.filter((entry) => entry !== "");
}

function fakeKernel(created = true) {
	const calls: string[] = [];
	let commandLine = "";
	let startup: DataView | undefined;
	let flags = 0;
	let environment: string[] = [];
	const kernel: Kernel32Process = {
		CreateProcessW: (line, creationFlags, block, startupInfo, processInfo) => {
			commandLine = String.fromCharCode(...new Uint16Array(line.buffer)).replace(/\0$/, "");
			environment = decodeBlock(block);
			startup = new DataView(startupInfo.buffer.slice(0));
			flags = creationFlags;
			if (!created) return 0;
			const info = new DataView(processInfo.buffer);
			info.setBigUint64(0, 0x111n, true);
			info.setBigUint64(8, 0x222n, true);
			info.setUint32(16, 5150, true);
			return 1;
		},
		GetStdHandle: (which) => BigInt(1000 - which),
		WaitForSingleObject: (handle) => {
			calls.push(`wait:${handle}`);
			return 0;
		},
		GetExitCodeProcess: (handle, code) => {
			calls.push(`exit:${handle}`);
			new DataView(code.buffer).setUint32(0, 3, true);
			return 1;
		},
		CloseHandle: (handle) => {
			calls.push(`close:${handle}`);
			return 1;
		},
		GetLastError: () => 87,
	};
	return { kernel, calls, read: () => ({ commandLine, startup, flags, environment }) };
}

describe("startBreakaway", () => {
	it("passes the breakaway flag, the quoted command line and the x64 STARTUPINFOW with the caller's std handles", () => {
		const { kernel, read } = fakeKernel();
		startBreakaway(kernel, 'cmd /c "echo hi"', {});
		const { commandLine, startup, flags } = read();
		expect(flags & 0x0100_0000).toBe(0x0100_0000);
		expect(commandLine).toBe('cmd /c "echo hi"');
		expect(startup?.getUint32(0, true)).toBe(104);
		expect(startup?.getUint32(60, true)).toBe(0x100);
		expect([80, 88, 96].map((offset) => startup?.getBigUint64(offset, true))).toEqual([1010n, 1011n, 1012n]);
	});

	it("reads the pid from PROCESS_INFORMATION, closes the thread handle at once and the process handle after the wait", () => {
		const { kernel, calls } = fakeKernel();
		const command = startBreakaway(kernel, "x.exe", {});
		expect(command.pid).toBe(5150);
		expect(calls).toEqual(["close:546"]);
		expect(command.wait()).toBe(3);
		expect(calls).toEqual(["close:546", "wait:273", "exit:273", "close:273"]);
	});

	it("fails typed when CreateProcessW refuses", () => {
		const { kernel } = fakeKernel(false);
		expect(() => startBreakaway(kernel, "x.exe", {})).toThrow(BreakawayError);
	});

	it("hands the command an explicit environment with every internal variable removed", () => {
		// senpi#3590 review HIGH 1: with lpEnvironment = null the command inherited the shim's role and command line.
		const { kernel, read } = fakeKernel();
		startBreakaway(kernel, "x.exe", {
			Path: "C:\\bin",
			SENPI_INTERNAL_ROLE: "launch-shim",
			SENPI_LAUNCH_SHIM_COMMAND_LINE: "x.exe",
			SENPI_TOOL_CHILD_REENTRY: "{}",
			USERNAME: "u",
		});
		const { flags, environment } = read();
		expect(flags & 0x400).toBe(0x400);
		expect(environment).toEqual(["Path=C:\\bin", "USERNAME=u"]);
	});
});
