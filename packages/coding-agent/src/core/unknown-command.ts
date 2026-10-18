import { fuzzyFilter } from "@earendil-works/pi-tui";

/** A leading `/name` token; a second `/` (`/tmp/a.txt`) makes the token a path, not a command. */
const COMMAND_TOKEN = /^\/[A-Za-z][A-Za-z0-9:_-]*$/;
const MAX_SUGGESTIONS = 3;

/** `unknown`: nothing registers the name. `interactive_only`: a TUI builtin sent as a prompt. */
export type UnknownCommandReason = "unknown" | "interactive_only";

/** Names a prompt can resolve, split by whether the prompt path itself can run them. */
export interface CommandCatalog {
	/** Extension commands, prompt templates, and `skill:<name>` for loaded skills. */
	readonly promptCommands: ReadonlySet<string>;
	/** TUI builtins (`model`, `settings`, ...) that only the interactive editor dispatches. */
	readonly interactiveCommands: ReadonlySet<string>;
}

/** Command-shaped input that no command handles, rejected before it reaches the model. */
export class UnknownCommandError extends Error {
	/** The command name without its leading `/`. */
	readonly command: string;
	/** Up to three known command names (without `/`) close to `command`. */
	readonly suggestions: readonly string[];
	readonly reason: UnknownCommandReason;

	constructor(command: string, suggestions: readonly string[], reason: UnknownCommandReason) {
		super(formatUnknownCommandMessage(command, suggestions, reason));
		this.name = "UnknownCommandError";
		this.command = command;
		this.suggestions = suggestions;
		this.reason = reason;
	}
}

function formatUnknownCommandMessage(
	command: string,
	suggestions: readonly string[],
	reason: UnknownCommandReason,
): string {
	if (reason === "interactive_only") {
		return `/${command} is an interactive command and cannot be sent as a prompt.`;
	}
	const hint = suggestions.length === 0 ? "" : ` Did you mean ${suggestions.map((name) => `/${name}`).join(", ")}?`;
	return `Unknown command /${command}.${hint}`;
}

/** How a protocol client confirms that a refused unknown command should be sent as text. */
export const UNKNOWN_COMMAND_CONFIRM_HINT = 'Resend with "unknownCommandAsText": true to send it as text.';

/** Rebuild the typed rejection from an RPC `unknown_command` failure's `errorData`, if it is well formed. */
export function unknownCommandErrorFromWire(data: unknown): UnknownCommandError | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const command: unknown = Reflect.get(data, "command");
	const suggestions: unknown = Reflect.get(data, "suggestions");
	const reason: unknown = Reflect.get(data, "reason");
	if (typeof command !== "string" || !Array.isArray(suggestions)) return undefined;
	if (reason !== "unknown" && reason !== "interactive_only") return undefined;
	const names = suggestions.filter((name): name is string => typeof name === "string");
	return new UnknownCommandError(command, names, reason);
}

/** The command name of command-shaped text, or `undefined` when the text is ordinary prose or a path. */
export function commandShapedName(text: string): string | undefined {
	const token = text.trim().split(/\s/, 1)[0] ?? "";
	return COMMAND_TOKEN.test(token) ? token.slice(1) : undefined;
}

/** The rejection for command-shaped `text` whose name the catalog cannot resolve, if any. */
export function findUnknownCommand(text: string, catalog: CommandCatalog): UnknownCommandError | undefined {
	const command = commandShapedName(text);
	if (command === undefined || catalog.promptCommands.has(command)) return undefined;
	if (catalog.interactiveCommands.has(command)) {
		return new UnknownCommandError(command, [], "interactive_only");
	}
	const known = [...new Set([...catalog.promptCommands, ...catalog.interactiveCommands])];
	const suggestions = fuzzyFilter(known, command, (name) => name).slice(0, MAX_SUGGESTIONS);
	return new UnknownCommandError(command, suggestions, "unknown");
}
