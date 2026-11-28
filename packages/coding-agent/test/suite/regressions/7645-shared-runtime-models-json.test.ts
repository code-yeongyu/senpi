import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../../../src/core/agent-session-services.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";

/**
 * senpi#7645: the in-process multi-session host builds one ModelRuntime at start and shares it with every session.
 * A provider written to models.json while the host had no open session (so no config-reload watcher saw the edit)
 * must still reach the next session the host opens, or that session's first turn fails "No API key found".
 */
describe("a session opened on a shared runtime reads the current models.json (senpi#7645)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function workspace() {
		const root = mkdtempSync(join(tmpdir(), "senpi-7645-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		return { agentDir, cwd };
	}

	// The host's construction (main.ts, multi-session branch).
	const hostRuntime = (agentDir: string) =>
		ModelRuntime.create({
			credentials: AuthStorage.create(join(agentDir, "auth.json")),
			authPath: join(agentDir, "auth.json"),
			agentDir,
			modelsPath: join(agentDir, "models.json"),
		});

	const writeProvider = (agentDir: string, apiKey: string) =>
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"late-provider": {
						baseUrl: "https://late-provider.test/v1",
						api: "openai-completions",
						apiKey,
						models: [
							{
								id: "late-model",
								name: "Late model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128000,
								maxTokens: 4096,
							},
						],
					},
				},
			}),
		);

	it("serves a provider added to models.json after the host started", async () => {
		const { agentDir, cwd } = workspace();
		const modelRuntime = await hostRuntime(agentDir);
		writeProvider(agentDir, "late-key");

		const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime });

		const model = services.modelRegistry.find("late-provider", "late-model");
		expect(model?.id).toBe("late-model");
		if (model === undefined) return;
		expect(services.modelRegistry.hasConfiguredAuth(model)).toBe(true);
		const auth = await services.modelRegistry.getApiKeyAndHeaders(model);
		expect(auth.ok && auth.apiKey).toBe("late-key");
	});

	it("serves a key changed in models.json after an earlier session opened", async () => {
		const { agentDir, cwd } = workspace();
		writeProvider(agentDir, "first-key");
		const modelRuntime = await hostRuntime(agentDir);
		await createAgentSessionServices({ cwd, agentDir, modelRuntime });
		writeProvider(agentDir, "second-key");

		const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime });

		const model = services.modelRegistry.find("late-provider", "late-model");
		if (model === undefined) throw new Error("late-provider/late-model is not listed");
		const auth = await services.modelRegistry.getApiKeyAndHeaders(model);
		expect(auth.ok && auth.apiKey).toBe("second-key");
	});

	it("rebuilds no provider beyond its own registrations when models.json is unchanged (senpi#1844)", async () => {
		const { agentDir, cwd } = workspace();
		writeProvider(agentDir, "same-key");
		const modelRuntime = await hostRuntime(agentDir);
		await createAgentSessionServices({ cwd, agentDir, modelRuntime });
		const refresh = vi.spyOn(modelRuntime, "refresh");

		await createAgentSessionServices({ cwd, agentDir, modelRuntime });

		expect(refresh.mock.calls.every(([options]) => options?.providers !== undefined)).toBe(true);
	});
});
