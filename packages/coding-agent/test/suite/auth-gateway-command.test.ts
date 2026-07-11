import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthBrokerServer } from "../../src/cli/auth-broker-server.ts";
import { executeAuthGatewayCommand } from "../../src/cli/auth-gateway-cli.ts";
import { AuthBrokerService, SqliteCredentialVault } from "../../src/core/auth-broker.ts";
import { AUTH_BROKER_CAPABILITIES } from "../../src/core/auth-broker-wire-contract.ts";

const brokerToken = "broker-command-auth-token";
const gatewayToken = "gateway-command-auth-token";
const directories: string[] = [];

async function createDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "senpi-auth-gateway-command-"));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { force: true, recursive: true })));
});

describe("auth gateway command", () => {
	it("starts from redacted snapshot and lists only authorized models", async () => {
		// Given: a broker credential and an explicit allowlist containing one of several OpenAI catalog models.
		const agentDir = await createDirectory();
		const openaiCatalog = getModels("openai");
		expect(openaiCatalog.length).toBeGreaterThan(1);
		const allowedModel = openaiCatalog[0];
		const disallowedModel = openaiCatalog[1];
		if (allowedModel === undefined || disallowedModel === undefined)
			throw new Error("OpenAI catalog fixture is incomplete");
		const vault = SqliteCredentialVault.open(join(agentDir, "broker.sqlite"));
		vault.upsertCredential({
			createdAt: "2026-07-11T00:00:00.000Z",
			credentialId: "openai-account",
			identityKey: "operator:openai",
			material: { apiKey: gatewayToken, type: "api_key" },
			pool: { provider: "openai", type: "api_key" },
			updatedAt: "2026-07-11T00:00:00.000Z",
		});
		vault.upsertCredential({
			createdAt: "2026-07-11T00:00:00.000Z",
			credentialId: "unknown-account",
			identityKey: "operator:unknown",
			material: { apiKey: "unknown-provider-key", type: "api_key" },
			pool: { provider: "unknown-provider", type: "api_key" },
			updatedAt: "2026-07-11T00:00:00.000Z",
		});
		const broker = new AuthBrokerService(vault, [
			{ authentication: brokerToken, capabilities: Object.values(AUTH_BROKER_CAPABILITIES), trustedGateway: true },
		]);
		const server = await startAuthBrokerServer({ bind: { host: "127.0.0.1", port: 0 }, broker, version: "test" });
		try {
			let models: unknown;

			// When: the command starts from the broker metadata snapshot with a configured model allowlist.
			const result = await executeAuthGatewayCommand(
				["auth-gateway", "serve", "--bind", "127.0.0.1:0", `--model=openai/${allowedModel.id}`],
				{
					agentDir,
					brokerToken,
					brokerUrl: server.url,
					onGatewayStarted: async (handle) => {
						const response = await fetch(`${handle.url}/v1/models`, {
							headers: { authorization: `Bearer ${await gatewayBearer(agentDir)}` },
						});
						expect(response.status).toBe(200);
						models = await response.json();
					},
				},
			);

			// Then: only the explicitly authorized model is exposed, never the provider-wide catalog, and no secret leaks.
			expect(result?.exitCode).toBe(0);
			expect(models).toEqual({
				data: [{ id: allowedModel.id, object: "model", owned_by: "openai" }],
				object: "list",
			});
			expect(JSON.stringify(models)).not.toContain(disallowedModel.id);
			expect(JSON.stringify(models)).not.toContain("unknown-provider");
			expect(`${result?.stdout}${result?.stderr}${JSON.stringify(models)}`).not.toContain(brokerToken);
			expect(`${result?.stdout}${result?.stderr}${JSON.stringify(models)}`).not.toContain(gatewayToken);
		} finally {
			await server.close();
			vault.close();
		}
	});

	it("fails startup without broker auth and omits tokens from status and check diagnostics", async () => {
		// Given: a configured broker endpoint and local values that must never be printed by diagnostics.
		const agentDir = await createDirectory();
		const vault = SqliteCredentialVault.open(join(agentDir, "broker.sqlite"));
		vault.upsertCredential({
			createdAt: "2026-07-11T00:00:00.000Z",
			credentialId: "disabled-openai-account",
			identityKey: "operator:disabled",
			material: { apiKey: gatewayToken, type: "api_key" },
			pool: { provider: "openai", type: "api_key" },
			updatedAt: "2026-07-11T00:00:00.000Z",
		});
		vault.disableCredential("disabled-openai-account", "test failure");
		const broker = new AuthBrokerService(vault, [
			{ authentication: brokerToken, capabilities: Object.values(AUTH_BROKER_CAPABILITIES), trustedGateway: true },
		]);
		const server = await startAuthBrokerServer({ bind: { host: "127.0.0.1", port: 0 }, broker, version: "test" });
		try {
			// When: startup has no broker bearer, while status and check use a valid broker bearer.
			const [missingAuth, status, check] = await Promise.all([
				executeAuthGatewayCommand(["auth-gateway", "serve"], { agentDir, brokerUrl: server.url }),
				executeAuthGatewayCommand(["auth-gateway", "status", "--json"], {
					agentDir,
					brokerToken,
					brokerUrl: server.url,
				}),
				executeAuthGatewayCommand(["auth-gateway", "check", "--json"], {
					agentDir,
					brokerToken,
					brokerUrl: server.url,
				}),
			]);

			// Then: no listener starts without broker auth, disabled account is reported, and diagnostics stay redacted.
			expect(missingAuth?.exitCode).toBe(2);
			expect(missingAuth?.stderr).toContain("requires broker authentication");
			expect(check?.exitCode).toBe(1);
			expect(check?.stdout).toContain("disabled-openai-account");
			for (const output of [missingAuth, status, check].map((result) => `${result?.stdout}${result?.stderr}`)) {
				expect(output).not.toContain(brokerToken);
				expect(output).not.toContain(gatewayToken);
			}
		} finally {
			await server.close();
			vault.close();
		}
	});
});

async function gatewayBearer(agentDir: string): Promise<string> {
	return (await readFile(join(agentDir, "auth-gateway.token"), "utf8")).trim();
}
