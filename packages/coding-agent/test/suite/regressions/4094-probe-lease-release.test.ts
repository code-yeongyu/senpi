import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialFailoverError } from "../../../src/core/credential-pool/failover.ts";
import { streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { acquireHalfOpenLease, CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";

// senpi#4094: the half-open probe lease an expired cooldown hands one caller was
// kept for its full 30 s TTL when the probe ended without a verdict (an abort, a
// request-scoped failure), and every other caller dropped the slot outright, so a
// one-slot pool refused with "No credential slots available" and no retry time.

const PROVIDER = "chatgpt-subscription";
const START = Date.UTC(2026, 9, 30, 0, 0, 0);
const HOUR = 60 * 60_000;

let dir: string;
let repository: CredentialSlotRepository;
let clock = START;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "senpi-4094-pool-"));
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

function abortError(): Error {
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}

async function request(attempt: () => AsyncIterable<AssistantMessageEvent>, attempts: string[]): Promise<unknown> {
	const stream = streamWithCredentialRotation({
		sources: {
			providerId: PROVIDER,
			credential: oneAccount(),
			env: () => undefined,
			repository,
			policy: { affinity: false },
			now: () => clock,
		},
		runAttempt: (slot) => {
			attempts.push(slot.name);
			return attempt();
		},
	});
	try {
		for await (const _event of stream) {
			// drain
		}
		return undefined;
	} catch (error) {
		return error;
	}
}

async function coolDownAlpha(attempts: string[]): Promise<number> {
	await request(() => {
		throw Object.assign(new Error("Too Many Requests"), { status: 429 });
	}, attempts);
	const until = (await repository.listSlots(PROVIDER, "stored")).alpha?.blockedUntil;
	if (until === undefined) throw new Error("expected alpha to cool down");
	return until;
}

describe("senpi#4094: a half-open probe lease never strands a slot", () => {
	it("#given the probe was aborted #when the next request comes 1 ms later #then it probes the slot", async () => {
		const attempts: string[] = [];
		clock = (await coolDownAlpha(attempts)) + 1;

		await request(() => {
			throw abortError();
		}, attempts);
		clock += 1;
		const outcome = await request(served, attempts);

		expect(outcome).toBeUndefined();
		expect(attempts).toEqual(["alpha", "alpha", "alpha"]);
	});

	it("#given another caller holds the live probe lease #when the pool refuses #then the refusal names the lease expiry as the retry time", async () => {
		const attempts: string[] = [];
		clock = (await coolDownAlpha(attempts)) + 1;
		const lease = await acquireHalfOpenLease(repository, PROVIDER, "stored", "alpha", { now: clock });
		if (lease === undefined) throw new Error("expected to take the probe lease");

		const outcome = await request(served, attempts);

		expect(outcome).toBeInstanceOf(CredentialFailoverError);
		expect((outcome as CredentialFailoverError).retryAt).toBe(lease.expiresAt);
		expect(attempts).toEqual(["alpha"]);
	});
});
