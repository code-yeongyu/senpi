import type { McpService } from "./service.ts";

const MAX_INSTRUCTIONS_CHARS = 4000;

export function refreshMcpInstructionsForSession(service: McpService): void {
	service.setMcpInstructions(buildMcpInstructionsBlock(service));
}

export function injectMcpInstructions(service: McpService, systemPrompt: string): string | undefined {
	const instructions = service.getMcpInstructions();
	if (instructions.length === 0) return undefined;
	if (systemPrompt.includes(instructions)) return undefined;
	return `${systemPrompt}\n\n${instructions}`;
}

function buildMcpInstructionsBlock(service: McpService): string {
	const blocks: string[] = [];
	for (const snapshot of service.getServerSnapshots()) {
		const connection = service.getConnection(snapshot.name);
		const instructions =
			connection?.state === "connected"
				? connection.client.getInstructions()
				: service.getCachedInstructions(snapshot.name);
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
