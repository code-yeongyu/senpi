import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBenchSession, loadTarget } from "../../scripts/bench-session.ts";
import { decodeBridgeFrame } from "../../src/bridge/protocol.ts";
import type { CodemodeSessionManager } from "../../src/extension/session-manager-contract.ts";
import type { InterpreterAvailability } from "../../src/interpreters/detect.ts";
import type { EvalKernelRunInput } from "../../src/tool/types.ts";
import { FakeKernel } from "../eval/fakes.ts";

const state = vi.hoisted(() => ({
	cpu: 0,
	placement: "before-value",
	events: [] as string[],
}));
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	execFileSync: () => {
		state.events.push("native-read");
		return String(state.cpu);
	},
}));
vi.mock("../../src/kernels/shared/bun-ffi.ts", () => ({ loadBunFfi: () => undefined }));
vi.mock("../../scripts/bench-accounting.ts", async (original) => ({
	...(await original<typeof import("../../scripts/bench-accounting.ts")>()),
	instrumentInterpreter: async (availability: InterpreterAvailability) => availability,
	watchExitUsage: async () => ({
		totals: async (live?: { pid: number; cpuUs: number }) => (live ? [live] : []),
		close: () => {},
	}),
}));

class EncodingKernel extends FakeKernel {
	constructor() {
		super([]);
	}
	override async run(input: EvalKernelRunInput) {
		if (state.placement === "before-value") state.cpu += 100;
		const valueRepr = `"42,${state.cpu}"`;
		const wire = JSON.stringify({
			toJSON() {
				if (state.placement === "during-result") state.cpu += 100;
				state.events.push("serialized");
				return { type: "result", cellId: input.cellId, ok: true, valueRepr, durationMs: 0 };
			},
		});
		state.cpu += 1;
		state.events.push("flushed");
		const decoded = decodeBridgeFrame(`${wire}\n`);
		if (!decoded.ok || decoded.message.type !== "result") throw new Error("fixture result decode failed");
		state.events.push("fully-received");
		return decoded.message;
	}
}
const kernel = new EncodingKernel();
vi.mock("../../src/extension/session-manager.ts", async (original) => ({
	...(await original<typeof import("../../src/extension/session-manager.ts")>()),
	createCodemodeSessionManager: async (): Promise<CodemodeSessionManager> => ({
		getKernel: async () => kernel,
		dispose: async () => {},
		complete: async () => {
			throw new Error("fixture has no completion");
		},
	}),
}));
vi.mock("../../src/interpreters/detect.ts", async (original) => ({
	...(await original<typeof import("../../src/interpreters/detect.ts")>()),
	getInterpreterAvailability: async (): Promise<InterpreterAvailability> => {
		const detected = { ok: true, path: "fixture-python", version: "fixture" } as const;
		const available = { enabled: true, detected };
		return { py: available, js: available, rb: available, jl: available };
	},
}));
afterEach(() => {
	state.cpu = 0;
	state.events = [];
});

describe("benchmark post-result CPU boundary (Refs senpi#3048)", () => {
	it.each(["before-value", "during-result"])(
		"counts cold encoding %s and flush work before sampling the received result",
		async (placement) => {
			state.placement = placement;
			const modules = await loadTarget(fileURLToPath(new URL("../..", import.meta.url)));
			const session = await createBenchSession(modules, "jl");
			try {
				const measured = await session.probe();
				expect(measured).toEqual({ pid: 42, cpuUs: 101 });
				expect(state.events).toEqual(["serialized", "flushed", "fully-received", "native-read"]);
			} finally {
				await session.dispose();
			}
		},
	);
});
