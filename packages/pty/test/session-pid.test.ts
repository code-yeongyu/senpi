import { execFileSync } from "node:child_process";
import process from "node:process";
import { describe, expect, it, onTestFinished } from "vitest";
import { loadNativePty, type NativePtyLoadResult } from "../src/native-loader.ts";
import { TerminalSession, type TerminalSessionOptions } from "../src/session.ts";

const posix = process.platform !== "win32";
const nativeAvailable = loadNativePty().native !== null;
const runningUnderBun = process.versions.bun !== undefined;

const shellOptions: TerminalSessionOptions = {
	command: "/bin/sh",
	args: ["-c", 'echo "PID=$$;"; exec sleep 30'],
};

const nativeUnavailable: NativePtyLoadResult = {
	native: null,
	diagnostic: {
		code: "native-unavailable",
		runtime: "node",
		host: "test-host",
		attemptedPath: "/missing/senpi_pty.node",
		attemptedPaths: ["/missing/senpi_pty.node"],
		message: "test native unavailable",
	},
};

function psField(field: "pid" | "pgid", pid: number): number {
	return Number(execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).trim());
}

function expectPositiveInteger(value: number | undefined): void {
	expect(Number.isInteger(value)).toBe(true);
	expect(value).toBeGreaterThan(0);
}

async function startAndReadShellPid(session: TerminalSession): Promise<number> {
	let output = "";
	const reported = new Promise<number>((resolve) => {
		const unsubscribe = session.onData((chunk) => {
			output += chunk.toString("utf8");
			const match = /PID=(\d+);/.exec(output);
			if (match === null) return;
			unsubscribe();
			resolve(Number(match[1]));
		});
	});
	session.start();
	onTestFinished(() => {
		session.kill("SIGKILL");
	});
	console.log(`backend=${session.backend}`);
	return await reported;
}

async function killAndWait(session: TerminalSession): Promise<void> {
	session.kill("SIGKILL");
	await session.waitExit();
	expect(session.status).toBe("exited");
}

function stubBinding(handle: object): NativePtyLoadResult {
	return {
		native: { PtySession: class {}, startPtySession: () => handle },
		diagnostic: null,
	};
}

function stubHandle(): object {
	return {
		write: () => undefined,
		resize: () => undefined,
		kill: () => undefined,
		waitExit: async () => ({ exitCode: 0, cancelled: false, timedOut: false }),
	};
}

describe("TerminalSession pid and processGroupId", () => {
	it.runIf(posix && nativeAvailable)(
		"native backend exposes the shell pid and process group, readable after exit",
		async () => {
			const session = new TerminalSession(shellOptions);
			const shellPid = await startAndReadShellPid(session);

			expect(session.backend).toBe("native");
			expect(session.pid).toBe(shellPid);
			expectPositiveInteger(session.pid);
			expect(psField("pid", shellPid)).toBe(shellPid);
			expect(session.processGroupId).toBe(psField("pgid", shellPid));
			expectPositiveInteger(session.processGroupId);

			const processGroupId = session.processGroupId;
			await killAndWait(session);
			expect(session.pid).toBe(shellPid);
			expect(session.processGroupId).toBe(processGroupId);
		},
		10_000,
	);

	it.runIf(posix)(
		"pipe-fallback exposes the child pid as pid and process group",
		async () => {
			const session = new TerminalSession(shellOptions, { nativeLoadResult: nativeUnavailable });
			const shellPid = await startAndReadShellPid(session);

			expect(session.backend).toBe("pipe-fallback");
			expect(session.pid).toBe(shellPid);
			expect(psField("pid", shellPid)).toBe(shellPid);
			expect(session.processGroupId).toBe(shellPid);
			expect(psField("pgid", shellPid)).toBe(shellPid);

			await killAndWait(session);
			expect(session.pid).toBe(shellPid);
			expect(session.processGroupId).toBe(shellPid);
		},
		10_000,
	);

	it.runIf(posix && runningUnderBun)(
		"bun backend exposes the shell pid",
		async () => {
			const session = new TerminalSession(shellOptions, { env: { SENPI_BUN_TERMINAL: "1" } });
			const shellPid = await startAndReadShellPid(session);

			expect(session.backend).toBe("bun");
			expect(session.pid).toBe(shellPid);
			expect(psField("pid", shellPid)).toBe(shellPid);
			expect(session.processGroupId).toBeUndefined();

			await killAndWait(session);
			expect(session.pid).toBe(shellPid);
		},
		10_000,
	);

	it("a native binding without the getters yields undefined without throwing", async () => {
		const session = new TerminalSession(
			{ command: "stub" },
			{ nativeLoadResult: stubBinding(stubHandle()), env: {} },
		);

		expect(() => session.start()).not.toThrow();
		console.log(`backend=${session.backend}`);
		expect(session.backend).toBe("native");
		expect(session.pid).toBeUndefined();
		expect(session.processGroupId).toBeUndefined();
		await session.waitExit();
		expect(session.pid).toBeUndefined();
	});

	it("reads numeric native getters and ignores non-numeric ones", async () => {
		const withGetters = new TerminalSession(
			{ command: "stub" },
			{ nativeLoadResult: stubBinding({ ...stubHandle(), pid: 4242, processGroupId: 4243 }), env: {} },
		).start();
		const withJunk = new TerminalSession(
			{ command: "stub" },
			{ nativeLoadResult: stubBinding({ ...stubHandle(), pid: "4242", processGroupId: null }), env: {} },
		).start();

		expect(withGetters.pid).toBe(4242);
		expect(withGetters.processGroupId).toBe(4243);
		expect(withJunk.pid).toBeUndefined();
		expect(withJunk.processGroupId).toBeUndefined();
		await Promise.all([withGetters.waitExit(), withJunk.waitExit()]);
	});
});
