import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type {
	ExtensionAPI,
	LoadExtensionsResult,
	SessionExtensionsRemovedEvent,
} from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const cleanups: Array<() => void> = [];

async function createReplacingSession(removeProbe: () => boolean) {
	const tempDir = join(tmpdir(), `pi-sr-removal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const agentDir = join(tempDir, "agent");
	mkdirSync(agentDir, { recursive: true });

	const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: join(agentDir, "models.json"),
	});

	const removedEvents: SessionExtensionsRemovedEvent[] = [];
	const probePath = "<inline:removal-probe>";

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			modelRuntime,
			resourceLoaderOptions: {
				extensionsOverride: (base: LoadExtensionsResult) =>
					removeProbe()
						? { ...base, extensions: base.extensions.filter((extension) => extension.path !== probePath) }
						: base,
				extensionFactories: [
					(pi) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((m) => ({
								id: m.id,
								name: m.name,
								api: m.api,
								reasoning: m.reasoning,
								input: m.input,
								cost: m.cost,
								contextWindow: m.contextWindow,
								maxTokens: m.maxTokens,
							})),
						});
					},
					{
						name: "removal-probe",
						factory: (pi: ExtensionAPI) => {
							pi.on("session_extensions_removed", (event: SessionExtensionsRemovedEvent) => {
								removedEvents.push(event);
							});
						},
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
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	return { runtime, removedEvents, probePath };
}

describe("extension removal notification on session replacement", () => {
	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("notifies an extension dropped from the new runtime during /new", async () => {
		let drop = false;
		const { runtime, removedEvents, probePath } = await createReplacingSession(() => drop);
		drop = true;

		await runtime.newSession();

		expect(removedEvents).toEqual([
			{ type: "session_extensions_removed", reason: "new", removed: [{ path: probePath, resolvedPath: probePath }] },
		]);
	});
});
