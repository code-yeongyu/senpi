import { describe, expect, it } from "vitest";
import { AuthBrokerRemoteStore } from "../../src/core/auth-broker-remote-store.ts";
import { AUTH_BROKER_PROTOCOL_VERSION, type AuthBrokerWireResponse } from "../../src/core/auth-broker-wire-contract.ts";

describe("auth broker remote session affinity", () => {
	it("forwards the session identifier with a selection lease", async () => {
		// Given: a remote broker transport that captures the wire request.
		let captured: unknown;
		const remote = new AuthBrokerRemoteStore({
			async request(request): Promise<AuthBrokerWireResponse> {
				captured = request;
				return {
					lease: {
						credentialId: "credential-a",
						leaseId: "lease-a",
						material: { apiKey: "secret", type: "api_key" },
						pool: { provider: "openai", type: "api_key" },
					},
					operation: "selection_lease",
					protocolVersion: AUTH_BROKER_PROTOCOL_VERSION,
					requestId: "remote-1",
				};
			},
		});

		// When: a caller selects a credential for a stable session.
		await Reflect.apply(remote.select, remote, [
			{ provider: "openai", type: "api_key" },
			{ kind: "automatic" },
			"session-affinity-a",
		]);

		// Then: the session reaches the capability-scoped wire payload.
		expect(captured).toMatchObject({
			operation: "selection_lease",
			payload: { sessionId: "session-affinity-a" },
		});
	});
});
