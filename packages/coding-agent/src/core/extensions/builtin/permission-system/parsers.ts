import { dirname, resolve } from "node:path";
import { realpathWithoutOpen } from "../../../../utils/paths.ts";
import type { ToolInfo } from "../../types.ts";
import { extractPatchedPaths } from "../gpt-apply-patch/index.ts";
import { BashArity } from "../permission-system/arity.ts";
import { analyzeBashCommand, bestEffortCommandLines } from "../permission-system/bash-command-segments.ts";
import {
	type AlwaysScope,
	extractExternalPaths,
	isExternalPath,
	toParentDirectoryPattern,
} from "../permission-system/external-dir.ts";
import type { Request } from "../permission-system/types.ts";
import { setApprovedMonitorParent } from "../terminal/monitor-permission.ts";
import { urlOriginAlias, widerAlwaysScope } from "./always-scope.ts";
import { parseReadPermission } from "./read-permission.ts";

/** Simplified permission request without ID/session metadata */
export type PermissionRequest = Pick<Request, "permission" | "patterns" | "always" | "widerAlways"> & {
	readonly autoApproveAsk?: true;
	readonly ruleAliases?: readonly string[];
};

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

/**
 * An unregistered tool has no declared parser. Falling back to a bare `*` target would let a
 * pattern-specific configured deny miss the call entirely (an unregistered tool's decision widens
 * to the preset, not to its actual arg), so the fallback derives the target from the tool's
 * meaningful arg — path, command, url, or input — and keeps `*` only for a truly arg-less call.
 */
function fallbackPermissionRequestFor(toolName: string, input: Record<string, unknown>): PermissionRequest {
	const found = getStringEntry(input, "path", "file_path", "command", "url", "input", "pattern", "filePath");
	if (found === undefined) return fallbackPermissionRequest(toolName);
	const [argKey, arg] = found;
	// A bare `*` alongside the concrete arg would still match an ask/all rule and widen past a
	// pattern-specific deny, so the concrete arg is the only target; `*` is the arg-less fallback.
	// "Allow always" keeps the exact arg; a wider scope is a separate, labelled choice (senpi#3403).
	const widerAlways = widerAlwaysScope(toolName, argKey, arg);
	// A URL is also matched as its canonical origin, so a domain grant (a literal origin) applies to
	// every spelling of that origin; rules on the raw URL, a deny included, still match the raw URL.
	const originAlias = argKey === "url" ? urlOriginAlias(arg) : undefined;
	return {
		permission: toolName,
		patterns: [arg],
		always: [arg],
		...(originAlias === undefined ? {} : { ruleAliases: [arg, originAlias] }),
		...(widerAlways ? { widerAlways } : {}),
	};
}

function getStringEntry(input: Record<string, unknown>, ...keys: string[]): [string, string] | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string") return [key, value];
	}
	return undefined;
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

function parseFilePath(input: Record<string, unknown>): string | undefined {
	return getString(input, "path", "file_path");
}

function withExternalDirectoryRequests(
	requests: PermissionRequest[],
	paths: string[],
	cwd: string,
	scope: AlwaysScope,
): PermissionRequest[] {
	const externalPaths = paths.filter((inputPath) => isExternalPath(inputPath, cwd));
	if (externalPaths.length === 0) {
		return requests;
	}

	return [
		...requests,
		{
			permission: "external_directory",
			patterns: externalPaths,
			always: externalPaths.map((externalPath) => toParentDirectoryPattern(externalPath, scope)),
		},
	];
}

const uniq = (values: readonly string[]): string[] => [...new Set(values)];

/**
 * The targets an "Allow always" answer may store. Stored rules are matched as globs, so a target holding
 * its own `*` or `?` would be remembered as a wildcard that matches other commands; such a target is
 * allowed once and never stored. Request patterns stay raw, so existing rules match exactly as before.
 */
const rememberable = (targets: readonly string[]): string[] => targets.filter((target) => !/[*?]/.test(target));

