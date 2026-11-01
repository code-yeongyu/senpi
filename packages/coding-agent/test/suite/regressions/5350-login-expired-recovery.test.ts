/**
 * senpi#5350 (PR-A): a due auth re-probe of a claude CLI account that `claude auth status` confirms `signed_out`
 * marks the account `login_expired` (needs /login) instead of re-blocking it forever. The account keeps its
 * `auth_error` cadence block, so the same local probe keeps running and `signed_in` clears the flag (self-heal).
 * `unreadable`, `rejected` and a thrown probe keep today's 15-min re-block.
 *
 * Guard tests (already green on main, kept as regression guards for the new union member): "not yet due",
 * "legacy_sign_in_retired", "legacy text", "signedInSlot", "needs_sign_in" and "unblock". "thrown status probe"
 * guards today's behaviour; it fails on main only because the status callback was renamed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { summarizeCredentialAccounts } from "../../../src/core/credential-accounts.ts";
import { AUTH_BLOCK_REPROBE_MS } from "../../../src/core/credential-pool/auth-reprobe.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";
import { registerClaudeAccountCommand } from "../../../src/core/extensions/builtin/anthropic-subscription/account-command.ts";
import { unblockProviderAccount } from "../../../src/core/extensions/builtin/anthropic-subscription/account-management.ts";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	addAccount,
	type ClaudeCliAccountSlot,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { isBlockedFor } from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { recoverAuthBlockedSlots } from "../../../src/core/extensions/builtin/anthropic-subscription/auth-block-recovery.ts";
import type { ClaudeCliAuthStatus } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-auth-status.ts";
import { signedInSlot } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-login-slots.ts";
import {
	overrideContinuityObservabilityBoundary,
	resetContinuityObservabilityBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-observability.ts";
import {
	ClaudeSignInRequiredError,
	isSignInAgainError,
	signInAgainMessage,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sign-in-again.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";
import { cliSlot } from "../../support/claude-cli-test-slots.ts";
import { type Command, createAccountCommandContext } from "../account-command-harness.ts";

const NOW = 1_800_000_000_000;
const PROVIDER = "anthropic-subscription";
const DUE = { blockReason: "auth_error", blockedUntil: NOW - 1, blockedAt: NOW - AUTH_BLOCK_REPROBE_MS } as const;
const EXPIRED = { ...DUE, signInRequired: "login_expired" } as const;
type State = ClaudeCliAuthStatus["state"];

const dirs: string[] = [];
let events: Array<{ event: string; data: Record<string, unknown> }> = [];

afterEach(() => {
	resetContinuityObservabilityBoundary();
	events = [];
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "senpi-5350-"));
	dirs.push(dir);
	return dir;
}

function memoryStore(accounts: AccountSlot[]): CredentialStore & { accounts: () => AccountSlot[] } {
	let credential: Record<string, unknown> = { type: "oauth", access: "m", refresh: "m", expires: NOW * 2, accounts };
	return {
		read: async () => credential,
		modify: async (_provider: string, fn: (current: unknown) => Promise<unknown>) => {
			credential = (await fn(credential)) as Record<string, unknown>;
		},
		accounts: () => credential.accounts as AccountSlot[],
	} as unknown as CredentialStore & { accounts: () => AccountSlot[] };
}

async function recover(
	accounts: AccountSlot[],
	status: (slot: ClaudeCliAccountSlot) => Promise<State>,
	isUsable: (account: AccountSlot) => boolean = (account) => !isBlockedFor(account, NOW),
) {
	overrideContinuityObservabilityBoundary({ log: (event, data) => events.push({ event, data }) });
	const store = memoryStore(accounts);
	const probed: string[] = [];
	const result = await recoverAuthBlockedSlots({
		store,
		providerId: PROVIDER,
		accounts,
		signal: new AbortController().signal,
		reload: async () => store.accounts(),
		isUsable,
		now: NOW,
		transientError: () => new Error("transient re-probe failure"),
		claudeCliStatus: async (slot) => {
			probed.push(slot.name);
			return status(slot);
		},
	} as Parameters<typeof recoverAuthBlockedSlots>[0]);
	const slot = (name: string) => store.accounts().find((account) => account.name === name);
	return { result, probed, slot };
}

const loginEvents = () => events.filter(({ event }) => event.startsWith("claude_cli_login_"));

describe("senpi#5350 a confirmed signed-out CLI login becomes login_expired and heals itself", () => {
	it("RED: a due re-probe that reports signed_out marks login_expired and keeps a 15-min cadence block", async () => {
		const { slot } = await recover([cliSlot("alice", DUE)], async () => "signed_out");
		expect(slot("alice")).toMatchObject({
			signInRequired: "login_expired",
			blockReason: "auth_error",
			blockedUntil: NOW + AUTH_BLOCK_REPROBE_MS,
			blockedAt: NOW,
		});
		expect(loginEvents()).toEqual([{ event: "claude_cli_login_expired", data: { accountName: "alice" } }]);
		expect(Object.keys(loginEvents()[0]?.data ?? {})).toEqual(["accountName"]);
	});

	it.each(["unreadable", "rejected"] as const)(
		"RED: %s keeps the 15-min re-block and never sets login_expired (only the literal signed_out does)",
		async (state) => {
			const { slot } = await recover([cliSlot("alice", DUE)], async () => state);
			expect(slot("alice")).toMatchObject({ blockReason: "auth_error", blockedUntil: NOW + AUTH_BLOCK_REPROBE_MS });
			expect(slot("alice")).not.toHaveProperty("signInRequired");
			expect(loginEvents()).toEqual([]);
		},
	);

	it("guard: a thrown status probe leaves the slot unchanged; with no usable account it surfaces transientError", async () => {
		const thrown = async (): Promise<State> => {
			throw new Error("spawn failed");
		};
		const { slot, probed } = await recover([cliSlot("alice", DUE)], thrown);
		expect(probed).toEqual(["alice"]);
		expect(slot("alice")).toEqual(cliSlot("alice", DUE));
		expect(loginEvents()).toEqual([]);
		await expect(recover([cliSlot("alice", DUE)], thrown, () => false)).rejects.toThrow("transient re-probe failure");
	});

	it("RED: a due login_expired slot is re-probed; signed_in clears the flag and the block and logs restored", async () => {
		const { slot, probed } = await recover([cliSlot("alice", EXPIRED)], async () => "signed_in");
		expect(probed).toEqual(["alice"]);
		const healed = slot("alice");
		for (const field of ["signInRequired", "blockReason", "blockedUntil", "blockedAt"]) {
			expect(healed).not.toHaveProperty(field);
		}
		expect(loginEvents()).toEqual([{ event: "claude_cli_login_restored", data: { accountName: "alice" } }]);
	});

	it("RED: a due login_expired slot that probes signed_out again stays expired and logs no second transition", async () => {
		const { slot } = await recover([cliSlot("alice", EXPIRED)], async () => "signed_out");
		expect(slot("alice")).toMatchObject({
			signInRequired: "login_expired",
			blockedUntil: NOW + AUTH_BLOCK_REPROBE_MS,
		});
		expect(loginEvents()).toEqual([]);
	});

	it("guard: a login_expired slot that is not yet due is not probed", async () => {
		const notDue = cliSlot("alice", { ...EXPIRED, blockedUntil: NOW + 1 });
		const { probed } = await recover([notDue], async () => "signed_in");
		expect(probed).toEqual([]);
	});

	it("guard: legacy_sign_in_retired is never probed", async () => {
		const retired = cliSlot("alice", { ...DUE, signInRequired: "legacy_sign_in_retired" });
		const { probed, slot } = await recover([retired], async () => "signed_in");
		expect(probed).toEqual([]);
		expect(slot("alice")).toMatchObject({ signInRequired: "legacy_sign_in_retired" });
	});
});

describe("senpi#5350 the login_expired surfaces", () => {
	it("guard: the legacy sign-in-again text is byte-identical", () => {
		expect(signInAgainMessage(["a", "b"])).toBe(
			"Claude sign-in changed. Sign in again with Claude to keep using: a, b. Run /login anthropic-subscription.",
		);
	});

	it("RED: the expired turn error names the accounts and is detected by the one shared prefix", () => {
		const error = new ClaudeSignInRequiredError([{ name: "work", reason: "login_expired" }]);
		expect(error.message).toBe(
			"authentication_failed: Claude sign-in expired. Sign in again with Claude to keep using: work. Run /login anthropic-subscription.",
		);
		expect(isSignInAgainError(error.message)).toBe(true);
		expect(isSignInAgainError(new ClaudeSignInRequiredError(["old"]).message)).toBe(true);
	});

	it("guard: signedInSlot drops login_expired", () => {
		const signedIn = signedInSlot(cliSlot("alice", EXPIRED), "alice", "f".repeat(32), {}, NOW);
		expect(signedIn).not.toHaveProperty("signInRequired");
		expect(signedIn).not.toHaveProperty("blockReason");
	});

	it("guard: login_expired lists as signIn needs_sign_in over RPC", async () => {
		const credential = addAccount(emptyCredential(), cliSlot("alice", EXPIRED));
		const repository = new CredentialSlotRepository(join(tempDir(), "pool-state.json"));
		const [summary] = await summarizeCredentialAccounts(PROVIDER, credential, {}, repository);
		expect(summary).toMatchObject({ name: "alice", signIn: "needs_sign_in" });
	});

	it("guard (Q4, account-management.ts:114): /claude-account unblock leaves a login_expired slot intact", async () => {
		const storage = AuthStorage.create(join(tempDir(), "auth.json"));
		const pending = { ...EXPIRED, blockedUntil: Date.now() + AUTH_BLOCK_REPROBE_MS };
		await storage.modify(PROVIDER, async () => addAccount(emptyCredential(), cliSlot("alice", pending)));
		expect(await unblockProviderAccount(storage, PROVIDER, "alice", {})).toBe(false);
		const stored = (storage.get(PROVIDER) as AnthropicSubscriptionCredential).accounts?.[0];
		expect(stored).toMatchObject({ signInRequired: "login_expired", blockReason: "auth_error" });
	});

	it("RED: /claude-account list shows sign-in expired instead of the timed-block text", async () => {
		const dir = tempDir();
		const storage = AuthStorage.create(join(dir, "auth.json"));
		const pending = { ...EXPIRED, blockedUntil: Date.now() + AUTH_BLOCK_REPROBE_MS };
		await storage.modify(PROVIDER, async () => addAccount(emptyCredential(), cliSlot("alice", pending)));
		const commands = new Map<string, Command>();
		const pi = {
			registerCommand: (name: string, command: Command) => commands.set(name, command),
			registerFlag: () => undefined,
			getFlag: () => undefined,
			on: () => undefined,
		} as unknown as ExtensionAPI;
		registerClaudeAccountCommand(pi, { loadSettings: () => ({}), environment: () => undefined });
		const { ctx, notices } = createAccountCommandContext(storage, dir);
		await commands.get("claude-account")?.handler("", ctx);
		const output = notices.map((notice) => notice.message).join("\n");
		expect(output).toContain("alice | login | sign-in expired - run /login anthropic-subscription");
		expect(output).not.toContain("sign-in rejected");
	});
});
