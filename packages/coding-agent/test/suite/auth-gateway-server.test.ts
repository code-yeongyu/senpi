import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AuthGatewayTransportConfigError,
	type AuthGatewayTransportHandle,
	startAuthGatewayTransport,
} from "../../src/core/auth-gateway-transport.ts";

const gatewayToken = "gateway-test-token";
const allowedOrigin = "https://console.example.test";

const handles: AuthGatewayTransportHandle[] = [];

afterEach(async () => {
	await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

describe("auth gateway server", () => {
	it("serves unauthenticated minimal health and authenticated exact-origin preflight", async () => {
		// Given: a loopback gateway with one explicit browser origin.
		const handle = await startGateway({ allowedOrigins: [allowedOrigin] });

		// When: a health probe and exact-origin authenticated preflight arrive.
		const health = await fetch(`${handle.url}/healthz`);
		const preflight = await fetch(`${handle.url}/v1/models`, {
			headers: {
				Authorization: `Bearer ${gatewayToken}`,
				Origin: allowedOrigin,
				"Access-Control-Request-Headers": "content-type",
				"Access-Control-Request-Method": "GET",
			},
			method: "OPTIONS",
		});

		// Then: health exposes only the fixed minimal payload and CORS is exact.
		expect(health.status).toBe(200);
		expect(await health.json()).toEqual({ ok: true, version: "test-version" });
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
		expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
		expect(preflight.headers.get("access-control-allow-origin")).not.toBe("*");
	});

	it("rejects wrong bearer, bad origin, malformed body, insecure remote broker URL, and external bind before a provider call", async () => {
		// Given: a gateway whose authorized dispatch records any provider-bound call.
		let dispatches = 0;
		const handle = await startGateway({
			onRequest: async () => {
				dispatches += 1;
				return { body: { unexpected: true }, statusCode: 200 };
			},
		});

		// When: invalid transport inputs arrive and invalid configurations are constructed.
		const wrongBearer = await fetch(`${handle.url}/v1/models`, {
			headers: { Authorization: "Bearer wrong-token" },
		});
		const badOrigin = await fetch(`${handle.url}/v1/models`, {
			headers: { Authorization: `Bearer ${gatewayToken}`, Origin: "https://evil.example.test" },
		});
		const malformedBody = await fetch(`${handle.url}/v1/chat/completions`, {
			body: "{invalid-json",
			headers: { Authorization: `Bearer ${gatewayToken}`, "content-type": "application/json" },
			method: "POST",
		});

		// Then: all invalid inputs fail before dispatch and unsafe binds/broker URLs fail closed.
		expect(wrongBearer.status).toBe(401);
		expect(badOrigin.status).toBe(403);
		expect(malformedBody.status).toBe(400);
		expect(dispatches).toBe(0);
		await expect(
			startAuthGatewayTransport({
				brokerUrl: "http://broker.example.test",
				auth: { kind: "token-value", token: gatewayToken },
			}),
		).rejects.toBeInstanceOf(AuthGatewayTransportConfigError);
		await expect(
			startAuthGatewayTransport({
				auth: { kind: "token-value", token: gatewayToken },
				host: "0.0.0.0",
			}),
		).rejects.toBeInstanceOf(AuthGatewayTransportConfigError);
	});

	it("creates a private token file and keeps forwarded client identity untrusted by default", async () => {
		// Given: a new token location and no configured trusted proxy.
		const directory = await mkdtemp(join(tmpdir(), "senpi-auth-gateway-"));
		const tokenPath = join(directory, "nested", "gateway-token");
		try {
			const handle = await startAuthGatewayTransport({
				auth: { kind: "token-file", path: tokenPath },
				port: 0,
			});
			handles.push(handle);

			// When: the generated token is used with a forwarded identity header.
			const token = (await readFile(tokenPath, "utf8")).trim();
			const response = await fetch(`${handle.url}/v1/models`, {
				headers: { Authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.99" },
			});

			// Then: the token is private and the request is not treated as a proxy assertion.
			expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
			expect((await stat(join(directory, "nested"))).mode & 0o777).toBe(0o700);
			expect(response.status).toBe(501);
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	});

	it("rejects invalid trusted-proxy and mTLS transport settings", async () => {
		// Given: invalid proxy and broker TLS configuration values.
		const invalidTrustedProxy = startAuthGatewayTransport({
			auth: { kind: "token-value", token: gatewayToken },
			trustedProxy: "proxy.example.test",
		});
		const invalidMtlsUrl = startAuthGatewayTransport({
			auth: { kind: "token-value", token: gatewayToken },
			brokerMtls: { certFile: "cert.pem", keyFile: "key.pem" },
			brokerUrl: "http://127.0.0.1:8787",
		});

		// When: gateway startup validates each configuration.
		const rejected = await Promise.allSettled([invalidTrustedProxy, invalidMtlsUrl]);

		// Then: forwarded identities and mTLS are accepted only under their fixed security policy.
		for (const result of rejected) {
			expect(result.status).toBe("rejected");
			if (result.status === "rejected") expect(result.reason).toBeInstanceOf(AuthGatewayTransportConfigError);
		}
	});

	it("bounds concurrent requests and aborts in-flight work during graceful shutdown", async () => {
		// Given: a one-request gateway whose adapter waits for shutdown cancellation.
		let entered: (() => void) | undefined;
		let aborted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const observedAbort = new Promise<void>((resolve) => {
			aborted = resolve;
		});
		const handle = await startAuthGatewayTransport({
			auth: { kind: "token-value", token: gatewayToken },
			maxConcurrentRequests: 1,
			onRequest: async ({ signal }) => {
				entered?.();
				await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
				aborted?.();
				return { statusCode: 499 };
			},
			port: 0,
		});

		// When: one adapter request is active, then a second arrives and the gateway closes.
		const first = fetch(`${handle.url}/v1/chat/completions`, {
			body: "{}",
			headers: { Authorization: `Bearer ${gatewayToken}`, "content-type": "application/json" },
			method: "POST",
		}).catch(() => undefined);
		await started;
		const second = await fetch(`${handle.url}/v1/models`, {
			headers: { Authorization: `Bearer ${gatewayToken}` },
		});
		await handle.close();

		// Then: queue overload is deterministic and shutdown cancels the adapter.
		expect(second.status).toBe(503);
		await expect(observedAbort).resolves.toBeUndefined();
		await first;
	});
});

async function startGateway(options: {
	readonly allowedOrigins?: readonly string[];
	readonly onRequest?: Parameters<typeof startAuthGatewayTransport>[0]["onRequest"];
}): Promise<AuthGatewayTransportHandle> {
	const handle = await startAuthGatewayTransport({
		allowedOrigins: options.allowedOrigins,
		auth: { kind: "token-value", token: gatewayToken },
		onRequest: options.onRequest,
		port: 0,
		version: "test-version",
	});
	handles.push(handle);
	return handle;
}
