import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { buildRpcSessionState } from "../../../src/modes/rpc/rpc-session-state.ts";
import { createHarness, type Harness } from "../harness.ts";

const MODELS = [
	{ id: "model-a", reasoning: true },
	{ id: "model-b", reasoning: true },
	{ id: "on-off-c", reasoning: true },
];

function requireModel(harness: Harness, id: string): Model<string> {
	const model = harness.getModel(id);
	if (!model) throw new Error(`Missing test model: ${id}`);
	return model;
}

function makeOnOffOnly(model: Model<string>): void {
	model.thinkingLevelMap = { minimal: null, low: null, medium: null, xhigh: null, max: null } as ThinkingLevelMap;
}

describe("3819 the thinking level is remembered per model per session", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function open(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
		const harness = await createHarness({ fileSettings: true, models: MODELS, ...options });
		harnesses.push(harness);
		return harness;
	}

	it("A(high) -> B(low) -> A restores high even after another thread changed A's global level", async () => {
		const thread = await open();
		const a = requireModel(thread, "model-a");
		const b = requireModel(thread, "model-b");
		await thread.session.setModel(a);
		thread.session.setThinkingLevel("high");
		await thread.session.setModel(b);
		thread.session.setThinkingLevel("low");

		// Another thread on the same host picks a different level for A.
		thread.settingsManager.setModelThinkingLevel(a.provider, a.id, "minimal");
		expect(thread.settingsManager.getModelThinkingLevel(a.provider, a.id)).toBe("minimal");

		await thread.session.setModel(a);
		expect(thread.session.thinkingLevel).toBe("high");
		expect(thread.session.thinkingLevelSource).toBe("session");
		await thread.session.setModel(b);
		expect(thread.session.thinkingLevel).toBe("low");
		expect(thread.session.thinkingLevelSource).toBe("session");
	});

	it("restores a session-scoped level, which never touches the global map", async () => {
		const thread = await open();
		const a = requireModel(thread, "model-a");
		const b = requireModel(thread, "model-b");
		await thread.session.setModel(a);
		thread.session.setSessionThinkingLevel("high");
		await thread.session.setModel(b);
		thread.session.setSessionThinkingLevel("low");
		await thread.session.setModel(a);
		expect(thread.session.thinkingLevel).toBe("high");
		expect(thread.session.thinkingLevelSource).toBe("session");
		expect(thread.settingsManager.getModelThinkingLevel(a.provider, a.id)).toBeUndefined();
	});

	it("falls back to the model's global last-used level when the session has none", async () => {
		const thread = await open();
		const a = requireModel(thread, "model-a");
		const b = requireModel(thread, "model-b");
		await thread.session.setModel(b);
		thread.settingsManager.setModelThinkingLevel(a.provider, a.id, "minimal");
		await thread.session.setModel(a);
		expect(thread.session.thinkingLevel).toBe("minimal");
		expect(thread.session.thinkingLevelSource).toBe("global");
	});

	it("clamps a restored level the model cannot run and says so", async () => {
		const thread = await open();
		const a = requireModel(thread, "model-a");
		const c = requireModel(thread, "on-off-c");
		makeOnOffOnly(c);
		await thread.session.setModel(a);
		thread.session.setSessionThinkingLevel("low");
		expect(thread.session.thinkingLevelSource).toBe("explicit");
		// A level remembered while the model offered more tiers than its catalog entry offers now.
		thread.settingsManager.setModelThinkingLevel(c.provider, c.id, "minimal");
		await thread.session.setModel(c);
		expect(thread.session.getAvailableThinkingLevels()).not.toContain("minimal");
		expect(thread.session.thinkingLevel).not.toBe("minimal");
		expect(thread.session.thinkingLevelSource).toBe("clamped");
		await thread.session.setModel(a);
		expect(thread.session.thinkingLevel).toBe("low");
		expect(thread.session.thinkingLevelSource).toBe("session");
	});

	it("rebuilds the per-model map from the session file on resume", async () => {
		const thread = await open({ persistSession: true });
		const a = requireModel(thread, "model-a");
		const b = requireModel(thread, "model-b");
		await thread.session.setModel(a);
		thread.session.setSessionThinkingLevel("high");
		await thread.session.setModel(b);
		thread.session.setSessionThinkingLevel("low");
		await thread.session.sessionManager.persistHeaderNow();
		const file = thread.session.sessionFile;
		if (!file) throw new Error("expected a persisted session file");

		const resumed = await open({ siblingOf: thread, sessionManager: SessionManager.open(file) });
		expect(resumed.session.getSessionModelThinkingLevels()).toEqual({
			[`${a.provider}/${a.id}`]: "high",
			[`${b.provider}/${b.id}`]: "low",
		});
		await resumed.session.setModel(a);
		expect(resumed.session.thinkingLevel).toBe("high");
		expect(resumed.session.thinkingLevelSource).toBe("session");
	});

	it("exposes the level, its source and the session map through get_state", async () => {
		const thread = await open();
		const a = requireModel(thread, "model-a");
		const b = requireModel(thread, "model-b");
		await thread.session.setModel(a);
		thread.session.setSessionThinkingLevel("high");
		await thread.session.setModel(b);
		thread.session.setSessionThinkingLevel("low");
		await thread.session.setModel(a);

		const state = buildRpcSessionState(thread.session);
		expect(state.thinkingLevel).toBe("high");
		expect(state.thinkingLevelSource).toBe("session");
		expect(state.sessionModelThinkingLevels).toEqual({
			[`${a.provider}/${a.id}`]: "high",
			[`${b.provider}/${b.id}`]: "low",
		});
	});
});
