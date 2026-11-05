import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getCredentialAccounts, removeCredentialAccount } from "../src/core/credential-accounts.ts";
import { CredentialSlotRepository } from "../src/core/credential-pool/state-store.ts";
import type { ClaudeCliAccountSlot } from "../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { emptyCredential } from "../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	accountDirFor,
	ensureAccountDir,
} from "../src/core/extensions/builtin/anthropic-subscription/claude-cli-account-dir.ts";

const PROVIDER = "anthropic-subscription";
const FIXTURE = join(import.meta.dirname, "fixtures", "claude-cli-auth", "fake-claude.mjs");
const DIR_ID = "fedcba9876543210fedcba9876543210";

const CLI_SLOT: ClaudeCliAccountSlot = {
	name: "work",
	source: "login",
	store: "claude-cli",
	dirId: DIR_ID,
	signedInAt: 1_793_000_000_000,
	profile: {
		email: "user@example.com",
		orgName: "Fixture Org",
		subscriptionType: "max",
		checkedAt: 1_793_000_000_000,
	},
	check: { model: "claude-opus-5-5", outcome: "ok", at: 1_793_000_000_100 },
};

let root: string;
let storage: AuthStorage;
let repository: CredentialSlotRepository;
let sharedRoot: string;

function cliEnv(mode: string): NodeJS.ProcessEnv {
	const executable = join(root, "claude");
	copyFileSync(FIXTURE, executable);
	chmodSync(executable, 0o755);
	return {
		PATH: process.env.PATH,
		HOME: root,
		CLAUDE_CODE_EXECUTABLE: executable,
		CLAUDE_CONFIG_DIR: sharedRoot,
		FAKE_CLAUDE_MODE: mode,
	};
}

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "senpi-cli-slot-listing-"));
	storage = AuthStorage.create(join(root, "agent", "auth.json"));
	repository = new CredentialSlotRepository(join(root, "agent", "credential-pool-state.json"));
	sharedRoot = join(root, "shared-claude");
	mkdirSync(join(sharedRoot, "projects"), { recursive: true });
	writeFileSync(join(sharedRoot, "projects", "x.jsonl"), "{}\n");
	await storage.modify(PROVIDER, async () => ({ ...emptyCredential(), accounts: [CLI_SLOT] }));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("CLI-store slot listing", () => {
	it("the summary of a CLI slot carries the store, sign-in time, profile and check", async () => {
		const [account] = await getCredentialAccounts(storage, PROVIDER, {}, repository);

		expect(account).toEqual({
			name: "work",
			source: "login",
			store: "claude-cli",
			signedInAt: 1_793_000_000_000,
			email: "user@example.com",
			orgName: "Fixture Org",
			subscriptionType: "max",
			check: { model: "claude-opus-5-5", outcome: "ok", at: 1_793_000_000_100 },
			signIn: "signed_in",
			blocked: false,
			pinned: false,
		});
	});

	it("a slot whose old sign-in was retired lists as needing sign-in", async () => {
		await storage.modify(PROVIDER, async () => ({
			...emptyCredential(),
			accounts: [{ ...CLI_SLOT, signInRequired: "legacy_sign_in_retired" }],
		}));

		const [account] = await getCredentialAccounts(storage, PROVIDER, {}, repository);

		expect(account?.signIn).toBe("needs_sign_in");
	});
});

describe("CLI-store slot removal", () => {
	it("signs the account out, removes its dir and keeps the shared root", async () => {
		const accountDir = ensureAccountDir({ agentDir: join(root, "agent"), dirId: DIR_ID, sharedRoot });

		await removeCredentialAccount(storage, PROVIDER, "work", cliEnv("logout-ok"), repository);

		expect(existsSync(accountDir)).toBe(false);
		expect(existsSync(join(sharedRoot, "projects", "x.jsonl"))).toBe(true);
		expect(await getCredentialAccounts(storage, PROVIDER, {}, repository)).toEqual([]);
	});

	it.each([
		["the sign-out fails", () => cliEnv("logout-fail")],
		[
			"claude cannot be run",
			() => {
				// A file the resolver accepts (it only stats) but the OS refuses to execute: no real claude ever runs.
				const unrunnable = join(root, "unrunnable-claude");
				writeFileSync(unrunnable, "not a binary\n", { mode: 0o644 });
				return { ...cliEnv("logout-ok"), CLAUDE_CODE_EXECUTABLE: unrunnable };
			},
		],
	])("when %s the account and its dir are still removed, with a notice", async (_label, env) => {
		ensureAccountDir({ agentDir: join(root, "agent"), dirId: DIR_ID, sharedRoot });

		const result = await removeCredentialAccount(storage, PROVIDER, "work", env(), repository);

		expect(result.notice).toMatch(/sign-out could not run/);
		expect(existsSync(accountDirFor(join(root, "agent"), DIR_ID))).toBe(false);
		expect(existsSync(join(sharedRoot, "projects", "x.jsonl"))).toBe(true);
		expect(await getCredentialAccounts(storage, PROVIDER, {}, repository)).toEqual([]);
	});

	it("an account dir that is a link is left untouched, and the slot is dropped with a notice", async () => {
		const accountDir = accountDirFor(join(root, "agent"), DIR_ID);
		mkdirSync(join(root, "agent", "anthropic-subscription-claude"), { recursive: true });
		symlinkSync(sharedRoot, accountDir, process.platform === "win32" ? "junction" : "dir");

		const result = await removeCredentialAccount(storage, PROVIDER, "work", cliEnv("logout-ok"), repository);

		expect(result.notice).toMatch(/its account dir is a link or a file, left untouched/);
		expect(lstatSync(accountDir).isSymbolicLink()).toBe(true);
		expect(existsSync(join(sharedRoot, "projects", "x.jsonl"))).toBe(true);
		expect(await getCredentialAccounts(storage, PROVIDER, {}, repository)).toEqual([]);
	});

	it.each([
		["no dir id", { ...CLI_SLOT, dirId: undefined }],
		["a malformed dir id", { ...CLI_SLOT, dirId: "../escape" }],
	])("a slot with %s is dropped and reported, never stuck", async (_label, slot) => {
		await storage.modify(PROVIDER, async () => ({ ...emptyCredential(), accounts: [slot] }));

		const result = await removeCredentialAccount(storage, PROVIDER, "work", cliEnv("logout-fail"), repository);

		expect(result.notice).toMatch(/without a Claude sign-out/);
		expect(await getCredentialAccounts(storage, PROVIDER, {}, repository)).toEqual([]);
	});
});
