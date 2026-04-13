import { extractPatchedPaths } from "../gpt-apply-patch.js";
import { BashArity } from "../permission-system/arity.js";
import { extractExternalPaths } from "../permission-system/external-dir.js";
import type { Request } from "../permission-system/types.js";

/** Simplified permission request without ID/session metadata */
export type PermissionRequest = Pick<Request, "permission" | "patterns" | "always">;

/** Parser function that extracts permission requests from tool input */
export type ToolPermissionParser = (
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
) => PermissionRequest[];

function fallbackPermissionRequest(permission: string): PermissionRequest {
	return {
		permission,
		patterns: ["*"],
		always: ["*"],
	};
}

function getString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string") {
			return value;
		}
	}
	return undefined;
}

function toParentDirectoryPattern(inputPath: string): string {
	if (inputPath === "~" || inputPath === "$HOME") {
		return `${inputPath}/*`;
	}

	if (inputPath.endsWith("/") || inputPath.endsWith("\\")) {
		return `${inputPath}*`;
	}

	return inputPath.replace(/[\\/][^\\/]+$/, "/*");
}

function parseFilePath(input: Record<string, unknown>): string | undefined {
	return getString(input, "path", "file_path");
}

/** Registry for tool-specific permission parsers */
export class ParserRegistry {
	private readonly parsers = new Map<string, ToolPermissionParser>();

	/** Register a parser for a specific tool */
	register(toolName: string, parser: ToolPermissionParser): void {
		this.parsers.set(toolName, parser);
	}

	/** Parse tool input into permission requests */
	parse(toolName: string, input: Record<string, unknown>, cwd: string): PermissionRequest[] {
		const parser = this.parsers.get(toolName);
		if (!parser) {
			return [fallbackPermissionRequest(toolName)];
		}
		return parser(toolName, input, cwd);
	}
}

/** Create registry with built-in parsers for standard tools */
export function createBuiltinParserRegistry(): ParserRegistry {
	const registry = new ParserRegistry();

	registry.register("bash", (_toolName, input, cwd) => {
		const command = getString(input, "command");
		if (!command) {
			return [fallbackPermissionRequest("bash")];
		}

		const tokens = command.split(/\s+/).filter(Boolean);
		const prefix = BashArity.prefix(tokens).join(" ");
		const always = prefix ? [prefix, `${prefix} *`] : ["*"];
		const requests: PermissionRequest[] = [
			{
				permission: "bash",
				patterns: [prefix || command],
				always,
			},
		];

		const externalPaths = extractExternalPaths(command, cwd);
		if (externalPaths.length > 0) {
			requests.push({
				permission: "external_directory",
				patterns: externalPaths,
				always: externalPaths.map(toParentDirectoryPattern),
			});
		}

		return requests;
	});

	const editParser: ToolPermissionParser = () => {
		return [fallbackPermissionRequest("edit")];
	};

	const parseEditPermission: ToolPermissionParser = (_toolName, input) => {
		const filePath = parseFilePath(input);
		if (filePath) {
			return [
				{
					permission: "edit",
					patterns: [filePath],
					always: [filePath],
				},
			];
		}

		const patchText = getString(input, "input", "patchText");
		if (!patchText) {
			return editParser("edit", input, "");
		}

		const patchedPaths = extractPatchedPaths(patchText);
		if (patchedPaths.length === 0) {
			return editParser("edit", input, "");
		}

		return patchedPaths.map((patchedPath) => ({
			permission: "edit",
			patterns: [patchedPath],
			always: [patchedPath],
		}));
	};

	registry.register("edit", parseEditPermission);
	registry.register("write", parseEditPermission);
	registry.register("apply_patch", parseEditPermission);
	registry.register("multiedit", parseEditPermission);

	registry.register("read", (_toolName, input) => {
		const filePath = parseFilePath(input);
		if (!filePath) {
			return [fallbackPermissionRequest("read")];
		}

		return [
			{
				permission: "read",
				patterns: [filePath],
				always: [filePath],
			},
		];
	});

	registry.register("grep", (_toolName, input) => {
		const searchPath = getString(input, "path");
		const pattern = getString(input, "pattern");
		const permissionPattern = searchPath ?? pattern;
		if (!permissionPattern) {
			return [fallbackPermissionRequest("grep")];
		}

		return [
			{
				permission: "grep",
				patterns: [permissionPattern],
				always: ["*"],
			},
		];
	});

	const listParser: ToolPermissionParser = (_toolName, input) => {
		const searchPath = getString(input, "path") ?? ".";
		return [
			{
				permission: "list",
				patterns: [searchPath],
				always: [searchPath],
			},
		];
	};

	registry.register("find", listParser);
	registry.register("ls", listParser);

	return registry;
}
