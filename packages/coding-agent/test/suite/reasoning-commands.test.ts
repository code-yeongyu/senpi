import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.ts";
import reasoningExtension from "../../src/core/extensions/builtin/reasoning/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { getModelRuntime } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * Behavior matrix for the capability-aware `/reasoning` and `/efforts` commands.
 *
 * Model classes come from `classifyReasoningCapability` (core/thinking-levels.ts) and are staged
 * here with real catalog-shaped `thinkingLevelMap` values, never model-id inference:
 * - none      -> `reasoning: false`
 * - always-on -> `{ off: null }`
 * - on-off    -> exactly one non-off level survives the map
 * - graded    -> several non-off levels (with and without xhigh/max)
 *
 * Every user-facing string asserted below is pinned copy from the work plan, not prose.
 */

type ThinkingLevelMap = NonNullable<Model<Api>["thinkingLevelMap"]>;

const GRADED_FULL_MAP: ThinkingLevelMap = { xhigh: "xhigh", max: "max" };
const GRADED_NO_XHIGH_MAP: ThinkingLevelMap = { xhigh: null, max: null };
const ON_OFF_MAP: ThinkingLevelMap = { minimal: null, low: null, medium: null, xhigh: null, max: null };
const ALWAYS_ON_MAP: ThinkingLevelMap = { off: null, xhigh: null, max: null };

interface CommandHarness {
	harness: Harness;
	notify: ReturnType<typeof vi.spyOn>;
	model: Model<string>;
	key: string;
}

