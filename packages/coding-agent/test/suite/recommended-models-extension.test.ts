import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { SessionStartEvent } from "../../src/core/extensions/types.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createAppServerRuntime } from "../../src/modes/app-server/runtime.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { configureModeEnv, scratchRoot, seedFauxConfig } from "./app-server-mode-harness.ts";
import { createHarness, model } from "./recommended-models-harness.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("recommended-models builtin", () => {
	it("#given an off-list saved default #when settings provenance starts #then it keeps the saved default without switching, persisting, or notifying", async () => {
		const offList = model("off-list");
		const harness = createHarness({ active: offList, available: [model("kimi-k3", "kimi-coding")] });

		await harness.start("settings");

		expect(harness.getActiveModel()).toBe(offList);
		expect(harness.settings.getDefaultProvider()).toBeUndefined();
		expect(harness.settings.getDefaultModel()).toBeUndefined();
		expect(harness.settings.getDefaultThinkingLevel()).toBeUndefined();
		expect(harness.notices).toEqual([]);
	});

	it("#given no available recommendation #when an implicit-fallback provenance starts #then it warns once with the prescribed text", async () => {
		const harness = createHarness({ active: model("off-list"), available: [] });

		await harness.start("first-available");
		await harness.select(model("another-off-list"), "fallback");

		expect(harness.notices).toEqual([
			{
				message:
					"Non-recommended model 'off-list': odd behavior is the default state; a working session is the anomaly.",
				type: "warning",
			},
		]);
	});

	it("#given recommended warnings are disabled #when a session starts #then it neither switches nor warns", async () => {
		const kimi = model("kimi-k3", "kimi-coding");
		const harness = createHarness({
			active: model("off-list"),
			available: [kimi],
			settings: { warnings: { offRecommendedModel: true } },
		});

		await harness.start("settings");

		expect(harness.getActiveModel().id).toBe("off-list");
		expect(harness.settings.getDefaultModel()).toBeUndefined();
		expect(harness.notices).toEqual([]);
	});

	it("#given a recommendedModels override #when a session starts #then it follows the override priority", async () => {
		const kimi = model("kimi-k3", "kimi-coding");
		const glm = model("glm-5.2", "zai-coding-plan");
		const harness = createHarness({
			active: model("off-list"),
			available: [kimi, glm],
			settings: { recommendedModels: ["glm-5.2"] },
		});

		await harness.start("provider-default");

		expect(harness.getActiveModel()).toBe(glm);
		expect(harness.settings.getDefaultThinkingLevel()).toBe("max");
	});

	it("#given suffix and k3 aliases #when the active model is already recommended #then it keeps the active model", async () => {
		for (const activeId of ["gpt-5.6-sol-fast", "kimi-k3-ultrafast", "k3"]) {
			const harness = createHarness({
				active: model(activeId),
				available: [model("kimi-k3", "kimi-coding"), model("gpt-5.6-sol", "openai")],
			});

			await harness.start("first-available");

			expect(harness.getActiveModel().id).toBe(activeId);
			expect(harness.notices).toEqual([]);
		}
	});

	it("#given cli or scoped provenance #when an off-list model starts #then it never switches or persists", async () => {
		for (const provenance of ["cli", "scoped"] as const) {
			const harness = createHarness({ active: model("off-list"), available: [model("kimi-k3", "kimi-coding")] });

			await harness.start(provenance);

			expect(harness.getActiveModel().id).toBe("off-list");
			expect(harness.settings.getDefaultModel()).toBeUndefined();
			expect(harness.notices).toEqual([]);
		}
	});

	it("#given the run flag #when a session starts #then it leaves recommended-model behavior disabled", async () => {
		const harness = createHarness({
			active: model("off-list"),
			available: [model("kimi-k3", "kimi-coding")],
			flag: true,
		});

		await harness.start("settings");

		expect(harness.flags.get("no-recommended-models")).toEqual({
			type: "boolean",
			default: false,
			description: "Disable recommended model selection for this run.",
		});
		expect(harness.getActiveModel().id).toBe("off-list");
		expect(harness.notices).toEqual([]);
	});

	it("#given settings selection #when the SDK emits session_start #then the provenance reaches extensions", async () => {
		const saved = model("off-list");
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(saved.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: null,
			allowModelNetwork: false,
		});
		modelRuntime.registerProvider(saved.provider, {
			baseUrl: saved.baseUrl,
			api: saved.api,
			models: [
				{
					id: saved.id,
					name: saved.name,
					api: saved.api,
					reasoning: saved.reasoning,
					input: saved.input,
					cost: saved.cost,
					contextWindow: saved.contextWindow,
					maxTokens: saved.maxTokens,
				},
			],
		});
		const events: SessionStartEvent[] = [];
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("session_start", (event) => {
					events.push(event);
				});
			},
		]);
		const { session } = await createAgentSession({
			cwd: "/tmp",
			modelRuntime,
			settingsManager: SettingsManager.inMemory({ defaultProvider: saved.provider, defaultModel: saved.id }),
			sessionManager: SessionManager.inMemory("/tmp"),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		try {
			await session.bindExtensions({});
			expect(events).toEqual([{ type: "session_start", reason: "startup", initialModelProvenance: "settings" }]);
		} finally {
			session.dispose();
		}
	});

	it("#given an app-server faux settings default #when recommended models initialize #then the faux model remains selected", async () => {
		const root = await scratchRoot();
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("faux response")]);
		await seedFauxConfig(root, faux);
		configureModeEnv(root);
		const runtime = createAppServerRuntime(() => {});
		const entry = await runtime.threads.createThread({ cwd: root });
		try {
			expect(entry.session.model?.provider).toBe(faux.getModel().provider);
			expect(entry.session.model?.id).toBe(faux.getModel().id);

			await entry.session.prompt("use the configured faux model");

			expect(faux.state.callCount).toBe(1);
		} finally {
			entry.session.dispose();
			runtime.dispose();
			faux.unregister();
		}
	});

	it("#given builtin registration #when extensions are enumerated #then recommended-models can be disabled by id", () => {
		expect(builtinExtensions.some((extension) => extension.id === "recommended-models")).toBe(true);
	});
});