/** Marks a bash request target that no command-specific rule can match: only a `*` rule decides it. */
export const UNPARSED_BASH_PREFIX = "(unparsed) ";

/**
 * The `bash` requests for one command. Every simple command it runs is decided, so the call is as
 * strict as its strictest command: one pattern per command (its arity prefix), all of which must be
 * allowed, and "Allow always" stores exactly those prefixes. A command the lexer cannot parse is one
 * target only a `*` rule (a preset, a blanket setting) can decide, so no grant for one command can
 * allow it; its plain words are still checked against deny rules.
 */
function bashCommandRequests(command: string): PermissionRequest[] {
	const analysis = analyzeBashCommand(command);
	if (analysis.kind === "unparsed") {
		const target = `${UNPARSED_BASH_PREFIX}${command}`;
		const candidates = uniq(
			bestEffortCommandLines(command)
				.map((words) => BashArity.prefix(words).join(" "))
				.filter(Boolean),
		);
		// The deny-only check runs first, so a denied call is refused before anyone is asked.
		return [
			...(candidates.length === 0
				? []
				: [{ permission: "bash", patterns: candidates, always: [], autoApproveAsk: true as const }]),
			{ permission: "bash", patterns: [target], always: rememberable([target]) },
		];
	}
	const prefixes = uniq(analysis.segments.map((words) => BashArity.prefix([...words]).join(" ")).filter(Boolean));
	if (prefixes.length === 0) return [{ permission: "bash", patterns: [command], always: rememberable([command]) }];
	return [
		{
			permission: "bash",
			patterns: prefixes,
			always: rememberable(prefixes).flatMap((prefix) => [prefix, `${prefix} *`]),
		},
	];
}

/** The `eval` class a cell carries on its own, used when its tool-owned parser names anything narrower. */
export function fallbackEvalPermissionRequest(): PermissionRequest {
	return { permission: "eval", patterns: ["*"], always: ["*"] };
}

/**
 * The permission requests for one call: the builtin registry's answer, or the tool's own parser
 * when the builtin registry does not own it. An `eval` call is arbitrary code, so its tool's own
 * parser can never speak for everything the cell does: the `eval` request is always carried
 * alongside, and a narrower answer (for example `read`) can never approve it (senpi#3211).
 */
export function permissionRequestsFor(
	getTools: () => readonly ToolInfo[],
	registry: ParserRegistry,
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): PermissionRequest[] {
	const requests = registry.has(toolName)
		? registry.parse(toolName, input, cwd)
		: (toolOwnedPermissionRequests(getTools(), toolName, input, cwd) ?? registry.parse(toolName, input, cwd));
	if (toolName === "eval" && !requests.some((request) => request.permission === "eval")) {
		return [...requests, fallbackEvalPermissionRequest()];
	}
	return requests;
}

/** The requests a tool's own `permissionParser` derives from this call, or undefined when the tool declares none. */
export function toolOwnedPermissionRequests(
	tools: readonly ToolInfo[],
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): PermissionRequest[] | undefined {
	const parser = tools.find((tool) => tool.name === toolName)?.permissionParser;
	return parser?.(input, cwd).map((request) => ({
		permission: request.permission,
		patterns: [...request.patterns],
		always: [...request.always],
	}));
}

/** Registry for tool-specific permission parsers */
export class ParserRegistry {
	private readonly parsers = new Map<string, ToolPermissionParser>();

	/** Register a parser for a specific tool */
	register(toolName: string, parser: ToolPermissionParser): void {
		this.parsers.set(toolName, parser);
	}

	/** Whether a built-in parser owns this tool */
	has(toolName: string): boolean {
		return this.parsers.has(toolName);
	}

	/** Parse tool input into permission requests */
	parse(toolName: string, input: Record<string, unknown>, cwd: string): PermissionRequest[] {
		const parser = this.parsers.get(toolName);
		if (!parser) {
			return [fallbackPermissionRequestFor(toolName, input)];
		}
		return parser(toolName, input, cwd);
	}
}

