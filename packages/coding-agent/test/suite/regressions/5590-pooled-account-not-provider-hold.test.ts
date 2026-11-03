import type { AssistantMessage, AssistantMessageEvent, ProviderDiagnostic } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lazyStream } from "../../../../ai/src/api/lazy.ts";
import { credentialPoolRepository } from "../../../src/core/credential-accounts.ts";
import { streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { createHarness, type Harness } from "../harness.ts";

// The reported sequence, sanitized: two accounts hit a per-minute token limit, a third has no credits left.
const PER_MINUTE =
	"This request would exceed your rate limit of 2,000,000 input tokens per minute (org: ORG, model: claude-opus-5-5). Please reduce the prompt length or the maximum tokens requested, or try again later.";
const NO_CREDITS =
	"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";
const START = Date.UTC(2026, 10, 3, 2, 24);

type Reply = "per-minute" | "no-credits" | "served";

function failure(errorMessage: string, diagnostic: ProviderDiagnostic): AssistantMessage {
	return { ...fauxAssistantMessage("", { stopReason: "error", errorMessage }), providerDiagnostic: diagnostic };
}

async function* reply(kind: Reply): AsyncGenerator<AssistantMessageEvent> {
	if (kind === "served") {
		yield { type: "done", reason: "stop", message: fauxAssistantMessage("served by a sibling account") };
		return;
	}
	const error =
		kind === "per-minute"
			? failure(PER_MINUTE, {
					category: "rate_limit",
					evidence: "structured_code",
					code: "rate_limit_error",
					httpStatus: 429,
				})
			: failure(NO_CREDITS, {
					category: "invalid_request",
					evidence: "structured_code",
					code: "invalid_request_error",
					httpStatus: 400,
				});
	yield { type: "error", reason: "error", error };
}

describe("#5590 one pooled account's failure does not hold the whole provider", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
		vi.useRealTimers();
	});

	async function pooledSession(accounts: readonly { name: string; turn1: Reply }[]) {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(START);
		const harness = await createHarness({
			fallbackNow: () => Date.now(),
			fallbackWallNow: () => Date.now(),
			settings: { retry: { enabled: true, maxRetries: 0 }, compaction: { enabled: false } },
		});
		harnesses.push(harness);
		const provider = harness.getModel().provider;
		const credential: PooledCredential = {
			type: "api_key",
			key: `${accounts[0]?.name}-key`,
			accounts: accounts.map((account) => ({ name: account.name, key: `${account.name}-key`, source: "login" })),
		};
		await harness.authStorage.modify(provider, async () => credential);
		const repository = credentialPoolRepository(harness.authStorage);
		const attempts: string[] = [];
		let turn = 1;
		harness.agent.streamFunction = (model) =>
			lazyStream(model, async () =>
				streamWithCredentialRotation({
					sources: { providerId: provider, credential, env: () => undefined, repository, policy: { affinity: false } },
					modelId: model.id,
					runAttempt: async (slot) => {
						attempts.push(`${turn}:${slot.name}`);
						const planned = accounts.find((account) => account.name === slot.name)?.turn1 ?? "served";
						return reply(turn === 1 ? planned : "served");
					},
				}),
			);
		return {
			harness,
			attempts,
			nextTurn: () => {
				turn += 1;
			},
		};
	}

	it("an automated turn after the per-minute cooldown reaches a sibling account", async () => {
		const { harness, attempts, nextTurn } = await pooledSession([
			{ name: "org-a", turn1: "per-minute" },
			{ name: "org-b", turn1: "per-minute" },
			{ name: "org-c", turn1: "no-credits" },
		]);
		await harness.session.prompt("first");
		expect(attempts.filter((attempt) => attempt.startsWith("1:")).sort()).toEqual(["1:org-a", "1:org-b", "1:org-c"]);

		nextTurn();
		vi.setSystemTime(START + 61_000);
		await harness.session.prompt("goal continuation", { source: "extension" });

		expect(attempts.filter((attempt) => attempt.startsWith("2:"))).toHaveLength(1);
		expect(attempts).not.toContain("2:org-c");
		expect(harness.session.messages.at(-1)).toMatchObject({
			content: [expect.objectContaining({ text: "served by a sibling account" })],
		});
	});

	it("still holds the provider when no account is left usable, and names each one", async () => {
		const { harness, attempts, nextTurn } = await pooledSession([
			{ name: "org-a", turn1: "no-credits" },
			{ name: "org-b", turn1: "no-credits" },
		]);
		await harness.session.prompt("first");

		nextTurn();
		vi.setSystemTime(START + 61_000);
		const refusal = harness.session.prompt("goal continuation", { source: "extension" });

		await expect(refusal).rejects.toMatchObject({ name: "AccountUsageLimitError" });
		await expect(refusal).rejects.toThrow(/org-a.*org-b|org-b.*org-a/);
		expect(attempts.filter((attempt) => attempt.startsWith("2:"))).toEqual([]);
	});
});
