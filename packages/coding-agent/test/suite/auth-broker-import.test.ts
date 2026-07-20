import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeAuthBrokerCommand } from "../../src/cli/auth-broker-cli.ts";
import { SqliteCredentialVault } from "../../src/core/auth-broker.ts";

const secret = "todo11-import-secret";
const temporaryDirectories: string[] = [];

function createDirectory(name: string): string {
	const directory = join(tmpdir(), `senpi-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(directory, { mode: 0o700, recursive: true });
	temporaryDirectories.push(directory);
	return directory;
}

function sha256(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("auth broker import", () => {
	it("imports each declared version and validates locked backup manifest before transaction", async () => {
		const agentDir = createDirectory("auth-broker-import");
		const backupCredentials = [
			{
				createdAt: "2026-07-11T00:00:00.000Z",
				credentialId: "backup-credential",
				identityKey: "backup:operator",
				material: { apiKey: `${secret}-backup`, type: "api_key" },
				pool: { provider: "openai", type: "api_key" },
				updatedAt: "2026-07-11T00:00:00.000Z",
			},
		];
		const backupPath = join(agentDir, "senpi-backup.json");
		writeJson(backupPath, {
			credentials: backupCredentials,
			format: "senpi-auth-broker-backup",
			manifest: { algorithm: "sha256", credentialsSha256: sha256(backupCredentials) },
			version: 1,
		});
		const gajaePath = join(agentDir, "gajae.json");
		writeJson(gajaePath, {
			credentials: [
				{
					credential: {
						access: `${secret}-gajae`,
						expires: 4_102_444_800_000,
						refresh: `${secret}-refresh`,
						type: "oauth",
					},
					id: 1,
					identityKey: "gajae:account",
					provider: "openai-codex",
				},
			],
			generatedAt: 1_783_792_000_000,
			generation: 1,
		});
		const cliProxyPath = join(agentDir, "cliproxy-v6.json");
		writeJson(cliProxyPath, {
			credentials: [
				{
					access_token: `${secret}-cli`,
					created_at: "2026-07-11T00:00:00.000Z",
					disabled: { cause: "quota" },
					email: "cli@example.test",
					expired: "2099-12-31T23:59:59.000Z",
					project_id: "import-project-id",
					provider: "claude",
					refresh_token: `${secret}-cli-refresh`,
					type: "claude",
					updated_at: "2026-07-12T00:00:00.000Z",
				},
			],
			version: 6,
		});

		const results = await Promise.all([
			executeAuthBrokerCommand(["auth-broker", "import", backupPath], { agentDir }),
			executeAuthBrokerCommand(["auth-broker", "import", gajaePath, "--format=gajae-snapshot-legacy"], { agentDir }),
			executeAuthBrokerCommand(["auth-broker", "import", cliProxyPath], { agentDir }),
		]);
		for (const result of results) expect(result?.exitCode).toBe(0);

		const exportedPath = join(agentDir, "exported.json");
		const backup = await executeAuthBrokerCommand(["auth-broker", "backup", exportedPath], { agentDir });
		expect(backup?.exitCode).toBe(0);
		const vault = SqliteCredentialVault.open(join(agentDir, "auth-broker.sqlite"));
		try {
			expect(vault.metadataSnapshot().credentials).toHaveLength(3);
			expect(vault.credential("backup-credential").pool).toEqual({ provider: "openai", type: "api_key" });
			expect(
				vault.metadataSnapshot().credentials.find(({ identityKey }) => identityKey === "gajae:account")?.pool,
			).toEqual({
				provider: "openai-codex",
				type: "oauth",
			});
			const cliCredential = vault.load().find((credential) => credential.identityKey === "cli@example.test");
			expect(cliCredential?.disabled).toEqual({
				at: "2026-07-12T00:00:00.000Z",
				cause: "quota",
			});
			expect(cliCredential?.material.type).toBe("oauth");
			if (cliCredential?.material.type === "oauth") {
				expect(cliCredential.material.extras).toEqual({ projectId: "import-project-id" });
			}
		} finally {
			vault.close();
		}
		const restored = await executeAuthBrokerCommand(["auth-broker", "restore", exportedPath], { agentDir });
		expect(restored?.exitCode).toBe(0);
		const restoredVault = SqliteCredentialVault.open(join(agentDir, "auth-broker.sqlite"));
		try {
			expect(restoredVault.metadataSnapshot().credentials).toHaveLength(3);
		} finally {
			restoredVault.close();
		}
	});

	it("rejects unknown version/field, duplicate identity, malformed secret reference, and dry-run mutation", async () => {
		const agentDir = createDirectory("auth-broker-import-invalid");
		const invalidPath = join(agentDir, "invalid.json");
		const duplicatePath = join(agentDir, "duplicate.json");
		const secretReferencePath = join(agentDir, "secret-reference.json");
		const staleBackupPath = join(agentDir, "stale-backup.json");
		const dryRunPath = join(agentDir, "dry-run.json");
		const unknownKindPath = join(agentDir, "unknown-kind.json");
		writeJson(invalidPath, { credentials: [], unexpected: true, version: 6 });
		writeJson(duplicatePath, {
			credentials: [
				{
					access_token: "a",
					email: "same@example.test",
					expired: "2099-12-31T23:59:59.000Z",
					provider: "claude",
					refresh_token: "r",
					type: "claude",
				},
				{
					access_token: "b",
					email: "same@example.test",
					expired: "2099-12-31T23:59:59.000Z",
					provider: "claude",
					refresh_token: "s",
					type: "claude",
				},
			],
			version: 6,
		});
		writeJson(secretReferencePath, {
			credentials: [
				{
					createdAt: "2026-07-11T00:00:00.000Z",
					credentialId: "secret-reference",
					identityKey: "reference:operator",
					material: { secretRef: "env:SECRET", type: "oauth" },
					pool: { provider: "openai", type: "oauth" },
					updatedAt: "2026-07-11T00:00:00.000Z",
				},
			],
			format: "senpi-auth-broker-backup",
			manifest: {
				algorithm: "sha256",
				credentialsSha256: sha256([
					{
						createdAt: "2026-07-11T00:00:00.000Z",
						credentialId: "secret-reference",
						identityKey: "reference:operator",
						material: { secretRef: "env:SECRET", type: "oauth" },
						pool: { provider: "openai", type: "oauth" },
						updatedAt: "2026-07-11T00:00:00.000Z",
					},
				]),
			},
			version: 1,
		});
		writeJson(staleBackupPath, {
			credentials: [],
			format: "senpi-auth-broker-backup",
			manifest: { algorithm: "sha256", credentialsSha256: "0".repeat(64) },
			version: 1,
		});
		writeJson(dryRunPath, {
			credentials: [
				{
					access_token: secret,
					email: "dry-run@example.test",
					expired: "2099-12-31T23:59:59.000Z",
					provider: "claude",
					refresh_token: `${secret}-refresh`,
					type: "claude",
				},
			],
			version: 6,
		});
		writeJson(unknownKindPath, {
			credentials: [
				{
					access_token: "proxy-v6-unknown-kind-sentinel",
					email: "unknown-kind@example.test",
					expired: "2099-12-31T23:59:59.000Z",
					provider: "surprise",
					refresh_token: "proxy-v6-unknown-kind-sentinel",
					type: "surprise-kind",
				},
			],
			version: 6,
		});
		const initialVault = SqliteCredentialVault.open(join(agentDir, "auth-broker.sqlite"));
		initialVault.close();
		const before = sha256(readFileSync(join(agentDir, "auth-broker.sqlite")));
		const results = await Promise.all([
			executeAuthBrokerCommand(["auth-broker", "import", invalidPath], { agentDir }),
			executeAuthBrokerCommand(["auth-broker", "import", duplicatePath], { agentDir }),
			executeAuthBrokerCommand(["auth-broker", "import", secretReferencePath], { agentDir }),
			executeAuthBrokerCommand(["auth-broker", "restore", staleBackupPath], { agentDir }),
			executeAuthBrokerCommand(["auth-broker", "import", unknownKindPath], { agentDir }),
			executeAuthBrokerCommand(["auth-broker", "import", dryRunPath, "--dry-run"], { agentDir }),
		]);
		for (const result of results.slice(0, 5)) {
			expect(result?.exitCode).toBe(2);
			expect(result?.stderr).not.toContain(secret);
			expect(result?.stderr).not.toContain("proxy-v6-unknown-kind-sentinel");
		}
		expect(results[5]?.exitCode).toBe(0);
		expect(sha256(readFileSync(join(agentDir, "auth-broker.sqlite")))).toBe(before);
	});
});