/** Create registry with built-in parsers for standard tools */
export function createBuiltinParserRegistry(): ParserRegistry {
	const registry = new ParserRegistry();

	// bash_input writes arbitrary stdin to a live shell session = arbitrary command execution,
	// so it MUST be gated in the SAME `bash` permission class (via the `input` field), else
	// read-only/ask presets would be bypassable through a persistent session. The steering/read
	// tools (bash_output/kill_bash/bash_resize) fall back to their own tool-named permissions.
	const parseBashLikePermission =
		(commandKey: string): ToolPermissionParser =>
		(_toolName, input, cwd) => {
			const command = getString(input, commandKey);
			if (!command) {
				return [fallbackPermissionRequest("bash")];
			}

			const requests = bashCommandRequests(command);
			const externalPaths = extractExternalPaths(command, cwd);
			if (externalPaths.length > 0) {
				requests.push({
					permission: "external_directory",
					patterns: externalPaths,
					always: externalPaths.map((externalPath) => toParentDirectoryPattern(externalPath, "file")),
				});
			}

			return requests;
		};

	registry.register("bash", parseBashLikePermission("command"));
	registry.register("bash_input", parseBashLikePermission("input"));
	registry.register("monitor", (toolName, input, cwd) => {
		const path = getString(input, "path");
		if (path) {
			// This runs on the host main thread: the parent identity must be derived without open(2)
			// (realpath opens directories and blocks forever on a wedged autofs trigger). Registration
			// performs the authoritative access check and re-derives the parent the same way.
			setApprovedMonitorParent(input, realpathWithoutOpen(dirname(resolve(cwd, path))));
			return withExternalDirectoryRequests(
				[{ permission: "read", patterns: [path], always: [path] }],
				[path],
				cwd,
				"file",
			);
		}
		return parseBashLikePermission("command")(toolName, input, cwd);
	});

	const editParser: ToolPermissionParser = () => {
		return [fallbackPermissionRequest("edit")];
	};

	const parseEditPermission: ToolPermissionParser = (_toolName, input, cwd) => {
		const filePath = parseFilePath(input);
		if (filePath) {
			return withExternalDirectoryRequests(
				[
					{
						permission: "edit",
						patterns: [filePath],
						always: [filePath],
					},
				],
				[filePath],
				cwd,
				"file",
			);
		}

		const patchText = getString(input, "input", "patchText");
		if (!patchText) {
			return editParser("edit", input, "");
		}

		const patchedPaths = extractPatchedPaths(patchText);
		if (patchedPaths.length === 0) {
			return editParser("edit", input, "");
		}

		const editRequests = patchedPaths.map((patchedPath) => ({
			permission: "edit",
			patterns: [patchedPath],
			always: [patchedPath],
		}));

		return withExternalDirectoryRequests(editRequests, patchedPaths, cwd, "file");
	};

	registry.register("edit", parseEditPermission);
	registry.register("write", parseEditPermission);
	registry.register("apply_patch", parseEditPermission);
	registry.register("multiedit", parseEditPermission);

	registry.register("read", parseReadPermission);

	registry.register("grep", (_toolName, input, cwd) => {
		const searchPath = getString(input, "path");
		const pattern = getString(input, "pattern");
		const permissionPattern = searchPath ?? pattern;
		if (!permissionPattern) {
			return [fallbackPermissionRequest("grep")];
		}

		const grepRequests: PermissionRequest[] = [
			{
				permission: "grep",
				patterns: [permissionPattern],
				always: ["*"],
			},
		];
		return searchPath ? withExternalDirectoryRequests(grepRequests, [searchPath], cwd, "directory") : grepRequests;
	});

	const listParser: ToolPermissionParser = (_toolName, input, cwd) => {
		const searchPath = getString(input, "path") ?? ".";
		return withExternalDirectoryRequests(
			[
				{
					permission: "list",
					patterns: [searchPath],
					always: [searchPath],
				},
			],
			[searchPath],
			cwd,
			"directory",
		);
	};

	registry.register("find", listParser);
	registry.register("glob", listParser);
	registry.register("ls", listParser);

	return registry;
}
