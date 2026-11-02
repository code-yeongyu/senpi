import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { getCredentialAccounts } from "../../../src/core/credential-accounts.ts";
import { streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";
import { unblockPooledAccount } from "../../../src/core/credential-account-unblock.ts";
import { subscribeProviderAccountEvents } from "../../../src/core/extensions/builtin/anthropic-subscription/account-events.ts";
import gptAccountExtension from "../../../src/core/extensions/builtin/gpt-account.ts";
import { type Command, createAccountCommandContext, registerCommand } from "../account-command-harness.ts";

// senpi#4600 (reported by CodeRiever): /gpt-account had no `unblock`, so a ChatGPT account stayed
// blocked until its stored `blockedUntil` even after the user reset the limit on the provider
// side. The command now lifts a usage block exactly like /claude-account unblock, and a 2xx on
// the account clears its stale block - for that account only.

const NOW = 1_800_000_000_000;
const FAR_FUTURE = 4_102_444_800_000;
const PROVIDER = "chatgpt-subscription";

let dir: string;
let storage: AuthStorage;
let repository: CredentialSlotRepository;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "gpt-account-unblock-4600-"));
	storage = AuthStorage.create(join(dir, "auth.json"));
	repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function command(): Command {
	return registerCommand("gpt-account", gptAccountExtension);
}

async function seedPool(): Promise<void> {
	await storage.modify(PROVIDER, async () => ({
		type: "oauth",
		access: "access-secret",
		refresh: "refresh-secret",
		expires: 1,
		accounts: [
			{ name: "default", access: "access-secret", refresh: "refresh-secret", expires: 1, source: "login" },
			{ name: "work", access: "work-access", refresh: "work-refresh", expires: 1, source: "login" },
		],
	}));
}

async function blockSlot(
	name: string,
	material: { key?: string; access?: string; refresh?: string },
	reason: "rate_limit" | "auth_error" = "rate_limit",
): Promise<void> {
	// A block belongs to the material that earned it: without the matching revision the
	// listing discards it (omo#7084), so the seed would be a no-op.
	const credentialRevision = await repository.storedCredentialRevision(PROVIDER, name, material);
	await repository.mutateSlotState(PROVIDER, "stored", name, () => ({
		blockedUntil: FAR_FUTURE,
		blockReason: reason,
		failureCount: 1,
		credentialRevision,
	}));
}

const WORK_OAUTH = { access: "work-access", refresh: "work-refresh" };

async function blocked(name: string): Promise<boolean | undefined> {
	const accounts = await getCredentialAccounts(storage, PROVIDER, {}, repository);
	return accounts.find((account) => account.name === name)?.blocked;
}

describe("/gpt-account unblock lifts a stale usage block (#4600)", () => {
	test("unblock clears the block so the account is available again", async () => {
		await seedPool();
		await blockSlot("work", WORK_OAUTH);
		expect(await blocked("work")).toBe(true);
		const { ctx, notices } = createAccountCommandContext(storage, dir);

		await command().handler("unblock work", ctx);

		expect(await blocked("work")).toBe(false);
		expect(await blocked("default")).toBe(false);
		expect(notices.at(-1)?.type).toBe("info");
		expect(notices.at(-1)?.message).toContain("Unblocked ChatGPT Subscription OAuth account 'work'");
	});

	test("unblock on an account with no usage block says so instead of claiming a lift", async () => {
		await seedPool();
		const { ctx, notices } = createAccountCommandContext(storage, dir);

		await command().handler("unblock work", ctx);

		expect(notices.at(-1)?.message).toContain("has no usage block to lift");
	});

	test("unblock leaves an auth block in place, like /claude-account", async () => {
		await seedPool();
		await blockSlot("work", WORK_OAUTH, "auth_error");
		const { ctx, notices } = createAccountCommandContext(storage, dir);

		await command().handler("unblock work", ctx);

		expect(await blocked("work")).toBe(true);
		expect(notices.at(-1)?.message).toContain("has no usage block to lift");
	});

	test("an unknown id reports the same error shape as /claude-account", async () => {
		await seedPool();
		const { ctx, notices } = createAccountCommandContext(storage, dir);

		await command().handler("unblock nope", ctx);

		expect(notices.at(-1)?.type).toBe("error");
		expect(notices.at(-1)?.message).toBe("ChatGPT Subscription OAuth account 'nope' does not exist.");
	});

	test("unblock without an id reports usage instead of touching any account", async () => {
		await seedPool();
		await blockSlot("work", WORK_OAUTH);
		const { ctx, notices } = createAccountCommandContext(storage, dir);

		await command().handler("unblock", ctx);

		expect(await blocked("work")).toBe(true);
		expect(notices.at(-1)?.type).toBe("error");
		expect(notices.at(-1)?.message).toContain("Usage: /gpt-account unblock <id>");
	});

	test("the help text lists unblock", async () => {
		const { ctx, notices } = createAccountCommandContext(storage, dir);

		await command().handler("bogus-action", ctx);

		expect(notices.at(-1)?.message).toContain("unblock <id>");
	});
});

