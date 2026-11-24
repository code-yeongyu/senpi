// Parse-break warnings for the edit and write results (senpi#7234). A JS, TS or JSON file that parsed before the
// call and does not parse after it gets one advisory block naming the first syntax error; the call still succeeds.
// Worker-safe: the JS/TS parser is injected by the host, JSON.parse is available everywhere.

import { strictJsonErrorOffset } from "./strict-json-offset.ts";
import { lineAndColumn } from "./text-position.ts";

/** Larger files get no verdict, so the check stays cheap: 1 MiB of text, counted in UTF-16 code units. */
const SYNTAX_CHECK_MAX_LENGTH = 1024 * 1024;

export interface SyntaxErrorReport {
	readonly message: string;
	/** 1-based line and column, both present only when the parser reports a position. */
	readonly line?: number;
	readonly column?: number;
}

/** `undefined` means no verdict: unsupported file type, too large, no parser, or a failure that is not a syntax error. */
type SyntaxVerdict = { readonly ok: true } | { readonly ok: false; readonly error: SyntaxErrorReport } | undefined;

export type ScriptLoader = "js" | "jsx" | "ts" | "tsx";

export type ScriptParser = (code: string, loader: ScriptLoader) => SyntaxVerdict;

export interface SyntaxParsers {
	readonly parseScript?: ScriptParser;
}

export interface SyntaxChecker {
	readonly check: (path: string, content: string) => SyntaxVerdict;
	/** The reported error with a position where one can be confirmed; called only once a warning is certain. */
	readonly locate: (path: string, content: string, error: SyntaxErrorReport) => SyntaxErrorReport;
}

/**
 * .mjs and .cjs are plain ECMAScript modules, and TypeScript allows JSX only in .tsx, so .mts and .cts parse as .ts.
 * .js keeps JSX because React toolchains (and Bun) accept JSX in .js files; the limitation is that JSX added to a .js
 * file meant for plain Node gets no warning.
 */
function scriptLoader(extension: string): ScriptLoader | undefined {
	switch (extension) {
		case "mjs":
		case "cjs":
			return "js";
		case "js":
		case "jsx":
			return "jsx";
		case "ts":
		case "mts":
		case "cts":
			return "ts";
		case "tsx":
			return "tsx";
		default:
			return undefined;
	}
}

function extensionOf(path: string): string {
	const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * The offset V8 appends to a JSON.parse message, `... at position N` optionally followed by `(line L column C)`;
 * JSC appends none. Only that suffix counts: elsewhere the message may quote the invalid input itself.
 */
function jsonParseErrorOffset(message: string, contentLength: number): number | undefined {
	const suffix = / at position (\d+)(?: \(line \d+ column \d+\))?$/u.exec(message);
	const offset = suffix ? Number(suffix[1]) : undefined;
	return offset !== undefined && offset <= contentLength ? offset : undefined;
}

function checkJson(content: string): SyntaxVerdict {
	try {
		JSON.parse(content);
		return { ok: true };
	} catch (error) {
		return error instanceof SyntaxError ? { ok: false, error: { message: error.message } } : undefined;
	}
}

/**
 * JSON.parse stays the verdict and the message; the position is the offset where the ECMA-404 grammar stops, added
 * only when that grammar rejects the content too and, where V8 names an offset, it names the same one.
 */
function locateJsonError(content: string, error: SyntaxErrorReport): SyntaxErrorReport {
	const offset = strictJsonErrorOffset(content);
	if (offset === undefined) return error;
	const reported = jsonParseErrorOffset(error.message, content.length);
	if (reported !== undefined && reported !== offset) return error;
	return { message: error.message, ...lineAndColumn(content, offset, false) };
}

export function createSyntaxChecker({ parseScript }: SyntaxParsers = {}): SyntaxChecker {
	return {
		check: (path, content) => {
			if (content.length > SYNTAX_CHECK_MAX_LENGTH) return undefined;
			const extension = extensionOf(path);
			if (extension === "json") return checkJson(content);
			const loader = scriptLoader(extension);
			return loader && parseScript ? parseScript(content, loader) : undefined;
		},
		locate: (path, content, error) => (extensionOf(path) === "json" ? locateJsonError(content, error) : error),
	};
}

function isPosition(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A leading byte order mark is not content: JSON.parse rejects it, editors and most loaders skip it. */
function withoutBom(content: string): string {
	return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

/** The error `after` introduces: it does not parse, and `before` parsed or is a new file. */
function introducedError(
	checkSyntax: SyntaxChecker,
	path: string,
	before: string | undefined,
	after: string,
): SyntaxErrorReport | undefined {
	const afterVerdict = checkSyntax.check(path, after);
	if (afterVerdict === undefined || afterVerdict.ok) return undefined;
	if (before !== undefined && checkSyntax.check(path, before)?.ok !== true) return undefined;
	return checkSyntax.locate(path, after, afterVerdict.error);
}

/** Reads each field of the report once and builds the warning from primitives only. */
function warningText(error: SyntaxErrorReport, created: boolean): string | undefined {
	const message: unknown = error.message;
	const line: unknown = error.line;
	const column: unknown = error.column;
	if (typeof message !== "string") return undefined;
	const at = isPosition(line) && isPosition(column) ? ` at ${line}:${column}` : "";
	const where = `First syntax error${at}: ${message}.`;
	return created
		? `Warning: the written file does not parse. ${where} The file was written; re-read that region and fix it.`
		: `Warning: this file parsed before the edit and does not parse after it. ${where} The edit was applied; re-read that region and fix it.`;
}

/**
 * The warning to append to a successful edit or write result, or `undefined`. `before` is the content before the
 * call, or `undefined` for a newly created file, which counts as having parsed.
 */
export function parseBreakWarning(
	checkSyntax: SyntaxChecker,
	path: string,
	before: string | undefined,
	after: string,
): string | undefined {
	// The file is already written and the warning is advisory: everything that touches checker output, down to
	// reading its fields, stays inside this boundary, so a checker that fails costs the warning, never the result.
	try {
		const error = introducedError(
			checkSyntax,
			path,
			before === undefined ? undefined : withoutBom(before),
			withoutBom(after),
		);
		return error === undefined ? undefined : warningText(error, before === undefined);
	} catch {
		return undefined;
	}
}
