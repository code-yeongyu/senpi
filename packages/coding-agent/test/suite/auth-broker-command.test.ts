import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeAuthBrokerCommand } from "../../src/cli/auth-broker-cli.ts";
import { startAuthBrokerServer } from "../../src/cli/auth-broker-server.ts";
import { AuthBrokerService, SqliteCredentialVault } from "../../src/core/auth-broker.ts";
import { AUTH_BROKER_CAPABILITIES, AUTH_BROKER_PROTOCOL_VERSION } from "../../src/core/auth-broker-wire-contract.ts";

const secret = "auth-broker-command-test-secret";
const temporaryDirectories: string[] = [];

function createDirectory(name: string): string {
	const directory = join(tmpdir(), `senpi-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe("auth broker command", () => {
	it("creates race-safe 0600 token and performs dry-run import without mutation", async () => {
		// Given: an isolated broker directory and a CLIProxy-style OAuth record.
		const agentDir = createDirectory("broker-command");
		const source = join(agentDir, "credential.json");
		writeFileSync(
			source,
			JSON.stringify({
				access_token: secret,
				email: "operator@example.test",
				expired: "2099-12-31T23:59:59.000Z",
				refresh_token: `${secret}-refresh`,
				type: "claude",
			}),
		);

		// When: concurrent token commands race and an import is previewed.
		const [first, second, imported] = await Promise.all([
			executeAuthBrokerCommand(["auth-broker", "token"], { agentDir }),
			executeAuthBrokerCommand(["auth-broker", "token"], { agentDir }),
			executeAuthBrokerCommand(["auth-broker", "import", source, "--dry-run", "--json"], { agentDir }),
		]);

		// Then: both callers observe the same protected token and no credential was written.
		expect(first?.exitCode).toBe(0);
		expect(second?.exitCode).toBe(0);
		expect(first?.stdout).toBe(second?.stdout);
		const tokenPath = join(agentDir, "auth-broker.token");
		expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
		expect(statSync(agentDir).mode & 0o777).toBe(0o700);
		expect(readFileSync(tokenPath, "utf8").trim()).toBe(first?.stdout.trim());
		expect(imported?.exitCode).toBe(0);
		expect(imported?.stdout).not.toContain(secret);
		const vault = SqliteCredentialVault.open(join(agentDir, "auth-broker.sqlite"));
		try {
			expect(vault.load()).toEqual([]);
			vault.upsertCredential({
				createdAt: "2026-07-11T00:00:00.000Z",
				credentialId: "credential-a",
				identityKey: "operator:a",
				material: { apiKey: secret, type: "api_key" },
				pool: { provider: "openai", type: "api_key" },
				updatedAt: "2026-07-11T00:00:00.000Z",
			});
			const token = readFileSync(tokenPath, "utf8").trim();
			const broker = new AuthBrokerService(vault, [
				{ authentication: token, capabilities: Object.values(AUTH_BROKER_CAPABILITIES), trustedGateway: true },
			]);
			const server = await startAuthBrokerServer({ bind: { host: "127.0.0.1", port: 0 }, broker, version: "test" });
			try {
				const health = await fetch(`${server.url}/healthz`);
				expect(await health.json()).toEqual({ ok: true, version: "test" });
				const denied = await fetch(`${server.url}/v1/broker`, { method: "POST" });
				expect(denied.status).toBe(401);
				const wrongBearer = await fetch(`${server.url}/v1/broker`, {
					body: JSON.stringify({
						capability: AUTH_BROKER_CAPABILITIES.metadataRead,
						operation: "metadata_snapshot",
						protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
						requestId: "wrong-bearer",
					}),
					headers: { authorization: "Bearer wrong-broker-token-value", "content-type": "application/json" },
					method: "POST",
				});
				expect(wrongBearer.status).toBe(401);
				const snapshot = await fetch(`${server.url}/v1/broker`, {
					body: JSON.stringify({
						capability: AUTH_BROKER_CAPABILITIES.metadataRead,
						operation: "metadata_snapshot",
						protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
						requestId: "snapshot",
					}),
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					method: "POST",
				});
				expect(snapshot.status).toBe(200);
				expect(JSON.stringify(await snapshot.json())).not.toContain(secret);
			} finally {
				await server.close();
			}
		} finally {
			vault.close();
		}
	});

	it("exits 2 for invalid bind or verb and rejects migration without backup receipt", async () => {
		// Given: a local auth file whose values must never appear in error output.
		const agentDir = createDirectory("broker-command-invalid");
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { key: secret, type: "api_key" } }), {
			mode: 0o600,
		});
		const malformedImport = join(agentDir, "malformed.json");
		writeFileSync(malformedImport, "{not-json");

		// When: invalid command forms and a destructive migration are requested.
		const results = await Promise.all([
			executeAuthBrokerCommand(["auth-broker", "serve", "--bind=0.0.0.0:8765"], { agentDir }),
			executeAuthBrokerCommand(["auth-broker", "unknown-verb"], { agentDir }),
			executeAuthBrokerCommand(["auth-broker", "migrate", "--from-local"], { agentDir }),
			executeAuthBrokerCommand(["auth-broker", "import", malformedImport], { agentDir }),
		]);

		// Then: every request is rejected as usage/safety failure and no secret is echoed.
		for (const result of results) {
			expect(result?.exitCode).toBe(2);
			expect(result?.stderr).not.toContain(secret);
		}
	});

	it("migrates local credentials only after a matching dry-run receipt", async () => {
		// Given: a local auth file and a receipt path in the protected agent directory.
		const agentDir = createDirectory("broker-command-migrate");
		const authPath = join(agentDir, "auth.json");
		const receiptPath = join(agentDir, "migration-receipt.json");
		writeFileSync(authPath, JSON.stringify({ openai: { key: secret, type: "api_key" } }), { mode: 0o600 });

		// When: a dry-run writes the receipt before the matching migration applies.
		const preview = await executeAuthBrokerCommand(
			["auth-broker", "migrate", "--from-local", "--dry-run", "--backup-receipt", receiptPath],
			{ agentDir },
		);
		const migrated = await executeAuthBrokerCommand(
			["auth-broker", "migrate", "--from-local", "--backup-receipt", receiptPath],
			{ agentDir },
		);

		// Then: the receipt is protected and exactly one local credential reaches the vault.
		expect(preview?.exitCode).toBe(0);
		expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
		expect(migrated?.exitCode).toBe(0);
		const vault = SqliteCredentialVault.open(join(agentDir, "auth-broker.sqlite"));
		try {
			expect(vault.metadataSnapshot().credentials).toHaveLength(1);
			expect(JSON.stringify(vault.metadataSnapshot())).not.toContain(secret);
		} finally {
			vault.close();
		}
	});

	it("rejects a manually forged migration receipt without a dry-run backup manifest", async () => {
		const agentDir = createDirectory("broker-command-forged-receipt");
		const authPath = join(agentDir, "auth.json");
		const receiptPath = join(agentDir, "forged-receipt.json");
		const auth = JSON.stringify({ openai: { key: secret, type: "api_key" } });
		writeFileSync(authPath, auth, { mode: 0o600 });
		writeFileSync(
			receiptPath,
			JSON.stringify({
				sourcePath: authPath,
				sourceSha256: createHash("sha256").update(auth).digest("hex"),
				version: 1,
			}),
			{ mode: 0o600 },
		);

		const result = await executeAuthBrokerCommand(
			["auth-broker", "migrate", "--from-local", "--backup-receipt", receiptPath],
			{ agentDir },
		);

		expect(result?.exitCode).toBe(2);
		expect(result?.stderr).not.toContain(secret);
	});
});
