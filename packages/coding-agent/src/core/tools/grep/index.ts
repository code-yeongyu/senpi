import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { FilesystemPolicyChecker, ToolDefinition } from "../../extensions/types.ts";
import { canonicalizeFilesystemPath } from "../filesystem-policy.ts";
import { resolveToCwd } from "../path-utils.ts";
import { grepRenderers } from "../renderers/grep.ts";
import { wrapToolDefinition } from "../tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, GREP_MAX_LINE_LENGTH, type TruncationResult } from "../truncate.ts";
import type { GrepEngineMatch, GrepEngineRequest, GrepEngineResult } from "./engine.ts";
import { formatGrepText } from "./format.ts";
import { searchPattern } from "./pattern.ts";
import { resolveGrepEngine } from "./select-engine.ts";

const strings = () => Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())]));
const grepSchema = Type.Object({
	pattern: Type.String(),
	path: strings(),
	glob: strings(),
	type: Type.Optional(Type.String()),
	ignoreCase: Type.Optional(Type.Boolean()),
	literal: Type.Optional(Type.Boolean()),
	multiline: Type.Optional(Type.Boolean()),
	context: Type.Optional(Type.Number()),
	before: Type.Optional(Type.Number()),
	after: Type.Optional(Type.Number()),
	mode: Type.Optional(Type.Union([Type.Literal("content"), Type.Literal("count"), Type.Literal("files")])),
	limit: Type.Optional(Type.Number()),
	skip: Type.Optional(Type.Number()),
	timeoutMs: Type.Optional(Type.Number()),
	hidden: Type.Optional(Type.Boolean()),
	gitignore: Type.Optional(Type.Boolean()),
});
export type GrepToolInput = Static<typeof grepSchema>;
export const grepToolSystemPromptContribution = {
	snippet: "Search file contents (regex/literal) across paths with structured results; respects .gitignore",
	guidelines: [
		"Use tool.grep for content search instead of rg/grep in a shell; paginate with skip and narrow with glob/path when a page is full",
	],
};
export interface GrepToolDetails {
	version: 1;
	engine: "native" | "rg";
	status: "ok" | "noMatch" | "pageEnd" | "partial";
	cwd: string;
	paths: string[];
	matches: GrepEngineMatch[];
	fileMatches: Array<{ path: string; count: number | null }>;
	matchCount: number | null;
	fileCount: number;
	skip: number;
	nextSkip: number | null;
	fileLimitReached: boolean;
	perFileLimitReached: boolean;
	totalLimitReached: boolean;
	scan: Omit<GrepEngineResult, "matches" | "fileCounts">;
	truncation?: TruncationResult;
	linesTruncated?: boolean;
}
/** @deprecated No longer honored; removed next release. Use the engine-backed local tool. */
export interface GrepOperations {
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	readFile: (absolutePath: string) => Promise<string> | string;
}
export interface GrepToolOptions {
	filesystemPolicy?: FilesystemPolicyChecker;
}

