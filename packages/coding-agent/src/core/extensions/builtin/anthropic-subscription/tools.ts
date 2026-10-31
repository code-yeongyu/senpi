import type { Context, Tool } from "@earendil-works/pi-ai";
import type { Options } from "./sdk-boundary.ts";

export const SDK_TO_PI_TOOL_NAME: Readonly<Record<string, string>> = {
	read: "read",
	write: "write",
	edit: "edit",
	bash: "bash",
	grep: "grep",
	glob: "find",
};

/**
 * Claude Code built-in tool names a model may still emit (from habit, or because a skill document names
 * them), each with the senpi tools that can serve it, in preference order. `resolveSdkTools` turns the
 * active ones into `toolAliases`, so such a call resolves to the matching custom-tools MCP tool and ends
 * the SDK turn at the host deny hook instead of becoming Claude Code's own `No such tool available`
 * answer, which would have let the model run on inside the query while senpi also executed the call
 * (the #2401 shape). The lowercase spellings are aliased too, since a bare `edit` otherwise takes the
 * same `No such tool` path. Arguments are translated from the built-in shape only for the exact
 * built-in spellings (`translatesBuiltinArguments`).
 */
export const BUILTIN_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
	Read: ["read"],
	Write: ["write"],
	Edit: ["edit"],
	MultiEdit: ["edit"],
	Bash: ["bash"],
	Grep: ["grep"],
	Glob: ["glob", "find"],
};

/**
 * Versioned host-tool denial policy. `configFingerprint` in session-sync.ts hashes this as
 * `hostToolPolicy` into `toolsetHash`; a mismatch is `toolset_changed` and retires the live
 * resident query (reattach with the current hooks). The same hash is persisted in the
 * restart sidecar, so the first admission after an upgrade also reattaches with
 * `toolset_changed` - the resumed query carries the current hooks, so the pre-bump
 * denial text is never served again. Bump when denial copy or hooks change so
 * wording-only edits cannot keep serving the old reason.
 */
export const HOST_TOOL_POLICY_FINGERPRINT = "host-tool-denial-v5";

/**
 * Claude Code gets no built-in tool: every senpi tool is served through the custom-tools MCP server
 * with its own schema, where no Claude Code validator runs ahead of the deny hook (#2401) and no
 * built-in schema shadows a custom one (#4059). `tools: []` is what disables the built-ins.
 */
export const BUILTIN_SDK_TOOLS: readonly string[] = [];
/**
 * The reason the host deny hook gives. Claude Code itself labels every PreToolUse deny as
 * "PreToolUse:<Tool> hook error: <reason>" with is_error true, and that label cannot be changed, so the
 * reason has to say first that it is the expected handoff and must not be reported (senpi#3417).
 */
export const TOOL_EXECUTION_DENIED_MESSAGE =
	"Not an error: this is the normal host handoff, so ignore the 'hook error' label. " +
	"Senpi runs this tool on the host and returns its result as the next user message. " +
	"Wait for that result, and do not mention this message to the user.";
export const HOST_TOOL_EXECUTION_DENIED_MESSAGE = TOOL_EXECUTION_DENIED_MESSAGE;
export const CUSTOM_TOOLS_MCP_SERVER_NAME = "custom-tools";
export const CUSTOM_TOOLS_MCP_PREFIX = `mcp__${CUSTOM_TOOLS_MCP_SERVER_NAME}__`;
export const HOST_CAPTURED_SDK_TOOL_MATCHER = `${CUSTOM_TOOLS_MCP_PREFIX}.*`;
export const HOST_TOOL_DENIAL_HOOKS: NonNullable<Options["hooks"]> = {
	PreToolUse: [
		{
			matcher: HOST_CAPTURED_SDK_TOOL_MATCHER,
			hooks: [
				async () => ({
					continue: false,
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "deny",
						permissionDecisionReason: HOST_TOOL_EXECUTION_DENIED_MESSAGE,
					},
				}),
			],
		},
	],
};

export type ResolvedSdkTools = {
	customTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
	/** Claude Code `toolAliases`: built-in name (both spellings) -> custom-tools MCP name of the active senpi tool. */
	toolAliases: Record<string, string>;
};

