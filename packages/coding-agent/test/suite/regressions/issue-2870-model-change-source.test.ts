import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { ModelChangeEntry, ThinkingLevelChangeEntry } from "../../../src/core/session-manager.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createRpcConnectionHandler, type RpcConnectionSink } from "../../../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#2870: a mid-session model switch was recorded with no source, so a switch nobody remembered making could not
// be attributed; and every terminal selection silently rewrote the global defaultModel for every later session.

const MODELS = [
	{ id: "main", name: "Main", reasoning: true },
	{ id: "other", name: "Other", reasoning: true },
];

function modelChanges(harness: Harness): ModelChangeEntry[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry): entry is ModelChangeEntry => entry.type === "model_change");
}

// Resolves on the session's next model_changed event, so a fire-and-forget selection is awaited, not polled.
function nextModelChanged(harness: Harness): Promise<void> {
	return new Promise((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "model_changed") return;
			unsubscribe();
			resolve();
		});
	});
}

function other(harness: Harness) {
	const model = harness.getModel("other");
	if (model === undefined) throw new Error("missing fixture model");
	return model;
}

describe("issue 2870: every model switch records its source", () => {
	beforeAll(() => initTheme("dark"));
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("an SDK setModel names sdk and still persists the default, as its contract says", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);

		await harness.session.setModel(other(harness));

		expect(modelChanges(harness).map(({ source, actor }) => ({ source, actor }))).toEqual([
			{ source: "sdk", actor: undefined },
		]);
		expect(harness.settingsManager.getDefaultModel()).toBe("other");
	});

	it("a picker selection records picker and its actor, and leaves the default for new sessions alone", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);
		const before = harness.settingsManager.getDefaultModel();

		await harness.session.setSessionModel(other(harness), { source: "picker", actor: "model-selector" });

		const [entry] = modelChanges(harness);
		expect(entry).toMatchObject({ source: "picker", actor: "model-selector", originalModelId: "main" });
		expect(entry?.duringTurn).toBeUndefined();
		expect(harness.settingsManager.getDefaultModel()).toBe(before);
		expect(harness.eventsOfType("model_changed").at(-1)).toMatchObject({
			origin: { source: "picker", actor: "model-selector" },
			duringTurn: false,
		});
	});

	it("a terminal cycle that asks not to persist records cycle and leaves the default alone", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);
		harness.session.setFavoriteModels([{ model: harness.getModel() }, { model: other(harness) }]);
		const before = harness.settingsManager.getDefaultModel();

		await harness.session.cycleModel("forward", { persistDefault: false });

		expect(harness.session.model?.id).toBe("other");
		expect(modelChanges(harness).at(-1)).toMatchObject({ source: "cycle" });
		expect(harness.settingsManager.getDefaultModel()).toBe(before);
	});

	it("an RPC cycle keeps persisting the default and records its own source", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);
		harness.session.setFavoriteModels([{ model: harness.getModel() }, { model: other(harness) }]);

		await harness.session.cycleModel("forward", { origin: { source: "rpc", actor: "cycle_model" } });

		expect(modelChanges(harness).at(-1)).toMatchObject({ source: "rpc", actor: "cycle_model" });
		expect(harness.settingsManager.getDefaultModel()).toBe("other");
	});

	it("an extension's switch names the extension that made it", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			models: MODELS,
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		if (api === undefined) throw new Error("extension was not loaded");

		await api.setSessionModel(other(harness));

		const [entry] = modelChanges(harness);
		expect(entry?.source).toBe("extension");
		expect(typeof entry?.actor).toBe("string");
		expect(entry?.actor?.length).toBeGreaterThan(0);
	});

	it("a switch made during a streaming turn is marked as such, with its thinking re-apply attributed too", async () => {
		const toolStarted = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const hold: AgentTool = {
			name: "hold",
			label: "Hold",
			description: "Runs until released",
			parameters: Type.Object({}),
			execute: async () => {
				toolStarted.resolve();
				await released.promise;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ models: MODELS, tools: [hold] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		harness.session.setThinkingLevel("low");
		const turn = harness.session.prompt("go");
		await toolStarted.promise;

		await harness.session.setSessionModel(other(harness), { source: "control" });
		released.resolve();
		await turn;

		expect(modelChanges(harness).at(-1)).toMatchObject({
			source: "control",
			duringTurn: true,
			originalModelId: "main",
		});
		expect(harness.eventsOfType("model_changed").at(-1)).toMatchObject({ duringTurn: true });
	});

	it("a thinking level a switch re-applies names the switch; one set by hand names nothing", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);
		harness.session.setFavoriteModels([
			{ model: harness.getModel(), thinkingLevel: "low" },
			{ model: other(harness), thinkingLevel: "high" },
		] as Parameters<typeof harness.session.setFavoriteModels>[0]);
		harness.session.setThinkingLevel("low");

		await harness.session.cycleModel("forward", { persistDefault: false });

		const thinking = harness.sessionManager
			.getEntries()
			.filter((entry): entry is ThinkingLevelChangeEntry => entry.type === "thinking_level_change");
		expect(thinking.map((entry) => [entry.thinkingLevel, entry.triggerSource])).toEqual([
			["low", undefined],
			["high", "cycle"],
		]);
	});

	it("writes one session-log line per switch with the source and the models", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);

		await harness.session.setSessionModel(other(harness), { source: "rpc" });

		const log = join(harness.session.agentDir, "logs", "session.log");
		expect(existsSync(log)).toBe(true);
		const lines = readFileSync(log, "utf8")
			.split("\n")
			.filter((line) => line.includes("model_change"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("rpc");
		expect(lines[0]).toContain("/other");
		expect(lines[0]).toContain("/main");
	});

	function interactiveSelection(harness: Harness) {
		const showStatus = vi.fn();
		const fakeThis = {
			session: harness.session,
			footer: { invalidate: () => {} },
			updateEditorBorderColor: () => {},
			showStatus,
			showError: (message: string) => {
				throw new Error(message);
			},
			showWarning: () => {},
			showRiskyMainModelWarning: () => {},
			maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
			checkDaxnutsEasterEgg: () => {},
			ui: { requestRender: () => {} },
			findExactModelMatch: async (term: string) => harness.getModel(term.split("/").at(-1) ?? term),
			selectModelFromUi: Reflect.get(InteractiveMode.prototype, "selectModelFromUi"),
			showModelSelector: () => {
				throw new Error("the picker opened instead of an exact match");
			},
		};
		return { fakeThis, showStatus };
	}

	it("a typed /model <id> records command and leaves the default; /model <id> --default also writes it", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);
		const before = harness.settingsManager.getDefaultModel();
		const { fakeThis, showStatus } = interactiveSelection(harness);
		const handleModelCommand = Reflect.get(InteractiveMode.prototype, "handleModelCommand") as (
			this: unknown,
			argument?: string,
		) => Promise<void>;

		await handleModelCommand.call(fakeThis, "other");
		expect(modelChanges(harness).at(-1)).toMatchObject({ source: "command", modelId: "other" });
		expect(harness.settingsManager.getDefaultModel()).toBe(before);

		await handleModelCommand.call(fakeThis, "main --default");
		expect(modelChanges(harness).at(-1)).toMatchObject({ source: "command", modelId: "main" });
		expect(harness.settingsManager.getDefaultModel()).toBe("main");
		expect(String(showStatus.mock.calls.at(-1)?.[0])).toContain("default model for new sessions");
	});

	it("the model picker's Enter and save chord reach the session through its real callback", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);
		const before = harness.settingsManager.getDefaultModel();
		const { fakeThis } = interactiveSelection(harness);
		let captured: ((model: unknown, selection: { asDefault: boolean }) => void) | undefined;
		const showSelector = (create: (done: () => void) => { component: { onSelectCallback?: unknown } }) => {
			const built = create(() => {});
			captured = Reflect.get(built.component, "onSelectCallback") as typeof captured;
		};
		const showModelSelector = Reflect.get(InteractiveMode.prototype, "showModelSelector") as (this: unknown) => void;
		showModelSelector.call({
			...fakeThis,
			showSelector,
			settingsManager: harness.settingsManager,
			captureFavoritePatternSnapshot: async () => undefined,
			selectModelFromUi: Reflect.get(InteractiveMode.prototype, "selectModelFromUi"),
		});
		if (captured === undefined) throw new Error("the picker exposed no selection callback");

		let changed = nextModelChanged(harness);
		captured.call(undefined, other(harness), { asDefault: false });
		await changed;
		expect(modelChanges(harness).at(-1)).toMatchObject({ source: "picker", actor: "model-selector" });
		expect(harness.settingsManager.getDefaultModel()).toBe(before);

		changed = nextModelChanged(harness);
		captured.call(undefined, harness.getModel("main"), { asDefault: true });
		await changed;
		expect(harness.settingsManager.getDefaultModel()).toBe("main");
	});

	it("an RPC set_model records rpc and keeps persisting the default", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);
		const lines: string[] = [];
		const sink: RpcConnectionSink = { writeRaw: (chunk) => lines.push(chunk), waitForBackpressure: async () => {} };
		const runtimeHost = { session: harness.session, setRebindSession: () => {}, dispose: async () => {} };
		const handler = createRpcConnectionHandler(runtimeHost as unknown as AgentSessionRuntime, sink);
		await handler.ready;
		try {
			await handler.handleInputLine(
				JSON.stringify({ id: "m1", type: "set_model", provider: harness.getModel().provider, modelId: "other" }),
			);

			expect(modelChanges(harness).at(-1)).toMatchObject({ source: "rpc", modelId: "other" });
			expect(harness.settingsManager.getDefaultModel()).toBe("other");
		} finally {
			await handler.dispose();
		}
	});

	it("a retry fallback records fallback with the model it left", async () => {
		const primary = "main";
		const harness = await createHarness({
			models: MODELS,
			settings: {
				retry: {
					enabled: true,
					maxRetries: 0,
					baseDelayMs: 1,
					fallbackChains: { "faux/main": ["faux/other"] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("fallback answer"),
		]);

		await harness.session.prompt("hello");

		expect(harness.session.model?.id).not.toBe(primary);
		expect(modelChanges(harness).at(-1)).toMatchObject({
			source: "fallback",
			reason: "fallback",
			originalModelId: "main",
		});
	});

	it("a cycle records the model it left, so a mid-turn notice replays with both models", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);
		harness.session.setFavoriteModels([{ model: harness.getModel() }, { model: other(harness) }]);

		await harness.session.cycleModel("forward", { persistDefault: false });

		expect(modelChanges(harness).at(-1)).toMatchObject({
			source: "cycle",
			originalModelId: "main",
			modelId: "other",
		});
	});

	it("the favorites picker's selection records picker/favorites through its real callback", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);
		const { fakeThis } = interactiveSelection(harness);
		let onSelect: ((model: unknown) => void) | undefined;
		const showFavoriteModelsSelector = Reflect.get(InteractiveMode.prototype, "showFavoriteModelsSelector") as (
			this: unknown,
		) => Promise<void>;
		await showFavoriteModelsSelector.call({
			...fakeThis,
			showSelector: (create: (done: () => void) => { component: object }) => {
				const built = create(() => {});
				onSelect = (Reflect.get(built.component, "callbacks") as { onSelect: (model: unknown) => void }).onSelect;
			},
			getFavoriteModelIdsForUi: async () => [],
			captureFavoritePatternSnapshot: async () => undefined,
		});
		if (onSelect === undefined) throw new Error("the favorites picker exposed no selection callback");

		const changed = nextModelChanged(harness);
		onSelect(other(harness));
		await changed;

		expect(modelChanges(harness).at(-1)).toMatchObject({ source: "picker", actor: "favorites" });
	});

	it("a session switch to a model with a remembered level names the switch on the re-applied thinking entry", async () => {
		const harness = await createHarness({ models: MODELS });
		harnesses.push(harness);
		harness.settingsManager.setModelThinkingLevel(harness.getModel().provider, "other", "high");
		harness.session.setThinkingLevel("low");

		await harness.session.setSessionModel(other(harness), { source: "control" });

		const thinking = harness.sessionManager
			.getEntries()
			.filter((entry): entry is ThinkingLevelChangeEntry => entry.type === "thinking_level_change");
		expect(thinking.map((entry) => [entry.thinkingLevel, entry.triggerSource])).toEqual([
			["low", undefined],
			["high", "control"],
		]);
	});
});
