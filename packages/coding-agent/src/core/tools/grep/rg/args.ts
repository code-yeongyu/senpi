import { relative } from "node:path";
import type { GrepEngineRequest } from "../engine.ts";
import { argvCost } from "./argv.ts";
import type { Candidate } from "./enumerate.ts";
import { slashPath } from "./paths.ts";
import { MAX_FILE_BYTES } from "./prefix-pass.ts";

export function walkerFlags(request: GrepEngineRequest): string[] {
	const args: string[] = [];
	if (request.hidden ?? true) args.push("--hidden");
	if (!(request.gitignore ?? true)) args.push("--no-ignore");
	else args.push("--no-require-git");
	// The contract makes exclusions win regardless of their position in the request.
	for (const glob of request.glob?.filter((glob) => !glob.startsWith("!")) ?? []) args.push("-g", glob);
	for (const glob of request.glob?.filter((glob) => glob.startsWith("!")) ?? []) args.push("-g", glob);
	if (request.type) args.push("--type", request.type);
	if (request.hidden ?? true) args.push("-g", "!.git");
	return args;
}

export function matcherFlags(request: GrepEngineRequest): string[] {
	// Disable BOM-driven transcoding: the frozen contract searches bytes, not decoded UTF-16.
	const args = ["--json", "--line-number", "--color=never", "--encoding", "none"];
	if (request.ignoreCase) args.push("-i");
	if (request.literal) args.push("-F");
	if (request.multiline) args.push("-U");
	if (request.contextBefore !== undefined) args.push("-B", String(request.contextBefore));
	if (request.contextAfter !== undefined) args.push("-A", String(request.contextAfter));
	if (request.pcre2) args.push("--pcre2");
	if (request.mode === "files") args.push("-m", "1");
	else if (
		(request.mode ?? "content") === "content" &&
		request.maxCountPerFile !== undefined &&
		request.lineStart === undefined &&
		request.lineEnd === undefined
	)
		args.push("-m", String(request.maxCountPerFile + 1));
	return args;
}

/** The per-file argument a segment launch spends on this candidate: the path itself, or an anchored include glob. */
export function candidateArgument(candidate: Candidate): string {
	if (candidate.root.file) return candidate.root.path;
	return `/${slashPath(relative(candidate.root.cwd, candidate.absolute)).replace(/[\\*?[\]{}!]/g, "\\$&")}`;
}

export function argumentCost(candidate: Candidate, platform: NodeJS.Platform = process.platform): number {
	const argument = argvCost(candidateArgument(candidate), platform);
	return candidate.root.file ? argument : argument + argvCost("-g", platform);
}

export function segmentFlags(segment: Candidate[], pattern: string, walk: string[], matcher: string[]): string[] {
	const first = segment[0];
	const limits = ["--sort", "path", "--max-filesize", String(MAX_FILE_BYTES), ...walk];
	// rg searches named files unfiltered, so explicit file roots need no include whitelist.
	if (first.root.file) return [...matcher, ...limits, "--", pattern, ...segment.map(candidateArgument)];
	// Original positive globs would otherwise OR with the include list. Reset file
	// admission, allow traversal, then whitelist precisely the enumerated segment.
	const includes = ["-g", "!**/*", "-g", "**/"];
	for (const candidate of segment) includes.push("-g", candidateArgument(candidate));
	return [...matcher, ...limits, ...includes, "--", pattern, first.root.path];
}
