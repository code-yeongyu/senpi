import { afterEach, describe, expect, it, vi } from "vitest";
import serviceTierExtension, {
	addServiceTierToPayload,
	type ServiceTier,
} from "../../src/core/extensions/builtin/service-tier.ts";
import { createHarness, type Harness } from "./harness.ts";

const CODEX_PROVIDER = "openai-codex";
const CODEX_POOL_PROVIDER = "codex-pool";
const CODEX_API = "openai-codex-responses";
const BASE_MODEL_ID = "gpt-5.6-sol";
const FAST_MODEL_ID = `${BASE_MODEL_ID}-fast`;
const OTHER_CODEX_MODEL_ID = "gpt-5.5";
const ANTHROPIC_MODEL_ID = "claude-sonnet-4-5";

describe("service-tier builtin extension", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		vi.restoreAllMocks();
	});

	it("leaves payload unchanged when service tier is unset", () => {
		// given
		const payload = {
			model: "gpt-5",
		};

		// when
		const result = addServiceTierToPayload("openai-responses", payload, undefined);

		// then
		expect(result).toBe(payload);
	});

	it("injects service_tier for openai responses payloads when configured", () => {
		// given
		const payload = {
			model: "gpt-5",
		};

		// when
		const result = addServiceTierToPayload("openai-responses", payload, "priority") as {
			service_tier?: ServiceTier;
		};

		// then
		expect(result.service_tier).toBe("priority");
	});

	it("resets a fast model on session_start, then toggles the catalog variant within the session", async () => {
		// given
		const harness = await createHarness({
			api: CODEX_API,
			provider: CODEX_PROVIDER,
			models: [{ id: FAST_MODEL_ID }, { id: BASE_MODEL_ID }],
			upstreamModelId: BASE_MODEL_ID,
			serviceTier: "priority",
			settings: {
				defaultProvider: CODEX_PROVIDER,
				defaultModel: BASE_MODEL_ID,
			},
			extensionFactories: [serviceTierExtension],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		expect(harness.session.model?.id).toBe(FAST_MODEL_ID);
		expect(harness.session.isFastModeActive()).toBe(true);

		// when
		await harness.session.bindExtensions({});

		// then
		expect(harness.session.model?.id).toBe(BASE_MODEL_ID);
		expect(harness.session.serviceTier).toBeUndefined();
		expect(harness.session.isFastModeActive()).toBe(false);
		expect(harness.settingsManager.getDefaultProvider()).toBe(CODEX_PROVIDER);
		expect(harness.settingsManager.getDefaultModel()).toBe(BASE_MODEL_ID);

		// when
		await harness.session.prompt("/fast");

		// then
		expect(harness.session.model?.id).toBe(FAST_MODEL_ID);
		expect(harness.session.serviceTier).toBe("priority");
		const fastModel = harness.session.model;
		expect(fastModel).toBeDefined();
		const upstreamModelId = harness.modelRegistry.getUpstreamModelId(fastModel!) ?? fastModel!.id;
		const priorityPayload = await runner.emitBeforeProviderRequest({ model: upstreamModelId });
		expect(priorityPayload).toEqual({
			model: BASE_MODEL_ID,
			service_tier: "priority",
		});

		// when
		await harness.session.prompt("/fast");

		// then
		expect(harness.session.model?.id).toBe(BASE_MODEL_ID);
		expect(harness.session.serviceTier).toBeUndefined();
		expect(harness.settingsManager.getDefaultProvider()).toBe(CODEX_PROVIDER);
		expect(harness.settingsManager.getDefaultModel()).toBe(BASE_MODEL_ID);
		const defaultPayload = { model: BASE_MODEL_ID };
		expect(await runner.emitBeforeProviderRequest(defaultPayload)).toBe(defaultPayload);
	});

	it("is a clear no-op for non-Codex providers", async () => {
		// given
		const harness = await createHarness({
			api: "anthropic-messages",
			provider: "anthropic",
			extensionFactories: [serviceTierExtension],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		const notify = vi.spyOn(runner.getUIContext(), "notify");
		const initialModel = harness.session.model;

		// when
		await harness.session.prompt("/fast");

		// then
		expect(harness.session.model).toBe(initialModel);
		expect(notify).toHaveBeenCalledWith("Fast mode is only available for OpenAI Codex models.", "warning");
	});

	it("toggles a session-level priority tier when the Codex model has no compatible fast variant", async () => {
		// given
		// chatgpt.com/backend-api/codex/models advertises
		// service_tiers [{ id: "priority", name: "Fast" }] to subscription accounts, and the
		// first-party Codex CLI sends service_tier=priority over that same OAuth, so a missing
		// `-fast` catalog sibling must fall back to a session tier toggle rather than declaring
		// fast mode unavailable. See issue #545.
		const harness = await createHarness({
			api: CODEX_API,
			provider: CODEX_PROVIDER,
			models: [{ id: BASE_MODEL_ID }, { id: FAST_MODEL_ID }],
			extensionFactories: [serviceTierExtension],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		const notify = vi.spyOn(runner.getUIContext(), "notify");
		const initialModel = harness.session.model;

		// when
		await harness.session.prompt("/fast");

		// then
		expect(harness.session.model).toBe(initialModel);
		expect(notify).toHaveBeenCalledWith(`Fast mode enabled: ${BASE_MODEL_ID}`, "info");
		expect(harness.session.isFastModeActive()).toBe(true);
		expect(await runner.emitBeforeProviderRequest({ model: BASE_MODEL_ID })).toEqual({
			model: BASE_MODEL_ID,
			service_tier: "priority",
		});

		// when
		await harness.session.prompt("/fast");

		// then
		expect(notify).toHaveBeenCalledWith(`Fast mode disabled: ${BASE_MODEL_ID}`, "info");
		expect(harness.session.isFastModeActive()).toBe(false);
		const defaultPayload = { model: BASE_MODEL_ID };
		expect(await runner.emitBeforeProviderRequest(defaultPayload)).toBe(defaultPayload);
	});

	it("toggles the priority tier for extension providers using the Codex responses API", async () => {
		const harness = await createHarness({
			api: CODEX_API,
			provider: CODEX_POOL_PROVIDER,
			models: [{ id: BASE_MODEL_ID }],
			extensionFactories: [serviceTierExtension],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		const notify = vi.spyOn(runner.getUIContext(), "notify");

		await harness.session.prompt("/fast");

		expect(notify).toHaveBeenCalledWith(`Fast mode enabled: ${BASE_MODEL_ID}`, "info");
		expect(harness.session.isFastModeActive()).toBe(true);
		expect(await runner.emitBeforeProviderRequest({ model: BASE_MODEL_ID })).toEqual({
			model: BASE_MODEL_ID,
			service_tier: "priority",
		});
	});

	it("keeps session fast mode on across a mid-session switch to another Codex model", async () => {
		// given
		// Fast mode is a session intent, not a property of the selected model, so switching
		// models mid-session (/model, Ctrl+P) must keep sending the tier. See issue #545.
		const harness = await createHarness({
			api: CODEX_API,
			provider: CODEX_PROVIDER,
			models: [{ id: BASE_MODEL_ID }, { id: OTHER_CODEX_MODEL_ID }],
			extensionFactories: [serviceTierExtension],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		const notify = vi.spyOn(runner.getUIContext(), "notify");
		const otherModel = harness.getModel(OTHER_CODEX_MODEL_ID);
		expect(otherModel).toBeDefined();

		// when
		await harness.session.prompt("/fast");
		await harness.session.setSessionModel(otherModel!);

		// then
		expect(harness.session.model?.id).toBe(OTHER_CODEX_MODEL_ID);
		expect(await runner.emitBeforeProviderRequest({ model: OTHER_CODEX_MODEL_ID })).toEqual({
			model: OTHER_CODEX_MODEL_ID,
			service_tier: "priority",
		});

		// when
		await harness.session.prompt("/fast");

		// then
		expect(notify).toHaveBeenCalledWith(`Fast mode disabled: ${OTHER_CODEX_MODEL_ID}`, "info");
		const defaultPayload = { model: OTHER_CODEX_MODEL_ID };
		expect(await runner.emitBeforeProviderRequest(defaultPayload)).toBe(defaultPayload);
	});

	it("stops sending the tier when fast mode is on and the session moves to a non-Codex model", async () => {
		// given
		// The tier is an OpenAI-family request field; a mid-session hop to Anthropic must not
		// carry it over, even while the Codex session intent is still enabled.
		const harness = await createHarness({
			api: CODEX_API,
			provider: CODEX_PROVIDER,
			models: [{ id: BASE_MODEL_ID }, { id: OTHER_CODEX_MODEL_ID }],
			extensionFactories: [serviceTierExtension],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		await harness.authStorage.modify("anthropic", async () => ({ type: "api_key", key: "faux-key" }));
		harness.modelRegistry.registerProvider("anthropic", {
			baseUrl: "https://api.anthropic.com",
			apiKey: "faux-key",
			api: "anthropic-messages",
			models: [
				{
					id: ANTHROPIC_MODEL_ID,
					name: ANTHROPIC_MODEL_ID,
					api: "anthropic-messages",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200000,
					maxTokens: 8192,
				},
			],
		});
		const anthropicModel = harness.modelRegistry.find("anthropic", ANTHROPIC_MODEL_ID);
		expect(anthropicModel).toBeDefined();

		// when
		await harness.session.prompt("/fast");
		await harness.session.setSessionModel(anthropicModel!);

		// then
		expect(harness.session.model?.provider).toBe("anthropic");
		const anthropicPayload = { model: ANTHROPIC_MODEL_ID };
		expect(await runner.emitBeforeProviderRequest(anthropicPayload)).toBe(anthropicPayload);
	});

	it("lets an explicitly configured model tier win over session fast mode", async () => {
		// given
		// A models.json/scoped tier is a deliberate per-model choice; the session toggle is a
		// fallback for Codex models that have none, so it must never overwrite the explicit value.
		const harness = await createHarness({
			api: CODEX_API,
			provider: CODEX_PROVIDER,
			models: [{ id: BASE_MODEL_ID }, { id: FAST_MODEL_ID }],
			serviceTier: "flex",
			extensionFactories: [serviceTierExtension],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		expect(harness.session.serviceTier).toBe("flex");

		// when
		await harness.session.prompt("/fast");

		// then
		expect(await runner.emitBeforeProviderRequest({ model: BASE_MODEL_ID })).toEqual({
			model: BASE_MODEL_ID,
			service_tier: "flex",
		});
	});

	it("drops session fast mode when a new session starts", async () => {
		// given
		// The toggle is session-scoped and never persisted, so a fresh session_start must not
		// inherit a priority tier from the previous one.
		const harness = await createHarness({
			api: CODEX_API,
			provider: CODEX_PROVIDER,
			models: [{ id: BASE_MODEL_ID }, { id: FAST_MODEL_ID }],
			extensionFactories: [serviceTierExtension],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		await harness.session.prompt("/fast");
		expect(await runner.emitBeforeProviderRequest({ model: BASE_MODEL_ID })).toEqual({
			model: BASE_MODEL_ID,
			service_tier: "priority",
		});

		// when
		await harness.session.bindExtensions({});

		// then
		const defaultPayload = { model: BASE_MODEL_ID };
		expect(await runner.emitBeforeProviderRequest(defaultPayload)).toBe(defaultPayload);
	});

	it("leaves incompatible api payloads unchanged", () => {
		// given
		const payload = {
			model: "claude-sonnet-4-5",
		};

		// when
		const result = addServiceTierToPayload("anthropic-messages", payload, "priority");

		// then
		expect(result).toBe(payload);
	});

	it("preserves explicit service_tier values already present on the payload", () => {
		// given
		const payload = {
			model: BASE_MODEL_ID,
			service_tier: "flex",
		};

		// when
		const result = addServiceTierToPayload(CODEX_API, payload, "priority");

		// then
		expect(result).toBe(payload);
	});
});
