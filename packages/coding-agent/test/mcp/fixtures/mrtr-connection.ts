import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { normalizeServer } from "../../../src/core/extensions/builtin/mcp/config.ts";
import { createMcpLogger } from "../../../src/core/extensions/builtin/mcp/log.ts";
import { ServerConnection } from "../../../src/core/extensions/builtin/mcp/connection.ts";
import { McpOAuthProvider } from "../../../src/core/extensions/builtin/mcp/auth/oauth-provider.ts";
import { McpTokenStore } from "../../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { createMcpRequestOrigin, mcpRequestOptions } from "../../../src/core/extensions/builtin/mcp/request-origin.ts";
import { getMcpMrtrPresentation } from "../../../src/core/mcp-mrtr-presentations.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { MrtrScript, startMrtrServer } from "./mrtr-2026-server.ts";

const cleanups: Array<() => Promise<unknown>> = [];
export async function cleanupMrtrConnections() {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
}

export async function connect(results: unknown[], sse: boolean | "stdio" = false, human = true, failure?: 401 | 403) {
	const script = new MrtrScript(results);
	script.continuationStatus = failure;
	const server = await startMrtrServer(script, sse === true);
	cleanups.push(server.close);
	const root = await mkdtemp(join(tmpdir(), "mrtr-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const logger = createMcpLogger("fixture", { logDir: root });
	const connection = new ServerConnection({
		serverName: "fixture",
		authProvider: failure
			? new McpOAuthProvider({
					serverName: "fixture",
					serverUrl: server.url,
					store: new McpTokenStore({ serverName: "fixture", serverUrl: server.url, agentDir: root }),
				})
			: undefined,
		config: normalizeServer(
			sse === "stdio"
				? {
						type: "stdio",
						command: process.execPath,
						env: { TMPDIR: root, TEMP: root, TMP: root },
						args: [
							"--import",
							"tsx",
							fileURLToPath(new URL("./mrtr-2026-server.ts", import.meta.url)),
							JSON.stringify(results),
						],
						auth: false,
					}
				: { type: "http", url: server.url, auth: false },
		),
		logger,
	});
	await connection.connect();
	const exited = sse === "stdio" ? Promise.withResolvers<void>() : undefined;
	if (exited) {
		const transport = connection.client.transport;
		if (!transport) throw new Error("Connected stdio transport missing");
		const onclose = transport.onclose;
		transport.onclose = () => {
			onclose?.();
			exited.resolve();
		};
	}
	cleanups.push(async () => {
		await connection.dispose();
		await exited?.promise;
	});
	const host = Object.create(InteractiveMode.prototype);
	Object.defineProperty(host, "session", {
		value: { sessionId: "fixture-session", admitHumanAnswer() {}, emitExtensionEvent() {} },
	});
	host.showExtensionSelector = async (_title: string, choices: string[]) =>
		choices.includes("Submit") ? "Submit" : choices[0];
	host.showExtensionInput = async () => "human answer";
	const ui = host.createExtensionUIContext();
	const origin = createMcpRequestOrigin({
		binding: {},
		connection,
		signal: connection.requestLifetimeSignal,
		presentation: human ? getMcpMrtrPresentation(ui) : undefined,
		serverLabel: "fixture",
		isCurrent: () => connection.state === "connected",
		resolveAuthority: async () => null,
	});
	const physical = connection.client;
	const client = new Proxy(physical, {
		get(target, property) {
			if (property === "callTool")
				return (...args: Parameters<Client["callTool"]>) =>
					target.callTool(args[0], args[1], mcpRequestOptions(origin, args[2]));
			if (property === "readResource")
				return (...args: Parameters<Client["readResource"]>) =>
					target.readResource(args[0], mcpRequestOptions(origin, args[1]));
			if (property === "getPrompt")
				return (...args: Parameters<Client["getPrompt"]>) =>
					target.getPrompt(args[0], mcpRequestOptions(origin, args[1]));
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return { client, script, origin, physical, connection, host, logger };
}
