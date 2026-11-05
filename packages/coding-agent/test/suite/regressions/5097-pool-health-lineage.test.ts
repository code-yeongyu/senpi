import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listRotationSlots, streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { type CredentialSlotState, CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";

// senpi#5097: follow-ups from the #5043/#5057 reviews. A block written on a slot must keep the health
// the same credential already earned (model blocks, counters, and fields another engine version wrote)
// even when it is written under the other key kind (account vs token), and a slot listed while another
// request's probe is in flight must carry its token revision so a 401 on it lands on that token.

const PROVIDER = "chatgpt-subscription";
const START = Date.UTC(2026, 10, 5, 0, 0, 0);
const HOUR = 60 * 60_000;
const MODEL_KEY = "gpt-5:gpt-5-test";

let dir: string;
let repository: CredentialSlotRepository;
let clock = START;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "senpi-5097-pool-"));
	repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
	clock = START;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const credential: PooledCredential = {
	type: "oauth",
	access: "managed",
	refresh: "managed",
	expires: START + 30 * 24 * HOUR,
	accounts: [
		{ name: "alpha", access: "alpha-access", refresh: "alpha-refresh", source: "login" },
		{ name: "bravo", access: "bravo-access", refresh: "bravo-refresh", source: "login" },
	],
};

const sources = () => ({
	providerId: PROVIDER,
	credential,
	env: () => undefined,
	repository,
	policy: { affinity: false },
	now: () => clock,
});

function failure(status: number, message: string): Error {
	return Object.assign(new Error(message), { status });
}

async function* served(): AsyncGenerator<AssistantMessageEvent> {
	yield {
		type: "done",
		reason: "stop",
		message: {
			role: "assistant",
			content: [],
			api: "openai-codex-responses",
			provider: PROVIDER,
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: START,
		},
	};
}

async function request(alphaFailure: Error | undefined): Promise<void> {
	const stream = streamWithCredentialRotation({
		sources: sources(),
		runAttempt: (slot) => {
			if (slot.name === "alpha" && alphaFailure !== undefined) throw alphaFailure;
			return served();
		},
	});
	for await (const _event of stream) {
		// drain
	}
}

async function alphaState(): Promise<CredentialSlotState & Record<string, unknown>> {
	const state = (await repository.listSlots(PROVIDER, "stored")).alpha;
	if (state === undefined) throw new Error("alpha has no stored state");
	return state as CredentialSlotState & Record<string, unknown>;
}

/** Health alpha earned under its account key: one success, a live model block, and a field this engine does not know. */
async function seedAccountHealth(): Promise<string> {
	const { account } = await repository.storedSlotRevisions(PROVIDER, "alpha", {
		access: "alpha-access",
		refresh: "alpha-refresh",
	});
	await repository.mutateSlotState(
		PROVIDER,
		"stored",
		"alpha",
		() =>
			({
				credentialRevision: account,
				lastSuccessAt: START,
				modelBlocks: { [MODEL_KEY]: { blockedUntil: START + 4 * HOUR } },
				futureEngineField: "kept",
			}) as Omit<CredentialSlotState, "stateVersion">,
	);
	return account;
}

describe("senpi#5097: a block keeps the health its own credential earned", () => {
	it("an account block keeps fields another engine version wrote", async () => {
		await seedAccountHealth();
		await request(failure(402, "Payment required"));

		const state = await alphaState();
		expect(state.blockReason).toBe("account_disabled");
		expect(state.futureEngineField).toBe("kept");
		expect(state.lastSuccessAt).toBe(START);
	});

	it("a rejected-token block written under the token key keeps the account-keyed model block", async () => {
		const accountRevision = await seedAccountHealth();
		await request(failure(401, "Unauthorized"));

		const state = await alphaState();
		expect(state.blockReason).toBe("auth_error");
		expect(state.credentialRevision).not.toBe(accountRevision);
		expect(state.modelBlocks?.[MODEL_KEY]?.blockedUntil).toBe(START + 4 * HOUR);
		expect(state.lastSuccessAt).toBe(START);
		expect(state.futureEngineField).toBe("kept");
	});

	it("a slot listed while another request probes it carries its token revision", async () => {
		await request(failure(429, "Rate limit reached"));
		const blocked = await alphaState();
		if (blocked.blockedUntil === undefined) throw new Error("alpha was not blocked");
		clock = blocked.blockedUntil + 1;

		const prober = (await listRotationSlots(sources())).find((slot) => slot.name === "alpha");
		expect(prober?.heldLeaseId).toBeDefined();
		const listedDuringProbe = (await listRotationSlots(sources())).find((slot) => slot.name === "alpha");

		expect(listedDuringProbe?.blockReason).toBe("probe_in_flight");
		expect(listedDuringProbe?.materialRevision).toBeDefined();
		expect(listedDuringProbe?.materialRevision).toBe(prober?.materialRevision);
	});
});
