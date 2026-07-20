import { afterEach, describe, expect, it } from "vitest";
import { AuthBrokerRemoteStore } from "../../src/core/auth-broker-remote-store.ts";
import {
	AUTH_BROKER_PROTOCOL_VERSION,
	type AuthBrokerCredentialMetadata,
	type AuthBrokerWireRequest,
	parseAuthBrokerWireRequest,
} from "../../src/core/auth-broker-wire-contract.ts";
import { createAuthGatewayObservabilityHandler } from "../../src/core/auth-gateway-observability.ts";
import { type AuthGatewayTransportHandle, startAuthGatewayTransport } from "../../src/core/auth-gateway-transport.ts";

const gatewayToken = "gateway-observability-test-token";
const handles: AuthGatewayTransportHandle[] = [];

afterEach(async () => {
	await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe("auth gateway observability", () => {
	it("returns only authorized models and single-flights usage probe", async () => {
		// Given: a broker snapshot with enabled and disabled accounts, plus a gateway allowlist.
		let snapshotRequests = 0;
		const broker = new AuthBrokerRemoteStore(
			{
				async request(request: unknown) {
					const message = parseAuthBrokerWireRequest(request);
					if (message.operation !== "metadata_snapshot") throw new Error("unexpected broker operation");
					snapshotRequests += 1;
					return metadataResponse(message, [
						credential("openai-ready", "operator:openai", "openai"),
						credential("anthropic-disabled", "operator:anthropic", "anthropic", true),
					]);
				},
			},
			0,
		);
		const handler = createAuthGatewayObservabilityHandler({
			broker,
			models: [
				{ modelId: "gpt-authorized", provider: "openai" },
				{ modelId: "claude-disabled", provider: "anthropic" },
			],
			usageCacheTtlMs: 60_000,
		});
		const gateway = await startGateway(handler);

		// When: model discovery and concurrent usage probes arrive through the live handler.
		const models = await fetchJson(`${gateway.url}/v1/models`);
		const usage = await Promise.all([fetchJson(`${gateway.url}/v1/usage`), fetchJson(`${gateway.url}/v1/usage`)]);

		// Then: only explicit enabled models are visible and concurrent usage shares one broker snapshot.
		expect(models.body).toEqual({
			data: [{ id: "openai/gpt-authorized", object: "model", owned_by: "openai" }],
			object: "list",
		});
		expect(usage[0]?.body).toEqual(usage[1]?.body);
		expect(usage[0]?.body).toEqual({
			data: [
				{ credentialId: "openai-ready", provider: "openai", status: "available", type: "api_key" },
				{ credentialId: "anthropic-disabled", provider: "anthropic", status: "disabled", type: "api_key" },
			],
			object: "list",
		});
		expect(snapshotRequests).toBe(2);
	});

	it("returns sanitized 503 on broker loss and isolates failed credential checks", async () => {
		// Given: a broker that can recover and a checker that fails for only one account.
		let brokerAvailable = false;
		const brokerSecret = "broker-secret-must-not-leak";
		const broker = new AuthBrokerRemoteStore(
			{
				async request(request: unknown) {
					const message = parseAuthBrokerWireRequest(request);
					if (!brokerAvailable) throw new Error(brokerSecret);
					if (message.operation !== "metadata_snapshot") throw new Error("unexpected broker operation");
					return metadataResponse(message, [
						credential("account-a", "operator:a", "openai"),
						credential("account-b", "operator:b", "openai"),
					]);
				},
			},
			0,
		);
		const handler = createAuthGatewayObservabilityHandler({
			broker,
			checkCredential: async (account) => {
				if (account.credentialId === "account-b") throw new Error("access-token-must-not-leak");
				return "available";
			},
			models: [{ modelId: "gpt-authorized", provider: "openai" }],
		});
		const gateway = await startGateway(handler);

		// When: the broker is down, then recovers before account checks run.
		const unavailable = await fetchJson(`${gateway.url}/v1/usage`);
		brokerAvailable = true;
		const usage = await fetchJson(`${gateway.url}/v1/usage`);
		const checks = await fetchJson(`${gateway.url}/v1/credentials/check`);

		// Then: outage details remain redacted, recovery does not retain a failed flight, and one check cannot fail its sibling.
		expect(unavailable.status).toBe(503);
		expect(unavailable.body).toEqual({ error: "broker unavailable" });
		expect(JSON.stringify(unavailable.body)).not.toContain(brokerSecret);
		expect(usage.status).toBe(200);
		expect(checks.status).toBe(200);
		expect(checks.body).toEqual({
			data: [
				{ credentialId: "account-a", provider: "openai", status: "available", type: "api_key" },
				{ credentialId: "account-b", provider: "openai", status: "unavailable", type: "api_key" },
			],
			object: "list",
		});
		expect(JSON.stringify(checks.body)).not.toContain("access-token-must-not-leak");
	});

	it("reports configured credentials without consuming a provider lease by default", async () => {
		// Given: a broker transport that exposes metadata but rejects credential selection.
		const operations: string[] = [];
		const broker = new AuthBrokerRemoteStore(
			{
				async request(request: unknown) {
					const message = parseAuthBrokerWireRequest(request);
					operations.push(message.operation);
					if (message.operation !== "metadata_snapshot") throw new Error("unexpected credential lease");
					return metadataResponse(message, [credential("account-a", "operator:a", "openai")]);
				},
			},
			0,
		);
		const handler = createAuthGatewayObservabilityHandler({
			broker,
			models: [{ modelId: "gpt-authorized", provider: "openai" }],
		});
		const gateway = await startGateway(handler);

		// When: the default credential diagnostic runs without an upstream-specific checker.
		const checks = await fetchJson(`${gateway.url}/v1/credentials/check`);

		// Then: it reports only metadata-backed configuration and does not consume a one-use lease.
		expect(checks.body).toEqual({
			data: [{ credentialId: "account-a", provider: "openai", status: "configured", type: "api_key" }],
			object: "list",
		});
		expect(operations).toEqual(["metadata_snapshot"]);
	});
});

async function startGateway(
	onRequest: Parameters<typeof startAuthGatewayTransport>[0]["onRequest"],
): Promise<AuthGatewayTransportHandle> {
	const handle = await startAuthGatewayTransport({
		auth: { kind: "token-value", token: gatewayToken },
		onRequest,
		port: 0,
	});
	handles.push(handle);
	return handle;
}

async function fetchJson(url: string): Promise<{ readonly body: unknown; readonly status: number }> {
	const response = await fetch(url, { headers: { authorization: `Bearer ${gatewayToken}` } });
	return { body: await response.json(), status: response.status };
}

function credential(
	credentialId: string,
	identityKey: string,
	provider: string,
	disabled = false,
): AuthBrokerCredentialMetadata {
	return {
		createdAt: "2026-07-11T00:00:00.000Z",
		credentialId,
		...(disabled ? { disabled: { at: "2026-07-11T00:00:00.000Z", cause: "fixture" } } : {}),
		identityKey,
		pool: { provider, type: "api_key" as const },
		updatedAt: "2026-07-11T00:00:00.000Z",
	};
}

function metadataResponse(
	request: Extract<AuthBrokerWireRequest, { readonly operation: "metadata_snapshot" }>,
	credentials: readonly AuthBrokerCredentialMetadata[],
) {
	return {
		operation: "metadata_snapshot" as const,
		protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
		requestId: request.requestId,
		snapshot: { credentials, generatedAt: "2026-07-11T00:00:00.000Z" },
	};
}
