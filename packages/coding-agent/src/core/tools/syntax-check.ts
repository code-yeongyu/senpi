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

/** Finds the first strict-JSON error with its position, for a runtime whose JSON.parse message carries none. */
export type JsonErrorLocator = (content: string) => Promise<SyntaxErrorReport | undefined>;

export interface SyntaxParsers {
	readonly parseScript?: ScriptParser;
	readonly locateJsonError?: JsonErrorLocator;
}

export interface SyntaxChecker {
	readonly check: (path: string, content: string) => SyntaxVerdict;
	/** The reported error with a position where one can be found; called only once a warning is certain. */
	readonly locate: (path: string, content: string, error: SyntaxErrorReport) => Promise<SyntaxErrorReport>;
}

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

export function createSyntaxChecker({ parseScript, locateJsonError }: SyntaxParsers = {}): SyntaxChecker {
	return {
		check: (path, content) => {
			if (content.length > SYNTAX_CHECK_MAX_LENGTH) return undefined;
			const extension = extensionOf(path);
			if (extension === "json") return checkJson(content);
			const loader = scriptLoader(extension);
			return loader && parseScript ? parseScript(content, loader) : undefined;
		},
		// JSON.parse stays the verdict; the locator only adds a position. When it finds no error (it is more lenient
		// than JSON.parse on some inputs), the error is reported without one.
		locate: async (path, content, error) => {
			if (error.line !== undefined || locateJsonError === undefined || extensionOf(path) !== "json") return error;
			return (await locateJsonError(content)) ?? error;
		},
	};
}

function errorLocation(error: SyntaxErrorReport): string {
	return error.line !== undefined && error.column !== undefined ? ` at ${error.line}:${error.column}` : "";
}

/**
 * The warning to append to a successful edit or write result, or `undefined`. `before` is the content before the
 * call, or `undefined` for a newly created file, which counts as having parsed.
 */
export async function parseBreakWarning(
	checkSyntax: SyntaxChecker,
	path: string,
	before: string | undefined,
	after: string,
): Promise<string | undefined> {
	const afterVerdict = checkSyntax.check(path, after);
	if (afterVerdict === undefined || afterVerdict.ok) return undefined;
	if (before !== undefined && checkSyntax.check(path, before)?.ok !== true) return undefined;
	const error = await checkSyntax.locate(path, after, afterVerdict.error);
	const where = `First syntax error${errorLocation(error)}: ${error.message}.`;
	if (before === undefined) {
		return `Warning: the written file does not parse. ${where} The file was written; re-read that region and fix it.`;
	}
	return `Warning: this file parsed before the edit and does not parse after it. ${where} The edit was applied; re-read that region and fix it.`;
}
