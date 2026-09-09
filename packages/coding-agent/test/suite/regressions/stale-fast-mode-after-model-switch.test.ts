import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import serviceTierExtension from "../../../src/core/extensions/builtin/service-tier.ts";
import { buildRpcSessionState } from "../../../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Regression: the fast indicator is a display flag over a request field only the OpenAI Codex
 * family accepts, so it must follow the model the session is actually on. Enabling fast and then
 * switching to a model that can never be served at the priority tier (Anthropic) used to leave the
 * session-level flag set, so `isFastModeActive()` — and with it the RPC state `fastMode` and the
 * `service_tier_changed` event clients render the lightning indicator from — kept claiming fast
 * for a model whose requests never carry the tier.
 *
 * Fast mode stays a session intent ACROSS Codex models (a sibling Codex model with no preference
 * of its own keeps it on); that contract is also pinned in `test/suite/service-tier-extension.test.ts`.
 */
const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
const FAST_PREFERENCE_MODEL_ID = "gpt-5.6-sol";
const FAST_OFF_MODEL_ID = "gpt-5.5";
const ANTHROPIC_PROVIDER = "anthropic";
const ANTHROPIC_API = "anthropic-messages";
const ANTHROPIC_MODEL_ID = "claude-opus-5";

describe("stale fast-mode indicator after a mid-session model switch", () => {
	const harnesses: Harness[] = [];
	const fauxRegistrations: Array<{ unregister: () => void }> = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (fauxRegistrations.length > 0) {
			fauxRegistrations.pop()?.unregister();
		}
	});

	async function createFastCodexSession(): Promise<Harness> {
		const harness = await createHarness({
			api: CODEX_API,
			provider: CODEX_PROVIDER,
			models: [{ id: FAST_PREFERENCE_MODEL_ID }, { id: FAST_OFF_MODEL_ID }],
			fileSettings: true,
			extensionFactories: [serviceTierExtension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		await harness.session.prompt("/fast on");
		expect(harness.session.model?.id).toBe(FAST_PREFERENCE_MODEL_ID);
		expect(harness.session.isFastModeActive()).toBe(true);
		return harness;
	}

	it("clears the fast indicator when the session moves to a non-Codex model", async () => {
		// given: a live Codex session with fast mode on, plus an Anthropic model backed by its own
		// faux provider (file-backed settings, so the per-model memory is real)
		const harness = await createFastCodexSession();
		const anthropicFaux = registerFauxProvider({
			api: ANTHROPIC_API,
			provider: ANTHROPIC_PROVIDER,
			models: [{ id: ANTHROPIC_MODEL_ID }],
		});
		fauxRegistrations.push(anthropicFaux);
		const fauxModel = anthropicFaux.getModel();
		await harness.authStorage.modify(ANTHROPIC_PROVIDER, async () => ({ type: "api_key", key: "faux-key" }));
		harness.modelRegistry.registerProvider(ANTHROPIC_PROVIDER, {
			baseUrl: fauxModel.baseUrl,
			apiKey: "faux-key",
			api: anthropicFaux.api,
			models: [
				{
					id: fauxModel.id,
					name: fauxModel.name,
					api: fauxModel.api,
					reasoning: fauxModel.reasoning,
					input: fauxModel.input,
					cost: fauxModel.cost,
					contextWindow: fauxModel.contextWindow,
					maxTokens: fauxModel.maxTokens,
					baseUrl: fauxModel.baseUrl,
				},
			],
		});
		const anthropicModel = harness.modelRegistry.find(ANTHROPIC_PROVIDER, ANTHROPIC_MODEL_ID);
		expect(anthropicModel).toBeDefined();

		// when
		await harness.session.setSessionModel(anthropicModel!);

		// then
		expect(harness.session.model?.id).toBe(ANTHROPIC_MODEL_ID);
		expect(harness.session.model?.provider).toBe(ANTHROPIC_PROVIDER);
		expect(harness.session.isFastModeActive()).toBe(false);
		expect(buildRpcSessionState(harness.session).fastMode).toBe(false);
		expect(harness.session.effectiveServiceTier).toBeUndefined();
		expect(harness.eventsOfType("service_tier_changed").at(-1)?.fastMode).toBe(false);
		const anthropicPayload = { model: ANTHROPIC_MODEL_ID };
		expect(await harness.getExtensionRunner().emitBeforeProviderRequest(anthropicPayload)).toBe(anthropicPayload);
	});

	it("keeps the fast indicator on a Codex sibling the user never expressed a preference for", async () => {
		// given: the session intent is on and the sibling Codex model has NO remembered tier, so the
		// intent must survive the hop — this is the contract the non-Codex clearing must not break
		const harness = await createFastCodexSession();
		const siblingModel = harness.getModel(FAST_OFF_MODEL_ID);
		expect(siblingModel).toBeDefined();

		// when
		await harness.session.setSessionModel(siblingModel!);

		// then
		expect(harness.session.model?.id).toBe(FAST_OFF_MODEL_ID);
		expect(harness.session.isFastModeActive()).toBe(true);
		expect(buildRpcSessionState(harness.session).fastMode).toBe(true);
	});
});
