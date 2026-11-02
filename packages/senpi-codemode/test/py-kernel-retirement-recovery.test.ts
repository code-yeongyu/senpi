import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { type CodemodeSessionManager, createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import type { InterpreterAvailability } from "../src/interpreters/detect.ts";
import { FakeChild } from "./py-kernel/fixtures.ts";

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

function measuredChild(options: ConstructorParameters<typeof FakeChild>[0] = {}): FakeChild {
	const child: FakeChild = new FakeChild({
		...options,
		autoRun: false,
		onRun: (message) =>
			child.emitMessage({
				type: "result",
				cellId: message.cellId,
				ok: true,
				valueRepr: message.code,
				durationMs: 1,
				memory: { liveBytes: 1024, measure: "heap", gcRan: true },
			}),
	});
	return child;
}

const managers: CodemodeSessionManager[] = [];
const dirs: string[] = [];

afterEach(async () => {
	await Promise.allSettled(managers.splice(0).map((manager) => manager.dispose()));
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	spawned.queue.length = 0;
	spawned.all.length = 0;
});

async function pythonSession(): Promise<CodemodeSessionManager> {
	const dir = mkdtempSync(join(tmpdir(), "codemode-py-retire-"));
	dirs.push(dir);
	const manager = await createCodemodeSessionManager({
		sessionId: "py-retirement",
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

describe("a Python kernel whose retirement failed", () => {
	it("reports the failure while the old interpreter lives, and recovers with the notice once it is gone", async () => {
		const stuck = measuredChild({ remainAliveOnSigkill: true });
		const replacement = measuredChild();
		spawned.queue.push(stuck, replacement);
		const manager = await pythonSession();
		const kernel = await manager.getKernel("py", () => undefined);

		await expect(kernel.reset()).rejects.toMatchObject({ name: "PythonKernelRetirementError" });
		await expect(kernel.run({ cellId: "while-stuck", code: "1" })).rejects.toThrow(/exit/i);
		expect(spawned.all).toEqual([stuck]);

		stuck.finish(null, "SIGKILL");
		const recovered = await (await manager.getKernel("py", () => undefined)).run({ cellId: "after", code: "2" });

		expect(recovered).toMatchObject({ ok: true, valueRepr: "2" });
		expect(recovered.notice).toMatch(/^\[py kernel was restarted after .+; every global is lost\]$/);
		expect(spawned.all).toEqual([stuck, replacement]);
	}, 30_000);
});