describe("a 2xx on a blocked account clears that account's stale block only (#4600)", () => {
	test("the served account recovers while another account keeps its block", async () => {
		const clock = { now: NOW };
		await blockSlot("default", { key: "key-default" });
		await blockSlot("work", { key: "key-work" });
		const credential: PooledCredential = {
			type: "api_key",
			key: "key-default",
			accounts: [
				{ name: "default", key: "key-default", source: "login" },
				{ name: "work", key: "key-work", source: "login" },
			],
			pinned: "default",
		};
		const message: AssistantMessage = {
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
		async function* succeed(): AsyncGenerator<AssistantMessageEvent> {
			yield { type: "done", reason: "stop", message };
		}

		const served: string[] = [];
		const stream = streamWithCredentialRotation({
			sources: { providerId: PROVIDER, credential, env: () => undefined, repository, now: () => clock.now },
			affinityKey: "session-4600",
			runAttempt: (slot) => {
				served.push(slot.name);
				return succeed();
			},
		});
		for await (const _event of stream) {
			// drain
		}

		expect(served).toEqual(["default"]);
		const slots = await repository.listSlots(PROVIDER, "stored");
		expect(slots.default?.blockedUntil).toBeUndefined();
		expect(slots.work?.blockedUntil).toBe(FAR_FUTURE);
	});
});

describe("unblock is narrow: only the account-level block is lifted (#4600)", () => {
	test("per-model usage limits and an in-flight lease survive the unblock", async () => {
		await seedPool();
		const credentialRevision = await repository.storedCredentialRevision(PROVIDER, "work", WORK_OAUTH);
		await repository.mutateSlotState(PROVIDER, "stored", "work", () => ({
			blockedUntil: FAR_FUTURE,
			blockReason: "rate_limit",
			failureCount: 1,
			credentialRevision,
			lease: { id: "lease-1", expiresAt: FAR_FUTURE },
			modelBlocks: { "gpt-5.1-codex": { blockedUntil: FAR_FUTURE } },
		}));
		const { ctx } = createAccountCommandContext(storage, dir);

		await command().handler("unblock work", ctx);

		const slot = (await repository.listSlots(PROVIDER, "stored")).work;
		expect(slot?.blockedUntil).toBeUndefined();
		expect(slot?.blockReason).toBeUndefined();
		expect(slot?.modelBlocks).toEqual({ "gpt-5.1-codex": { blockedUntil: FAR_FUTURE } });
		expect(slot?.lease).toEqual({ id: "lease-1", expiresAt: FAR_FUTURE });
		const accounts = await getCredentialAccounts(storage, PROVIDER, {}, repository);
		const work = accounts.find((account) => account.name === "work");
		expect(work?.blocked).toBe(false);
		expect(work?.blockedModels).toEqual([{ model: "gpt-5.1-codex", until: FAR_FUTURE }]);
	});

	test("a block written between the listing and the write is not erased", async () => {
		await seedPool();
		const credentialRevision = await repository.storedCredentialRevision(PROVIDER, "work", WORK_OAUTH);
		await blockSlot("work", WORK_OAUTH);

		// The listing that decides liftability is unlocked, so another session can record an auth
		// block right after it. The decision is retaken inside the locked write, so that block stays.
		class RacingRepository extends CredentialSlotRepository {
			private raced = false;
			override async listSlots(providerId: string, laneId: string) {
				const slots = await super.listSlots(providerId, laneId);
				if (!this.raced && laneId === "stored") {
					this.raced = true;
					await super.mutateSlotState(providerId, laneId, "work", () => ({
						blockedUntil: FAR_FUTURE,
						blockReason: "auth_error",
						failureCount: 2,
						credentialRevision,
					}));
				}
				return slots;
			}
		}
		const racing = new RacingRepository(join(dir, "credential-pool-state.json"));

		const outcome = await unblockPooledAccount(storage, PROVIDER, "work", {}, racing);

		expect(outcome).toMatchObject({ lifted: false, blocked: true, blockedReason: "auth_error" });
		const slot = (await repository.listSlots(PROVIDER, "stored")).work;
		expect(slot?.blockReason).toBe("auth_error");
		expect(slot?.blockedUntil).toBe(FAR_FUTURE);
	});
});

describe("the outcome is the merged state, and dead blocks are left alone (#4603 review)", () => {
	// senpi#4885: generic pool rotation reads only revision-matched sidecar health, so an auth block a ChatGPT
	// slot carries in auth.json is not a block the selector honours. The merged state after lifting the sidecar
	// block is therefore usable, and the stored field is left exactly as it was.
	test("an auth block stored in auth.json does not keep a ChatGPT account blocked once the sidecar block lifts", async () => {
		await storage.modify(PROVIDER, async () => ({
			type: "oauth",
			access: "access-secret",
			refresh: "refresh-secret",
			expires: 1,
			accounts: [
				{ name: "default", access: "access-secret", refresh: "refresh-secret", expires: 1, source: "login" },
				{
					name: "work",
					access: "work-access",
					refresh: "work-refresh",
					expires: 1,
					source: "login",
					blockReason: "auth_error",
					blockedUntil: FAR_FUTURE,
				},
			],
		}));
		await blockSlot("work", WORK_OAUTH);
		const { ctx, notices } = createAccountCommandContext(storage, dir);

		await command().handler("unblock work", ctx);

		expect(notices.at(-1)?.message).toContain("The next turn may use it");
		expect(notices.at(-1)?.message).not.toContain("still blocked");
		expect(await blocked("work")).toBe(false);
		expect((await repository.listSlots(PROVIDER, "stored")).work?.blockedUntil).toBeUndefined();
		const stored = (storage.get(PROVIDER) as PooledCredential).accounts?.find((slot) => slot.name === "work") as
			| { blockReason?: unknown; blockedUntil?: unknown }
			| undefined;
		expect(stored?.blockReason).toBe("auth_error");
		expect(stored?.blockedUntil).toBe(FAR_FUTURE);
	});

	test("an expired block is not rewritten and reports nothing to lift", async () => {
		await seedPool();
		const credentialRevision = await repository.storedCredentialRevision(PROVIDER, "work", WORK_OAUTH);
		await repository.mutateSlotState(PROVIDER, "stored", "work", () => ({
			blockedUntil: Date.now() - 60_000,
			blockReason: "rate_limit",
			credentialRevision,
		}));
		const before = (await repository.listSlots(PROVIDER, "stored")).work;
		const { ctx, notices } = createAccountCommandContext(storage, dir);

		await command().handler("unblock work", ctx);

		expect(notices.at(-1)?.message).toContain("has no usage block to lift");
		expect((await repository.listSlots(PROVIDER, "stored")).work).toEqual(before);
	});

	test("a block left by a previous login is not rewritten", async () => {
		await seedPool();
		const staleRevision = await repository.storedCredentialRevision(PROVIDER, "work", { access: "stale-access" });
		await repository.mutateSlotState(PROVIDER, "stored", "work", () => ({
			blockedUntil: FAR_FUTURE,
			blockReason: "rate_limit",
			credentialRevision: staleRevision,
		}));
		const before = (await repository.listSlots(PROVIDER, "stored")).work;
		const { ctx, notices } = createAccountCommandContext(storage, dir);

		await command().handler("unblock work", ctx);

		expect(notices.at(-1)?.message).toContain("has no usage block to lift");
		expect((await repository.listSlots(PROVIDER, "stored")).work).toEqual(before);
	});

	test("an account with no sidecar entry gets none created", async () => {
		await seedPool();
		const { ctx } = createAccountCommandContext(storage, dir);

		await command().handler("unblock work", ctx);

		expect(await repository.listSlots(PROVIDER, "stored")).toEqual({});
	});

	test("a failing stored write still emits the accounts-changed event for the sidecar lift", async () => {
		await seedPool();
		await blockSlot("work", WORK_OAUTH);
		const events: string[] = [];
		const unsubscribe = subscribeProviderAccountEvents((event) => {
			if (event.type === "accounts_changed") events.push(event.provider);
		});
		const failing = {
			get: (provider: string) => storage.get(provider),
			getStoragePath: () => storage.getStoragePath(),
			listSlots: (provider: string) => storage.listSlots(provider),
			modify: async () => {
				throw new Error("auth.json is locked");
			},
		} as unknown as AuthStorage;

		await expect(unblockPooledAccount(failing, PROVIDER, "work", {}, repository)).rejects.toThrow(
			"auth.json is locked",
		);

		unsubscribe();
		expect(events).toContain(PROVIDER);
		expect((await repository.listSlots(PROVIDER, "stored")).work?.blockedUntil).toBeUndefined();
	});
});

describe("the lift is only claimed once the write landed, and flat credentials are covered (#4603 delta 2)", () => {
	test("a write that throws after its callback ran neither lifts nor emits", async () => {
		await seedPool();
		await blockSlot("work", WORK_OAUTH);
		const events: string[] = [];
		const unsubscribe = subscribeProviderAccountEvents((event) => {
			if (event.type === "accounts_changed") events.push(event.provider);
		});

		// The real repository runs the callback and only then writes the document, so a write that
		// fails must leave the caller with "nothing lifted".
		class ThrowingRepository extends CredentialSlotRepository {
			override async mutateSlotState(
				providerId: string,
				laneId: string,
				slotId: string,
				fn: Parameters<CredentialSlotRepository["mutateSlotState"]>[3],
			): ReturnType<CredentialSlotRepository["mutateSlotState"]> {
				fn((await super.listSlots(providerId, laneId))[slotId]);
				throw new Error("credential-pool-state.json is not writable");
			}
		}
		const throwing = new ThrowingRepository(join(dir, "credential-pool-state.json"));

		await expect(unblockPooledAccount(storage, PROVIDER, "work", {}, throwing)).rejects.toThrow("not writable");

		unsubscribe();
		expect(events).toEqual([]);
		expect((await repository.listSlots(PROVIDER, "stored")).work?.blockedUntil).toBe(FAR_FUTURE);
	});

	test("a previous-login block on a flat pre-pool credential is not lifted", async () => {
		// No `accounts` array: the listing reads this as the implicit `default` slot.
		await storage.modify(PROVIDER, async () => ({
			type: "oauth",
			access: "flat-access",
			refresh: "flat-refresh",
			expires: 1,
		}));
		const staleRevision = await repository.storedCredentialRevision(PROVIDER, "default", {
			access: "previous-login-access",
			refresh: "previous-login-refresh",
		});
		await repository.mutateSlotState(PROVIDER, "stored", "default", () => ({
			blockedUntil: FAR_FUTURE,
			blockReason: "rate_limit",
			credentialRevision: staleRevision,
		}));
		const before = (await repository.listSlots(PROVIDER, "stored")).default;
		const { ctx, notices } = createAccountCommandContext(storage, dir);

		await command().handler("unblock default", ctx);

		expect(notices.at(-1)?.message).toContain("has no usage block to lift");
		expect((await repository.listSlots(PROVIDER, "stored")).default).toEqual(before);
	});

	test("a live block on a flat pre-pool credential is still lifted", async () => {
		await storage.modify(PROVIDER, async () => ({
			type: "oauth",
			access: "flat-access",
			refresh: "flat-refresh",
			expires: 1,
		}));
		const credentialRevision = await repository.storedCredentialRevision(PROVIDER, "default", {
			access: "flat-access",
			refresh: "flat-refresh",
		});
		await repository.mutateSlotState(PROVIDER, "stored", "default", () => ({
			blockedUntil: FAR_FUTURE,
			blockReason: "rate_limit",
			credentialRevision,
		}));
		const { ctx, notices } = createAccountCommandContext(storage, dir);

		await command().handler("unblock default", ctx);

		expect(notices.at(-1)?.message).toContain("Unblocked");
		expect((await repository.listSlots(PROVIDER, "stored")).default?.blockedUntil).toBeUndefined();
	});

	test("a block written between the unlocked pre-check and the locked write is refused", async () => {
		await seedPool();
		const credentialRevision = await repository.storedCredentialRevision(PROVIDER, "work", WORK_OAUTH);
		await blockSlot("work", WORK_OAUTH);

		// The pre-check is the LAST stored listing before the write, so injecting on it lands the
		// competing block strictly between the pre-check and the locked callback.
		class LateRacingRepository extends CredentialSlotRepository {
			private storedReads = 0;
			override async listSlots(providerId: string, laneId: string) {
				const slots = await super.listSlots(providerId, laneId);
				if (laneId !== "stored") return slots;
				this.storedReads += 1;
				if (this.storedReads === 2) {
					await super.mutateSlotState(providerId, laneId, "work", () => ({
						blockedUntil: FAR_FUTURE,
						blockReason: "auth_error",
						credentialRevision,
					}));
				}
				return slots;
			}
		}
		const racing = new LateRacingRepository(join(dir, "credential-pool-state.json"));

		const outcome = await unblockPooledAccount(storage, PROVIDER, "work", {}, racing);

		expect(outcome.lifted).toBe(false);
		const slot = (await repository.listSlots(PROVIDER, "stored")).work;
		expect(slot?.blockReason).toBe("auth_error");
		expect(slot?.blockedUntil).toBe(FAR_FUTURE);
	});
});
