import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AUTH_BLOCK_REPROBE_MS } from "../../../src/core/credential-pool/auth-reprobe.ts";
import { classifyCredentialFailure } from "../../../src/core/credential-pool/classify.ts";
import { listRotationSlots, streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository, slotHealth } from "../../../src/core/credential-pool/state-store.ts";
import type {
	AccountSlot,
	ClaudeCliAccountSlot,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	AllAccountsBlockedError,
	selectAccount,
} from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { runFailover } from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";
import { cliSlot } from "../../support/claude-cli-test-slots.ts";

const NOW = 1_800_000_000_000;

function account(name: string, extra: Partial<ClaudeCliAccountSlot> = {}): AccountSlot {
	return cliSlot(name, extra);
}

function memoryStore(initial: { accounts: AccountSlot[] }): CredentialStore & { accounts: () => AccountSlot[] } {
	let credential: Record<string, unknown> = { type: "oauth", access: "m", refresh: "m", expires: NOW * 2, ...initial };
	return {
		get: async () => credential,
		read: async () => credential,
		modify: async (_provider: string, fn: (current: unknown) => Promise<unknown>) => {
			credential = (await fn(credential)) as Record<string, unknown>;
		},
		accounts: () => credential.accounts as AccountSlot[],
	} as unknown as CredentialStore & { accounts: () => AccountSlot[] };
}

describe("Claude subscription auth blocks are re-probed on a timer (senpi#3264)", () => {
	test("a rejected token blocks the account until a re-probe time, not until re-login", async () => {
		const store = memoryStore({ accounts: [account("a"), account("b")] });
		const stream = runFailover({
			accounts: store.accounts(),
			selectFn: (accounts) =>
				accounts.find((slot) => slot.blockReason === undefined) ?? (accounts[0] as AccountSlot),
			runAttempt: async function* (slot) {
				if (slot.name === "a") throw new Error("401 authentication_failed");
				yield { type: "done" };
			},
			classify: (error) =>
				String(error).includes("401")
					? { kind: "auth_error", retryable: true }
					: { kind: "other", retryable: false },
			store,
			providerId: "anthropic-subscription",
			now: () => NOW,
		});
		for await (const _event of stream) {
			// drain
		}

		const blocked = store.accounts().find((slot) => slot.name === "a");
		expect(blocked).toMatchObject({ blockReason: "auth_error", blockedUntil: NOW + AUTH_BLOCK_REPROBE_MS });
	});

	test("once the re-probe time passes, the account is selected again instead of the pool reporting blocked", () => {
		const accounts = [account("a", { blockReason: "auth_error", blockedUntil: NOW - 1 })];

		expect(selectAccount(accounts, { now: NOW }).name).toBe("a");
	});

	test("an auth block persisted before re-probe timers existed is probed rather than kept forever", () => {
		const accounts = [account("a", { blockReason: "auth_error" })];

		expect(selectAccount(accounts, { now: NOW }).name).toBe("a");
	});

	test("before the re-probe time the pool reports when it will re-check", () => {
		const accounts = [account("a", { blockReason: "auth_error", blockedUntil: NOW + AUTH_BLOCK_REPROBE_MS })];

		let thrown: unknown;
		try {
			selectAccount(accounts, { now: NOW });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(AllAccountsBlockedError);
		const blocked = thrown instanceof AllAccountsBlockedError ? thrown : undefined;
		expect(blocked?.soonestUnblockAt).toBe(NOW + AUTH_BLOCK_REPROBE_MS);
		expect(blocked?.blockReason).toBe("auth_error");
	});
});

describe("generic credential-pool auth blocks are re-probed on a timer (senpi#3264)", () => {
	let dir: string;
	let repository: CredentialSlotRepository;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "auth-reprobe-3264-"));
		repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const credential = {
		type: "api_key" as const,
		key: "key-a",
		accounts: [{ name: "a", key: "key-a", source: "login" as const }],
	};
	const sources = () => ({ providerId: "test", credential, env: () => undefined, repository, now: () => NOW });

	test("an auth block's health is blocked only until its re-probe time", () => {
		const state = { stateVersion: 1, blockReason: "auth_error" as const, blockedUntil: NOW + 1 };

		expect(slotHealth(state, NOW)).toBe("blocked");
		expect(slotHealth(state, NOW + 2)).toBe("ready");
	});

	test("a 401 records an auth block with a re-probe time", async () => {
		const action = classifyCredentialFailure(Object.assign(new Error("401 Unauthorized"), { status: 401 }), {
			nowMs: NOW,
		});
		expect(action).toMatchObject({ kind: "failover", block: { reason: "auth_error" } });

		const stream = streamWithCredentialRotation({
			sources: sources(),
			affinityKey: "session-3264",
			runAttempt: async () => {
				throw Object.assign(new Error("401 Unauthorized"), { status: 401 });
			},
		});
		await expect(
			(async () => {
				for await (const _event of stream) {
					// drain
				}
			})(),
		).rejects.toThrow();

		const slots = await repository.listSlots("test", "stored");
		expect(slots.a).toMatchObject({ blockReason: "auth_error", blockedUntil: NOW + AUTH_BLOCK_REPROBE_MS });
	});

	test("an auth block whose re-probe time passed is offered for a probe", async () => {
		const credentialRevision = await repository.storedCredentialRevision("test", "a", { key: "key-a" });
		await repository.mutateSlotState("test", "stored", "a", () => ({
			blockReason: "auth_error",
			blockedUntil: NOW - 1,
			failureCount: 1,
			credentialRevision,
		}));

		const slots = await listRotationSlots(sources());

		expect(slots).toHaveLength(1);
		expect(slots[0]?.lease).toBeDefined();
	});
});
