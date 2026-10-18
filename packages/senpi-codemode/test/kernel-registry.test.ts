import { afterEach, describe, expect, it } from "vitest";
import { defaultCodemodeSettings } from "../src/config/settings.ts";
import { kernelRegistry } from "../src/extension/kernel-registry.ts";
import { type CodemodeSessionManager, createCodemodeSessionManager } from "../src/extension/session-manager.ts";
import type { InterpreterAvailability } from "../src/interpreters/detect.ts";

// senpi#2561: a process must be able to say which live kernels it holds and what each one last
// measured, without running a cell. The registry is that answer; these cells drive it through the
// real session manager and real JS kernels, the way the extension creates and disposes them.

const MIB = 1024 * 1024;
const availability: InterpreterAvailability = {
	js: { enabled: true, detected: { ok: true, path: "node", version: "v24" } },
	py: { enabled: false, detected: { ok: false } },
	rb: { enabled: false, detected: { ok: false } },
	jl: { enabled: false, detected: { ok: false } },
};

const managers: CodemodeSessionManager[] = [];

afterEach(async () => {
	await Promise.allSettled(managers.splice(0).map(async (manager) => await manager.dispose()));
});

async function openManager(
	label: string,
	ceilingMb = 0,
): Promise<{ manager: CodemodeSessionManager; sessionId: string }> {
	const sessionId = `${label}-${crypto.randomUUID()}`;
	const manager = await createCodemodeSessionManager({
		sessionId,
		cwd: process.cwd(),
		settings: {
			...defaultCodemodeSettings,
			memory: { ...defaultCodemodeSettings.memory, gcWatermarkMb: 32, noticeMb: 64, ceilingMb },
		},
		availability,
		executeTool: async () => ({ content: [{ type: "text", text: "" }], details: {} }),
		complete: async () => {
			throw new Error("completion is not exercised in this test");
		},
	});
	managers.push(manager);
	return { manager, sessionId };
}

async function runCell(manager: CodemodeSessionManager, code: string) {
	const kernel = await manager.getKernel("js", () => {});
	return await kernel.run({ cellId: `cell-${crypto.randomUUID()}`, code, timeoutMs: 30_000 });
}

function listed(sessionId: string) {
	return kernelRegistry.list().filter((kernel) => kernel.sessionId === sessionId);
}

describe("live kernel registry", () => {
	it("Given two sessions with a JS kernel each when one is disposed then the registry lists exactly the other", async () => {
		const { manager: first, sessionId: firstId } = await openManager("registry-a");
		const { manager: second, sessionId: secondId } = await openManager("registry-b");
		const firstResult = await runCell(first, "globalThis.kept = new Float64Array(1024).fill(1); kept.length");
		await runCell(second, "1 + 1");

		expect(listed(firstId)).toEqual([
			expect.objectContaining({ language: "js", measure: "heap", lastLiveBytes: firstResult.memory?.liveBytes }),
		]);
		expect(listed(secondId)).toHaveLength(1);

		await first.dispose();

		expect(listed(firstId)).toEqual([]);
		expect(listed(secondId)).toEqual([expect.objectContaining({ language: "js", busy: false })]);
		const reading = await kernelRegistry.query(listed(secondId)[0]?.id ?? "missing");
		expect(reading).toMatchObject({ measure: "heap" });
		expect(reading?.liveBytes).toBeGreaterThan(0);
	}, 60_000);

	it("Given a kernel restarted for exceeding its ceiling when the next cell settles then it keeps its registry id and reports the fresh worker's heap", async () => {
		const { manager, sessionId } = await openManager("registry-ceiling", 128);
		const offending = await runCell(
			manager,
			"globalThis.huge = new Float64Array((160 * 1024 * 1024) / 8).fill(1); 0",
		);
		const [before] = listed(sessionId);

		const next = await runCell(manager, "typeof huge");
		const after = listed(sessionId);

		expect(offending.memory).toMatchObject({ overCeiling: true });
		expect(offending.memory?.liveBytes).toBeGreaterThanOrEqual(128 * MIB);
		expect(before?.id).toEqual(expect.any(String));
		expect(next).toMatchObject({ ok: true, valueRepr: JSON.stringify("undefined"), memory: { recycled: true } });
		expect(after).toEqual([expect.objectContaining({ id: before?.id, lastLiveBytes: next.memory?.liveBytes })]);
		expect(after[0]?.lastLiveBytes).toBeLessThan(128 * MIB);
	}, 60_000);

	it("Given a session that never ran a cell when it is listed then no kernel is registered for it", async () => {
		const { sessionId } = await openManager("registry-empty");

		expect(listed(sessionId)).toEqual([]);
	});
});
