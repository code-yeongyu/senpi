import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeServerHandle, BridgeServerOptions } from "../src/bridge/http-server.ts";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { kernelRegistry } from "../src/extension/kernel-registry.ts";
import { type CodemodeSessionManager, createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import type { InterpreterAvailability } from "../src/interpreters/detect.ts";
import type { EvalKernel, EvalKernelResult, EvalKernelRunInput, KernelInterruptHandle } from "../src/tool/types.ts";

const MINUTE = 60_000;

class FakeKernel implements EvalKernel {
	closeCount = 0;

	async run(input: EvalKernelRunInput): Promise<EvalKernelResult> {
		input.onStarted?.();
		return { type: "result", cellId: input.cellId, ok: true, durationMs: 0 };
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

	async close(): Promise<void> {
		this.closeCount++;
	}
}

const harness = vi.hoisted(() => ({ starts: [] as (() => Promise<EvalKernel>)[] }));

vi.mock("../src/bridge/http-server.ts", () => ({
	startBridgeServer: async (_options: BridgeServerOptions): Promise<BridgeServerHandle> => ({
		port: 31337,
		token: "test-token",
		close: async () => {},
	}),
}));

vi.mock("../src/kernels/py/kernel.ts", () => ({
	PythonKernel: {
		start: async (): Promise<EvalKernel> => {
			const next = harness.starts.shift();
			if (!next) throw new Error("no kernel start configured");
			return await next();
		},
	},
}));

const availability: InterpreterAvailability = {
	js: { enabled: false, detected: { ok: false } },
	py: { enabled: true, detected: { ok: true, path: "python", version: "3" } },
	rb: { enabled: false, detected: { ok: false } },
	jl: { enabled: false, detected: { ok: false } },
};

const SESSION = "idle-park-session";

function registeredPy(): number {
	return kernelRegistry.list().filter((entry) => entry.sessionId === SESSION && entry.language === "py").length;
}

async function createManager(): Promise<CodemodeSessionManager> {
	return await createCodemodeSessionManager({
		sessionId: SESSION,
		cwd: tmpdir(),
		settings: { ...defaultCodemodeSettings, memory: { ...defaultCodemodeSettings.memory, idleParkMinutes: 1 } },
		availability,
		executeTool: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		complete: async () => ({ text: "ok", details: { model: "fake/model", structured: false } }),
	});
}

describe("session manager with idle park", () => {
	beforeEach(() => {
		harness.starts = [];
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("Given a parked kernel when the next cell restarts it then the registry drops the parked kernel and lists the fresh one", async () => {
		const first = new FakeKernel();
		const second = new FakeKernel();
		harness.starts.push(
			async () => first,
			async () => second,
		);
		const manager = await createManager();
		const kernel = await manager.getKernel("py", () => undefined);
		expect(registeredPy()).toBe(1);

		await vi.advanceTimersByTimeAsync(MINUTE);
		expect(first.closeCount).toBe(1);
		expect(registeredPy()).toBe(0);

		await kernel.run({ cellId: "after-park", code: "1" });
		expect(registeredPy()).toBe(1);

		await manager.dispose();
		expect(second.closeCount).toBe(1);
		expect(registeredPy()).toBe(0);
	});

	it("Given a restart still starting when the session is disposed then the fresh kernel is closed and never registered", async () => {
		const first = new FakeKernel();
		const late = new FakeKernel();
		const gate = Promise.withResolvers<void>();
		harness.starts.push(
			async () => first,
			async () => {
				await gate.promise;
				return late;
			},
		);
		const manager = await createManager();
		const kernel = await manager.getKernel("py", () => undefined);
		await vi.advanceTimersByTimeAsync(MINUTE);

		const cell = kernel.run({ cellId: "during-dispose", code: "1" });
		await vi.advanceTimersByTimeAsync(0);
		const disposing = manager.dispose();
		gate.resolve();
		await disposing;
		const result = await cell;

		expect(result.ok).toBe(false);
		expect(late.closeCount).toBe(1);
		expect(registeredPy()).toBe(0);
	});
});
