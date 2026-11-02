import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listRotationSlots, streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";
import { CredentialStoreBusyError, FILE_STORAGE_LOCK_OPTIONS } from "../../../src/core/lockfile-policy.ts";

/**
 * senpi#3285: several sessions sharing one credential-pool state file. The
 * sidecar only records health, so contention on its lock may slow a health
 * write but must never fail the request it describes.
 */

const SHORT_BUDGET_MS = 150;
const FAR_FUTURE = 4_102_444_800_000;

let dir: string;
let path: string;
let repository: CredentialSlotRepository;
let held: (() => Promise<void>) | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pool-lock-3285-"));
	path = join(dir, "credential-pool-state.json");
	repository = new CredentialSlotRepository(path, { lockWaitBudgetMs: SHORT_BUDGET_MS });
});

afterEach(async () => {
	await held?.();
	held = undefined;
	rmSync(dir, { recursive: true, force: true });
});

async function holdLock(): Promise<void> {
	held = await lockfile.lock(path, FILE_STORAGE_LOCK_OPTIONS);
}

function pooled(): PooledCredential {
	return {
		type: "api_key",
		key: "key-a",
		accounts: [
			{ name: "a", key: "key-a", source: "login" },
			{ name: "b", key: "key-b", source: "login" },
		],
	};
}

function sources() {
	return { providerId: "test", credential: pooled(), env: () => undefined, repository };
}

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "test",
		model: "m",
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
		...overrides,
	};
}

async function* ok(onFirstFrame?: () => Promise<void>): AsyncGenerator<AssistantMessageEvent> {
	await onFirstFrame?.();
	yield { type: "start", partial: message() };
	yield { type: "done", reason: "stop", message: message({ content: [{ type: "text", text: "ok" }] }) };
}

async function* rateLimited(): AsyncGenerator<AssistantMessageEvent> {
	yield { type: "start", partial: message() };
	yield {
		type: "error",
		reason: "error",
		error: message({ stopReason: "error", errorMessage: "429 rate limited" }),
	};
}

async function drain(stream: AsyncIterable<AssistantMessageEvent>): Promise<string[]> {
	const seen: string[] = [];
	for await (const event of stream) seen.push(event.type);
	return seen;
}

async function seedBlock(slot: string, key: string): Promise<void> {
	const credentialRevision = await repository.storedCredentialRevision("test", slot, { key });
	await repository.mutateSlotState("test", "stored", slot, () => ({
		blockedUntil: FAR_FUTURE,
		blockReason: "rate_limit",
		failureCount: 1,
		credentialRevision,
	}));
}

describe("credential pool state-file contention never fails a request (senpi#3285)", () => {
	test("listing rotation slots reads health without waiting on a held lock", async () => {
		await seedBlock("a", "key-a");
		await holdLock();

		const slots = await listRotationSlots(sources(), { acquireLeases: false });

		expect(slots.find((slot) => slot.name === "a")).toMatchObject({ blockReason: "rate_limit" });
		expect(slots.find((slot) => slot.name === "b")?.blockReason).toBeUndefined();
	});

	test("an unreadable state file with a held lock reads as no health instead of failing the request", async () => {
		await repository.listSlots("test", "stored");
		writeFileSync(path, "{ torn");
		await holdLock();

		const slots = await listRotationSlots(sources(), { acquireLeases: false });

		expect(slots.map((slot) => [slot.name, slot.blockReason])).toEqual([
			["a", undefined],
			["b", undefined],
		]);
	});

	test("deriving a slot's credential revision neither rewrites the file nor needs the lock", async () => {
		await repository.listSlots("test", "stored");
		const before = readFileSync(path, "utf-8");
		const mtimeBefore = statSync(path).mtimeMs;
		await holdLock();

		const revisions = await Promise.all(
			["a", "b", "c"].map((slot) => repository.storedCredentialRevision("test", slot, { key: `key-${slot}` })),
		);

		expect(new Set(revisions).size).toBe(3);
		expect(readFileSync(path, "utf-8")).toBe(before);
		expect(statSync(path).mtimeMs).toBe(mtimeBefore);
	});

	test("a reply that streamed to completion still completes when its success write cannot take the lock", async () => {
		await repository.listSlots("test", "stored");

		const seen = await drain(
			streamWithCredentialRotation({
				sources: sources(),
				affinityKey: "session-3285",
				runAttempt: () => ok(holdLock),
			}),
		);

		expect(seen).toEqual(["start", "done"]);
	});

	test("a failover block write that cannot take the lock still rotates to the next account", async () => {
		await repository.listSlots("test", "stored");
		const tried: string[] = [];

		const seen = await drain(
			streamWithCredentialRotation({
				sources: sources(),
				affinityKey: "session-3285",
				runAttempt: async (slot) => {
					tried.push(slot.name);
					if (tried.length === 1) {
						await holdLock();
						return rateLimited();
					}
					return ok();
				},
			}),
		);

		expect(tried).toHaveLength(2);
		expect(new Set(tried).size).toBe(2);
		expect(seen).toEqual(["start", "done"]);
	});

	test("past the bound, a health write fails naming the lock and the wait, not a provider error", async () => {
		await repository.listSlots("test", "stored");
		await holdLock();

		const failure = await repository
			.mutateSlotState("test", "stored", "a", () => ({ failureCount: 1 }))
			.then(
				() => undefined,
				(error: unknown) => error,
			);

		expect(failure).toBeInstanceOf(CredentialStoreBusyError);
		const busy = failure instanceof CredentialStoreBusyError ? failure : undefined;
		expect(busy?.path).toBe(path);
		expect(busy?.waitedMs).toBeGreaterThanOrEqual(SHORT_BUDGET_MS);
		expect(busy?.message).toContain(path);
	});

	test("six sessions writing one state file concurrently all complete without a lost update", async () => {
		const sessions = Array.from({ length: 6 }, () => new CredentialSlotRepository(path));
		const writes = sessions.flatMap((session) =>
			Array.from({ length: 10 }, () =>
				session.mutateSlotState("test", "stored", "a", (current) => ({
					failureCount: (current?.failureCount ?? 0) + 1,
				})),
			),
		);

		await Promise.all(writes);

		const slots = await repository.listSlots("test", "stored");
		expect(slots.a).toMatchObject({ failureCount: 60, stateVersion: 60 });
	});
});
