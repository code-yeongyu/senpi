import { describe, expect, it } from "vitest";
import {
	negotiatePiCodexAppServerCapabilities,
	parseExternalInitializeCapabilities,
} from "../../src/core/extensions/builtin/pi-codex-app-server/capability-negotiator.ts";
import {
	ADAPTER_ERROR_SOURCE,
	ADAPTER_JSON_RPC_ERROR_CODE,
	createAdapterJsonRpcError,
	preserveAppServerJsonRpcError,
} from "../../src/core/extensions/builtin/pi-codex-app-server/error-mapper.ts";
import { PI_CODEX_APP_SERVER_PROTOCOL_VERSION } from "../../src/core/extensions/builtin/pi-codex-app-server/protocol-core.ts";

describe("pi-codex-app-server capability negotiation", () => {
	it("accepts semantic plus opaque relay and maps app-server notification opt-outs", () => {
		const parsed = parseExternalInitializeCapabilities({
			protocolVersion: PI_CODEX_APP_SERVER_PROTOCOL_VERSION,
			capabilities: {
				semanticEvents: true,
				opaqueNotifications: true,
				opaqueCallbacks: true,
				realtime: false,
				filesystem: true,
				appPluginConfig: true,
				notificationOptOuts: ["thread/tokenUsage/updated", "warning"],
			},
		});

		const negotiated = negotiatePiCodexAppServerCapabilities({
			external: parsed,
			appServer: {
				experimentalApi: true,
				requestAttestation: true,
				mcpServerOpenaiFormElicitation: true,
				optOutNotificationMethods: ["warning", "thread/tokenUsage/updated", "configWarning"],
			},
		});

		expect(negotiated).toMatchObject({
			kind: "accepted",
			protocolVersion: PI_CODEX_APP_SERVER_PROTOCOL_VERSION,
			capabilityFlags: [
				"semantic-events",
				"opaque-notifications",
				"opaque-callbacks",
				"filesystem",
				"app-plugin-config",
				"app-server-experimental-api",
				"app-server-attestation",
				"app-server-mcp-form-elicitation",
			],
			notificationOptOuts: ["thread/tokenUsage/updated", "warning"],
		});
	});

	it("rejects clients that refuse opaque notifications or opaque callbacks", () => {
		const withoutNotifications = parseExternalInitializeCapabilities({
			protocolVersion: PI_CODEX_APP_SERVER_PROTOCOL_VERSION,
			capabilities: {
				semanticEvents: true,
				opaqueNotifications: false,
				opaqueCallbacks: true,
			},
		});
		const withoutCallbacks = parseExternalInitializeCapabilities({
			protocolVersion: PI_CODEX_APP_SERVER_PROTOCOL_VERSION,
			capabilities: {
				semanticEvents: true,
				opaqueNotifications: true,
				opaqueCallbacks: false,
			},
		});

		expect(negotiatePiCodexAppServerCapabilities({ external: withoutNotifications }).error).toMatchObject({
			code: ADAPTER_JSON_RPC_ERROR_CODE,
			data: {
				source: ADAPTER_ERROR_SOURCE,
				adapterCode: "incompatible-capabilities",
			},
		});
		expect(negotiatePiCodexAppServerCapabilities({ external: withoutCallbacks }).error).toMatchObject({
			code: ADAPTER_JSON_RPC_ERROR_CODE,
			data: {
				source: ADAPTER_ERROR_SOURCE,
				adapterCode: "incompatible-capabilities",
			},
		});
	});

	it("rejects malformed protocol versions and unknown notification opt-outs at the boundary", () => {
		expect(() =>
			parseExternalInitializeCapabilities({
				protocolVersion: "2026-06-24.pr-000",
				capabilities: {
					semanticEvents: true,
					opaqueNotifications: true,
					opaqueCallbacks: true,
				},
			}),
		).toThrow("Unsupported pi-codex-app-server protocol version");

		expect(() =>
			parseExternalInitializeCapabilities({
				protocolVersion: PI_CODEX_APP_SERVER_PROTOCOL_VERSION,
				capabilities: {
					semanticEvents: true,
					opaqueNotifications: true,
					opaqueCallbacks: true,
					notificationOptOuts: ["not/a-real-notification"],
				},
			}),
		).toThrow("Unknown app-server notification opt-out");
	});
});

describe("pi-codex-app-server error namespace", () => {
	it("marks adapter errors with the pi-codex-app-server source without rewriting app-server errors", () => {
		const adapterError = createAdapterJsonRpcError({
			adapterCode: "malformed-message",
			message: "Malformed initialize params.",
			details: ["capabilities must be an object"],
		});
		const appServerError = preserveAppServerJsonRpcError({
			code: -32001,
			message: "app-server overloaded",
			data: { retryAfterMs: 100 },
		});

		expect(adapterError).toEqual({
			code: ADAPTER_JSON_RPC_ERROR_CODE,
			message: "Malformed initialize params.",
			data: {
				source: ADAPTER_ERROR_SOURCE,
				adapterCode: "malformed-message",
				details: ["capabilities must be an object"],
				retryable: false,
			},
		});
		expect(appServerError).toEqual({
			code: -32001,
			message: "app-server overloaded",
			data: { retryAfterMs: 100 },
		});
	});
});
