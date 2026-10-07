import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import serviceTierExtension from "../../src/core/extensions/builtin/service-tier.ts";
import { parseModelPattern, resolveModelScopeFromModels } from "../../src/core/model-resolver.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const PROVIDER = "chatgpt-subscription";
const MODEL = "gpt-6-astra";
const astra = getModel(PROVIDER, MODEL);

describe("Ultrafast service-tier selection", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		vi.restoreAllMocks();
	});

	it.each(EFFORTS)("parses %s effort with ultrafast in either decorator order and a glob", (effort) => {
		for (const suffix of [`${effort}:ultrafast`, `ultrafast:${effort}`]) {
			const resolved = parseModelPattern(`${PROVIDER}/${MODEL}:${suffix}`, [astra]);
			expect(resolved).toMatchObject({ model: astra, thinkingLevel: effort, serviceTier: "ultrafast" });
			expect(resolved.warning).toBeUndefined();
		}
		const scope = resolveModelScopeFromModels([`${PROVIDER}/gpt-6-*:${effort}:ultrafast`], [astra]);
		expect(scope.diagnostics).toEqual([]);
		expect(scope.scopedModels).toEqual([
			expect.objectContaining({ thinkingLevel: effort, serviceTier: "ultrafast" }),
		]);
	});

	it("accepts a models.json Ultrafast alias without losing its upstream id or effort map", async () => {
		const harness = await createHarness({
			modelsJson: {
				providers: {
					[PROVIDER]: {
						models: [{ ...astra, id: `${MODEL}-ultrafast`, upstreamModelId: MODEL, serviceTier: "ultrafast" }],
					},
				},
			},
		});
		harnesses.push(harness);
		expect(harness.modelRegistry.getError()).toBeUndefined();
		const model = harness.modelRegistry.find(PROVIDER, `${MODEL}-ultrafast`)!;
		expect(model).toBeDefined();
		expect(harness.modelRegistry.getUpstreamModelId(model)).toBe(MODEL);
		expect(harness.modelRegistry.getServiceTier(model)).toBe("ultrafast");
		for (const effort of EFFORTS) expect(model.thinkingLevelMap?.[effort]).toBe(effort);
	});

	it("round-trips ultrafast on the OpenAI setting and drops it from model memory", async () => {
		const manager = SettingsManager.inMemory({
			openai: { serviceTier: "ultrafast" },
			modelServiceTiers: { [`${PROVIDER}/${MODEL}`]: "ultrafast" },
		} as unknown as Parameters<typeof SettingsManager.inMemory>[0]);
		expect(manager.getOpenAIServiceTier()).toBe("ultrafast");
		expect(manager.getModelServiceTier(PROVIDER, MODEL)).toBeUndefined();
		manager.setModelServiceTier(PROVIDER, MODEL, "priority");
		await manager.flush();
		expect(manager.getModelServiceTier(PROVIDER, MODEL)).toBe("priority");
	});

	it("warns for a glob that pairs ultrafast with a non-Astra model and still scopes it", () => {
		const openaiAstra = getModel("openai", MODEL);
		const sol = getModel("openai", "gpt-6.1-sol");
		const scope = resolveModelScopeFromModels(["openai/gpt-6*:ultrafast"], [openaiAstra, sol]);
		expect(scope.scopedModels.map((entry) => [entry.model.id, entry.serviceTier])).toEqual([
			[MODEL, "ultrafast"],
			["gpt-6.1-sol", "ultrafast"],
		]);
		expect(scope.diagnostics).toEqual([
			{
				type: "warning",
				code: "ultrafast-undocumented",
				message: "Ultrafast is documented for GPT-6 Astra only; openai/gpt-6.1-sol may reject or ignore it",
				pattern: "openai/gpt-6*:ultrafast",
			},
		]);
	});

	it("keeps an Ultrafast model pin above remembered priority and the /fast toggle", async () => {
		const harness = await createHarness({
			api: "openai-codex-responses",
			provider: PROVIDER,
			models: [{ id: MODEL }],
			serviceTier: "ultrafast",
			fileSettings: true,
			settings: { modelServiceTiers: { [`${PROVIDER}/${MODEL}`]: "priority" } },
			extensionFactories: [serviceTierExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const runner = harness.getExtensionRunner();
		const notify = vi.spyOn(runner.getUIContext(), "notify");
		for (const command of [undefined, "/fast on", "/fast off"]) {
			if (command) await harness.session.prompt(command);
			expect(harness.session.effectiveServiceTier).toBe("ultrafast");
			expect(await runner.emitBeforeProviderRequest({ model: MODEL })).toEqual({
				model: MODEL,
				service_tier: "ultrafast",
			});
		}
		expect(notify).toHaveBeenCalledWith("Service tier is fixed to ultrafast by the active model selection.", "info");
	});

	it.each([
		["openai", { service_tier: "ultrafast" }],
		["opencode", {}],
	] as const)(
		"puts an Ultrafast pin or OpenAI setting on the %s wire only for first-party providers",
		async (provider, tier) => {
			const selections = [
				{ serviceTier: "ultrafast" as const },
				{ fileSettings: true, settings: { openai: { serviceTier: "ultrafast" as const } } },
			];
			for (const selection of selections) {
				const harness = await createHarness({
					api: "openai-responses",
					provider,
					models: [{ id: MODEL }],
					extensionFactories: [serviceTierExtension],
					...selection,
				});
				harnesses.push(harness);
				await harness.session.bindExtensions({});
				const runner = harness.getExtensionRunner();
				expect(await runner.emitBeforeProviderRequest({ model: MODEL })).toEqual({ model: MODEL, ...tier });
				expect(await runner.emitBeforeProviderRequest({ model: MODEL, service_tier: "ultrafast" })).toEqual({
					model: MODEL,
					...tier,
				});
			}
		},
	);

	it("warns for resolved settings and models.json alias tiers without repeating the advisory", async () => {
		const sol = getModel("openai", "gpt-6.1-sol");
		const aliasId = "gpt-6.1-sol-ultrafast";
		const cases = [
			await createHarness({
				api: "openai-responses",
				provider: "openai",
				models: [{ id: sol.id }],
				fileSettings: true,
				settings: { openai: { serviceTier: "ultrafast" } },
				extensionFactories: [serviceTierExtension],
			}),
			await createHarness({
				api: "openai-responses",
				provider: "openai",
				models: [{ id: aliasId }],
				modelsJson: {
					providers: {
						openai: {
							models: [{ ...sol, id: aliasId, upstreamModelId: sol.id, serviceTier: "ultrafast" }],
						},
					},
				},
				extensionFactories: [serviceTierExtension],
			}),
		];
		for (const harness of cases) {
			harnesses.push(harness);
			await harness.session.bindExtensions({});
			const runner = harness.getExtensionRunner();
			const notify = vi.spyOn(runner.getUIContext(), "notify");
			await runner.emitBeforeProviderRequest({ model: sol.id });
			expect(notify).toHaveBeenCalledWith(
				"Ultrafast is documented for GPT-6 Astra only; openai/gpt-6.1-sol may reject or ignore it",
				"warning",
			);
		}
	});

	it("preserves an Ultrafast pin in an extension-less session with fast mode already on", async () => {
		const harness = await createHarness({ serviceTier: "ultrafast" });
		harnesses.push(harness);
		harness.session.setSessionFastMode(true);
		expect(harness.session.effectiveServiceTier).toBe("ultrafast");
	});
});
