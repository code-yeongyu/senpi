import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { pinCredentialAccount, summarizeCredentialAccounts } from "../../../src/core/credential-accounts.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";
import { collectAuthDiagnostics, interactiveAuthNotices } from "../../../src/main.ts";

/**
 * senpi#3486 review: each credential notice must be shown exactly once per change in every mode
 * a person reads (print, model listing, interactive). Print mode collected it twice per run.
 */
const expires = 4_102_444_800_000;
const NOTICE = "an API key saved earlier";
const mixed = {
	openrouter: {
		type: "oauth",
		access: "old-access",
		refresh: "old-refresh",
		expires,
		accounts: [
			{ name: "default", source: "login", access: "old-access", refresh: "old-refresh", expires },
			{ name: "login-2", source: "login", key: "sk-secret-material-3486" },
		],
	},
};
const count = (lines: readonly string[]) => lines.filter((line) => line.includes(NOTICE)).length;
const messages = (diagnostics: readonly { message: string }[]) => diagnostics.map((d) => d.message);

describe("credential notices: exactly once per change in every mode (senpi#3486)", () => {
	let dir: string;
	let authPath: string;
	const launch = () => AuthStorage.create(authPath);

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "senpi-3486-once-"));
		authPath = join(dir, "agent", "auth.json");
		mkdirSync(join(dir, "agent"), { recursive: true });
		writeFileSync(authPath, JSON.stringify(mixed));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("print mode shows it once per run (runtime creation + print mode), then not on the next run", () => {
		const run = launch();
		const shown = [
			...messages(collectAuthDiagnostics(run, "runtime creation", { persistSeen: true })),
			...messages(collectAuthDiagnostics(run, "print mode", { persistSeen: true })),
		];
		expect(count(shown)).toBe(1);
		expect(count(messages(collectAuthDiagnostics(launch(), "runtime creation", { persistSeen: true })))).toBe(0);
	});

	it("model listing shows it once, then not on the next run", () => {
		expect(count(messages(collectAuthDiagnostics(launch(), "model listing", { persistSeen: true })))).toBe(1);
		expect(count(messages(collectAuthDiagnostics(launch(), "model listing", { persistSeen: true })))).toBe(0);
	});

	it("interactive mode shows it once, marks it seen after showing, then not on the next start", () => {
		const notices = interactiveAuthNotices(launch());
		expect(count(notices.messages)).toBe(1);
		notices.markSeen();
		expect(count(interactiveAuthNotices(launch()).messages)).toBe(0);
	});

	it("an RPC run reports it without hiding it from the next interactive start", () => {
		expect(count(messages(collectAuthDiagnostics(launch(), "runtime creation", { persistSeen: false })))).toBe(1);
		expect(count(interactiveAuthNotices(launch()).messages)).toBe(1);
	});

	it("the seen record holds no key material and a failed write does not abort startup", () => {
		const notices = interactiveAuthNotices(launch());
		notices.markSeen();
		const seen = readFileSync(join(dir, "agent", "auth-notices-seen.json"), "utf-8");
		expect(seen).not.toContain("sk-secret-material-3486");
		expect(seen).toContain("login-2");

		rmSync(join(dir, "agent", "auth-notices-seen.json"));
		mkdirSync(join(dir, "agent", "auth-notices-seen.json"));
		const blocked = interactiveAuthNotices(launch());
		expect(() => blocked.markSeen()).not.toThrow();
	});

	it("the account list marks the other kind's slot as unused and refuses to pin it", async () => {
		const storage = launch();
		const repository = new CredentialSlotRepository(join(dir, "agent", "credential-pool-state.json"));
		const accounts = await summarizeCredentialAccounts("openrouter", storage.get("openrouter"), {}, repository);
		expect(accounts.map((account) => [account.name, account.unused === true])).toEqual([
			["default", false],
			["login-2", true],
		]);
		await expect(pinCredentialAccount(storage, "openrouter", "login-2", {}, repository)).rejects.toThrow(/\/login/);
	});
});
