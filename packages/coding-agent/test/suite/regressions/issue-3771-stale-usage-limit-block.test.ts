import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { COOLDOWN_BASE_MS } from "../../../src/core/credential-pool/classify.ts";
import { listRotationSlots, streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";
import { describeProviderFailure } from "../../../src/core/provider-failure.ts";

// senpi#3771: a usage-limit block in the persisted credential-pool state must not outlive the
// limit. A spent account is blocked until the reset the provider named (not an exponential
// backoff past it), a success clears the slot's failure history, and when every slot is still
// cooling, the turn reaches the provider instead of failing locally, so a reset the user
// redeemed early is picked up on the next turn. Contract guarded: persisted pool health.

const NOW = 1_800_000_000_000;
const PROVIDER = "chatgpt-subscription";
const RESET_IN_MS = 10 * 60_000;

let dir: string;
let statePath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "issue-3771-"));
	statePath = join(dir, "credential-pool-state.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function pooled(pinned?: string): PooledCredential {
	return {
		type: "api_key",
		key: "key-a",
		accounts: [
			{ name: "a", key: "key-a", source: "login" },
			{ name: "b", key: "key-b", source: "login" },
		],
		...(pinned === undefined ? {} : { pinned }),
	};
}

function sources(repository: CredentialSlotRepository, clock: { now: number }, pinned?: string) {
	return { providerId: PROVIDER, credential: pooled(pinned), env: () => undefined, repository, now: () => clock.now };
}

function message(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-codex-responses",
		provider: PROVIDER,
		model: "gpt-5.1-codex",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

async function* succeed(): AsyncGenerator<AssistantMessageEvent> {
	yield { type: "done", reason: "stop", message: message() };
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>): Promise<string[]> {
	const seen: string[] = [];
	for await (const event of stream) seen.push(event.type);
	return seen;
}

async function blockSlot(repository: CredentialSlotRepository, name: string, key: string, blockedUntil: number) {
	const credentialRevision = await repository.storedCredentialRevision(PROVIDER, name, { key });
	await repository.mutateSlotState(PROVIDER, "stored", name, () => ({
		blockedUntil,
		blockReason: "rate_limit",
		failureCount: 10,
		credentialRevision,
	}));
}

describe("a stale usage-limit block does not keep failing turns (#3771)", () => {
	test("a persisted weekly block survives a restart, yet the next turn reaches the provider and clears it", async () => {
		const clock = { now: NOW };
		const weekly = NOW + 3 * 24 * 60 * 60_000;
		const before = new CredentialSlotRepository(statePath);
		await blockSlot(before, "a", "key-a", weekly);
		await blockSlot(before, "b", "key-b", weekly);

		const restarted = new CredentialSlotRepository(statePath);
		const listed = await listRotationSlots(sources(restarted, clock));
		expect(listed.map((slot) => [slot.name, slot.blockedUntil])).toEqual([
			["a", weekly],
			["b", weekly],
		]);

		let attempts = 0;
		const seen = await drain(
			streamWithCredentialRotation({
				sources: sources(restarted, clock),
				affinityKey: "session-3771",
				runAttempt: () => {
					attempts += 1;
					return succeed();
				},
			}),
		);

		expect(attempts).toBe(1);
		expect(seen).toEqual(["done"]);
		const probed = Object.values(await restarted.listSlots(PROVIDER, "stored")).filter(
			(state) => state.lastSuccessAt === NOW,
		);
		expect(probed).toHaveLength(1);
		expect(probed[0]?.blockedUntil).toBeUndefined();
		expect(probed[0]?.failureCount).toBeUndefined();
	});

	test("a usage limit blocks the slot until the reset it names, then the slot serves again", async () => {
		const clock = { now: NOW };
		const repository = new CredentialSlotRepository(statePath);
		const credentialRevision = await repository.storedCredentialRevision(PROVIDER, "a", { key: "key-a" });
		await repository.mutateSlotState(PROVIDER, "stored", "a", () => ({ failureCount: 10, credentialRevision }));
		const resetsAt = Math.floor((NOW + RESET_IN_MS) / 1000);
		const limit = new Error(
			`Codex error: {"type":"usage_limit_reached","message":"The usage limit has been reached","resets_at":${resetsAt}}`,
		);

		await drain(
			streamWithCredentialRotation({
				sources: sources(repository, clock, "a"),
				affinityKey: "session-3771",
				runAttempt: (slot) => {
					if (slot.name === "a") throw limit;
					return succeed();
				},
			}),
		);
		expect((await repository.listSlots(PROVIDER, "stored")).a?.blockedUntil).toBe(resetsAt * 1000);

		clock.now = resetsAt * 1000 + 1;
		const served: string[] = [];
		await drain(
			streamWithCredentialRotation({
				sources: sources(repository, clock, "a"),
				affinityKey: "session-3771",
				runAttempt: (slot) => {
					served.push(slot.name);
					return succeed();
				},
			}),
		);
		expect(served).toEqual(["a"]);
		const recovered = (await repository.listSlots(PROVIDER, "stored")).a;
		expect(recovered?.blockedUntil).toBeUndefined();
		expect(recovered?.failureCount).toBeUndefined();
	});

	test("a usage limit naming a reset already past keeps the default cooldown, never zero", async () => {
		const clock = { now: NOW };
		const repository = new CredentialSlotRepository(statePath);
		const pastReset = Math.floor((NOW - 3_600_000) / 1000);
		const limit = new Error(
			`Codex error: {"type":"usage_limit_reached","message":"The usage limit has been reached","resets_at":${pastReset}}`,
		);

		await drain(
			streamWithCredentialRotation({
				sources: sources(repository, clock, "a"),
				affinityKey: "session-3771",
				runAttempt: (slot) => {
					if (slot.name === "a") throw limit;
					return succeed();
				},
			}),
		);

		expect((await repository.listSlots(PROVIDER, "stored")).a?.blockedUntil).toBe(NOW + COOLDOWN_BASE_MS);
	});

	test("the turn's failure carries the quota code and reset timestamp", () => {
		const failure = describeProviderFailure(
			{
				category: "quota",
				httpStatus: 429,
				code: "usage_limit_reached",
				evidence: "structured_code",
				resetsAt: 1_792_540_800_000,
			},
			PROVIDER,
		);
		expect(failure).toMatchObject({
			category: "quota",
			code: "usage_limit_reached",
			resetsAt: 1_792_540_800_000,
		});
	});
});
