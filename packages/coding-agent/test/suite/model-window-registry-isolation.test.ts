import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { availableModelsData } from "../../src/modes/rpc/session-control-actions-data.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";
import { model } from "./recommended-models-harness.ts";

describe("extension model window registry views", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("uses the session overlay when cycling to a favorite model", async () => {
		const harness = await createHarness({
			models: [
				{ id: "first", name: "First", contextWindow: 32_000 },
				{ id: "next", name: "Next", contextWindow: 32_000 },
			],
			extensionFactories: [(pi) => pi.setModelWindowOverrides("faux", { next: 100_000 })],
		});
		harnesses.push(harness);
		const first = harness.getModel("first");
		const next = harness.getModel("next");
		if (!first || !next) throw new Error("Fixture models are missing");
		harness.session.setFavoriteModels([{ model: first }, { model: next }]);
		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("next");
		expect(harness.session.model?.contextWindow).toBe(100_000);
	});

	it("applies the overlay when selecting a model from the shared host catalog", async () => {
		const harness = await createHarness({
			models: [
				{ id: "first", name: "First", contextWindow: 128_000 },
				{ id: "next", name: "Next", contextWindow: 128_000 },
			],
			extensionFactories: [(pi) => pi.setModelWindowOverrides("faux", { next: 200_000 })],
		});
		harnesses.push(harness);
		const next = harness.getModel("next");
		if (!next) throw new Error("Fixture model is missing");
		expect((await availableModelsData(harness.session)).models).toContainEqual(
			expect.objectContaining({ provider: "faux", id: "next", contextWindow: 200_000 }),
		);
		await harness.session.setSessionModel(next);
		expect(harness.session.model?.contextWindow).toBe(200_000);
	});

	it("does not replace the active model for no-change reads and unrelated provider refresh", async () => {
		let api: ExtensionAPI | undefined;
		let modelSelectCount = 0;
		const harness = await createHarness({
			models: [{ id: "fixture", name: "Fixture", contextWindow: 128_000 }],
			extensionFactories: [
				(pi) => {
					api = pi;
					pi.setModelWindowOverrides("faux", { fixture: 200_000 });
					pi.on("model_select", () => {
						modelSelectCount++;
					});
				},
			],
		});
		harnesses.push(harness);
		if (!api) throw new Error("Extension API was not registered");
		const selected = harness.session.model;
		if (!selected) throw new Error("Fixture model is missing");
		const entries = harness.sessionManager.getEntries().length;
		const changes = harness.eventsOfType("model_changed").length;
		for (let index = 0; index < 3; index++) {
			harness.session.modelRegistry.getAll();
			harness.session.modelRegistry.find(selected.provider, selected.id);
			await harness.session.modelRegistry.refresh({ allowNetwork: false });
			expect(harness.session.model).toBe(selected);
		}
		api.registerProvider("unrelated", {
			api: selected.api,
			baseUrl: selected.baseUrl,
			apiKey: "faux-key",
			models: [{ ...selected, id: "other" }],
		});
		expect(harness.session.model).toBe(selected);
		expect(harness.sessionManager.getEntries()).toHaveLength(entries);
		expect(harness.eventsOfType("model_changed")).toHaveLength(changes);
		expect(modelSelectCount).toBe(0);
		api.setModelWindowOverrides(selected.provider, { [selected.id]: 64_000 });
		expect(harness.session.modelRegistry.find(selected.provider, selected.id)?.contextWindow).toBe(64_000);
		api.registerProvider("unrelated", {
			api: selected.api,
			baseUrl: selected.baseUrl,
			apiKey: "faux-key",
			models: [{ ...selected, id: "other" }],
		});
		expect(harness.session.model).toBe(selected);
		api.registerProvider(selected.provider, {
			api: selected.api,
			baseUrl: selected.baseUrl,
			apiKey: "faux-key",
			models: [{ ...selected, maxTokens: selected.maxTokens + 1 }],
		});
		expect(harness.session.model).not.toBe(selected);
		expect(harness.session.model?.maxTokens).toBe(selected.maxTokens + 1);
		expect(harness.session.model?.contextWindow).toBe(selected.contextWindow);
		const other = harness.session.modelRegistry.find("unrelated", "other");
		if (!other) throw new Error("Unrelated fixture model is missing");
		await harness.session.setSessionModel(other);
		expect(harness.eventsOfType("model_changed")).toHaveLength(changes + 1);
		expect(modelSelectCount).toBe(1);
	});

	it("isolates sessions even when the SDK caller supplies the same registry", async () => {
		const fixture = model("fixture");
		const hidden = model("hidden");
		const auth = AuthStorage.inMemory();
		await auth.modify(fixture.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const runtime = await ModelRuntime.create({ credentials: auth, modelsPath: null, allowModelNetwork: false });
		await runtime.registerProvider(fixture.provider, {
			api: fixture.api,
			baseUrl: fixture.baseUrl,
			models: [fixture, hidden],
		});
		const registry = new ModelRegistry(runtime, auth);
		const find = registry.find.bind(registry);
		const provided = { ...fixture };
		const getAll = registry.getAll.bind(registry);
		const getAvailable = registry.getAvailable.bind(registry);
		const findSpy = vi.spyOn(registry, "find").mockImplementation((provider, id) => {
			if (id === hidden.id) return undefined;
			if (provider === fixture.provider && id === fixture.id) return provided;
			return find(provider, id);
		});
		const allSpy = vi
			.spyOn(registry, "getAll")
			.mockImplementation(() => getAll().filter((entry) => entry.id !== hidden.id));
		const availableSpy = vi
			.spyOn(registry, "getAvailable")
			.mockImplementation(() => getAvailable().filter((entry) => entry.id !== hidden.id));
		const settings = SettingsManager.inMemory({ defaultProvider: fixture.provider, defaultModel: fixture.id });
		const makeSession = async (window: number, sessionManager = SessionManager.inMemory("/tmp")) => {
			const extensionsResult = await createTestExtensionsResult([
				(pi) => pi.setModelWindowOverrides(fixture.provider, { [fixture.id]: window }),
			]);
			return (
				await createAgentSession({
					cwd: "/tmp",
					modelRegistry: registry,
					settingsManager: settings,
					sessionManager,
					resourceLoader: createTestResourceLoader({ extensionsResult }),
				})
			).session;
		};
		const a = await makeSession(180_000);
		const b = await makeSession(240_000);
		const history = SessionManager.inMemory("/tmp");
		history.appendModelChange(fixture.provider, fixture.id);
		history.appendMessage({ role: "user", content: [{ type: "text", text: "resume" }], timestamp: 1 });
		const resumed = await makeSession(210_000, history);
		try {
			expect(a.modelRegistry).toBeInstanceOf(ModelRegistry);
			expect(a.modelRegistry.constructor).toBe(registry.constructor);
			expect(a.model?.contextWindow).toBe(180_000);
			expect(b.model?.contextWindow).toBe(240_000);
			expect(a.modelRegistry.find(fixture.provider, fixture.id)?.contextWindow).toBe(180_000);
			expect(b.modelRegistry.find(fixture.provider, fixture.id)?.contextWindow).toBe(240_000);
			const firstRead = a.modelRegistry.find(fixture.provider, fixture.id);
			expect(a.modelRegistry.find(fixture.provider, fixture.id)).toBe(firstRead);
			provided.maxTokens += 1;
			expect(a.modelRegistry.find(fixture.provider, fixture.id)?.maxTokens).toBe(provided.maxTokens);
			expect(b.modelRegistry.find(fixture.provider, fixture.id)?.maxTokens).toBe(provided.maxTokens);
			expect(a.modelRegistry.find(fixture.provider, fixture.id)).not.toBe(firstRead);
			const updatedRead = a.modelRegistry.find(fixture.provider, fixture.id);
			expect(resumed.model?.contextWindow).toBe(210_000);
			expect(resumed.modelRegistry.find(fixture.provider, fixture.id)?.contextWindow).toBe(210_000);
			expect(runtime.getModel(hidden.provider, hidden.id)).toBeDefined();
			expect(a.modelRegistry.find(hidden.provider, hidden.id)).toBeUndefined();
			expect(a.modelRegistry.getAll().filter((entry) => entry.provider === fixture.provider)).toMatchObject([
				{ id: fixture.id, contextWindow: 180_000 },
			]);
			expect(b.modelRegistry.getAll().filter((entry) => entry.provider === fixture.provider)).toMatchObject([
				{ id: fixture.id, contextWindow: 240_000 },
			]);
			expect(a.modelRegistry.getAvailable().filter((entry) => entry.provider === fixture.provider)).toMatchObject([
				{ id: fixture.id, contextWindow: 180_000 },
			]);
			expect(b.modelRegistry.getAvailable().filter((entry) => entry.provider === fixture.provider)).toMatchObject([
				{ id: fixture.id, contextWindow: 240_000 },
			]);
			expect(a.modelRegistry.findOfType("chat", fixture.provider, fixture.id)?.contextWindow).toBe(180_000);
			expect(a.modelRegistry.getModelOfType("chat", fixture.provider, fixture.id)?.contextWindow).toBe(180_000);
			expect(
				a.modelRegistry.getModelsOfType("chat", fixture.provider).find((entry) => entry.id === fixture.id),
			).toMatchObject({ contextWindow: 180_000 });
			expect(
				(await b.modelRegistry.getAvailableOfType("chat", fixture.provider)).find(
					(entry) => entry.id === fixture.id,
				),
			).toMatchObject({ contextWindow: 240_000 });
			const refreshSpy = vi.spyOn(registry, "refresh");
			await a.modelRegistry.refresh({ allowNetwork: false });
			expect(refreshSpy).toHaveBeenCalledOnce();
			expect(a.modelRegistry.find(fixture.provider, fixture.id)?.contextWindow).toBe(180_000);
			expect(a.modelRegistry.find(fixture.provider, fixture.id)).toBe(updatedRead);
			expect(b.modelRegistry.find(fixture.provider, fixture.id)?.contextWindow).toBe(240_000);
			refreshSpy.mockRestore();
			const authSpy = vi.spyOn(registry, "hasConfiguredAuth").mockReturnValue(false);
			expect(a.modelRegistry.hasConfiguredAuth(fixture)).toBe(false);
			authSpy.mockRestore();
		} finally {
			a.dispose();
			b.dispose();
			resumed.dispose();
			findSpy.mockRestore();
			allSpy.mockRestore();
			availableSpy.mockRestore();
		}
	});

	it("updates an ordinary provider window when no session overlay is involved", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			models: [{ id: "fixture", contextWindow: 128_000 }],
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		const selected = harness.session.model;
		if (!api || !selected) throw new Error("Missing provider fixture");
		api.registerProvider(selected.provider, {
			api: selected.api,
			baseUrl: selected.baseUrl,
			apiKey: "faux-key",
			models: [{ ...selected, contextWindow: 100_000 }],
		});
		expect(harness.session.model?.contextWindow).toBe(100_000);
	});
});
