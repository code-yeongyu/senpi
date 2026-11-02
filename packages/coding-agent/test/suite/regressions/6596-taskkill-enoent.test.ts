import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));

vi.mock("child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("child_process")>();
	return { ...actual, spawnSync: spawnSyncMock };
});

import { killProcessTree } from "../../../src/utils/shell.ts";

function withWindowsPlatform(test: () => void): void {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	try {
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		test();
	} finally {
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	}
}

afterEach(() => {
	spawnSyncMock.mockReset();
});

describe("issue #6596 taskkill spawn failures", () => {
	it("uses System32 taskkill and does not throw when spawnSync fails with ENOENT", () => {
		const systemRoot = mkdtempSync(join(tmpdir(), "senpi-6596-systemroot-"));
		mkdirSync(join(systemRoot, "System32"), { recursive: true });
		writeFileSync(join(systemRoot, "System32", "taskkill.exe"), "");
		const previousSystemRoot = process.env.SystemRoot;
		process.env.SystemRoot = systemRoot;
		spawnSyncMock.mockReturnValue({
			error: Object.assign(new Error("spawnSync ENOENT"), { code: "ENOENT" }),
			status: null,
			signal: null,
			output: [null, Buffer.alloc(0), Buffer.alloc(0)],
			pid: 0,
			stdout: Buffer.alloc(0),
			stderr: Buffer.alloc(0),
		});
		const realKill = process.kill.bind(process);
		const killed: number[] = [];
		process.kill = ((pid: number) => {
			killed.push(pid);
			return true;
		}) as typeof process.kill;

		try {
			withWindowsPlatform(() => {
				expect(() => killProcessTree(1234)).not.toThrow();
			});
		} finally {
			process.kill = realKill;
			if (previousSystemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = previousSystemRoot;
			rmSync(systemRoot, { recursive: true, force: true });
		}

		expect(spawnSyncMock).toHaveBeenCalledWith(
			join(systemRoot, "System32", "taskkill.exe"),
			["/F", "/T", "/PID", "1234"],
			{ stdio: "ignore", windowsHide: true, timeout: 5_000 },
		);
		expect(killed).toEqual([1234]);
	});
});
