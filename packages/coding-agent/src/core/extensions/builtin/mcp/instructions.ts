import type { McpService } from "./service.ts";

const MAX_INSTRUCTIONS_CHARS = 4000;

let sessionInstructionsBlock = "";

export function refreshMcpInstructionsForSession(service: McpService): void {
	sessionInstructionsBlock = buildMcpInstructionsBlock(service);
}

export function injectMcpInstructions(systemPrompt: string): string | undefined {
	if (sessionInstructionsBlock.length === 0) return undefined;
	if (systemPrompt.includes(sessionInstructionsBlock)) return undefined;
	return `${systemPrompt}\n\n${sessionInstructionsBlock}`;
}

function buildMcpInstructionsBlock(service: McpService): string {
	const blocks: string[] = [];
	for (const snapshot of service.getServerSnapshots()) {
		const connection = service.getConnection(snapshot.name);
		if (connection?.state !== "connected") continue;
		const instructions = connection.client.getInstructions();
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
