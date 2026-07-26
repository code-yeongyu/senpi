import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../../src/core/agent-session-runtime.ts";

/**
 * timings.ts reads PI_TIMING once at module evaluation, so every module in the
 * reload path must be imported AFTER the env stub. resetModules + dynamic
 * import keeps the faux provider and the session on one module graph.
 */
describe("reload phase timings", () => {
	const cleanups: Array<() => void | Promise<void>> = [];

	beforeEach(() => {
		vi.resetModules();
		vi.stubEnv("PI_TIMING", "1");
	});

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it("records a reload timing namespace covering every reload phase", async () => {
		const { getTimings } = await import("../../src/core/timings.ts");
		const { registerFauxProvider } = await import("@earendil-works/pi-ai/compat");
		const { AuthStorage } = await import("../../src/core/auth-storage.ts");
		const { ModelRuntime } = await import("../../src/core/model-runtime.ts");
		const { SessionManager } = await import("../../src/core/session-manager.ts");
		const { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices } = await import(
			"../../src/core/agent-session-runtime.ts"
		);

		const tempDir = join(tmpdir(), `pi-reload-timings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });

		const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				modelRuntime,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi) => {
							pi.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((registeredModel) => ({
									id: registeredModel.id,
									name: registeredModel.name,
									api: registeredModel.api,
									reasoning: registeredModel.reasoning,
									input: registeredModel.input,
									cost: registeredModel.cost,
									contextWindow: registeredModel.contextWindow,
									maxTokens: registeredModel.maxTokens,
								})),
							});
						},
					],
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir,
			sessionManager: SessionManager.create(tempDir),
		});

		cleanups.push(() => {
			runtime.session.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await runtime.session.reload();

		const labels = getTimings("reload").map((entry) => entry.label);
		expect(labels).toEqual(["shutdown", "settings", "models", "resources", "runtime", "lifecycle"]);
	});
});
