import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	type McpElicitationUiProvider,
	configureMcpElicitation,
	legacyMcpFormEligible,
	mcpClientCapabilities,
} from "../elicitation.ts";
import { loadMcpSdkClient } from "../sdk.lazy.ts";
import { mcpElapsedClock } from "../wrap.ts";
import { installModernRequestAdapter, type ModernProtocolState } from "./request.ts";

export async function createMcpRequestClient(
	protocol: ModernProtocolState,
	uiProvider: McpElicitationUiProvider | undefined,
	readCredential: () => string | undefined = () => undefined,
	elicitationEnabled = true,
): Promise<Client> {
	const { Client } = await loadMcpSdkClient();
	protocol.privateForms = uiProvider?.enforced?.() === true;
	const legacyEligible = legacyMcpFormEligible(uiProvider, elicitationEnabled);
	protocol.legacyFormEligible = legacyEligible;
	const client = new Client(
		{ name: "senpi-mcp-client", version: "0.0.0" },
		{ capabilities: mcpClientCapabilities(legacyEligible) },
	);
	await configureMcpElicitation(client, uiProvider, undefined, legacyEligible);
	installModernRequestAdapter(client, protocol, mcpElapsedClock, readCredential);
	return client;
}
