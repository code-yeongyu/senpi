import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const TINY = { id: "tiny", contextWindow: 16_000, maxTokens: 4_000 };
const ROOMY = { id: "roomy", contextWindow: 400_000, maxTokens: 32_000 };

async function startWithoutDefault(harness: Harness, sessionManager = SessionManager.inMemory(harness.tempDir)) {
	return createAgentSession({
		cwd: harness.tempDir,
		agentDir: join(harness.tempDir, "sdk-agent"),
		modelRegistry: harness.modelRegistry,
		authStorage: harness.authStorage,
		sessionManager,
	});
}

describe("senpi#3333 an automatic startup pick that cannot start", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("#given no default model and a first available model too small to start #when a session starts #then it runs on the next model that fits and says why", async () => {
		const harness = await createHarness({ models: [TINY, ROOMY], withConfiguredAuth: true });
		harnesses.push(harness);

		const created = await startWithoutDefault(harness);

		expect(created.session.model?.id).toBe("roomy");
		expect(created.modelFallbackMessage).toContain(`${harness.getModel("tiny")?.provider}/tiny`);
		expect(created.modelFallbackMessage).toContain("No usable default model is set");
		created.session.dispose();
	});

	it("#given no default model and no available model that fits #when a session starts #then the refusal names the automatic pick and what to do", async () => {
		const harness = await createHarness({ models: [TINY], withConfiguredAuth: true });
		harnesses.push(harness);

		const error = await startWithoutDefault(harness).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		expect(error).toMatchObject({ name: "ModelUsabilityBudgetError", projection: { admission: "start" } });
		expect(error instanceof Error ? error.message : "").toContain(
			"picked automatically because no usable default model is set",
		);
	});

	it("#given a model the caller chose #when it cannot start #then it is refused, never replaced", async () => {
		const harness = await createHarness({ models: [TINY, ROOMY], withConfiguredAuth: true });
		harnesses.push(harness);
		const tiny = harness.getModel("tiny");
		if (!tiny) throw new Error("missing tiny fixture");

		const error = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "sdk-agent"),
			modelRegistry: harness.modelRegistry,
			authStorage: harness.authStorage,
			sessionManager: SessionManager.inMemory(harness.tempDir),
			model: tiny,
		}).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		expect(error).toMatchObject({
			name: "ModelUsabilityBudgetError",
			projection: { model: `${tiny.provider}/tiny` },
		});
		expect(error instanceof Error ? error.message : "").toContain("Choose a model with a larger context window");
	});

	it("#given an automatic pick that was replaced #when the session log is read #then it records only the model that ran", async () => {
		const harness = await createHarness({ models: [TINY, ROOMY], withConfiguredAuth: true });
		harnesses.push(harness);
		const sessionManager = SessionManager.inMemory(harness.tempDir);

		const created = await startWithoutDefault(harness, sessionManager);

		const modelEntries = sessionManager
			.getEntries()
			.filter((entry) => entry.type === "model_change")
			.map((entry) => (entry as { modelId?: string }).modelId);
		expect(modelEntries).toEqual(["roomy"]);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "thinking_level_change")).toHaveLength(1);
		created.session.dispose();
	});
});
