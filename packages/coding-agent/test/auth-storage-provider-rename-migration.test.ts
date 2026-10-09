import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, test } from "vitest";
import { AuthStorage, ReadOnlyAuthStorage } from "../src/core/auth-storage.ts";

const SENTINEL = "claude-sdk-oauth-managed";

/**
 * A pre-rename auth.json: a pooled `claude-sdk-oauth` credential (carrying a
 * poisoned managed-sentinel slot), a flat `openai-codex` OAuth credential, and
 * an unrelated `anthropic` API key that must not move.
 */
function legacyFixture(): Record<string, unknown> {
	return {
		"claude-sdk-oauth": {
			type: "oauth",
			access: SENTINEL,
			refresh: SENTINEL,
			expires: 4_102_444_800_000,
			pinned: "login-2",
			slotState: { work: { blockedUntil: 123, blockReason: "rate_limited" } },
			accounts: [
				{ name: "default", access: "acc-default", refresh: "ref-default", expires: 1, source: "login" },
				{
					name: "work",
					access: "acc-work",
					refresh: "ref-work",
					expires: 2,
					source: "login",
					displayName: "Work",
				},
				{ name: "login-2", access: "acc-pinned", refresh: "ref-pinned", expires: 3, source: "login" },
				{
					name: "login-3",
					access: SENTINEL,
					refresh: SENTINEL,
					expires: 4_102_444_800_000,
					source: "login",
				},
			],
		},
		"openai-codex": {
			type: "oauth",
			access: "codex-access",
			refresh: "codex-refresh",
			expires: 1_700_000_000_000,
		},
		anthropic: { type: "api_key", key: "sk-ant-untouched" },
	};
}

/** The fixture's claude pool after its poisoned `login-3` slot was repaired. */
function healedClaudePool(): Record<string, unknown> {
	const entry = legacyFixture()["claude-sdk-oauth"] as Record<string, unknown> & {
		accounts: Array<{ name: string }>;
	};
	return { ...entry, accounts: entry.accounts.filter((slot) => slot.name !== "login-3") };
}

