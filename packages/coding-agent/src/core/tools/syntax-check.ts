// Parse-break warnings for the edit and write results (senpi#7234). A JS, TS or JSON file that parsed before the
// call and does not parse after it gets one advisory block naming the first syntax error; the call still succeeds.
// Worker-safe: the JS/TS parser is injected by the host, JSON.parse is available everywhere.

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

export type ScriptLoader = "jsx" | "ts" | "tsx";

export type ScriptParser = (code: string, loader: ScriptLoader) => SyntaxVerdict;

export type SyntaxChecker = (path: string, content: string) => SyntaxVerdict;

function scriptLoader(extension: string): ScriptLoader | undefined {
	switch (extension) {
		case "js":
		case "jsx":
		case "mjs":
		case "cjs":
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

/** The position in a JSON.parse message, which V8 reports as `(line N column M)` or `at position N`; Bun reports none. */
function jsonErrorPosition(message: string, content: string): { line: number; column: number } | undefined {
	const lineColumn = /\(line (\d+) column (\d+)\)/u.exec(message);
	if (lineColumn) return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
	const offsetMatch = /at position (\d+)/u.exec(message);
	if (!offsetMatch) return undefined;
	const before = content.slice(0, Number(offsetMatch[1]));
	const lastNewline = before.lastIndexOf("\n");
	return { line: before.split("\n").length, column: before.length - lastNewline };
}

function checkJson(content: string): SyntaxVerdict {
	try {
		JSON.parse(content);
		return { ok: true };
	} catch (error) {
		if (!(error instanceof SyntaxError)) return undefined;
		return { ok: false, error: { message: error.message, ...jsonErrorPosition(error.message, content) } };
	}
}

export function createSyntaxChecker(parseScript?: ScriptParser): SyntaxChecker {
	return (path, content) => {
		if (content.length > SYNTAX_CHECK_MAX_LENGTH) return undefined;
		const extension = extensionOf(path);
		if (extension === "json") return checkJson(content);
		const loader = scriptLoader(extension);
		return loader && parseScript ? parseScript(content, loader) : undefined;
	};
}

function errorLocation(error: SyntaxErrorReport): string {
	return error.line !== undefined && error.column !== undefined ? ` at ${error.line}:${error.column}` : "";
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
	const afterVerdict = checkSyntax(path, after);
	if (afterVerdict === undefined || afterVerdict.ok) return undefined;
	const where = `First syntax error${errorLocation(afterVerdict.error)}: ${afterVerdict.error.message}.`;
	if (before === undefined) {
		return `Warning: the written file does not parse. ${where} The file was written; re-read that region and fix it.`;
	}
	if (checkSyntax(path, before)?.ok !== true) return undefined;
	return `Warning: this file parsed before the edit and does not parse after it. ${where} The edit was applied; re-read that region and fix it.`;
}
