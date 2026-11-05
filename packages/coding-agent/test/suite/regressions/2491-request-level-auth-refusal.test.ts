import { type AssistantMessage, fauxAssistantMessage, type ProviderDiagnostic } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { registerFallbackModels } from "../fallback-provider-fixture.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#2491: a 401 on a credential that served a response moments before is the gateway refusing that
// one request, not a dead key. agent_end.failure reports it as `request_refused`, the gateway's own text
// stays on the message, and the fallback chain never walks onto another model behind the same provider
// and key. A 401 with no recent success on the credential keeps the `auth` path.

const AUTH_401: ProviderDiagnostic = { category: "auth", httpStatus: 401, evidence: "structured_status" };
const GATEWAY_TEXT = "401 Invalid or expired api_key";

function rejected(): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: GATEWAY_TEXT }),
		providerDiagnostic: AUTH_401,
	};
}

describe("senpi#2491 request-level auth refusal", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function runtimeHarness(chain: readonly string[]): Promise<Harness> {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { "faux/faux-1": [...chain] } } },
		});
		harnesses.push(harness);
		registerFallbackModels(harness, "other-faux", ["faux-2"]);
		// Stream through the model runtime: it keeps the record of which credential served lately.
		const runtime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, options) => runtime.streamSimple(model, context, options);
		return harness;
	}

	const lastFailure = (harness: Harness) => harness.eventsOfType("agent_end").at(-1)?.failure;
	const fallbackTargets = (harness: Harness) =>
		harness.eventsOfType("retry_fallback_applied").map((event) => event.to);

	it("reports request_refused and stays off the same provider after the key served moments before", async () => {
		const harness = await runtimeHarness(["faux/faux-2"]);
		harness.setResponses([fauxAssistantMessage("served"), rejected()]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1"]);
		expect(fallbackTargets(harness)).toEqual([]);
		// senpi#4328: request-level refusal retains the failing request's model identity too.
		expect(lastFailure(harness)).toMatchObject({
			category: "request_refused",
			provider: "faux",
			model: "faux-1",
			httpStatus: 401,
		});
		expect(harness.session.state.messages.at(-1)).toMatchObject({ errorMessage: GATEWAY_TEXT });
	});

	it("still falls back to another provider after a request-level refusal", async () => {
		const harness = await runtimeHarness(["faux/faux-2", "other-faux/faux-2"]);
		harness.setResponses([fauxAssistantMessage("served"), rejected(), fauxAssistantMessage("fallback answer")]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1", "faux-2"]);
		expect(fallbackTargets(harness)).toEqual(["other-faux/faux-2"]);
	});

	it("keeps a 401 with no recent success on the credential as auth and walks the chain as before", async () => {
		const harness = await runtimeHarness(["faux/faux-2"]);
		harness.setResponses([rejected(), rejected()]);

		await harness.session.prompt("first");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2"]);
		expect(fallbackTargets(harness)).toEqual(["faux/faux-2"]);
		expect(lastFailure(harness)).toMatchObject({ category: "auth", provider: "faux", httpStatus: 401 });
	});
});
