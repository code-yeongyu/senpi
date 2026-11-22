import { mkdtempSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { posixSignalTable } from "../../src/core/tools/posix-signals.ts";
import { createCoreBashTool, createMachineOutputSpill, createToolMachine } from "../../src/tools-core.ts";
import { createFakeMachine } from "./support/fake-machine.ts";

// Platform contract: a worker-side bash reports a signal-killed shell as 128 + n with the machine's own numbering,
// the number the local tool reads from os.constants.signals on that platform, and never fewer signals than the one
// common table every OS got before (senpi#6744 L1).
describe("posixSignalTable", () => {
	it("numbers every signal Node knows on this platform the way Node does", () => {
		const table = posixSignalTable(process.platform);
		const missing = Object.entries(constants.signals).filter(([name, number]) => table[name] !== number);
		expect(missing).toEqual([]);
	});
});

const COMMON_NAMES = [
	"SIGHUP",
	"SIGINT",
	"SIGQUIT",
	"SIGILL",
	"SIGTRAP",
	"SIGABRT",
	"SIGFPE",
	"SIGKILL",
	"SIGSEGV",
	"SIGPIPE",
	"SIGALRM",
	"SIGTERM",
];

describe("posixSignalTable coverage", () => {
	it.each(["linux", "android", "darwin", "freebsd", "openbsd", "netbsd", "win32", "aix", "sunos"])(
		"%s numbers every signal of the common table",
		(os) => {
			expect(COMMON_NAMES.filter((name) => posixSignalTable(os)[name] === undefined)).toEqual([]);
		},
	);
});

describe("worker bash exit code of a signal-killed shell", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tools-core-signals-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it.each([
		["linux", "SIGUSR1", 138],
		["linux", "SIGTERM", 143],
		["darwin", "SIGUSR1", 158],
		["darwin", "SIGBUS", 138],
		["win32", "SIGTERM", 143],
		["win32", "SIGINT", 130],
		["win32", "SIGKILL", 137],
		["win32", "SIGABRT", 150],
		["win32", "SIGQUIT", 131],
		["freebsd", "SIGUSR1", 158],
		["openbsd", "SIGTERM", 143],
		["netbsd", "SIGUSR2", 159],
		["aix", "SIGTERM", 143],
	] as const)("on %s, %s exits with %i", async (os, signal, exitCode) => {
		const fake = createFakeMachine({
			scripts: { killed: { output: [{ stream: "stdout", text: "partial" }], exitCode: null, signal } },
			errorCodes: "fs",
			os,
		});
		const machine = createToolMachine({ ops: fake });
		const bash = createCoreBashTool(dir, {
			machine,
			outputSpill: createMachineOutputSpill(machine, { tempDir: dir }),
		});

		const result = await bash.execute("call", { command: "killed" });

		expect(result.structuredContent).toMatchObject({ exit_code: exitCode });
		expect(JSON.stringify(result.content)).toContain(`Command exited with code ${exitCode}`);
	});
});
