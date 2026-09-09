import { homedir } from "node:os";
import type { EvalLanguage, EvalRuntimeInfo } from "./types.ts";

const MAX_BADGE_PATH_CODE_POINTS = 40;
const ELLIPSIS = "\u2026";

/**
 * One-line runtime badge for eval headers, e.g. "3.14.7, ~/.venv/bin/python3"
 * or "node 26.7.0, /opt/…/bin/node". The js language always carries the
 * runtime name because node and bun are otherwise indistinguishable.
 */
export function formatRuntimeBadge(language: EvalLanguage, runtime: EvalRuntimeInfo, home: string = homedir()): string {
	const label = language === "js" ? `${runtime.name} ${runtime.version}` : runtime.version;
	if (runtime.path === undefined || runtime.path.length === 0) return label;
	return `${label}, ${minifyPath(runtime.path, home)}`;
}

/** Home-contracts and middle-truncates a path so header badges stay short. */
export function minifyPath(path: string, home: string = homedir()): string {
	const contracted = contractHome(path, home);
	if (codePointLength(contracted) <= MAX_BADGE_PATH_CODE_POINTS) return contracted;
	const separator = contracted.includes("/") ? "/" : "\\";
	const segments = contracted.split(separator).filter((segment) => segment.length > 0);
	const head = contracted.startsWith(separator) ? `${separator}${segments[0] ?? ""}` : (segments[0] ?? "");
	const tail: string[] = [];
	for (let index = segments.length - 1; index >= 1; index -= 1) {
		const attempt = joinTruncated(head, [segments[index] ?? "", ...tail], separator);
		if (codePointLength(attempt) > MAX_BADGE_PATH_CODE_POINTS) break;
		tail.unshift(segments[index] ?? "");
	}
	if (tail.length > 0) return joinTruncated(head, tail, separator);
	const suffix = [...contracted].slice(-(MAX_BADGE_PATH_CODE_POINTS - 1)).join("");
	return `${ELLIPSIS}${suffix}`;
}

function joinTruncated(head: string, tail: readonly string[], separator: string): string {
	return `${head}${separator}${ELLIPSIS}${separator}${tail.join(separator)}`;
}

function contractHome(path: string, home: string): string {
	if (home.length === 0) return path;
	if (path === home) return "~";
	if (path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) return `~${path.slice(home.length)}`;
	return path;
}

function codePointLength(text: string): number {
	return [...text].length;
}