describe("auth.json provider-key migration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function isolatedAuthPath(): { dir: string; authPath: string } {
		const dir = mkdtempSync(join(tmpdir(), "pi-test-auth-migration-"));
		tempDirs.push(dir);
		return { dir, authPath: join(dir, "auth.json") };
	}

	function backupNames(dir: string): string[] {
		return readdirSync(dir).filter((name) => name.startsWith("auth.json.backup-"));
	}

	test("moves legacy provider keys to canonical keys once, with a timestamped 0o600 backup", () => {
		const { dir, authPath } = isolatedAuthPath();
		const original = JSON.stringify(legacyFixture(), null, 2);
		// senpi itself creates auth.json 0o600; the migration must keep it that way.
		writeFileSync(authPath, original, { encoding: "utf8", mode: 0o600 });

		AuthStorage.create(authPath);

		const disk = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		expect("claude-sdk-oauth" in disk).toBe(false);
		expect("openai-codex" in disk).toBe(false);
		expect(disk["anthropic-subscription"]).toEqual(healedClaudePool());
		expect(disk["chatgpt-subscription"]).toEqual(legacyFixture()["openai-codex"]);
		expect(disk.anthropic).toEqual(legacyFixture().anthropic);

		const backups = backupNames(dir);
		expect(backups).toHaveLength(1);
		const backupPath = join(dir, backups[0]);
		expect(readFileSync(backupPath, "utf8")).toBe(original);
		expect(statSync(backupPath).mode & 0o777).toBe(0o600);
		expect(statSync(authPath).mode & 0o777).toBe(0o600);
	});

	test("a migrated file is not rewritten by a later load", () => {
		const { dir, authPath } = isolatedAuthPath();
		writeFileSync(authPath, JSON.stringify(legacyFixture(), null, 2), "utf8");
		AuthStorage.create(authPath);

		// Deliberately odd formatting: a rewrite by the next load would
		// normalize these bytes, so byte preservation proves no rewrite.
		const oddFormatting = `${JSON.stringify(JSON.parse(readFileSync(authPath, "utf8")), null, 4)}\n`;
		writeFileSync(authPath, oddFormatting, "utf8");

		AuthStorage.create(authPath);

		expect(readFileSync(authPath, "utf8")).toBe(oddFormatting);
		expect(backupNames(dir)).toHaveLength(1);
	});

	test("a legacy entry colliding with a canonical entry never merges", () => {
		const { dir, authPath } = isolatedAuthPath();
		const canonical = {
			type: "oauth",
			access: "canonical-access",
			refresh: "canonical-refresh",
			expires: 4_102_444_800_000,
			accounts: [
				{
					name: "default",
					access: "canonical-access",
					refresh: "canonical-refresh",
					expires: 1,
					source: "login",
				},
			],
		};
		const original = JSON.stringify(
			{
				"claude-sdk-oauth": legacyFixture()["claude-sdk-oauth"],
				"anthropic-subscription": canonical,
				anthropic: legacyFixture().anthropic,
			},
			null,
			2,
		);
		writeFileSync(authPath, original, "utf8");

		AuthStorage.create(authPath);

		const disk = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		expect("claude-sdk-oauth" in disk).toBe(false);
		expect(disk["anthropic-subscription"]).toEqual(canonical);

		const backups = backupNames(dir);
		expect(backups).toHaveLength(1);
		const backup = JSON.parse(readFileSync(join(dir, backups[0]), "utf8")) as Record<string, unknown>;
		expect(backup["claude-sdk-oauth"]).toEqual(legacyFixture()["claude-sdk-oauth"]);
		expect(backup["anthropic-subscription"]).toEqual(canonical);
	});

	test("a busy credential store skips the migration and retries on a later load", () => {
		const { authPath } = isolatedAuthPath();
		const original = JSON.stringify(legacyFixture(), null, 2);
		writeFileSync(authPath, original, "utf8");

		const release = lockfile.lockSync(authPath, { realpath: false, retries: 0 });
		try {
			const storage = AuthStorage.create(authPath);
			expect(storage.drainErrors().length).toBeGreaterThan(0);
			expect(readFileSync(authPath, "utf8")).toBe(original);
		} finally {
			release();
		}

		AuthStorage.create(authPath);
		const disk = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		expect("claude-sdk-oauth" in disk).toBe(false);
		expect("anthropic-subscription" in disk).toBe(true);
	});

	test("a poisoned slot carrying legacy sentinel material is repaired under the canonical key", () => {
		const { authPath } = isolatedAuthPath();
		const pool = {
			type: "oauth",
			access: SENTINEL,
			refresh: SENTINEL,
			expires: 4_102_444_800_000,
			pinned: "default",
			accounts: [
				{ name: "default", access: "acc-default", refresh: "ref-default", expires: 1, source: "login" },
				{ name: "login-2", access: SENTINEL, refresh: SENTINEL, expires: 4_102_444_800_000, source: "login" },
			],
		};
		writeFileSync(authPath, JSON.stringify({ "anthropic-subscription": pool }, null, 2), "utf8");

		AuthStorage.create(authPath);

		const disk = JSON.parse(readFileSync(authPath, "utf8")) as {
			"anthropic-subscription": { accounts: Array<{ name: string }>; pinned?: string };
		};
		expect(disk["anthropic-subscription"].accounts.map((slot) => slot.name)).toEqual(["default"]);
		expect(disk["anthropic-subscription"].pinned).toBe("default");
	});

	test("read-only storage leaves the bytes untouched", async () => {
		const { dir, authPath } = isolatedAuthPath();
		const original = JSON.stringify(legacyFixture(), null, 2);
		writeFileSync(authPath, original, "utf8");

		const storage = new ReadOnlyAuthStorage(authPath);
		const credential = await storage.read("claude-sdk-oauth");
		expect(credential).toEqual(healedClaudePool());

		expect(readFileSync(authPath, "utf8")).toBe(original);
		expect(backupNames(dir)).toHaveLength(0);
	});
});