function pascalCase(value: string): string {
	return value
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean)
		.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
		.join("");
}

export function mapPiToolNameToSdk(name: string, customToolNameToSdk?: ReadonlyMap<string, string>): string {
	return customToolNameToSdk?.get(name) ?? customToolNameToSdk?.get(name.toLowerCase()) ?? pascalCase(name);
}

/**
 * The active context wins (an alias such as `Glob` follows the tool it was derived from); the static
 * table only serves names from transcripts recorded while the built-ins were still offered.
 */
export function mapSdkToolNameToPi(name: string, customToolNameToPi?: ReadonlyMap<string, string>): string {
	const normalized = name.toLowerCase();
	return (
		customToolNameToPi?.get(name) ??
		customToolNameToPi?.get(normalized) ??
		SDK_TO_PI_TOOL_NAME[normalized] ??
		(normalized.startsWith(CUSTOM_TOOLS_MCP_PREFIX) ? name.slice(CUSTOM_TOOLS_MCP_PREFIX.length) : name)
	);
}

/** Only a call the model emitted under an exact built-in spelling carries Claude Code's argument shape. */
export function translatesBuiltinArguments(sdkToolName: string): boolean {
	return Object.hasOwn(BUILTIN_TOOL_ALIASES, sdkToolName);
}

type EditEntry = { oldText: unknown; newText: unknown };

function toEditEntry(entry: unknown): EditEntry {
	const input = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
	return {
		oldText: input.old_string ?? input.oldText ?? input.old_text,
		newText: input.new_string ?? input.newText ?? input.new_text,
	};
}

/** Translate Claude Code's built-in-tool inputs into senpi's active tool schemas. */
export function mapToolArgs(
	toolName: string,
	args: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
	const input = args ?? {};
	switch (toolName.toLowerCase()) {
		case "read":
			return { path: input.file_path ?? input.path, offset: input.offset, limit: input.limit };
		case "write":
			return { path: input.file_path ?? input.path, content: input.content };
		case "edit":
			return {
				path: input.file_path ?? input.path,
				edits: Array.isArray(input.edits) ? input.edits.map(toEditEntry) : [toEditEntry(input)],
			};
		case "bash":
			return {
				command: input.command,
				timeout: typeof input.timeout === "number" ? input.timeout / 1_000 : input.timeout,
			};
		case "grep":
			return {
				pattern: input.pattern,
				path: input.path,
				glob: input.glob,
				ignoreCase: input["-i"] ?? input.ignoreCase,
				context: input.context ?? input["-C"],
				limit: input.head_limit ?? input.limit,
			};
		case "glob":
		case "find":
			return { pattern: input.pattern, path: input.path, limit: input.limit };
		default:
			return { ...input };
	}
}

export function resolveSdkTools(context: Context): ResolvedSdkTools {
	const customTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();
	const toolAliases: Record<string, string> = {};
	for (const tool of context.tools ?? []) {
		const customSdkName = `${CUSTOM_TOOLS_MCP_PREFIX}${tool.name}`;
		customTools.push(tool);
		customToolNameToSdk.set(tool.name, customSdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), customSdkName);
		customToolNameToPi.set(customSdkName, tool.name);
		customToolNameToPi.set(customSdkName.toLowerCase(), tool.name);
	}
	for (const [builtinName, candidates] of Object.entries(BUILTIN_TOOL_ALIASES)) {
		const served = candidates.find((candidate) => customToolNameToSdk.has(candidate));
		if (served === undefined) continue;
		const target = customToolNameToSdk.get(served);
		if (target === undefined) continue;
		const piName = customToolNameToPi.get(target);
		if (piName === undefined) continue;
		for (const alias of [builtinName, builtinName.toLowerCase()]) {
			toolAliases[alias] = target;
			customToolNameToPi.set(alias, piName);
		}
	}
	return { customTools, customToolNameToSdk, customToolNameToPi, toolAliases };
}

export const canUseTool: NonNullable<Options["canUseTool"]> = async () => ({
	behavior: "deny",
	message: TOOL_EXECUTION_DENIED_MESSAGE,
});
