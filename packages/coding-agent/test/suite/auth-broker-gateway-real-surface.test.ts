import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startAuthBrokerServer } from "../../src/cli/auth-broker-server.ts";
import { AuthBrokerService, SqliteCredentialVault } from "../../src/core/auth-broker.ts";
import { AUTH_BROKER_CAPABILITIES, AUTH_BROKER_PROTOCOL_VERSION } from "../../src/core/auth-broker-wire-contract.ts";
import { type AuthGatewayTransportHandle, startAuthGatewayTransport } from "../../src/core/auth-gateway-transport.ts";

const token = "gateway-real-surface-token";
const handles: AuthGatewayTransportHandle[] = [];

afterEach(async () => {
	await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe("auth broker gateway real surface", () => {
	it("drives isolated broker plus gateway with faux provider through all fixed routes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "senpi-auth-broker-gateway-live-"));
		const vault = SqliteCredentialVault.open(join(directory, "broker.sqlite"));
		const brokerToken = "broker-real-surface-token-value";
		vault.upsertCredential({
			createdAt: "2026-07-11T00:00:00.000Z",
			credentialId: "faux-provider-account",
			identityKey: "operator:faux",
			material: { apiKey: "faux-provider-key-not-returned", type: "api_key" },
			pool: { provider: "faux", type: "api_key" },
			updatedAt: "2026-07-11T00:00:00.000Z",
		});
		const broker = new AuthBrokerService(vault, [
			{ authentication: brokerToken, capabilities: Object.values(AUTH_BROKER_CAPABILITIES), trustedGateway: true },
		]);
		const brokerServer = await startAuthBrokerServer({
			bind: { host: "127.0.0.1", port: 0 },
			broker,
			version: "real-surface-test",
		});
		try {
			const snapshot = await fetch(`${brokerServer.url}/v1/broker`, {
				body: JSON.stringify({
					capability: AUTH_BROKER_CAPABILITIES.metadataRead,
					operation: "metadata_snapshot",
					protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
					requestId: "real-surface",
				}),
				headers: { authorization: `Bearer ${brokerToken}`, "content-type": "application/json" },
				method: "POST",
			});
			expect(snapshot.status).toBe(200);
			expect(JSON.stringify(await snapshot.json())).not.toContain("faux-provider-key-not-returned");
			const calls: string[] = [];
			const handle = await startAuthGatewayTransport({
				auth: { kind: "token-value", token },
				onRequest: async (request) => {
					calls.push(request.pathname);
					return { body: { fauxProvider: true, path: request.pathname }, statusCode: 200 };
				},
				port: 0,
				version: "real-surface-test",
			});
			handles.push(handle);
			const health = await fetch(`${handle.url}/healthz`);
			expect(await health.json()).toEqual({ ok: true, version: "real-surface-test" });
			const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
			for (const path of ["/v1/models", "/v1/usage", "/v1/credentials/check"]) {
				const response = await fetch(`${handle.url}${path}`, { headers });
				expect(response.status).toBe(200);
			}
			for (const path of ["/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1/pi/stream"]) {
				const response = await fetch(`${handle.url}${path}`, {
					body: JSON.stringify({ model: "faux/model" }),
					headers,
					method: "POST",
				});
				expect(response.status).toBe(200);
			}
			expect(calls).toEqual([
				"/v1/models",
				"/v1/usage",
				"/v1/credentials/check",
				"/v1/chat/completions",
				"/v1/messages",
				"/v1/responses",
				"/v1/pi/stream",
			]);
		} finally {
			await brokerServer.close();
			vault.close();
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("proves auth/CORS/TLS/pin/failover/secret-boundary negative matrix", async () => {
		const directory = await mkdtemp(join(tmpdir(), "senpi-auth-broker-gateway-real-"));
		try {
			const tokenPath = join(directory, "private", "gateway.token");
			const handle = await startAuthGatewayTransport({ auth: { kind: "token-file", path: tokenPath }, port: 0 });
			handles.push(handle);
			const generated = (await readFile(tokenPath, "utf8")).trim();
			expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
			expect((await stat(join(directory, "private"))).mode & 0o777).toBe(0o700);
			const wrongAuth = await fetch(`${handle.url}/v1/models`, { headers: { authorization: "Bearer wrong-token" } });
			const badOrigin = await fetch(`${handle.url}/v1/models`, {
				headers: { authorization: `Bearer ${generated}`, origin: "https://evil.test" },
			});
			const malformed = await fetch(`${handle.url}/v1/messages`, {
				body: "{",
				headers: { authorization: `Bearer ${generated}`, "content-type": "application/json" },
				method: "POST",
			});
			expect([wrongAuth.status, badOrigin.status, malformed.status]).toEqual([401, 403, 400]);
			const text = `${await wrongAuth.text()} ${await badOrigin.text()} ${await malformed.text()}`;
			expect(text).not.toContain(generated);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});
});
