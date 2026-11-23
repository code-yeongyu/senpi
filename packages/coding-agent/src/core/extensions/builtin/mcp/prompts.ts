// MCP prompts → slash commands (todo 40).
//
// Every prompt a connected server lists becomes a `/mcp:<server>:<prompt>`
// senpi command. Invoking it collects the prompt's declared arguments through
// ctx.ui.input (required arguments re-prompt once, then abort with a notice;
// optional arguments may be left empty), calls prompts/get, and injects the
// flattened returned messages into the input editor (senpi command semantics:
// the user reviews and submits). Registration re-runs on every catalog
// generation (senpi#7249), so a prompt that arrives after attach still becomes a
// command. A handler reads its prompt from the live catalog when it runs, so it
// uses the server's current arguments. A prompt the server stopped offering keeps
// its command name, since commands cannot be unregistered, and invoking it says so.
// Dedup is per registrar (one extension instance's `pi`): two runners sharing a
// service, or a replacement runner after reload, each get their own commands.

import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "../../types.ts";
import type { McpCachedServerCatalog } from "./catalog-cache.ts";
import type { ServerConnection } from "./connection.ts";
import { createMcpLogger } from "./log.ts";
import type { McpService } from "./service.ts";
import { type McpRequestOrigin, mcpRequestOptions } from "./request-origin.ts";
import { ensureMcpToolCallConnection } from "./health.ts";

export interface McpPromptServer {
	readonly ensureFresh?: () => Promise<void>;
	readonly requestOrigin?: () => McpRequestOrigin | undefined;
	readonly bindPresentation?: (ui: ExtensionUIContext) => void;
	readonly server: string;
	readonly connection: ServerConnection;
	readonly requestTimeoutMs?: number;
	readonly prompts: NonNullable<McpCachedServerCatalog["prompts"]>;
}

type CommandRegistrar = Pick<ExtensionAPI, "registerCommand">;

/** Command name -> description, per registrar. A new extension instance is a new key. */
const registeredByRegistrar = new WeakMap<CommandRegistrar, Map<string, string>>();

/** The prompt commands this registrar holds, live (read by the TUI autocomplete wrapper). */
export function registeredMcpPromptCommands(pi: CommandRegistrar): ReadonlyMap<string, string> {
	return registeredByRegistrar.get(pi) ?? new Map();
}

type LiveCatalog = () => readonly McpPromptServer[];
type McpPromptRegistry = Pick<McpService, "getMcpPromptServers" | "onMcpRegistrationChanged">;

/** Registers this session's prompt commands now and after every later catalog generation. */
export function createMcpPromptCommandSync(
	service: McpPromptRegistry,
	pi: CommandRegistrar,
): { register(): void; dispose(): void } {
	const current: LiveCatalog = () => service.getMcpPromptServers(pi);
	const register = (): void => {
		registerMcpPromptCommands(pi, current(), current);
	};
	const dispose = service.onMcpRegistrationChanged(register);
	return { register, dispose };
}

export function registerMcpPromptCommands(
	pi: CommandRegistrar,
	servers: readonly McpPromptServer[],
	current?: LiveCatalog,
): string[] {
	let registered = registeredByRegistrar.get(pi);
	if (registered === undefined) {
		registered = new Map();
		registeredByRegistrar.set(pi, registered);
	}
	const added: string[] = [];
	for (const server of servers) {
		for (const prompt of server.prompts) {
			const commandName = `mcp:${server.server}:${prompt.name}`;
			if (registered.has(commandName)) continue;
			const description = prompt.description ?? `MCP prompt ${prompt.name} from ${server.server}`;
			registered.set(commandName, description);
			added.push(commandName);
			pi.registerCommand(commandName, {
				description,
				handler: async (_args, ctx) => {
					const live = livePrompt(server, prompt, current);
					if (live === undefined) {
						ctx.ui.notify(`MCP prompt ${prompt.name} is no longer offered by ${server.server}.`, "warning");
						return;
					}
					try {
						live.server.bindPresentation?.(ctx.ui);
						const collected = await collectPromptArguments(live.prompt.arguments ?? [], ctx);
						if (collected === undefined) return;
						if (live.server.requestOrigin) {
							await ensureMcpToolCallConnection(live.server.connection, live.server.ensureFresh);
						}
						const result = await live.server.connection.client.getPrompt(
							{ arguments: collected, name: live.prompt.name },
							mcpRequestOptions(live.server.requestOrigin?.(), { timeout: live.server.requestTimeoutMs }),
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

type PromptEntry = McpPromptServer["prompts"][number];

/** The server and prompt a command should use now: the live catalog's entry by name, or the registered one. */
function livePrompt(
	server: McpPromptServer,
	prompt: PromptEntry,
	current: LiveCatalog | undefined,
): { server: McpPromptServer; prompt: PromptEntry } | undefined {
	if (current === undefined) return { server, prompt };
	const liveServer = current().find((candidate) => candidate.server === server.server);
	const liveEntry = liveServer?.prompts.find((candidate) => candidate.name === prompt.name);
	return liveServer && liveEntry ? { server: liveServer, prompt: liveEntry } : undefined;
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
