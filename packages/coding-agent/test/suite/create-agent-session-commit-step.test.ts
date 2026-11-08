import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepCommit } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestResourceLoader } from "../utilities.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

async function sessionWith(commitStep?: (step: StepCommit) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "c2-commit-step-"));
	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("done")]);
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: join(dir, "models.json") });
	const model = faux.getModel();
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model,
		modelRuntime,
		settingsManager: SettingsManager.inMemory(),
		sessionManager: SessionManager.inMemory(dir),
		resourceLoader: createTestResourceLoader(),
		...(commitStep ? { commitStep } : {}),
	});
	cleanups.push(() => {
		session.dispose();
		faux.unregister();
		rmSync(dir, { recursive: true, force: true });
	});
	return session;
}

describe("C2: createAgentSession forwards commitStep to the Agent it builds (custody C.P3)", () => {
	it("commits each step of a session built with commitStep", async () => {
		const commits: string[] = [];
		const session = await sessionWith(async (step) => {
			commits.push(step.message.stopReason);
		});

		await session.prompt("go");

		expect(commits).toEqual(["stop"]);
	});

	it("leaves a session built without commitStep uncommitted and unchanged", async () => {
		const session = await sessionWith();

		await session.prompt("go");

		expect(session.agent.state.messages.at(-1)?.role).toBe("assistant");
	});
});
