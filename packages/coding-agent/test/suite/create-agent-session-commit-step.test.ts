import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepCommit } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.ts";
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

	it("passes no commitStep to the Agent of a session built without one", async () => {
		const session = await sessionWith();
		const loopOwner = session.agent as unknown as { createLoopConfig(): Record<string, unknown> };

		expect(Object.hasOwn(loopOwner.createLoopConfig(), "commitStep")).toBe(false);
		await session.prompt("go");
		expect(session.agent.state.messages.at(-1)?.role).toBe("assistant");
	});

	it("forwards commitStep through createAgentSessionFromServices, and not when unset", async () => {
		const loopKeys = async (commitStep?: (step: StepCommit) => Promise<void>) => {
			const dir = mkdtempSync(join(tmpdir(), "c2-services-"));
			const settingsManager = SettingsManager.inMemory();
			const services = await createAgentSessionServices({ cwd: dir, agentDir: dir, settingsManager });
			const { session } = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(dir),
				...(commitStep ? { commitStep } : {}),
			});
			cleanups.push(() => {
				session.dispose();
				rmSync(dir, { recursive: true, force: true });
			});
			const loopOwner = session.agent as unknown as { createLoopConfig(): Record<string, unknown> };
			return Object.hasOwn(loopOwner.createLoopConfig(), "commitStep");
		};

		expect(await loopKeys(async () => {})).toBe(true);
		expect(await loopKeys()).toBe(false);
	});
});
