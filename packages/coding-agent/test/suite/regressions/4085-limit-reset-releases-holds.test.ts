import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lazyStream } from "../../../../ai/src/api/lazy.ts";
import { credentialPoolRepository } from "../../../src/core/credential-accounts.ts";
import { streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { registerFallbackModels } from "../fallback-provider-fixture.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#4085: an account blocked for a usage limit must serve again once the reset it named has passed, with no
// re-login. Two session holds outlived that reset: a fallback pinned by a usage limit never released (the reset was
// ignored, senpi#3038), and a held account counted its reset on the monotonic clock, which stops while the machine
// sleeps, so a laptop that slept through the reset kept the account out for the whole window again.
const START = Date.UTC(2026, 10, 11, 6, 0);
const HOUR = 60 * 60_000;
const AFTER_RESET = START + 2 * HOUR + 60_000;

const SESSION_LIMIT = "You've hit your session limit · resets in 2 hours";
const USAGE_LIMIT_REACHED = `429 {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_at":${(START + 2 * HOUR) / 1000}}}`;

function limited(errorMessage: string): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage }),
		providerDiagnostic: {
			category: "rate_limit",
			evidence: "structured_code",
			code: "rate_limit_error",
			httpStatus: 429,
		},
	};
}

async function* reply(spent: boolean): AsyncGenerator<AssistantMessageEvent> {
	if (spent) {
		yield { type: "error", reason: "error", error: limited(SESSION_LIMIT) };
		return;
	}
	yield { type: "done", reason: "stop", message: fauxAssistantMessage("served after the reset") };
}

describe("an account limited until a reset serves again once the reset passed (senpi#4085)", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
		vi.useRealTimers();
	});

	it("releases a fallback pinned by a usage limit once the limit's stated reset passed", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(START);
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => Date.now(),
			settings: {
				retry: {
					enabled: true,
					maxRetries: 0,
					baseDelayMs: 1,
					fallbackChains: { "faux/faux-1": ["other-faux/faux-2"] },
				},
			},
		});
		harnesses.push(harness);
		registerFallbackModels(harness, "other-faux", ["faux-2"]);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT_REACHED }),
			fauxAssistantMessage("fallback"),
			fauxAssistantMessage("primary after the reset"),
		]);

		await harness.session.prompt("first");
		expect(harness.session.model?.id).toBe("faux-2");

		vi.setSystemTime(AFTER_RESET);
		await harness.session.prompt("goal continuation", { source: "extension" });

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-2", "faux-1"]);
		expect(harness.session.model?.id).toBe("faux-1");
	});

	it("serves on the held account after its reset even when the monotonic clock stood still while asleep", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(START);
		const harness = await createHarness({
			// The monotonic clock does not advance while the machine is suspended; the wall clock does.
			fallbackNow: () => START,
			fallbackWallNow: () => Date.now(),
			settings: { retry: { enabled: true, maxRetries: 0 }, compaction: { enabled: false } },
		});
		harnesses.push(harness);
		const provider = harness.getModel().provider;
		const credential: PooledCredential = { type: "api_key", key: "synthetic-only-key" };
		await harness.authStorage.modify(provider, async () => credential);
		const attempts: string[] = [];
		let spent = true;
		harness.agent.streamFunction = (model) =>
			lazyStream(model, async () =>
				streamWithCredentialRotation({
					sources: {
						providerId: provider,
						credential,
						env: () => undefined,
						repository: credentialPoolRepository(harness.authStorage),
						policy: { affinity: false },
					},
					modelId: model.id,
					runAttempt: async (slot) => {
						attempts.push(slot.name);
						return reply(spent);
					},
				}),
			);

		await harness.session.prompt("first");
		expect(attempts).toHaveLength(1);

		spent = false;
		vi.setSystemTime(AFTER_RESET);
		await harness.session.prompt("goal continuation", { source: "extension" });

		expect(attempts).toHaveLength(2);
		expect(harness.session.messages.at(-1)).toMatchObject({
			content: [expect.objectContaining({ text: "served after the reset" })],
		});
	});
});