describe("reasoning builtin extension (/reasoning + /efforts)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		vi.restoreAllMocks();
	});

	async function createReasoningHarness(options: {
		reasoning?: boolean;
		thinkingLevelMap?: ThinkingLevelMap;
		modelId?: string;
		settings?: Record<string, unknown>;
	}): Promise<CommandHarness> {
		const modelId = options.modelId ?? "faux-reasoner";
		const harness = await createHarness({
			models: [{ id: modelId, reasoning: options.reasoning ?? true }],
			settings: options.settings,
			// File-backed settings: the extension resolves remembered levels through its own
			// SettingsManager over ctx.agentDir, exactly as it does in a real session.
			fileSettings: true,
			extensionFactories: [reasoningExtension],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		if (options.thinkingLevelMap) {
			model.thinkingLevelMap = options.thinkingLevelMap;
		}
		const runner = harness.getExtensionRunner();
		return {
			harness,
			notify: vi.spyOn(runner.getUIContext(), "notify"),
			model,
			key: `${model.provider}/${model.id}`,
		};
	}

	function lastNotify(notify: ReturnType<typeof vi.spyOn>): [string, string | undefined] {
		const calls = notify.mock.calls;
		expect(calls.length).toBeGreaterThan(0);
		const call = calls[calls.length - 1] as [string, string | undefined];
		return call;
	}

	async function runReasoningOnAfterRestart(harness: Harness, model: Model<string>): Promise<string> {
		const agentDir = join(harness.tempDir, "agent");
		const settingsManager = SettingsManager.create(harness.tempDir, agentDir);
		const agent = new Agent({
			getApiKey: () => "faux-key",
			streamFn: streamSimple,
			initialState: { model, systemPrompt: "You are a test assistant.", tools: [] },
		});
		const extensionsResult = await createTestExtensionsResult([reasoningExtension], harness.tempDir);
		const extensionRunnerRef = {};
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			cwd: harness.tempDir,
			agentDir,
			modelRuntime: getModelRuntime(harness.modelRegistry),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			extensionRunnerRef,
		});
		try {
			session.setSessionThinkingLevel(settingsManager.getModelThinkingLevel(model.provider, model.id) ?? "medium");
			await session.bindExtensions({});
			await session.prompt("/reasoning on");
			await settingsManager.flush();
			return session.thinkingLevel;
		} finally {
			session.dispose();
		}
	}

	// =====================================================================
	// /reasoning — status
	// =====================================================================

	it("reports reasoning off for a graded model sitting at off", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		harness.session.setSessionThinkingLevel("off");

		// when
		await harness.session.prompt("/reasoning");

		// then
		expect(lastNotify(notify)).toEqual(["Reasoning: off.", "info"]);
	});

	it("reports the active level for a graded model with reasoning on", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		harness.session.setSessionThinkingLevel("high");

		// when
		await harness.session.prompt("/reasoning");

		// then
		expect(lastNotify(notify)).toEqual(["Reasoning: on (high).", "info"]);
	});

	it("reports reasoning off for a model that cannot reason at all", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({ reasoning: false });

		// when
		await harness.session.prompt("/reasoning");

		// then
		expect(lastNotify(notify)).toEqual(["Reasoning: off.", "info"]);
	});

	// =====================================================================
	// /reasoning on
	// =====================================================================

	it("restores the remembered per-model level with /reasoning on", async () => {
		// given
		const { harness, notify, model } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		harness.settingsManager.setModelThinkingLevel(model.provider, model.id, "xhigh");
		await harness.settingsManager.flush();
		harness.session.setSessionThinkingLevel("off");

		// when
		await harness.session.prompt("/reasoning on");

		// then
		expect(harness.session.thinkingLevel).toBe("xhigh");
		expect(lastNotify(notify)).toEqual(["Reasoning: on (xhigh).", "info"]);
	});

	it("returns to the same pre-off level with and without a restart", async () => {
		// given: continuous session
		const continuous = await createReasoningHarness({
			thinkingLevelMap: GRADED_FULL_MAP,
			settings: { defaultThinkingLevel: "minimal" },
		});
		await continuous.harness.session.bindExtensions({});
		await continuous.harness.session.prompt("/efforts high");
		await continuous.harness.session.prompt("/reasoning off");
		expect(continuous.harness.session.thinkingLevel).toBe("off");

		// when: no restart
		await continuous.harness.session.prompt("/reasoning on");
		const withoutRestart = continuous.harness.session.thinkingLevel;

		// given: same sequence, but discard extension state and reload settings from the same dir
		const restarted = await createReasoningHarness({
			thinkingLevelMap: GRADED_FULL_MAP,
			settings: { defaultThinkingLevel: "minimal" },
		});
		await restarted.harness.session.bindExtensions({});
		await restarted.harness.session.prompt("/efforts high");
		await restarted.harness.session.prompt("/reasoning off");
		await restarted.harness.settingsManager.flush();
		expect(restarted.harness.session.thinkingLevel).toBe("off");

		// when: fresh AgentSession, extension instance, and SettingsManager over the original agent directory
		const afterRestart = await runReasoningOnAfterRestart(restarted.harness, restarted.model);

		// then
		expect(withoutRestart).toBe("high");
		expect(afterRestart).toBe("high");
		expect(afterRestart).toBe(withoutRestart);
	});

	it("falls back to the non-off global default when the model has no memory", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({
			thinkingLevelMap: GRADED_FULL_MAP,
			settings: { defaultThinkingLevel: "low" },
		});
		harness.session.setSessionThinkingLevel("off");

		// when
		await harness.session.prompt("/reasoning on");

		// then
		expect(harness.session.thinkingLevel).toBe("low");
		expect(lastNotify(notify)).toEqual(["Reasoning: on (low).", "info"]);
	});

	it("falls back to medium when neither memory nor a non-off default exists", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({
			thinkingLevelMap: GRADED_FULL_MAP,
			settings: { defaultThinkingLevel: "off" },
		});
		harness.session.setSessionThinkingLevel("off");

		// when
		await harness.session.prompt("/reasoning on");

		// then
		expect(harness.session.thinkingLevel).toBe("medium");
		expect(lastNotify(notify)).toEqual(["Reasoning: on (medium).", "info"]);
	});

	it("clamps a stale restored level without rewriting the durable preference", async () => {
		// given
		// The on/off-only model supports [off, high]; a stale remembered "low" must clamp up to
		// "high" at apply time without rewriting storage, so catalog changes remain reversible.
		const { harness, notify, model } = await createReasoningHarness({ thinkingLevelMap: ON_OFF_MAP });
		harness.settingsManager.setModelLastOnThinkingLevel(model.provider, model.id, "low");
		await harness.settingsManager.flush();
		harness.session.setSessionThinkingLevel("off");

		// when
		await harness.session.prompt("/reasoning on");

		// then
		expect(harness.session.thinkingLevel).toBe("high");
		const reloaded = SettingsManager.create(harness.tempDir, join(harness.tempDir, "agent"));
		expect(reloaded.getModelLastOnThinkingLevel(model.provider, model.id)).toBe("low");
		expect(lastNotify(notify)).toEqual(["Reasoning: on (high).", "info"]);
	});

	it("keeps the current level when /reasoning on runs while reasoning is already on", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		harness.session.setSessionThinkingLevel("high");

		// when
		await harness.session.prompt("/reasoning on");

		// then
		expect(harness.session.thinkingLevel).toBe("high");
		expect(lastNotify(notify)).toEqual(["Reasoning: on (high).", "info"]);
	});

	it("errors on /reasoning on for a non-reasoning model", async () => {
		// given
		const { harness, notify, key } = await createReasoningHarness({ reasoning: false });

		// when
		await harness.session.prompt("/reasoning on");

		// then
		expect(harness.session.thinkingLevel).toBe("off");
		expect(lastNotify(notify)).toEqual([`Model ${key} does not support reasoning.`, "error"]);
	});

	// =====================================================================
	// /reasoning off
	// =====================================================================

	it("turns reasoning off on a graded model", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		harness.session.setSessionThinkingLevel("high");

		// when
		await harness.session.prompt("/reasoning off");

		// then
		expect(harness.session.thinkingLevel).toBe("off");
		expect(lastNotify(notify)).toEqual(["Reasoning: off.", "info"]);
	});

	it("is idempotent for /reasoning off on a non-reasoning model", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({ reasoning: false });

		// when
		await harness.session.prompt("/reasoning off");

		// then
		expect(harness.session.thinkingLevel).toBe("off");
		expect(lastNotify(notify)).toEqual(["Reasoning: off.", "info"]);
	});

	it("refuses /reasoning off on an always-on model", async () => {
		// given
		const { harness, notify, key } = await createReasoningHarness({ thinkingLevelMap: ALWAYS_ON_MAP });
		const before = harness.session.thinkingLevel;

		// when
		await harness.session.prompt("/reasoning off");

		// then
		expect(harness.session.thinkingLevel).toBe(before);
		expect(lastNotify(notify)).toEqual([`Reasoning cannot be disabled for ${key}.`, "error"]);
	});

	it("rejects an unknown /reasoning argument without changing state", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		harness.session.setSessionThinkingLevel("high");

		// when
		await harness.session.prompt("/reasoning maybe");

		// then
		expect(harness.session.thinkingLevel).toBe("high");
		expect(lastNotify(notify)).toEqual(["Usage: /reasoning [on|off]", "error"]);
	});

	it("rejects extra /reasoning arguments", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		harness.session.setSessionThinkingLevel("high");

		// when
		await harness.session.prompt("/reasoning on now");

		// then
		expect(harness.session.thinkingLevel).toBe("high");
		expect(lastNotify(notify)).toEqual(["Usage: /reasoning [on|off]", "error"]);
	});

	it("treats a whitespace-only /reasoning argument as the status form", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		harness.session.setSessionThinkingLevel("medium");

		// when
		await harness.session.prompt("/reasoning    ");

		// then
		expect(lastNotify(notify)).toEqual(["Reasoning: on (medium).", "info"]);
	});

	it("rejects a case-shifted /reasoning argument", async () => {
		// given
		// Casing is not silently normalized: `ON` is a typo, and answering it with success would
		// teach users a grammar the completions never offer.
		const { harness, notify } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		harness.session.setSessionThinkingLevel("high");

		// when
		await harness.session.prompt("/reasoning ON");

		// then
		expect(harness.session.thinkingLevel).toBe("high");
		expect(lastNotify(notify)).toEqual(["Usage: /reasoning [on|off]", "error"]);
	});

	// =====================================================================
	// /efforts — status
	// =====================================================================

	it("lists available efforts for a graded model with xhigh and max", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		harness.session.setSessionThinkingLevel("high");

		// when
		await harness.session.prompt("/efforts");

		// then
		expect(lastNotify(notify)).toEqual([
			"Reasoning effort: high. Available: minimal, low, medium, high, xhigh, max.",
			"info",
		]);
	});

	it("omits xhigh and max for a graded model that does not support them", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({ thinkingLevelMap: GRADED_NO_XHIGH_MAP });
		harness.session.setSessionThinkingLevel("high");

		// when
		await harness.session.prompt("/efforts");

		// then
		expect(lastNotify(notify)).toEqual(["Reasoning effort: high. Available: minimal, low, medium, high.", "info"]);
	});

	it("reports effort off when a graded model has reasoning disabled", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({ thinkingLevelMap: GRADED_NO_XHIGH_MAP });
		harness.session.setSessionThinkingLevel("off");

		// when
		await harness.session.prompt("/efforts");

		// then
		expect(lastNotify(notify)).toEqual(["Reasoning effort: off. Available: minimal, low, medium, high.", "info"]);
	});

	it("refuses /efforts status on an on/off-only model", async () => {
		// given
		const { harness, notify, key } = await createReasoningHarness({ thinkingLevelMap: ON_OFF_MAP });

		// when
		await harness.session.prompt("/efforts");

		// then
		expect(lastNotify(notify)).toEqual([
			`Reasoning effort is not configurable for ${key}; this model supports on/off only. Use /reasoning on or /reasoning off.`,
			"error",
		]);
	});

	it("refuses /efforts status on a non-reasoning model", async () => {
		// given
		const { harness, notify, key } = await createReasoningHarness({ reasoning: false });

		// when
		await harness.session.prompt("/efforts");

		// then
		expect(lastNotify(notify)).toEqual([`Model ${key} does not support reasoning.`, "error"]);
	});

	// =====================================================================
	// /efforts <level>
	// =====================================================================

	it("sets a supported effort on a graded model", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		harness.session.setSessionThinkingLevel("off");

		// when
		await harness.session.prompt("/efforts high");

		// then
		expect(harness.session.thinkingLevel).toBe("high");
		expect(lastNotify(notify)).toEqual([
			"Reasoning effort: high. Available: minimal, low, medium, high, xhigh, max.",
			"info",
		]);
	});

	it("sets xhigh when the model supports it", async () => {
		// given
		const { harness } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });

		// when
		await harness.session.prompt("/efforts xhigh");

		// then
		expect(harness.session.thinkingLevel).toBe("xhigh");
	});

	it("persists the chosen effort as this model's remembered level", async () => {
		// given
		const { harness, model } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });

		// when
		await harness.session.prompt("/efforts high");

		// then
		await harness.settingsManager.flush();
		expect(harness.settingsManager.getModelThinkingLevel(model.provider, model.id)).toBe("high");
	});

	it("rejects an unsupported effort with the available list", async () => {
		// given
		const { harness, notify, key } = await createReasoningHarness({ thinkingLevelMap: GRADED_NO_XHIGH_MAP });
		harness.session.setSessionThinkingLevel("medium");

		// when
		await harness.session.prompt("/efforts xhigh");

		// then
		expect(harness.session.thinkingLevel).toBe("medium");
		expect(lastNotify(notify)).toEqual([
			`Reasoning effort "xhigh" is not supported by ${key}. Available: minimal, low, medium, high.`,
			"error",
		]);
	});

	it("rejects an unsupported effort on an always-on model", async () => {
		// given
		const { harness, notify, key } = await createReasoningHarness({ thinkingLevelMap: ALWAYS_ON_MAP });
		harness.session.setSessionThinkingLevel("medium");

		// when
		await harness.session.prompt("/efforts max");

		// then
		expect(harness.session.thinkingLevel).toBe("medium");
		expect(lastNotify(notify)).toEqual([
			`Reasoning effort "max" is not supported by ${key}. Available: minimal, low, medium, high.`,
			"error",
		]);
	});

	it("refuses /efforts <level> on an on/off-only model", async () => {
		// given
		const { harness, notify, key } = await createReasoningHarness({ thinkingLevelMap: ON_OFF_MAP });
		harness.session.setSessionThinkingLevel("off");

		// when
		await harness.session.prompt("/efforts high");

		// then
		expect(harness.session.thinkingLevel).toBe("off");
		expect(lastNotify(notify)).toEqual([
			`Reasoning effort is not configurable for ${key}; this model supports on/off only. Use /reasoning on or /reasoning off.`,
			"error",
		]);
	});

	it("refuses /efforts <level> on a non-reasoning model", async () => {
		// given
		const { harness, notify, key } = await createReasoningHarness({ reasoning: false });

		// when
		await harness.session.prompt("/efforts high");

		// then
		expect(harness.session.thinkingLevel).toBe("off");
		expect(lastNotify(notify)).toEqual([`Model ${key} does not support reasoning.`, "error"]);
	});

	it("rejects an unknown effort token with the usage line", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		harness.session.setSessionThinkingLevel("medium");

		// when
		await harness.session.prompt("/efforts turbo");

		// then
		expect(harness.session.thinkingLevel).toBe("medium");
		expect(lastNotify(notify)).toEqual(["Usage: /efforts [minimal|low|medium|high|xhigh|max]", "error"]);
	});

	it("rejects a case-shifted effort with the usage line", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		harness.session.setSessionThinkingLevel("medium");

		// when
		await harness.session.prompt("/efforts HIGH");

		// then
		expect(harness.session.thinkingLevel).toBe("medium");
		expect(lastNotify(notify)).toEqual(["Usage: /efforts [minimal|low|medium|high|xhigh|max]", "error"]);
	});

	it("rejects extra effort arguments with the usage line", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		harness.session.setSessionThinkingLevel("medium");

		// when
		await harness.session.prompt("/efforts high extra-arg");

		// then
		expect(harness.session.thinkingLevel).toBe("medium");
		expect(lastNotify(notify)).toEqual(["Usage: /efforts [minimal|low|medium|high|xhigh|max]", "error"]);
	});

	it("rejects a unicode effort argument with the usage line", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		harness.session.setSessionThinkingLevel("medium");

		// when
		await harness.session.prompt("/efforts 高");

		// then
		expect(harness.session.thinkingLevel).toBe("medium");
		expect(lastNotify(notify)).toEqual(["Usage: /efforts [minimal|low|medium|high|xhigh|max]", "error"]);
	});

	it("treats a whitespace-only effort argument as the status form", async () => {
		// given
		const { harness, notify } = await createReasoningHarness({ thinkingLevelMap: GRADED_NO_XHIGH_MAP });
		harness.session.setSessionThinkingLevel("medium");

		// when
		await harness.session.prompt("/efforts   ");

		// then
		expect(lastNotify(notify)).toEqual(["Reasoning effort: medium. Available: minimal, low, medium, high.", "info"]);
	});

	it("rejects the off pseudo-level and points at /reasoning off", async () => {
		// given
		// `off` is not an effort: it is the on/off axis, owned by /reasoning.
		const { harness, notify, key } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		harness.session.setSessionThinkingLevel("medium");

		// when
		await harness.session.prompt("/efforts off");

		// then
		expect(harness.session.thinkingLevel).toBe("medium");
		expect(lastNotify(notify)).toEqual([
			`Reasoning effort "off" is not supported by ${key}. Available: minimal, low, medium, high, xhigh, max.`,
			"error",
		]);
	});

	// =====================================================================
	// Completions + registration
	// =====================================================================

	it("offers on/off completions for /reasoning", async () => {
		// given
		const { harness } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		await harness.session.bindExtensions({});
		const command = harness.getExtensionRunner().getCommand("reasoning");
		expect(command).toBeDefined();

		// when
		const completions = await command?.getArgumentCompletions?.("");

		// then
		expect(completions?.map((item) => item.value)).toEqual(["on", "off"]);
	});

	it("offers only supported effort completions", async () => {
		// given
		const { harness } = await createReasoningHarness({ thinkingLevelMap: GRADED_NO_XHIGH_MAP });
		// session_start is how the live model reaches the completion callback, exactly as at startup.
		await harness.session.bindExtensions({});
		const command = harness.getExtensionRunner().getCommand("efforts");
		expect(command).toBeDefined();

		// when
		const completions = await command?.getArgumentCompletions?.("");

		// then
		expect(completions?.map((item) => item.value)).toEqual(["minimal", "low", "medium", "high"]);
	});

	it("includes xhigh and max in completions only when the model supports them", async () => {
		// given
		const { harness } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		await harness.session.bindExtensions({});
		const command = harness.getExtensionRunner().getCommand("efforts");

		// when
		const completions = await command?.getArgumentCompletions?.("");

		// then
		expect(completions?.map((item) => item.value)).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	it("filters effort completions by prefix", async () => {
		// given
		const { harness } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });
		await harness.session.bindExtensions({});
		const command = harness.getExtensionRunner().getCommand("efforts");

		// when
		const completions = await command?.getArgumentCompletions?.("m");

		// then
		expect(completions?.map((item) => item.value)).toEqual(["minimal", "medium", "max"]);
	});

	it("does not register a /thinking alias", async () => {
		// given
		const { harness } = await createReasoningHarness({ thinkingLevelMap: GRADED_FULL_MAP });

		// when
		const thinking = harness.getExtensionRunner().getCommand("thinking");

		// then
		expect(thinking).toBeUndefined();
	});

	// =====================================================================
	// Stale state: capability must follow the CURRENT model
	// =====================================================================

	it("classifies the model that is active right now, not the session's first model", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "graded-model", reasoning: true },
				{ id: "plain-model", reasoning: false },
			],
			fileSettings: true,
			extensionFactories: [reasoningExtension],
		});
		harnesses.push(harness);
		const graded = harness.getModel("graded-model");
		const plain = harness.getModel("plain-model");
		expect(graded).toBeDefined();
		expect(plain).toBeDefined();
		graded!.thinkingLevelMap = GRADED_FULL_MAP;
		const notify = vi.spyOn(harness.getExtensionRunner().getUIContext(), "notify");
		await harness.session.prompt("/efforts high");
		expect(harness.session.thinkingLevel).toBe("high");

		// when
		await harness.session.setSessionModel(plain!);
		await harness.session.prompt("/efforts high");

		// then
		expect(lastNotify(notify)).toEqual([`Model ${plain!.provider}/plain-model does not support reasoning.`, "error"]);
	});
});
