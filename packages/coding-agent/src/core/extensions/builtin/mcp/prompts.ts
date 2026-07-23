// MCP prompts → slash commands (todo 40).
//
// Every prompt a connected server lists becomes a `/mcp:<server>:<prompt>`
// senpi command. Invoking it collects the prompt's declared arguments through
// ctx.ui.input (required arguments re-prompt once, then abort with a notice;
// optional arguments may be left empty), calls prompts/get, and injects the
// flattened returned messages into the input editor (senpi command semantics:
// the user reviews and submits). prompts_list_changed rides the existing
// tools-changed refresh, which re-runs registration; command registration is
// last-wins, and prompts removed server-side keep a stale command until the
// next session — invoking one surfaces the server error as a notice.

import type { ExtensionAPI, ExtensionCommandContext } from "../../types.ts";
import type { McpCachedServerCatalog } from "./catalog-cache.ts";
import type { ServerConnection } from "./connection.ts";
import { createMcpLogger } from "./log.ts";
import type { McpService } from "./service.ts";

export interface McpPromptServer {
	readonly server: string;
	readonly connection: ServerConnection;
	readonly requestTimeoutMs?: number;
	readonly prompts: NonNullable<McpCachedServerCatalog["prompts"]>;
}

type CommandRegistrar = Pick<ExtensionAPI, "registerCommand">;

const registeredCommandNames = new Set<string>();

/** Test seam: forget which commands were registered (module-level last-wins). */
export function resetMcpPromptCommandsForTests(): void {
	registeredCommandNames.clear();
}

export function registerMcpPromptCommands(pi: CommandRegistrar, servers: readonly McpPromptServer[]): string[];
export function registerMcpPromptCommands(
	service: McpService,
	pi: CommandRegistrar,
	servers: readonly McpPromptServer[],
): string[];
export function registerMcpPromptCommands(
	serviceOrPi: McpService | CommandRegistrar,
	piOrServers: CommandRegistrar | readonly McpPromptServer[],
	serversArg?: readonly McpPromptServer[],
): string[] {
	const service = serversArg === undefined ? undefined : (serviceOrPi as McpService);
	const pi = (serversArg === undefined ? serviceOrPi : piOrServers) as CommandRegistrar;
	const servers = (serversArg === undefined ? piOrServers : serversArg) as readonly McpPromptServer[];
	const added: string[] = [];
	for (const server of servers) {
		for (const prompt of server.prompts) {
			const commandName = `mcp:${server.server}:${prompt.name}`;
			if (service?.isMcpPromptCommandRegistered(commandName) ?? registeredCommandNames.has(commandName)) continue;
			if (service) service.markMcpPromptCommandRegistered(commandName);
			else registeredCommandNames.add(commandName);
			added.push(commandName);
			pi.registerCommand(commandName, {
				description: prompt.description ?? `MCP prompt ${prompt.name} from ${server.server}`,
				handler: async (_args, ctx) => {
					try {
						const collected = await collectPromptArguments(prompt.arguments ?? [], ctx);
						if (collected === undefined) return;
						const result = await server.connection.client.getPrompt(
							{ arguments: collected, name: prompt.name },
							{ timeout: server.requestTimeoutMs },
						);
						ctx.ui.setEditorText(flattenPromptMessages(result.messages));
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						createMcpLogger(server.server).warn(`prompt ${prompt.name} failed: ${message}`);
						ctx.ui.notify(`MCP prompt ${prompt.name} failed: ${message}`, "error");
					}
				},
			});
		}
	}
	return added;
}

async function collectPromptArguments(
	declared: ReadonlyArray<{ name: string; description?: string; required?: boolean }>,
	ctx: ExtensionCommandContext,
): Promise<Record<string, string> | undefined> {
	const collected: Record<string, string> = {};
	for (const argument of declared) {
		const title = `${argument.name}${argument.required ? "" : " (optional)"}`;
		const value = await ctx.ui.input(title, argument.description);
		if (value !== undefined && value.length > 0) {
			collected[argument.name] = value;
			continue;
		}
		if (argument.required) {
			ctx.ui.notify(`MCP prompt cancelled: required argument '${argument.name}' not provided.`, "warning");
			return undefined;
		}
	}
	return collected;
}

function flattenPromptMessages(messages: ReadonlyArray<{ role: string; content: unknown }>): string {
	return messages
		.map((message) => {
			const content = message.content as { type?: string; text?: string };
			const text = typeof content?.text === "string" ? content.text : JSON.stringify(message.content);
			return messages.length > 1 ? `${message.role}: ${text}` : text;
		})
		.join("\n\n");
}
