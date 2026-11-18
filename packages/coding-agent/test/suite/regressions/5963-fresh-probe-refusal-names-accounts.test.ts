import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lazyStream } from "../../../../ai/src/api/lazy.ts";
import { credentialPoolRepository } from "../../../src/core/credential-accounts.ts";
import { streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#5963: a fresh process whose pool sidecar already holds every account on a weekly limit sends one probe
// (senpi#3771, kept). When that probe fails, the error the user sees names the blocked accounts the same way the
// in-process turn-boundary refusal does.
const WEEKLY = "You've hit your weekly limit · resets in 5 hours";
const START = Date.UTC(2026, 10, 3, 2, 24);
const HOURS_AHEAD = 5 * 60 * 60_000;

async function* weeklyLimit(): AsyncGenerator<AssistantMessageEvent> {
	const error: AssistantMessage = {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: WEEKLY }),
		providerDiagnostic: {
			category: "rate_limit",
			evidence: "structured_code",
			code: "rate_limit_error",
			httpStatus: 429,
		},
	};
	yield { type: "error", reason: "error", error };
}

describe("#5963 a fresh process's failed probe names the blocked accounts", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
		vi.useRealTimers();
	});

	it("keeps the single probe and surfaces the same 'No account can serve' sentence as the turn-boundary refusal", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(START);
		const harness = await createHarness({
			fallbackNow: () => Date.now(),
			fallbackWallNow: () => Date.now(),
			settings: { retry: { enabled: true, maxRetries: 0 }, compaction: { enabled: false } },
		});
		harnesses.push(harness);
		const provider = harness.getModel().provider;
		const names = ["fresh-a", "fresh-b"];
		const credential: PooledCredential = {
			type: "api_key",
			key: "fresh-a-key",
			accounts: names.map((name) => ({ name, key: `${name}-key`, source: "login" })),
		};
		await harness.authStorage.modify(provider, async () => credential);
		const repository = credentialPoolRepository(harness.authStorage);
		// A previous process left both accounts blocked by the weekly limit, hours ahead.
		for (const name of names) {
			const credentialRevision = await repository.storedCredentialRevision(provider, name, { key: `${name}-key` });
			await repository.mutateSlotState(provider, "stored", name, () => ({
				blockedUntil: START + HOURS_AHEAD,
				blockReason: "rate_limit",
				failureCount: 10,
				credentialRevision,
			}));
		}
		const attempts: string[] = [];
		harness.agent.streamFunction = (model) =>
			lazyStream(model, async () =>
				streamWithCredentialRotation({
					sources: {
						providerId: provider,
						credential,
						env: () => undefined,
						repository,
						policy: { affinity: false },
					},
					modelId: model.id,
					runAttempt: async (slot) => {
						attempts.push(slot.name);
						return weeklyLimit();
					},
				}),
			);

		await harness.session.prompt("first");
		expect(attempts).toHaveLength(1);

		vi.setSystemTime(START + 61_000);
		const refusal = harness.session.prompt("goal continuation", { source: "extension" });
		await expect(refusal).rejects.toMatchObject({ name: "AccountUsageLimitError" });
		const inProcess = await refusal.catch((error: Error) => error.message);
		const accountsSentence = /No account can serve: .*\.$/.exec(String(inProcess))?.[0];
		expect(accountsSentence).toMatch(/fresh-a.*fresh-b|fresh-b.*fresh-a/);
		expect(attempts).toHaveLength(1);

		const surfaced = harness
			.eventsOfType("message_end")
			.map((event) => event.message)
			.filter(
				(message): message is AssistantMessage => message.role === "assistant" && message.stopReason === "error",
			);
		expect(surfaced).toHaveLength(1);
		expect(surfaced[0]?.errorMessage).toContain(accountsSentence);
	});
});
