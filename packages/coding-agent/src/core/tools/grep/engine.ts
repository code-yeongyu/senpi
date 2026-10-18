// Frozen engine contract
export type GrepMode = "content" | "count" | "files";
export interface GrepEngineRequest {
	pattern: string; // required, non-empty (whitespace-only is a valid pattern)
	paths: string[]; // required, >= 1 absolute path (files or directories); no globs inside
	cwd: string; // for display-relative paths
	glob?: string[]; // positive globs OR-ed; entries starting with "!" exclude and win; slashless = basename match
	type?: string; // ripgrep type name via ignore::types defaults; unknown -> UNKNOWN_TYPE
	ignoreCase?: boolean; // default false
	literal?: boolean; // default false (fixed-string search)
	multiline?: boolean; // engines treat undefined as false; the FACADE resolves the default (true iff pattern contains an LF or the two-char regex escape \n) and always passes an explicit boolean
	hidden?: boolean; // default true (".git" is always skipped)
	gitignore?: boolean; // default true (.gitignore + .ignore + global excludes; false disables all three)
	maxCount?: number; // total matching lines (content) / matching files (files); undefined = unlimited
	maxCountPerFile?: number; // per-file matching lines; undefined = unlimited
	contextBefore?: number; // default 0
	contextAfter?: number; // default 0
	maxColumns?: number; // truncate display text after N Unicode scalars (+ "..."); matching happens before truncation
	mode?: GrepMode; // default "content"
	timeoutMs?: number; // default 30000; cooperative
	lineStart?: number; // 1-based inclusive; only valid with exactly one file path
	lineEnd?: number;
	pcre2?: boolean; // rg-engine only; native rejects with UNSUPPORTED_REGEX when true
}
export interface GrepEngineMatch {
	path: string;
	line: number;
	column?: number;
	text: string;
	isContext: boolean;
	truncated: boolean;
} // column = 1-based byte column of the first submatch on the FIRST physical line of a match only; later lines of a multiline match and context rows carry column undefined
export interface GrepEngineFileCount {
	path: string;
	count: number | null;
	limitReached: boolean;
}
export interface GrepEngineWarning {
	path?: string;
	code: string;
	message: string;
}
export interface GrepEngineResult {
	matches: GrepEngineMatch[]; // content mode only; sorted by (path bytes, line, column); context rows deduped, match wins
	fileCounts: GrepEngineFileCount[]; // count/files modes (count null in files mode); sorted by path bytes
	counts: { matches: number | null; files: number; exact: boolean }; // admitted results; exact=false when a cap/timeout truncated
	filesSearched: number;
	limitReached: boolean;
	perFileLimitReached: boolean;
	skippedOversized: number;
	prefixSearched: number;
	skippedBinary: number;
	missingPaths: string[]; // ENOENT roots (only when at least one root existed)
	warnings: GrepEngineWarning[];
	timedOut: boolean;
	elapsedMs: number;
	effectivePattern: string;
	patternKind: "regex" | "sanitized" | "literal";
	regexEngine: "rust" | "pcre2";
}
export type GrepEngineErrorCode =
	| "UNSUPPORTED_REGEX"
	| "INVALID_PATTERN"
	| "INVALID_GLOB"
	| "UNKNOWN_TYPE"
	| "PATH_NOT_FOUND"
	| "ABORTED"
	| "ENGINE_UNAVAILABLE";
export class GrepEngineError extends Error {
	readonly code: GrepEngineErrorCode;

	constructor(code: GrepEngineErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}
export interface GrepEngine {
	readonly name: "native" | "rg";
	search(request: GrepEngineRequest, signal?: AbortSignal): Promise<GrepEngineResult>;
}
