import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killWindowsProcessTree, windowsTaskkillCandidates } from "../../src/harness/env/nodejs.ts";

/** Names that can never resolve on PATH, so spawn() fails with ENOENT on every platform. */
const UNRESOLVABLE_TASKKILL = ["senpi-nonexistent-taskkill-binary.exe"];

const tempRoots: string[] = [];

function createFakeSystemRoot(withTaskkill: boolean): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-systemroot-"));
	tempRoots.push(root);
	if (withTaskkill) {
		mkdirSync(join(root, "System32"), { recursive: true });
		writeFileSync(join(root, "System32", "taskkill.exe"), "");
	}
	return root;
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true });
	}
});

describe("windowsTaskkillCandidates", () => {
	it("puts the absolute System32 executable ahead of the bare PATH lookup", () => {
		const root = createFakeSystemRoot(true);
		expect(windowsTaskkillCandidates({ SystemRoot: root })).toEqual([
			join(root, "System32", "taskkill.exe"),
			"taskkill.exe",
		]);
	});

	it("falls back to the bare executable name when no absolute candidate exists", () => {
		const root = createFakeSystemRoot(false);
		expect(windowsTaskkillCandidates({ SystemRoot: root })).toEqual(["taskkill.exe"]);
		expect(windowsTaskkillCandidates({})).toEqual(["taskkill.exe"]);
	});
});

describe("killWindowsProcessTree", () => {
	it("kills the child instead of crashing the process when taskkill cannot be spawned", async () => {
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
		await once(child, "spawn");
		const pid = child.pid;
		expect(pid).toBeDefined();

		const uncaught: unknown[] = [];
		const onUncaught = (error: unknown) => uncaught.push(error);
		process.on("uncaughtException", onUncaught);

		try {
			// An asynchronous spawn() surfaces ENOENT through the child's 'error' event.
			// Before the fix this became an uncaughtException that killed the host process.
			killWindowsProcessTree(pid as number, UNRESOLVABLE_TASKKILL);
			await once(child, "exit");
			expect(uncaught).toEqual([]);
		} finally {
			process.off("uncaughtException", onUncaught);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
	});

	it("issues the fallback kill synchronously, before the caller can exit", () => {
		// A caller that tears down and exits in the same tick never reaches a later
		// event-loop turn, so the fallback must be issued before this call returns.
		const calls: Array<[number, NodeJS.Signals | number | undefined]> = [];
		const realKill = process.kill.bind(process);
		process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
			calls.push([pid, signal]);
			return true;
		}) as typeof process.kill;

		try {
			killWindowsProcessTree(4242, UNRESOLVABLE_TASKKILL);
		} finally {
			process.kill = realKill;
		}

		expect(calls).toEqual([[4242, undefined]]);
	});
});
