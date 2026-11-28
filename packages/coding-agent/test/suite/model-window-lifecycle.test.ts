import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";
import { model } from "./recommended-models-harness.ts";

describe("extension model window lifecycle", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("removes a retired extension's windows on reload and rejects its stale API", async () => {
		const fixture = { ...model("fixture"), contextWindow: 372_000, maxTokens: 32_000 };
		const other = { ...fixture, id: "other", name: "Other" };
		const auth = AuthStorage.inMemory();
		await auth.modify(fixture.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const runtime = await ModelRuntime.create({ credentials: auth, modelsPath: null, allowModelNetwork: false });
		await runtime.registerProvider(fixture.provider, {
			api: fixture.api,
			baseUrl: fixture.baseUrl,
			models: [fixture, other],
		});
		let enabled = true;
		let oldApi: ExtensionAPI | undefined;
		const load = () =>
			createTestExtensionsResult(
				enabled
					? [
							(pi) => {
								oldApi = pi;
								pi.setModelWindowOverrides(fixture.provider, { [fixture.id]: 1_000_000 });
							},
						]
					: [],
			);
		let extensions = await load();
		const baseLoader = createTestResourceLoader();
		const loader = {
			...baseLoader,
			getExtensions: () => extensions,
			reload: async () => {
				extensions = await load();
			},
		};
		const { session } = await createAgentSession({
			cwd: "/tmp",
			modelRuntime: runtime,
			model: fixture,
			settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } }),
			sessionManager: SessionManager.inMemory("/tmp"),
			resourceLoader: loader,
		});
		try {
			const notices: string[] = [];
			await session.bindExtensions({
				uiContext: createTestUiContext({
					notify: (_message, level) => {
						if (level) notices.push(level);
					},
				}),
			});
			expect(session.model?.contextWindow).toBe(1_000_000);
			const firstApi = oldApi;
			if (!firstApi) throw new Error("Extension API was not registered");
			const selected = session.model;
			const entries = session.sessionManager.getEntries().length;
			await session.reload();
			expect(session.model).toBe(selected);
			expect(session.sessionManager.getEntries()).toHaveLength(entries);
			expect(() => firstApi.setModelWindowOverrides(fixture.provider, {})).toThrow();

			let signalAuth: () => void = () => {};
			const authStarted = new Promise<void>((resolve) => {
				signalAuth = resolve;
			});
			let releaseAuth: () => void = () => {};
			const authGate = new Promise<void>((resolve) => {
				releaseAuth = resolve;
			});
			const checkAuth = runtime.checkAuth.bind(runtime);
			let holdNextCheck = true;
			const authSpy = vi.spyOn(runtime, "checkAuth").mockImplementation(async (provider, options) => {
				if (holdNextCheck) {
					holdNextCheck = false;
					signalAuth();
					await authGate;
				}
				return checkAuth(provider, options);
			});
			enabled = false;
			const reloading = session.reload();
			const timeout = Promise.withResolvers<never>();
			const timer = setTimeout(() => timeout.reject(new Error("Reload did not reach model authentication")), 4_000);
			try {
				await Promise.race([authStarted, timeout.promise]);
				const userChoice = session.modelRegistry.find(other.provider, other.id);
				if (!userChoice) throw new Error("User target is missing");
				await session.setSessionModel(userChoice, { source: "sdk" });
			} finally {
				clearTimeout(timer);
				releaseAuth();
				await reloading;
				authSpy.mockRestore();
			}
			expect(session.model?.id).toBe(other.id);
			const restored = session.modelRegistry.find(fixture.provider, fixture.id);
			if (!restored) throw new Error("Fixture model is missing after reload");
			await session.setSessionModel(restored, { source: "sdk" });
			expect(session.modelRegistry.find(fixture.provider, fixture.id)?.contextWindow).toBe(fixture.contextWindow);
			expect(session.model?.contextWindow).toBe(fixture.contextWindow);
			expect(() => oldApi?.setModelWindowOverrides(fixture.provider, { [fixture.id]: 300_000 })).toThrow();
			enabled = true;
			await session.reload();
			expect(session.modelRegistry.find(fixture.provider, fixture.id)?.contextWindow).toBe(1_000_000);
			expect(session.model?.contextWindow).toBe(1_000_000);

			session.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "large live context ".repeat(30_000) }],
				timestamp: 1,
			});
			session.sessionManager.appendMessage({
				...fauxAssistantMessage("earlier response"),
				api: fixture.api,
				provider: fixture.provider,
				model: fixture.id,
				usage: {
					input: 150_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 151_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 2,
			});
			session.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "continue" }],
				timestamp: 3,
			});
			session.sessionManager.appendMessage({
				...fauxAssistantMessage("still working"),
				api: fixture.api,
				provider: fixture.provider,
				model: fixture.id,
				usage: {
					input: 320_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 321_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 4,
			});
			session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
			enabled = false;
			await session.reload();
			expect(session.model?.contextWindow).toBe(1_000_000);
			expect(session.pendingModelSwitch?.model.contextWindow).toBe(fixture.contextWindow);
			expect(notices).toContain("warning");

			enabled = true;
			await session.reload();
			expect(session.model?.contextWindow).toBe(1_000_000);
			expect(session.pendingModelSwitch).toBeUndefined();

			const userTarget = session.modelRegistry.find(other.provider, other.id);
			if (!userTarget) throw new Error("User target is missing");
			await session.setSessionModel(userTarget, { source: "sdk" });
			expect(session.pendingModelSwitch?.model.id).toBe(other.id);
			notices.length = 0;
			enabled = false;
			await session.reload();
			expect(session.pendingModelSwitch?.model.id).toBe(other.id);
			expect(notices).toContain("warning");
		} finally {
			session.dispose();
		}
	});

	it("preserves an active fallback when reload changes only its window", async () => {
		let enabled = true;
		const load = () =>
			createTestExtensionsResult(enabled ? [(pi) => pi.setModelWindowOverrides("faux", { fallback: 200_000 })] : []);
		let extensions = await load();
		const baseLoader = createTestResourceLoader();
		const loader = {
			...baseLoader,
			getExtensions: () => extensions,
			reload: async () => {
				extensions = await load();
			},
		};
		const harness = await createHarness({
			models: [
				{ id: "primary", contextWindow: 128_000 },
				{ id: "fallback", contextWindow: 128_000 },
			],
			fallbackNow: () => 0,
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { "faux/primary": ["faux/fallback"] } } },
			resourceLoader: loader,
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage("refusal", {
				stopReason: "error",
				errorMessage: "misleading_success_output",
				stopDetails: { type: "refusal" },
			}),
			fauxAssistantMessage("fallback answer"),
		]);
		await harness.session.prompt("hello");
		const before = harness.getExtensionRunner().createContext().sessionSettings.getFallbackStatus();
		expect(before).toMatchObject({ active: true, originalSelector: "faux/primary", pinned: true });
		expect(harness.session.model?.contextWindow).toBe(200_000);

		enabled = false;
		await harness.session.reload();

		expect(harness.session.model?.contextWindow).toBe(128_000);
		expect(harness.getExtensionRunner().createContext().sessionSettings.getFallbackStatus()).toEqual(before);
	});

	it.each([false, true])("keeps the pick across reload (hold auth: %s)", async (holdAuth) => {
		let extensions = await createTestExtensionsResult([
			(pi) => pi.setModelWindowOverrides("faux", { next: 250_000 }),
		]);
		const loading = Promise.withResolvers<void>();
		const finishLoading = Promise.withResolvers<void>();
		const loader = {
			...createTestResourceLoader(),
			getExtensions: () => extensions,
			reload: async () => {
				loading.resolve();
				await finishLoading.promise;
				extensions = await createTestExtensionsResult([]);
			},
		};
		const harness = await createHarness({
			models: [
				{ id: "first", contextWindow: 128_000 },
				{ id: "next", contextWindow: 128_000 },
			],
			resourceLoader: loader,
		});
		harnesses.push(harness);
		const checkingAuth = Promise.withResolvers<void>();
		const finishAuth = Promise.withResolvers<void>();
		const runtime = harness.session.modelRuntime;
		const checkAuth = runtime.checkAuth.bind(runtime);
		let authSpy: ReturnType<typeof vi.spyOn> | undefined;
		let selecting: Promise<unknown> | undefined;
		const reloading = harness.session.reload();
		try {
			await Promise.race([loading.promise, reloading]);
			const next = harness.session.modelRegistry.find("faux", "next");
			if (!next) throw new Error("Missing next model");
			if (holdAuth) {
				authSpy = vi.spyOn(runtime, "checkAuth").mockImplementationOnce(async (provider, options) => {
					checkingAuth.resolve();
					await finishAuth.promise;
					return checkAuth(provider, options);
				});
			}
			selecting = harness.session.setSessionModel(next, { source: "sdk" });
			if (holdAuth) {
				await Promise.race([checkingAuth.promise, selecting]);
				expect(harness.session.model?.id).toBe("first");
			} else {
				await selecting;
				expect(harness.session.model).toMatchObject({ id: "next", contextWindow: 250_000 });
			}
		} finally {
			finishLoading.resolve();
			try {
				await reloading;
			} finally {
				finishAuth.resolve();
				authSpy?.mockRestore();
				await selecting;
			}
		}
		expect(harness.session.model).toMatchObject({ id: "next", contextWindow: 128_000 });
	});
});
