import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import serviceTierExtension from "../../src/core/extensions/builtin/service-tier.ts";
import type { ExtensionAPI, RegisteredCommand } from "../../src/core/extensions/types.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
const BASE_MODEL_ID = "gpt-5.6-sol";
const FAST_MODEL_ID = `${BASE_MODEL_ID}-fast`;
const BASE_KEY = `${CODEX_PROVIDER}/${BASE_MODEL_ID}`;

/**
 * Fast mode is a per-model preference, so the surface under test is settings on disk:
 * every harness here uses file-backed settings in its own temp agent dir, and a "restart"
 * is a second harness pointed at that same dir.
 */
describe("/fast per-model service-tier persistence", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		vi.restoreAllMocks();
	});

	function settingsPath(harness: Harness): string {
		return join(harness.tempDir, "agent", "settings.json");
	}

	function readSettings(harness: Harness): Record<string, unknown> {
		return JSON.parse(readFileSync(settingsPath(harness), "utf-8")) as Record<string, unknown>;
	}

	async function createCodexHarness(options: Partial<HarnessOptions> = {}): Promise<Harness> {
		const harness = await createHarness({
			api: CODEX_API,
			provider: CODEX_PROVIDER,
			models: [{ id: BASE_MODEL_ID }],
			fileSettings: true,
			settings: {},
			extensionFactories: [serviceTierExtension],
			...options,
		});
		harnesses.push(harness);
		return harness;
	}

	/**
	 * A restart over the same agent dir: a fresh harness (fresh session, fresh extension
	 * instance) whose settings.json is the one the previous harness wrote.
	 */
	async function restart(previous: Harness, options: Partial<HarnessOptions> = {}): Promise<Harness> {
		const harness = await createCodexHarness({
			settings: readSettings(previous) as HarnessOptions["settings"],
			...options,
		});
		await harness.session.bindExtensions({});
		return harness;
	}

	it("keeps fast mode on for the same model after a restart", async () => {
		// given
		const harness = await createCodexHarness();
		await harness.session.bindExtensions({});

		// when
		await harness.session.prompt("/fast on");

		// then
		expect(harness.session.isFastModeActive()).toBe(true);
		expect(readSettings(harness).modelServiceTiers).toEqual({ [BASE_KEY]: "priority" });

		// when
		const restarted = await restart(harness);

		// then
		expect(restarted.session.isFastModeActive()).toBe(true);
		expect(await restarted.getExtensionRunner().emitBeforeProviderRequest({ model: BASE_MODEL_ID })).toEqual({
			model: BASE_MODEL_ID,
			service_tier: "priority",
		});
	});

	it("keeps fast mode off after a restart and records an explicit auto", async () => {
		// given
		const harness = await createCodexHarness();
		await harness.session.bindExtensions({});
		await harness.session.prompt("/fast on");

		// when
		await harness.session.prompt("/fast off");

		// then
		expect(harness.session.isFastModeActive()).toBe(false);
		// "auto", never a deleted key: only an explicit value can override an inherited
		// catalog/global priority tier.
		expect(readSettings(harness).modelServiceTiers).toEqual({ [BASE_KEY]: "auto" });

		// when
		const restarted = await restart(harness);

		// then
		expect(restarted.session.isFastModeActive()).toBe(false);
	});

	it("survives on -> restart -> off -> restart -> on without drifting", async () => {
		// given
		const first = await createCodexHarness();
		await first.session.bindExtensions({});
		await first.session.prompt("/fast on");

		// when
		const second = await restart(first);

		// then
		expect(second.session.isFastModeActive()).toBe(true);

		// when
		await second.session.prompt("/fast off");
		const third = await restart(second);

		// then
		expect(third.session.isFastModeActive()).toBe(false);
		expect(readSettings(third).modelServiceTiers).toEqual({ [BASE_KEY]: "auto" });

		// when
		await third.session.prompt("/fast on");
		const fourth = await restart(third);

		// then
		expect(fourth.session.isFastModeActive()).toBe(true);
		expect(readSettings(fourth).modelServiceTiers).toEqual({ [BASE_KEY]: "priority" });
	});

	it("takes effect on the wire immediately for an in-session /fast off", async () => {
		// given
		// A session that STARTS with remembered priority resolves ctx.serviceTier="priority";
		// that resolution is only recomputed on a model switch, so a same-session `/fast off`
		// (no swap) must still stop sending the tier instead of waiting for a restart.
		const first = await createCodexHarness();
		await first.session.bindExtensions({});
		await first.session.prompt("/fast on");
		const second = await restart(first);
		const runner = second.getExtensionRunner();
		expect(second.session.isFastModeActive()).toBe(true);
		expect(await runner.emitBeforeProviderRequest({ model: BASE_MODEL_ID })).toEqual({
			model: BASE_MODEL_ID,
			service_tier: "priority",
		});

		// when
		await second.session.prompt("/fast off");

		// then
		expect(second.session.isFastModeActive()).toBe(false);
		const offPayload = { model: BASE_MODEL_ID };
		expect(await runner.emitBeforeProviderRequest(offPayload)).toBe(offPayload);
	});

	it("keeps the no-arg form a toggle", async () => {
		// given
		const harness = await createCodexHarness();
		await harness.session.bindExtensions({});
		const notify = vi.spyOn(harness.getExtensionRunner().getUIContext(), "notify");

		// when
		await harness.session.prompt("/fast");

		// then
		expect(notify).toHaveBeenCalledWith(`Fast mode enabled: ${BASE_MODEL_ID}`, "info");
		expect(harness.session.isFastModeActive()).toBe(true);
		expect(readSettings(harness).modelServiceTiers).toEqual({ [BASE_KEY]: "priority" });

		// when
		await harness.session.prompt("/fast");

		// then
		expect(notify).toHaveBeenCalledWith(`Fast mode disabled: ${BASE_MODEL_ID}`, "info");
		expect(harness.session.isFastModeActive()).toBe(false);
		expect(readSettings(harness).modelServiceTiers).toEqual({ [BASE_KEY]: "auto" });
	});

	it("rejects an unknown argument without writing anything", async () => {
		// given
		const harness = await createCodexHarness();
		await harness.session.bindExtensions({});
		const notify = vi.spyOn(harness.getExtensionRunner().getUIContext(), "notify");

		// when
		await harness.session.prompt("/fast ON PLEASE");

		// then
		expect(notify).toHaveBeenCalledWith("Usage: /fast [on|off]", "error");
		expect(harness.session.isFastModeActive()).toBe(false);
		expect(readSettings(harness).modelServiceTiers).toBeUndefined();
	});

	it("offers on and off as argument completions", async () => {
		// given
		const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
		const pi = {
			on: () => {},
			registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
				commands.set(name, command);
			},
		} as unknown as ExtensionAPI;
		serviceTierExtension(pi);

		// when
		const command = commands.get("fast");

		// then
		expect(await command?.getArgumentCompletions?.("")).toEqual([
			{ value: "on", label: "on" },
			{ value: "off", label: "off" },
		]);
		expect(await command?.getArgumentCompletions?.("o")).toEqual([
			{ value: "on", label: "on" },
			{ value: "off", label: "off" },
		]);
		expect(await command?.getArgumentCompletions?.("of")).toEqual([{ value: "off", label: "off" }]);
	});

	it("normalizes a -fast catalog sibling onto the base model key", async () => {
		// given
		// The catalog `-fast` variant and its base model are the same model to the user, so a
		// single memory key must serve both; two keys could hold contradictory preferences.
		const harness = await createCodexHarness({
			models: [{ id: FAST_MODEL_ID }, { id: BASE_MODEL_ID }],
			upstreamModelId: BASE_MODEL_ID,
			serviceTier: "priority",
			settings: { defaultProvider: CODEX_PROVIDER, defaultModel: BASE_MODEL_ID },
		});
		await harness.session.bindExtensions({});
		expect(harness.session.model?.id).toBe(BASE_MODEL_ID);

		// when
		await harness.session.prompt("/fast on");

		// then
		expect(harness.session.model?.id).toBe(FAST_MODEL_ID);
		expect(readSettings(harness).modelServiceTiers).toEqual({ [BASE_KEY]: "priority" });

		// when
		await harness.session.prompt("/fast off");

		// then
		expect(harness.session.model?.id).toBe(BASE_MODEL_ID);
		expect(readSettings(harness).modelServiceTiers).toEqual({ [BASE_KEY]: "auto" });
	});

	it("lets an explicit auto beat a catalog-inherited priority tier", async () => {
		// given
		// A codex model can carry `serviceTier: "priority"` in its catalog/models.json entry. A
		// remembered "auto" (`/fast off`) must override that inheritance — deleting the key would
		// silently re-inherit the priority tier.
		const seed = await createCodexHarness({
			models: [{ id: BASE_MODEL_ID }],
			serviceTier: "priority",
			settings: { modelServiceTiers: { [BASE_KEY]: "auto" } },
		});
		const runner = seed.getExtensionRunner();
		await seed.session.bindExtensions({});

		// then
		expect(seed.session.model?.id).toBe(BASE_MODEL_ID);
		expect(seed.session.isFastModeActive()).toBe(false);
		const offPayload = { model: BASE_MODEL_ID };
		expect(await runner.emitBeforeProviderRequest(offPayload)).toBe(offPayload);
		expect(readSettings(seed).modelServiceTiers).toEqual({ [BASE_KEY]: "auto" });

		// control: the same catalog priority stays on the wire without a remembered off
		const control = await createCodexHarness({
			models: [{ id: BASE_MODEL_ID }],
			serviceTier: "priority",
		});
		await control.session.bindExtensions({});
		expect(await control.getExtensionRunner().emitBeforeProviderRequest({ model: BASE_MODEL_ID })).toEqual({
			model: BASE_MODEL_ID,
			service_tier: "priority",
		});
	});

	it("keeps the remembered auto after switching away from the model and back", async () => {
		// given
		// The memory is per model, so a model switch must RE-DERIVE it for the incoming model
		// rather than forget it: switching away and back in one session would otherwise leave the
		// remembered "auto" unable to suppress the catalog-inherited priority, silently re-sending
		// the tier `/fast off` turned off.
		const harness = await createCodexHarness({
			models: [{ id: BASE_MODEL_ID }, { id: "gpt-5.5" }],
			serviceTier: "priority",
			settings: { modelServiceTiers: { [BASE_KEY]: "auto" } },
		});
		await harness.session.bindExtensions({});
		const runner = harness.getExtensionRunner();
		expect(harness.session.isFastModeActive()).toBe(false);
		const beforeSwitch = { model: BASE_MODEL_ID };
		expect(await runner.emitBeforeProviderRequest(beforeSwitch)).toBe(beforeSwitch);

		// when: away to another model and back
		const other = harness.getModel("gpt-5.5");
		expect(other).toBeDefined();
		await harness.session.setSessionModel(other!);
		await harness.session.setSessionModel(harness.getModel());

		// then: the model's own memory is back in force, so nothing reaches the wire
		expect(harness.session.serviceTier).toBe("priority");
		const afterSwitch = { model: BASE_MODEL_ID };
		expect(await runner.emitBeforeProviderRequest(afterSwitch)).toBe(afterSwitch);
	});

	it("keeps a config-time priority pin on the wire despite a remembered auto", async () => {
		// given
		// The pin is resolved BEFORE session_start (as a `--models provider/id:priority` scope is at
		// session construction), so the extension starts with liveMemoryTier="auto" AND a pinned
		// priority. A pin outranks the memory, so the suppression that serves a catalog-inherited
		// priority must not fire here — it can only fire when the catalog explains the priority.
		const harness = await createCodexHarness({
			settings: { modelServiceTiers: { [BASE_KEY]: "auto" } },
		});
		harness.session.setScopedModels([{ model: harness.getModel(), serviceTier: "priority" }]);
		await harness.session.setSessionModel(harness.getModel());
		await harness.session.bindExtensions({});

		// then
		expect(harness.session.serviceTier).toBe("priority");
		expect(harness.session.isFastModeActive()).toBe(true);
		expect(await harness.getExtensionRunner().emitBeforeProviderRequest({ model: BASE_MODEL_ID })).toEqual({
			model: BASE_MODEL_ID,
			service_tier: "priority",
		});
	});

	it("tolerates malformed memory at session start", async () => {
		// given
		// settings.json is user-editable, so garbage must degrade to "no preference" rather
		// than throwing out of session_start and breaking startup.
		const harness = await createCodexHarness({
			settings: { modelServiceTiers: { [BASE_KEY]: "turbo" } as never },
		});

		// when
		await harness.session.bindExtensions({});

		// then
		expect(harness.session.isFastModeActive()).toBe(false);
		expect(harness.session.serviceTier).toBeUndefined();
	});

	it("ignores memory naming a model that is no longer in the registry", async () => {
		// given
		const harness = await createCodexHarness({
			settings: { modelServiceTiers: { [`${CODEX_PROVIDER}/retired-model`]: "priority" } },
		});

		// when
		await harness.session.bindExtensions({});

		// then
		expect(harness.session.isFastModeActive()).toBe(false);
	});

	it("refuses to disable fast mode while a scoped priority pin is active", async () => {
		// given
		const harness = await createCodexHarness();
		await harness.session.bindExtensions({});
		const model = harness.getModel();
		harness.session.setScopedModels([{ model, serviceTier: "priority" }]);
		await harness.session.setSessionModel(model);
		const notify = vi.spyOn(harness.getExtensionRunner().getUIContext(), "notify");

		// when
		await harness.session.prompt("/fast off");

		// then
		expect(notify).toHaveBeenCalledWith("Fast mode is fixed by the active model selection's priority tier.", "info");
		expect(readSettings(harness).modelServiceTiers).toBeUndefined();
		expect(harness.session.isFastModeActive()).toBe(true);
	});

	it("refuses to disable fast mode while a favorite priority pin is active", async () => {
		// given
		// A favorite `provider/id:priority` pin resolves through the session the same way a scoped
		// pin does, but never appears in scopedModels — so the pin has to be recognized by the tier
		// the catalog cannot explain, not by scanning one of the two lists.
		const harness = await createCodexHarness({ models: [{ id: BASE_MODEL_ID }, { id: "gpt-5.5" }] });
		await harness.session.bindExtensions({});
		const pinned = harness.getModel("gpt-5.5");
		expect(pinned).toBeDefined();
		harness.session.setFavoriteModels([{ model: harness.getModel() }, { model: pinned!, serviceTier: "priority" }]);
		await harness.session.cycleModel();
		expect(harness.session.model?.id).toBe("gpt-5.5");
		expect(harness.session.serviceTier).toBe("priority");
		const notify = vi.spyOn(harness.getExtensionRunner().getUIContext(), "notify");

		// when
		await harness.session.prompt("/fast off");

		// then
		expect(notify).toHaveBeenCalledWith("Fast mode is fixed by the active model selection's priority tier.", "info");
		expect(readSettings(harness).modelServiceTiers).toBeUndefined();
		expect(harness.session.isFastModeActive()).toBe(true);
	});

	it("keeps the non-Codex copy and writes no memory", async () => {
		// given
		const harness = await createHarness({
			api: "anthropic-messages",
			provider: "anthropic",
			fileSettings: true,
			settings: {},
			extensionFactories: [serviceTierExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const notify = vi.spyOn(harness.getExtensionRunner().getUIContext(), "notify");

		// when
		await harness.session.prompt("/fast on");

		// then
		expect(notify).toHaveBeenCalledWith("Fast mode is only available for OpenAI Codex models.", "warning");
		expect(readSettings(harness).modelServiceTiers).toBeUndefined();
	});

	it("writes only the nested key so a concurrent session's model preference survives", async () => {
		// given
		const harness = await createCodexHarness();
		await harness.session.bindExtensions({});

		// when
		const concurrent = SettingsManager.create(harness.tempDir, join(harness.tempDir, "agent"));
		concurrent.setModelServiceTier(CODEX_PROVIDER, "some-other-model", "priority");
		await harness.session.prompt("/fast on");

		// then
		expect(readSettings(harness).modelServiceTiers).toEqual({
			[`${CODEX_PROVIDER}/some-other-model`]: "priority",
			[BASE_KEY]: "priority",
		});
	});
});
