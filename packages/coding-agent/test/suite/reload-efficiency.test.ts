import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type {
	ExtensionAPI,
	InlineExtension,
	LoadExtensionsResult,
	SessionExtensionsRemovedEvent,
} from "../../src/core/extensions/types.ts";
import { ModelConfig } from "../../src/core/model-config.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

const cleanups: Array<() => void> = [];

async function createReloadSession(
	options: {
		extensionFactories?: InlineExtension[];
		extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	} = {},
) {
	const tempDir = join(tmpdir(), `pi-reload-eff-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
				extensionsOverride: options.extensionsOverride,
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
					...(options.extensionFactories ?? []),
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

	return { runtime, modelRuntime, agentDir, authStorage };
}

describe("reload does redundant work only once", () => {
	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
		vi.restoreAllMocks();
	});

	it("reloads settings exactly once per session reload", async () => {
		const { runtime } = await createReloadSession();
		const settingsReload = vi.spyOn(runtime.services.settingsManager, "reload");

		await runtime.session.reload();

		expect(settingsReload).toHaveBeenCalledTimes(1);
	});

	it("loads models.json once per model-runtime reload", async () => {
		const { modelRuntime } = await createReloadSession();
		const configLoad = vi.spyOn(ModelConfig, "load");

		await modelRuntime.reloadConfig();

		expect(configLoad).toHaveBeenCalledTimes(1);
	});

	it("runs a single model-availability scan per session reload", async () => {
		const { runtime, authStorage } = await createReloadSession();
		const credentialList = vi.spyOn(authStorage, "list");

		await runtime.session.reload();

		expect(credentialList).toHaveBeenCalledTimes(1);
	});

	it("keeps the trust-probe reload and the post-trust reload when project trust is resolved", async () => {
		const { runtime } = await createReloadSession();
		const settingsReload = vi.spyOn(runtime.services.settingsManager, "reload");

		await runtime.services.resourceLoader.reload({
			resolveProjectTrust: async () => true,
			settingsAlreadyReloadedFor: runtime.services.settingsManager,
		});

		expect(settingsReload).toHaveBeenCalledTimes(2);
	});

	it("still reloads settings when the caller reloaded a different settings manager", async () => {
		const { runtime } = await createReloadSession();
		const settingsReload = vi.spyOn(runtime.services.settingsManager, "reload");
		const unrelatedManager = SettingsManager.inMemory();

		await runtime.services.resourceLoader.reload({ settingsAlreadyReloadedFor: unrelatedManager });

		expect(settingsReload).toHaveBeenCalledTimes(1);
	});

	it("notifies extensions removed from the rebuilt runner during reload", async () => {
		const removedEvents: SessionExtensionsRemovedEvent[] = [];
		let removeProbe = false;
		const probePath = "<inline:reload-removal-probe>";
		const { runtime } = await createReloadSession({
			extensionFactories: [
				{
					name: "reload-removal-probe",
					factory: (pi: ExtensionAPI) => {
						pi.on("session_extensions_removed", (event: SessionExtensionsRemovedEvent) => {
							removedEvents.push(event);
						});
					},
				},
			],
			extensionsOverride: (base) =>
				removeProbe
					? { ...base, extensions: base.extensions.filter((extension) => extension.path !== probePath) }
					: base,
		});
		removeProbe = true;

		await runtime.session.reload();

		expect(removedEvents).toEqual([
			{
				type: "session_extensions_removed",
				reason: "reload",
				removed: [{ path: probePath, resolvedPath: probePath }],
			},
		]);
	});
});
