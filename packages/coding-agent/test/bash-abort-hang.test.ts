import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { waitForChildProcess } from "../src/utils/child-process.ts";

/**
 * Aborting a bash command must release the tool promptly even when a
 * descendant process survives the process-group SIGKILL.
 *
 * `createLocalBashOperations` kills the detached shell's process group on
 * abort/timeout, but completion is gated on `waitForChildProcess`, whose
 * post-exit idle grace re-arms on every stdio chunk (pi#5303 tail
 * preservation). A descendant that escaped the group kill (own process
 * group / daemonized) and keeps writing to the inherited stdout pipe
 * therefore re-arms the grace forever: the tool never returns, the agent's
 * abort awaits it forever, and ESC appears dead while "Running bash"
 * counts up. These tests pin that abort/timeout always release the wait.
 */

function toShellSingleQuotedArg(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Direct child spawns a chattering grandchild in its OWN process group
 * (detached) that inherits stdout, records its pid, then stays alive until
 * killed. Killing the shell's process group leaves the grandchild running
 * and writing into the inherited pipe every 40ms.
 */
const ORPHAN_PARENT_SCRIPT = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => console.log('orphan-tick'), 40);"], {
	detached: true,
	stdio: ["ignore", "inherit", "ignore"],
});
writeFileSync(process.argv[2], String(child.pid));
child.unref();
console.log("parent-ready");
setInterval(() => {}, 1000);
`;

function killPidFromFile(pidFile: string): void {
	if (!existsSync(pidFile)) {
		return;
	}
	const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
	if (Number.isFinite(pid) && pid > 0) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			reject(new Error(`${label}: wait did not release within ${ms}ms`));
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timeoutId);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timeoutId);
				reject(error);
			},
		);
	});
}

describe.skipIf(process.platform === "win32")("bash abort releases the wait", () => {
	let testDir: string;
	let scriptPath: string;
	const pidFiles: string[] = [];

	beforeEach(() => {
		testDir = join(tmpdir(), `senpi-bash-abort-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
		scriptPath = join(testDir, "orphan-parent.cjs");
		writeFileSync(scriptPath, ORPHAN_PARENT_SCRIPT);
	});

	afterEach(() => {
		for (const pidFile of pidFiles) {
			killPidFromFile(pidFile);
		}
		pidFiles.length = 0;
		rmSync(testDir, { recursive: true, force: true });
	});

	function orphanCommand(pidFile: string): string {
		pidFiles.push(pidFile);
		return `${toShellSingleQuotedArg(process.execPath)} ${toShellSingleQuotedArg(scriptPath)} ${toShellSingleQuotedArg(pidFile)}`;
	}

	it("rejects with aborted when a plain long-running command is interrupted", async () => {
		const ops = createLocalBashOperations();
		const controller = new AbortController();
		let aborted = false;

		const execPromise = ops.exec("echo started; sleep 60", testDir, {
			onData: (data) => {
				if (!aborted && data.toString().includes("started")) {
					aborted = true;
					controller.abort();
				}
			},
			signal: controller.signal,
		});

		await expect(withTimeout(execPromise, 8000, "plain abort")).rejects.toThrow("aborted");
	});

	it("rejects with aborted while an escaped descendant keeps writing to the inherited pipe", async () => {
		const ops = createLocalBashOperations();
		const controller = new AbortController();
		const pidFile = join(testDir, "orphan-abort.pid");
		let aborted = false;

		const execPromise = ops.exec(orphanCommand(pidFile), testDir, {
			onData: (data) => {
				// First tick proves the escaped grandchild is alive and chattering.
				if (!aborted && data.toString().includes("orphan-tick")) {
					aborted = true;
					controller.abort();
				}
			},
			signal: controller.signal,
		});

		await expect(withTimeout(execPromise, 8000, "abort with chattering orphan")).rejects.toThrow("aborted");
	});

	it("rejects with timeout while an escaped descendant keeps writing to the inherited pipe", async () => {
		const ops = createLocalBashOperations();
		const pidFile = join(testDir, "orphan-timeout.pid");

		const execPromise = ops.exec(orphanCommand(pidFile), testDir, {
			onData: () => {},
			timeout: 1,
		});

		await expect(withTimeout(execPromise, 8000, "timeout with chattering orphan")).rejects.toThrow("timeout:1");
	});

	it("resolves after the abort exit grace when the killed process never exits", async () => {
		// Nobody kills the child here: this simulates a kill that did not take
		// effect (uninterruptible IO, taskkill failure). The abort grace must
		// still release the wait instead of blocking the agent forever.
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const controller = new AbortController();

		const wait = waitForChildProcess(child, { signal: controller.signal, abortExitGraceMs: 300 });
		controller.abort();

		try {
			const exitCode = await withTimeout(wait, 8000, "abort exit grace");
			expect(exitCode).toBeNull();
			// The wait gave up on the process, not the other way round.
			expect(() => {
				if (child.pid) process.kill(child.pid, 0);
			}).not.toThrow();
		} finally {
			if (child.pid) {
				try {
					process.kill(child.pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		}
	});
});
