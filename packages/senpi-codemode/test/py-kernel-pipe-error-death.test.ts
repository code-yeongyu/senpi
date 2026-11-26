import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { type CodemodeSessionManager, createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import type { InterpreterAvailability } from "../src/interpreters/detect.ts";
import { FakeChild } from "./py-kernel/fixtures.ts";

// senpi#3612: an interpreter killed from outside can surface first as a pipe error (EPIPE on the
// control stdin) and only then as its exit. The kernel must still report that death, so the next cell
// runs on a replacement that announces every global is gone, instead of a silent fresh interpreter
// whose first cell fails with NameError.

type SpawnedSlot = { queue: unknown[]; all: unknown[] };
const spawned: SpawnedSlot = vi.hoisted((): SpawnedSlot => ({ queue: [], all: [] }));

vi.mock("../src/kernels/py/process.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/kernels/py/process.ts")>();
	return {
		...actual,
		defaultSpawn: () => {
			const next = spawned.queue.shift();
			if (!(next instanceof FakeChild)) throw new Error("unexpected Python spawn");
			spawned.all.push(next);
			return next;
		},
	};
});

const availability: InterpreterAvailability = {
	js: { enabled: false, detected: { ok: false } },
	py: { enabled: true, detected: { ok: true, path: "python3", version: "3" } },
	rb: { enabled: false, detected: { ok: false } },
	jl: { enabled: false, detected: { ok: false } },
};

const managers: CodemodeSessionManager[] = [];
const dirs: string[] = [];

afterEach(async () => {
	await Promise.allSettled(managers.splice(0).map((manager) => manager.dispose()));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	spawned.queue.length = 0;
	spawned.all.length = 0;
});

async function pythonSession(): Promise<CodemodeSessionManager> {
	const dir = mkdtempSync(join(tmpdir(), "codemode-py-pipe-death-"));
	dirs.push(dir);
	const manager = await createCodemodeSessionManager({
		sessionId: "py-pipe-death",
		cwd: dir,
		settings: defaultCodemodeSettings,
		availability,
		executeTool: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		complete: async () => {
			throw new Error("completion is not exercised here");
		},
	});
	managers.push(manager);
	return manager;
}

function pipeError(): Error {
	return Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
}

describe("a Python interpreter whose death surfaces as a pipe error before its exit", () => {
	it("between cells: the next cell runs on a replacement that carries the restart notice", async () => {
		const killed = new FakeChild({ remainAliveOnSigkill: true });
		const replacement = new FakeChild();
		spawned.queue.push(killed, replacement);
		const manager = await pythonSession();
		const kernel = await manager.getKernel("py", () => undefined);
		expect(await kernel.run({ cellId: "before", code: "def helper(): pass" })).toMatchObject({ ok: true });

		killed.stdin.emit("error", pipeError());
		killed.finish(null, "SIGKILL");
		const next = await kernel.run({ cellId: "after", code: "helper()" });

		expect(spawned.all).toEqual([killed, replacement]);
		expect(next).toMatchObject({ ok: true, kernelState: "restarted" });
		expect(next.notice).toMatch(/^\[py kernel was restarted after signal 9\b.*; every global is lost\]$/);
	}, 30_000);

	it("during a cell: that cell is lost, and the next one carries the restart notice", async () => {
		const killed = new FakeChild({ autoRun: false, remainAliveOnSigkill: true });
		const replacement = new FakeChild();
		spawned.queue.push(killed, replacement);
		const manager = await pythonSession();
		const kernel = await manager.getKernel("py", () => undefined);

		const running = kernel.run({ cellId: "running", code: "work()" });
		await vi.waitFor(() => expect(killed.runMessages).toHaveLength(1));
		killed.stdin.emit("error", pipeError());
		killed.finish(null, "SIGKILL");

		expect(await running).toMatchObject({
			ok: false,
			error: { message: expect.stringContaining("every global is lost") },
			kernelState: "lost",
		});
		const next = await kernel.run({ cellId: "after", code: "1" });
		expect(next).toMatchObject({ ok: true, kernelState: "restarted" });
		expect(next.notice).toMatch(/^\[py kernel was restarted after signal 9\b.*; every global is lost\]$/);
	}, 30_000);

	it("with no exit after it: the pipe error alone is the death, announced on the next cell", async () => {
		const stalled = new FakeChild({ autoRun: false });
		spawned.queue.push(stalled, new FakeChild());
		const manager = await pythonSession();
		const kernel = await manager.getKernel("py", () => undefined);

		const running = kernel.run({ cellId: "running", code: "work()" });
		await vi.waitFor(() => expect(stalled.runMessages).toHaveLength(1));
		stalled.stdin.emit("error", pipeError());

		expect(await running).toMatchObject({
			ok: false,
			error: { message: expect.stringContaining("every global is lost") },
			kernelState: "lost",
		});
		const next = await kernel.run({ cellId: "after", code: "1" });
		expect(next.notice).toBe(
			"[py kernel was restarted after a failure of its control pipe (write EPIPE); every global is lost]",
		);
	}, 30_000);
});
