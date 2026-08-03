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

export const PI_TO_SDK_TOOL_NAME: Readonly<Record<string, string>> = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	bash: "Bash",
	grep: "Grep",
	find: "Glob",
	glob: "Glob",
};

export const HOST_TOOL_POLICY_FINGERPRINT = "host-tool-denial-v1";

export const BUILTIN_SDK_TOOLS = ["Read", "Write", "Edit", "Bash", "Grep", "Glob"] as const;
export const TOOL_EXECUTION_DENIED_MESSAGE = "Tool execution is unavailable in this environment.";
export const HOST_TOOL_EXECUTION_DENIED_MESSAGE =
	"This tool call is captured and executed by the host. Do not retry with other tools; end the turn.";
export const CUSTOM_TOOLS_MCP_SERVER_NAME = "custom-tools";
export const CUSTOM_TOOLS_MCP_PREFIX = `mcp__${CUSTOM_TOOLS_MCP_SERVER_NAME}__`;
export const HOST_CAPTURED_SDK_TOOL_MATCHER = "Bash|Write|Edit|Read|Grep|Glob|mcp__custom-tools__.*";
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
	sdkTools: string[];
	customTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
};

function pascalCase(value: string): string {
	return value
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean)
		.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
		.join("");
}

export function mapPiToolNameToSdk(name: string, customToolNameToSdk?: ReadonlyMap<string, string>): string {
	const normalized = name.toLowerCase();
	return (
		customToolNameToSdk?.get(name) ??
		customToolNameToSdk?.get(normalized) ??
		PI_TO_SDK_TOOL_NAME[normalized] ??
		pascalCase(name)
	);
}

export function mapSdkToolNameToPi(name: string, customToolNameToPi?: ReadonlyMap<string, string>): string {
	const normalized = name.toLowerCase();
	return (
		SDK_TO_PI_TOOL_NAME[normalized] ??
		customToolNameToPi?.get(name) ??
		customToolNameToPi?.get(normalized) ??
		(normalized.startsWith(CUSTOM_TOOLS_MCP_PREFIX) ? name.slice(CUSTOM_TOOLS_MCP_PREFIX.length) : name)
	);
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
				edits: Array.isArray(input.edits)
					? input.edits
					: [
							{
								oldText: input.old_string ?? input.oldText ?? input.old_text,
								newText: input.new_string ?? input.newText ?? input.new_text,
							},
						],
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
	if (!context.tools) {
		return {
			sdkTools: [...BUILTIN_SDK_TOOLS],
			customTools: [],
			customToolNameToSdk: new Map(),
			customToolNameToPi: new Map(),
		};
	}

	const sdkTools = new Set<string>();
	const customTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();
	for (const tool of context.tools) {
		const normalized = tool.name.toLowerCase();
		const sdkName = PI_TO_SDK_TOOL_NAME[normalized];
		if (sdkName) {
			sdkTools.add(sdkName);
			continue;
		}
		const customSdkName = `${CUSTOM_TOOLS_MCP_PREFIX}${tool.name}`;
		customTools.push(tool);
		customToolNameToSdk.set(tool.name, customSdkName);
		customToolNameToSdk.set(normalized, customSdkName);
		customToolNameToPi.set(customSdkName, tool.name);
		customToolNameToPi.set(customSdkName.toLowerCase(), tool.name);
	}
	return { sdkTools: [...sdkTools], customTools, customToolNameToSdk, customToolNameToPi };
}

export const canUseTool: NonNullable<Options["canUseTool"]> = async () => ({
	behavior: "deny",
	message: TOOL_EXECUTION_DENIED_MESSAGE,
});
