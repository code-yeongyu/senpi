import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { killWindowsProcessTree, windowsTaskkillCandidates } from "../../../src/utils/shell.ts";

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
	it("puts every existing absolute System32 executable ahead of the bare PATH lookup", () => {
		const root = createFakeSystemRoot(true);
		expect(windowsTaskkillCandidates({ SystemRoot: root })).toEqual([
			join(root, "System32", "taskkill.exe"),
			"taskkill.exe",
		]);
	});

	it("accepts the uppercase SYSTEMROOT, windir, and SystemDrive spellings", () => {
		const upper = createFakeSystemRoot(true);
		const windir = createFakeSystemRoot(true);
		expect(windowsTaskkillCandidates({ SYSTEMROOT: upper })[0]).toBe(join(upper, "System32", "taskkill.exe"));
		expect(windowsTaskkillCandidates({ windir })[0]).toBe(join(windir, "System32", "taskkill.exe"));
	});

	it("collects Sysnative and deduplicates repeated roots", () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-systemroot-"));
		tempRoots.push(root);
		for (const systemDir of ["System32", "Sysnative"]) {
			mkdirSync(join(root, systemDir), { recursive: true });
			writeFileSync(join(root, systemDir, "taskkill.exe"), "");
		}
		expect(windowsTaskkillCandidates({ SystemRoot: root, SYSTEMROOT: root, windir: root })).toEqual([
			join(root, "System32", "taskkill.exe"),
			join(root, "Sysnative", "taskkill.exe"),
			"taskkill.exe",
		]);
	});

	it("falls back to the bare executable name when no absolute candidate exists", () => {
		const root = createFakeSystemRoot(false);
		expect(windowsTaskkillCandidates({ SystemRoot: root })).toEqual(["taskkill.exe"]);
		expect(windowsTaskkillCandidates({})).toEqual(["taskkill.exe"]);
	});

	it("ignores an empty SystemDrive instead of probing a drive-relative path", () => {
		// `join("\\", "Windows", ...)` resolves against the current drive, which would silently
		// reintroduce a candidate the environment does not actually declare.
		expect(windowsTaskkillCandidates({ SystemDrive: "" })).toEqual(["taskkill.exe"]);
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
			// Before the fix this became an uncaughtException that killed the whole CLI.
			killWindowsProcessTree(pid as number, UNRESOLVABLE_TASKKILL);
			await once(child, "exit");
			expect(uncaught).toEqual([]);
		} finally {
			process.off("uncaughtException", onUncaught);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
	});

	it("issues the fallback kill synchronously, before the caller can exit", () => {
		// emergencyTerminalExit() runs killTrackedDetachedChildren() and then process.exit(129)
		// in the same tick, so a fallback deferred to a later event-loop turn never runs and the
		// tracked child survives. The kill must therefore be issued before this call returns.
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

	it("tries every candidate before degrading to the direct kill", () => {
		const attempted: string[] = [];
		const realKill = process.kill.bind(process);
		const candidates = ["senpi-missing-a.exe", "senpi-missing-b.exe", process.execPath];
		process.kill = (() => {
			attempted.push("direct");
			return true;
		}) as typeof process.kill;

		try {
			// process.execPath launches successfully, so the tree kill is considered handled
			// and the direct fallback must not run.
			killWindowsProcessTree(4242, candidates);
		} finally {
			process.kill = realKill;
		}

		expect(attempted).toEqual([]);
	});

	it("tolerates a pid that is already gone", async () => {
		const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
		await once(child, "exit");
		const pid = child.pid as number;

		const uncaught: unknown[] = [];
		const onUncaught = (error: unknown) => uncaught.push(error);
		process.on("uncaughtException", onUncaught);
		try {
			expect(() => killWindowsProcessTree(pid, UNRESOLVABLE_TASKKILL)).not.toThrow();
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(uncaught).toEqual([]);
		} finally {
			process.off("uncaughtException", onUncaught);
		}
	});
});
