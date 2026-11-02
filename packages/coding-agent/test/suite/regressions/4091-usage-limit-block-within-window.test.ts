import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";

// senpi#4091: a usage limit that names no reset time fell to the exponential
// cooldown (60 s x 2^failureCount, cap 48 h). Every failed half-open probe
// doubled it, so a spent account stayed blocked for many hours after its
// provider window (5 h) had already reset.

const PROVIDER = "chatgpt-subscription";
const START = Date.UTC(2026, 9, 30, 0, 0, 0);
const HOUR = 60 * 60_000;
const USAGE_WINDOW = 5 * HOUR;
const LIMIT_WITHOUT_RESET = "You have hit your ChatGPT usage limit (plus plan).";

let dir: string;
let repository: CredentialSlotRepository;
let clock = START;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "senpi-4091-pool-"));
	repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
	clock = START;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function oneAccount(): PooledCredential {
	return {
		type: "oauth",
		access: "managed",
		refresh: "managed",
		expires: START + 30 * 24 * HOUR,
		accounts: [{ name: "alpha", access: "alpha-access", refresh: "alpha-refresh", source: "login" }],
	};
}

function message(errorMessage?: string): AssistantMessage {
	return {
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
		stopReason: errorMessage === undefined ? "stop" : "error",
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp: START,
	};
}

async function* spent(): AsyncGenerator<AssistantMessageEvent> {
	yield { type: "error", reason: "error", error: message(LIMIT_WITHOUT_RESET) };
}

async function requestSpent(): Promise<void> {
	const stream = streamWithCredentialRotation({
		sources: {
			providerId: PROVIDER,
			credential: oneAccount(),
			env: () => undefined,
			repository,
			policy: { affinity: false },
			now: () => clock,
		},
		runAttempt: () => spent(),
	});
	for await (const _event of stream) {
		// drain: the error is the stream's terminal event
	}
}

async function blockedUntil(): Promise<number> {
	const until = (await repository.listSlots(PROVIDER, "stored")).alpha?.blockedUntil;
	if (until === undefined) throw new Error("expected alpha to be blocked");
	return until;
}

describe("senpi#4091: a usage limit without a reset never blocks past its window", () => {
	it("#given every half-open probe still hits the limit #when the cooldown elapses ten times #then no block outlives the usage window", async () => {
		const lengths: number[] = [];
		for (let probe = 0; probe < 10; probe++) {
			await requestSpent();
			const until = await blockedUntil();
			lengths.push(until - clock);
			clock = until;
		}

		expect(Math.max(...lengths)).toBeLessThanOrEqual(USAGE_WINDOW);
	});
});
