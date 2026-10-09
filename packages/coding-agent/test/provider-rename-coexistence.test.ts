import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage, readStoredCredential } from "../src/core/auth-storage.ts";
import { resolveAccountsDirectory } from "../src/core/extensions/builtin/anthropic-subscription/config-dir-credentials.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Multi-binary coexistence for the subscription provider rename (senpi#1989).
 *
 * An agent directory written by the OLD binary - every provider id in its
 * legacy spelling - must stay fully usable after upgrading, and running the new
 * binary twice must not keep rewriting it. This is the regression that proves a
 * user who upgrades does not silently lose credentials, settings or accounts.
 */
const dirs: string[] = [];
function oldBinaryAgentDir(): string {
	const agent = mkdtempSync(join(tmpdir(), "coexist-omo-"));
	dirs.push(agent);
	// auth.json exactly as the OLD binary wrote it
	writeFileSync(
		join(agent, "auth.json"),
		JSON.stringify(
			{
				"claude-sdk-oauth": { type: "oauth", access: "a-tok", refresh: "r-tok", expires: 0 },
				"openai-codex": { type: "oauth", access: "c-tok", refresh: "cr-tok", expires: 0 },
				anthropic: { type: "api_key", key: "sk-untouched" },
			},
			null,
			2,
		),
	);
	// settings.json exactly as the OLD binary wrote it
	writeFileSync(
		join(agent, "settings.json"),
		JSON.stringify(
			{
				defaultProvider: "claude-sdk-oauth",
				defaultModel: "openai-codex/gpt-5.6-sol",
				favoriteModels: ["anthropic-subscription/opus"],
				modelThinkingLevels: { "anthropic-subscription/opus": "high" },
				providers: { "claude-sdk-oauth": { maxConcurrency: 3 } },
				claudeSdkOauthProvider: { tokenInjection: "config-dir" },
			},
			null,
			2,
		),
	);
	// the per-account directory the OLD binary created
	mkdirSync(join(agent, "claude-sdk-oauth-accounts", "work"), { recursive: true });
	writeFileSync(join(agent, "claude-sdk-oauth-accounts", "work", ".credentials.json"), '{"seed":true}');
	return agent;
}
function backups(agent: string): string[] {
	return readdirSync(agent).filter((e) => e.startsWith("auth.json.backup-"));
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("multi-binary coexistence after the subscription rename (senpi#1989)", () => {
	it("reads every credential an OLD binary stored, under the canonical ids", () => {
		const agent = oldBinaryAgentDir();
		const authPath = join(agent, "auth.json");
		expect(readStoredCredential("anthropic-subscription", authPath)).toMatchObject({ access: "a-tok" });
		expect(readStoredCredential("chatgpt-subscription", authPath)).toMatchObject({ access: "c-tok" });
		// the untouched API-key lane is still its own credential
		expect(readStoredCredential("anthropic", authPath)).toMatchObject({ type: "api_key" });
	});

	it("resolves every provider-keyed setting an OLD binary wrote", () => {
		const agent = oldBinaryAgentDir();
		const m = SettingsManager.create(agent, agent);
		const s = m.getGlobalSettings() as Record<string, unknown>;
		expect(s.defaultProvider).toBe("anthropic-subscription");
		expect(s.defaultModel).toBe("chatgpt-subscription/gpt-5.6-sol");
		expect(s.favoriteModels).toEqual(["anthropic-subscription/opus"]);
		expect(s.modelThinkingLevels).toEqual({ "anthropic-subscription/opus": "high" });
		expect(m.getProviderConcurrencyLimit("anthropic-subscription")).toBe(3);
		expect(s.anthropicSubscriptionProvider).toEqual({ tokenInjection: "config-dir" });
	});

	it("moves the OLD account directory once, preserving its slots", () => {
		const agent = oldBinaryAgentDir();
		expect(resolveAccountsDirectory(agent)).toBe(join(agent, "anthropic-subscription-accounts"));
		expect(existsSync(join(agent, "claude-sdk-oauth-accounts"))).toBe(false);
		expect(readFileSync(join(agent, "anthropic-subscription-accounts", "work", ".credentials.json"), "utf8")).toBe(
			'{"seed":true}',
		);
	});

	it("keeps a models.json written by the OLD binary attached to the same provider", () => {
		const agent = oldBinaryAgentDir();
		const p = join(agent, "models.json");
		writeFileSync(p, JSON.stringify({ providers: { "claude-sdk-oauth": { baseUrl: "https://old", models: [] } } }));
		const cfg = ModelConfig.loadSync(p);
		expect(cfg.getProvider("anthropic-subscription")).toMatchObject({ baseUrl: "https://old" });
		expect(cfg.getError()).toBeUndefined();
	});

	it("is idempotent: a second run changes neither settings resolution nor auth.json, and adds no second backup", () => {
		const agent = oldBinaryAgentDir();
		const authPath = join(agent, "auth.json");

		// first run: the migration fires and takes exactly one backup
		AuthStorage.create(authPath);
		const afterFirstAuth = readFileSync(authPath, "utf8");
		const firstBackups = backups(agent);
		expect(firstBackups).toHaveLength(1);
		const backupBody = readFileSync(join(agent, firstBackups[0]!), "utf8");
		const firstSettings = JSON.stringify(SettingsManager.create(agent, agent).getGlobalSettings());
		resolveAccountsDirectory(agent);

		// second run: nothing left to migrate
		AuthStorage.create(authPath);
		expect(readFileSync(authPath, "utf8")).toBe(afterFirstAuth);
		expect(backups(agent)).toEqual(firstBackups);
		expect(readFileSync(join(agent, firstBackups[0]!), "utf8")).toBe(backupBody);
		expect(JSON.stringify(SettingsManager.create(agent, agent).getGlobalSettings())).toBe(firstSettings);
		expect(resolveAccountsDirectory(agent)).toBe(join(agent, "anthropic-subscription-accounts"));
		expect(readdirSync(join(agent, "anthropic-subscription-accounts"))).toEqual(["work"]);
	});

	it("preserves the legacy credential body verbatim in the backup", () => {
		const agent = oldBinaryAgentDir();
		const authPath = join(agent, "auth.json");
		AuthStorage.create(authPath);
		const backup = JSON.parse(readFileSync(join(agent, backups(agent)[0]!), "utf8")) as Record<string, unknown>;
		// the backup is the pre-migration document, so it still carries the legacy keys
		expect(backup["claude-sdk-oauth"]).toMatchObject({ access: "a-tok" });
	});
});