async function pathStat(path: string) {
	try {
		return await stat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails> {
	if (options && "operations" in options)
		throw new TypeError("GrepToolOptions.operations is deprecated and no longer supported; removed next release");
	return {
		name: "grep",
		label: "grep",
		exposure: "eval",
		description:
			"Search file contents with tool.grep({ pattern, path }) inside eval. Supports regex/literal patterns, file pages with skip, context, count/files modes, and structured results. Respects .gitignore.",
		promptSnippet: grepToolSystemPromptContribution.snippet,
		promptGuidelines: grepToolSystemPromptContribution.guidelines,
		parameters: grepSchema,
		async execute(_id, input, signal, _update, ctx) {
			const started = Date.now();
			if (!input.pattern) throw new Error("Pattern must not be empty");
			const requested = input.path === undefined ? ["."] : Array.isArray(input.path) ? input.path : [input.path];
			if (!requested.length || requested.some((p) => typeof p !== "string" || !p.length))
				throw new Error("path must be a non-empty string or array of non-empty strings");
			const limit = input.limit ?? 100;
			if (!Number.isInteger(input.skip ?? 0) || (input.skip ?? 0) < 0)
				throw new Error("skip must be a non-negative integer");
			if (!Number.isInteger(limit) || limit <= 0) throw new Error("limit must be a positive integer");
			const workingCwd = ctx?.cwd || cwd;
			const paths: string[] = [];
			const missingPaths: string[] = [];
			let lineStart: number | undefined;
			let lineEnd: number | undefined;
			let singleFile = false;
			for (const raw of requested) {
				let path = resolveToCwd(raw, workingCwd);
				let info = await pathStat(path);
				if (!info) {
					const selector = /^(.*):L(\d+)-L?(\d+)$/.exec(path);
					if (selector) {
						const prefix = await pathStat(selector[1]);
						if (prefix?.isFile()) {
							if (requested.length !== 1 || +selector[2] < 1 || +selector[3] < +selector[2])
								throw new Error("Invalid line selector");
							path = selector[1];
							info = prefix;
							lineStart = +selector[2];
							lineEnd = +selector[3];
						}
					}
				}
				const canonicalPath = await canonicalizeFilesystemPath(path);
				if (options?.filesystemPolicy) {
					const decision = await options.filesystemPolicy({
						operation: "enumerate",
						canonicalPath,
						toolName: "grep",
					});
					if (!decision.allow) throw new Error(decision.reason);
				}
				if (!info) {
					missingPaths.push(path);
					continue;
				}
				paths.push(path);
				singleFile = info.isFile();
			}
			if (!paths.length) throw new Error(`Path not found: ${missingPaths.join(", ")}`);
			singleFile = paths.length === 1 && singleFile;
			const skip = singleFile ? 0 : (input.skip ?? 0);
			const mode = input.mode ?? "content";
			const pageSize = Math.min(20, limit);
			const cap = singleFile ? 200 : 20;
			const before = input.before ?? input.context ?? 0;
			const after = input.after ?? input.context ?? 0;
			const request: GrepEngineRequest = {
				pattern: input.pattern,
				paths,
				cwd: workingCwd,
				glob: input.glob === undefined ? undefined : Array.isArray(input.glob) ? input.glob : [input.glob],
				type: input.type,
				ignoreCase: input.ignoreCase,
				literal: input.literal,
				multiline: input.multiline ?? (input.pattern.includes("\n") || input.pattern.includes("\\n")),
				hidden: input.hidden,
				gitignore: input.gitignore,
				contextBefore: before,
				contextAfter: after,
				maxColumns: GREP_MAX_LINE_LENGTH,
				timeoutMs: input.timeoutMs ?? 30000,
				lineStart,
				lineEnd,
				mode,
			};
			let engine = await resolveGrepEngine();
			let preselection: GrepEngineResult | undefined;
			let selected: string[] = [];
			let more = false;
			if (!singleFile) {
				const first = await searchPattern(
					engine,
					{ ...request, mode: "files", maxCount: skip + pageSize + 1 },
					signal,
				);
				engine = first.engine;
				preselection = first.result;
				selected = first.result.fileCounts.slice(skip, skip + pageSize).map((file) => file.path);
				more = first.result.fileCounts.length > skip + selected.length;
			}
			let result: GrepEngineResult;
			if (!singleFile && !selected.length) result = preselection!;
			else if (mode === "files" && preselection)
				result = { ...preselection, fileCounts: preselection.fileCounts.slice(skip, skip + pageSize) };
			else {
				const response = await searchPattern(
					engine,
					{
						...request,
						paths: singleFile ? paths : selected.map((path) => resolve(workingCwd, path)),
						maxCountPerFile: mode === "content" ? cap + 1 : undefined,
						timeoutMs: Math.max(0, (input.timeoutMs ?? 30000) - (Date.now() - started)),
					},
					signal,
				);
				engine = response.engine;
				result = response.result;
			}
			let matches: GrepEngineMatch[] = [];
			let fileMatches: Array<{ path: string; count: number | null }> = [];
			let perFileLimitReached = false;
			let totalLimitReached = false;
			if (mode === "content") {
				const groups = new Map<string, GrepEngineMatch[]>();
				for (const row of result.matches)
					if (!row.isContext) {
						const rows = groups.get(row.path) ?? [];
						rows.push(row);
						groups.set(row.path, rows);
					}
				const admitted = new Set<GrepEngineMatch>();
				for (let round = 0; round < cap && admitted.size < limit; round++) {
					for (const rows of groups.values()) {
						if (rows[round] && admitted.size < limit) admitted.add(rows[round]);
					}
				}
				perFileLimitReached = [...groups.values()].some((rows) => rows.length > cap);
				totalLimitReached =
					[...groups.values()].reduce((n, rows) => n + Math.min(cap, rows.length), 0) > admitted.size;
				// Context belongs only to admitted matches, not to discarded matches from the second phase.
				matches = result.matches.filter(
					(row) =>
						admitted.has(row) ||
						(row.isContext &&
							[...admitted].some(
								(match) =>
									match.path === row.path && row.line >= match.line - before && row.line <= match.line + after,
							)),
				);
				let bytes = 0;
				matches = matches.filter((row) => {
					bytes += Buffer.byteLength(`${row.path}\n${row.line}: ${row.text}\n`);
					if (bytes > DEFAULT_MAX_BYTES - 2048) {
						totalLimitReached = true;
						return false;
					}
					return true;
				});
				const counts = new Map<string, number>();
				for (const row of matches) if (!row.isContext) counts.set(row.path, (counts.get(row.path) ?? 0) + 1);
				matches = matches.filter((row) => counts.has(row.path));
				fileMatches = [...counts].map(([path, count]) => ({ path, count }));
			} else if (singleFile || selected.length)
				fileMatches = result.fileCounts.map(({ path, count }) => ({ path, count }));
			const { matches: _matches, fileCounts: _fileCounts, ...scan } = preselection ?? result;
			scan.missingPaths = missingPaths;
			scan.elapsedMs = Date.now() - started;
			scan.effectivePattern = result.effectivePattern;
			scan.patternKind = result.patternKind;
			scan.regexEngine = result.regexEngine;
			scan.timedOut ||= result.timedOut;
			if (result.timedOut && preselection) scan.warnings = [...scan.warnings, ...result.warnings];
			const partial = scan.timedOut || scan.prefixSearched > 0 || scan.skippedOversized > 0;
			const details: GrepToolDetails = {
				version: 1,
				engine: engine.name,
				status: partial ? "partial" : fileMatches.length ? "ok" : skip ? "pageEnd" : "noMatch",
				cwd: workingCwd,
				paths,
				matches,
				fileMatches,
				matchCount: mode === "files" ? null : fileMatches.reduce((n, file) => n + (file.count ?? 0), 0),
				fileCount: fileMatches.length,
				skip,
				nextSkip: more ? skip + selected.length : null,
				fileLimitReached: more,
				perFileLimitReached,
				totalLimitReached,
				scan,
				linesTruncated: matches.some((row) => row.truncated),
			};
			return { content: [{ type: "text", text: formatGrepText(details) }], details };
		},
		...grepRenderers,
	};
}
export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
