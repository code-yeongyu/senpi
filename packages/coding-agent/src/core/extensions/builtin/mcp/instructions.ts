import type { McpService } from "./service.ts";

const MAX_INSTRUCTIONS_CHARS = 4000;

/** Rebuild instructions from this session's servers (senpi#3001). */
export function refreshMcpInstructionsForSession(service: McpService, pi: object): void {
	service.setMcpInstructions(buildMcpInstructionsBlock(service, pi), pi);
}

export function injectMcpInstructions(service: McpService, systemPrompt: string, pi: object): string | undefined {
	const instructions = service.getMcpInstructions(pi);
	if (instructions.length === 0) return undefined;
	if (systemPrompt.includes(instructions)) return undefined;
	return `${systemPrompt}\n\n${instructions}`;
}

function buildMcpInstructionsBlock(service: McpService, pi: object): string {
	const blocks: string[] = [];
	for (const snapshot of service.getServerSnapshots(pi)) {
		const connection = service.getConnection(snapshot.name, pi);
		const instructions =
			connection?.state === "connected"
				? connection.client.getInstructions()
				: service.getCachedInstructions(snapshot.name, pi);
		if (instructions === undefined || instructions.length === 0) continue;
		blocks.push(formatInstructionsBlock(snapshot.name, instructions));
	}
	return blocks.join("\n\n");
}

function formatInstructionsBlock(serverName: string, instructions: string): string {
	const escapedServerName = escapeXml(serverName);
	const cappedInstructions = instructions.slice(0, MAX_INSTRUCTIONS_CHARS);
	const escapedInstructions = escapeXml(cappedInstructions);
	return `<mcp_instructions server="${escapedServerName}">\n${escapedInstructions}\n</mcp_instructions>`;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
