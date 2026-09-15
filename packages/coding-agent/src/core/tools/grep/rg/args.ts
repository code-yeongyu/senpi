import { relative } from "node:path";
import type { GrepEngineRequest } from "../engine.ts";
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

export function segmentFlags(segment: Candidate[], pattern: string, walk: string[], matcher: string[]): string[] {
	const first = segment[0];
	// Original positive globs would otherwise OR with the include list. Reset file
	// admission, allow traversal, then whitelist precisely the enumerated segment.
	const includes = ["-g", "!**/*", "-g", "**/"];
	for (const candidate of segment)
		includes.push(
			"-g",
			`/${slashPath(relative(first.root.cwd, candidate.absolute)).replace(/[\\*?[\]{}!]/g, "\\$&")}`,
		);
	return [
		...matcher,
		"--sort",
		"path",
		"--max-filesize",
		String(MAX_FILE_BYTES),
		...walk,
		...includes,
		"--",
		pattern,
		first.root.path,
	];
}
