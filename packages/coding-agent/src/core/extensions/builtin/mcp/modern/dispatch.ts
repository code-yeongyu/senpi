import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ConnectError } from "../errors.ts";
import {
	type MaterializeMcpTransportOptions,
	type McpMaterializedTransport,
	materializeMcpTransport,
} from "../transport-sdk.ts";
import { type EraOutcome, probeHttpEra } from "./era.ts";
import { modernCredentialSnapshot, modernHttpFetch } from "./http-fetch.ts";
import { createMcpRequestClient } from "./client.ts";
import type { ModernProtocolState } from "./request.ts";
import { ModernSdkBridge } from "./sdk-bridge.ts";
import { probeStdioTransport } from "./stdio-probe.ts";
import { ModernHttpTransport } from "./transport.ts";
import { MODERN_PROTOCOL_VERSION } from "./wire.ts";

const clientInfo = { name: "senpi-mcp-client", version: "0.0.0" };
const probeOptions = {
	clientInfo,
	clientCapabilities: {},
	supportedVersions: [MODERN_PROTOCOL_VERSION],
};

export async function materializeNegotiatedTransport(
	options: MaterializeMcpTransportOptions,
	serverName: string,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<McpMaterializedTransport> {
	signal.throwIfAborted();
	const { spec, logger } = options;
	const protocol: ModernProtocolState = {};
	let outcome: EraOutcome = { kind: "legacy-fallback" };
	if (spec.kind === "http") {
		const fetch = modernHttpFetch(spec, signal);
		const timeout = AbortSignal.timeout(timeoutMs);
		outcome = await probeHttpEra(spec.url, (url, init) => fetch(url, { ...init, signal: timeout }), probeOptions);
		signal.throwIfAborted();
		timeout.throwIfAborted();
		if (outcome.kind === "modern-OK" || outcome.kind === "modern-version-retry") {
			if (!outcome.discovery) {
				throw new ConnectError(`MCP server ${serverName} modern discovery failed: ${outcome.error?.message}`, {
					phase: "connect",
					serverName,
				});
			}
			protocol.version = outcome.version;
			const client = await createMcpRequestClient(
				protocol,
				options.elicitationUiProvider,
				() => modernCredentialSnapshot(spec.authProvider?.tokens()),
				options.elicitationEnabled,
			);
			const transport = new ModernSdkBridge(
				new ModernHttpTransport({
					url: spec.url,
					fetch: modernHttpFetch(spec, signal, false),
					clientInfo,
					clientCapabilities: {},
					protocolVersion: outcome.version,
					logger,
				}),
				outcome.discovery,
				outcome.version,
			);
			const version = outcome.version;
			logVersion(transport, () => version);
			return {
				client,
				transport,
				readPid: () => null,
				close: async () => {
					await transport.close();
					await client.close();
				},
			};
		}
		if (outcome.kind === "indeterminate" && (outcome.era === "modern" || outcome.reason === "invalid-discovery")) {
			throw new ConnectError(`MCP server ${serverName}: ${outcome.reason}. ${outcome.action}`, {
				phase: "connect",
				serverName,
				cause: outcome.cause,
			});
		}
	}
	// Unknown endpoints (including legacy session-required 404s and auth challenges) retain SDK diagnostics.
	if (spec.kind === "http") protocol.legacy = true;
	const legacy = await materializeMcpTransport(options, protocol);
	// A modern stdio child is detected when the SDK starts it, before its local initialize answer sets the version.
	let stdioModernVersion: string | undefined;
	if (spec.kind === "stdio") {
		probeStdioTransport(
			legacy.transport,
			probeOptions,
			logger,
			timeoutMs,
			serverName,
			(version) => {
				stdioModernVersion = version;
				protocol.version = version;
				protocol.activateRequests?.();
				protocol.resolveStdioDiagnostics?.(true);
			},
			undefined,
			() => {
				protocol.legacy = true;
				protocol.resolveStdioDiagnostics?.(false);
			},
		);
	}
	logVersion(legacy.transport, () => stdioModernVersion);
	return legacy;

	function logVersion(transport: Transport, readModernVersion: () => string | undefined): void {
		const setVersion = transport.setProtocolVersion?.bind(transport);
		transport.setProtocolVersion = (sdkVersion) => {
			setVersion?.(sdkVersion);
			const modernVersion = readModernVersion();
			logger.info(
				`MCP server ${serverName} negotiated: era=${modernVersion ? "modern" : "legacy"} version=${modernVersion ?? sdkVersion}`,
			);
		};
	}
}
