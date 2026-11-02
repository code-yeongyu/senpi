import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { type CodemodeSessionManager, createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import type { InterpreterAvailability } from "../src/interpreters/detect.ts";
import type { PythonKernelStartOptions } from "../src/kernels/py/kernel.ts";
import type { EvalKernel, EvalKernelRunInput, KernelInterruptHandle } from "../src/tool/types.ts";

const harness = vi.hoisted(() => ({
	startKernel: async (): Promise<EvalKernel> => {
		throw new Error("python kernel start was not configured");
	},
}));

vi.mock("../src/kernels/py/kernel.ts", () => ({
	PythonKernel: {
		start: async (_options: PythonKernelStartOptions): Promise<EvalKernel> => await harness.startKernel(),
	},
}));

const availability: InterpreterAvailability = {
	js: { enabled: true, detected: { ok: true, path: "node", version: "v20" } },
	py: { enabled: true, detected: { ok: true, path: "python", version: "3" } },
	rb: { enabled: false, detected: { ok: false } },
	jl: { enabled: false, detected: { ok: false } },
};

class PythonNamedKernel implements EvalKernel {
	listKernelToolNames(): readonly string[] {
		return ["py_lookup"];
	}

	async run(input: EvalKernelRunInput) {
		input.onStarted?.();
		return { type: "result" as const, cellId: input.cellId, ok: true as const, durationMs: 0 };
	}

	async interrupt(): Promise<KernelInterruptHandle> {
		return { stateRetained: Promise.resolve(true) };
	}

	deliverToolReply(): void {}

	cancelQueued(): boolean {
		return false;
	}

	queueSnapshot() {
		return { activeCellId: null, queuedCellIds: [] };
	}

	async reset(): Promise<void> {}

	async close(): Promise<void> {}
}

describe("session manager kernel-tool collisions", () => {
	let manager: CodemodeSessionManager | undefined;
	let dir = "";

	afterEach(async () => {
		await manager?.dispose();
		manager = undefined;
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	it("rejects JS tool() that collides with a Python kernel name in the same session", async () => {
		harness.startKernel = async () => new PythonNamedKernel();
		dir = mkdtempSync(join(tmpdir(), "codemode-sm-kt-"));
		manager = await createCodemodeSessionManager({
			sessionId: "kernel-tools-session",
			cwd: dir,
			settings: defaultCodemodeSettings,
			availability,
			executeTool: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
			complete: async () => {
				throw new Error("completion is not exercised in this test");
			},
		});
		const js = await manager.getKernel("js", () => undefined);
		const boot = await js.run({ cellId: "boot-js", code: "return 1", timeoutMs: 8_000 });
		expect(boot).toMatchObject({ ok: true, valueRepr: "1" });
		await manager.getKernel("py", () => undefined);
		const collided = await js.run({
			cellId: "collide-py",
			code: "try { tool(function py_lookup(path) { return path; }); } catch (e) { return e.code; }",
			timeoutMs: 8_000,
		});
		expect(collided).toMatchObject({ ok: true, valueRepr: '"tool_name_collision"' });
	});
});
