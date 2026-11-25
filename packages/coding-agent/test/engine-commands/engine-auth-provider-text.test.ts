import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { joinAccount, splitAccount } from "../../src/cli/auth-account-check.ts";
import { getAgentDir } from "../../src/config.ts";
import type { CredentialAccountSummary } from "../../src/core/credential-accounts.ts";
import { engine } from "../../src/engine/index.ts";

const CLI = join(__dirname, "..", "..", "src", "cli.ts");
const PLANTED = "sk-ant-canary-provider-echo-7451";
const STORED_CHECK = {
	model: "claude-model",
	outcome: "failed",
	reason: `bad key ${PLANTED}`,
	message: `401 invalid x-api-key ${PLANTED}`,
	status: 401,
	at: 1,
} as const;

let root: string;

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "engine-auth-provider-text-")));
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(
		join(getAgentDir(), "auth.json"),
		JSON.stringify({
			"anthropic-subscription": {
				type: "oauth",
				access: "claude-sdk-oauth-managed",
				refresh: "claude-sdk-oauth-managed",
				expires: 4102444800000,
				accounts: [
					{
						name: "work",
						source: "login",
						store: "claude-cli",
						dirId: "c".repeat(32),
						email: "person@example.test",
						orgName: "Example Org",
						check: STORED_CHECK,
					},
				],
			},
		}),
		{ mode: 0o600 },
	);
});

afterAll(() => {
	rmSync(join(getAgentDir(), "auth.json"), { force: true });
	rmSync(root, { recursive: true, force: true });
});

function fieldsHolding(value: unknown, path = ""): string[] {
	if (typeof value === "string") return value.includes(PLANTED) ? [path] : [];
	if (typeof value !== "object" || value === null) return [];
	return Object.entries(value).flatMap(([key, field]) => fieldsHolding(field, path ? `${path}.${key}` : key));
}

describe("engine.auth.check keeps provider text apart from its closed codes (security owner ruling, senpi#7451)", () => {
	it("puts a key-shaped string from a stored provider error in provider_text only", async () => {
		const checked = await engine.auth.check({ provider: "anthropic-subscription", refresh: false });
		expect(checked.kind).toBe("ok");
		expect(fieldsHolding(checked)).toEqual([
			"value.accounts.0.check.provider_text.reason",
			"value.accounts.0.check.provider_text.message",
		]);
		const account = checked.kind === "ok" ? checked.value.accounts[0] : undefined;
		expect(account?.check).toMatchObject({
			outcome: "failed",
			code: "unrecognized",
			message: "connection test failed: unrecognized",
			status: 401,
		});
	});

	it("leaves the command's output as it was: the stored check, joined back in its own field order", () => {
		const printed = spawnSync(
			"bun",
			[CLI, "auth", "check", "--provider", "anthropic-subscription", "--json", "--no-refresh"],
			{
				cwd: root,
				encoding: "utf8",
				timeout: 120_000,
				env: { PATH: process.env.PATH ?? "", HOME: root, SENPI_CODING_AGENT_DIR: getAgentDir(), PI_OFFLINE: "1" },
			},
		);
		const record = JSON.parse(printed.stdout) as { readonly accounts: readonly { readonly check?: unknown }[] };
		expect(JSON.stringify(record.accounts[0]?.check)).toBe(JSON.stringify(STORED_CHECK));
	});

	it("joins a split account back byte for byte, a known code included", () => {
		const known: CredentialAccountSummary = {
			name: "work",
			source: "login",
			blocked: false,
			pinned: false,
			email: "person@example.test",
			orgName: "Example Org",
			check: { model: "claude-model", outcome: "failed", reason: "rate_limit", status: 429, at: 2 },
			signIn: "signed_in",
		};
		expect(splitAccount(known).check).toMatchObject({ code: "rate_limit" });
		expect(splitAccount(known).check).not.toHaveProperty("provider_text");
		expect(splitAccount(known)).toMatchObject({ email: "person@example.test", orgName: "Example Org" });
		expect(JSON.stringify(joinAccount(splitAccount(known)))).toBe(JSON.stringify(known));
	});
});
