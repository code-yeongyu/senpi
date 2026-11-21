import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { discoverySchema } from "./modern/era.ts";
import { McpMrtrError } from "./modern/errors.ts";
import { modernMcpProtocolVersion } from "./modern/request.ts";

export class UnsupportedMcpHealthVersionError extends Error {
	constructor(version: string) {
		super(`MCP health checks do not support protocol version ${version}`);
		this.name = "UnsupportedMcpHealthVersionError";
	}
}

export async function probeMcpHealth(client: Client, timeout: number): Promise<void> {
	const version = modernMcpProtocolVersion(client);
	if (version === undefined) {
		await client.ping({ timeout });
		return;
	}
	if (version !== "2026-07-28") throw new UnsupportedMcpHealthVersionError(version);
	const discovery = await client.request({ method: "server/discover" }, discoverySchema, {
		timeout,
		maxTotalTimeout: timeout,
	});
	if (!discovery.supportedVersions.includes(version)) throw new McpMrtrError("MCP_MRTR_INVALID_RESULT");
}
