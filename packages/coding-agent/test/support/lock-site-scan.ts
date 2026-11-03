/** Keywords after which an expression starts, so a following `/` opens a regex rather than dividing. */
const EXPRESSION_KEYWORDS = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
]);

/**
 * Whether a `/` following `before` opens a regular expression, judged by the previous token as a tokenizer
 * would: an operand (identifier, number, closing bracket, postfix `++`/`--`) is followed by a division.
 */
function regexCanStart(before: string): boolean {
	const code = before.trimEnd();
	const last = code.at(-1);
	if (last === undefined) return true;
	if (last === "+" || last === "-") return !code.endsWith(last + last);
	if (last === ")" || last === "]" || last === "}") return false;
	if (/[\w$]/.test(last)) return EXPRESSION_KEYWORDS.has(code.match(/[\w$]+$/)?.[0] ?? "");
	return true;
}

/** The end index (exclusive) of the regular expression literal that opens at `start`, flags included. */
function regexLiteralEnd(source: string, start: number): number {
	let i = start + 1;
	let inClass = false;
	while (i < source.length && source[i] !== "\n") {
		const char = source[i];
		if (char === "\\") i += 2;
		else {
			if (char === "[") inClass = true;
			else if (char === "]") inClass = false;
			else if (char === "/" && !inClass) break;
			i++;
		}
	}
	i++;
	while (i < source.length && /[a-z]/i.test(source[i] ?? "")) i++;
	return i;
}

/**
 * Blanks comments while keeping string and regular-expression contents, so a module name inside a string
 * is still seen and a `/*` inside a regex is not mistaken for a comment.
 */
export function withoutComments(source: string): string {
	let out = "";
	let i = 0;
	while (i < source.length) {
		const char = source[i];
		const next = source[i + 1];
		if (char === "/" && next !== "/" && next !== "*" && regexCanStart(out)) {
			const end = regexLiteralEnd(source, i);
			out += source.slice(i, end);
			i = end;
		} else if (char === "/" && next === "/") {
			while (i < source.length && source[i] !== "\n") i++;
		} else if (char === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			const skipped = source.slice(i, end === -1 ? source.length : end + 2);
			out += skipped.replace(/[^\n]/g, " ");
			i += skipped.length;
		} else if (char === '"' || char === "'" || char === "`") {
			const start = i++;
			while (i < source.length && source[i] !== char) i += source[i] === "\\" ? 2 : 1;
			out += source.slice(start, ++i);
		} else {
			out += char;
			i++;
		}
	}
	return out;
}

const SYNC_ONLY_IMPORT = /^\s*import\s+(\w+)\s+from\s+["']proper-lockfile["'];?\s*$/m;

/** A lockSync-only file may hold one default import and use it only for the sync calls. */
export function referenceViolations(source: string, lockSyncOnly: boolean): string[] {
	const code = withoutComments(source);
	if (!code.includes("proper-lockfile")) return [];
	if (!lockSyncOnly) return ["references proper-lockfile"];
	const [importLine, binding] = code.match(SYNC_ONLY_IMPORT) ?? [];
	if (!importLine || !binding) return ["lockSync-only file must use one plain default import"];
	const rest = code.replace(importLine, "");
	if (rest.includes("proper-lockfile")) return ["second proper-lockfile reference"];
	const uses = [
		...rest.matchAll(new RegExp(`(?<![\\w.$/-])${binding}\\b(?![-.]\\w*\\.ts)(\\s*\\.\\s*\\w+\\s*\\()?`, "g")),
	];
	return uses
		.filter(([, call]) => !call || !/^\s*\.\s*(lockSync|unlockSync|checkSync)\s*\($/.test(call))
		.map(([use]) => `non-sync use: ${use.trim()}`);
}

/** A tab-indented top-level function or class method header (formatter output: indent 0 or 1). */
const FUNCTION_HEADER =
	/^(\t?)(?:export\s+)?(?:(?:public|private|protected|static|override)\s+)*(?:async\s+)?(?:function\s*\*?\s*)?(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\((?:.*\)\s*(?::.*)?\{|[^)]*)\s*$/;
const NOT_FUNCTIONS = new Set(["if", "for", "while", "switch", "catch", "return", "await", "new", "throw", "void"]);

interface FunctionSpan {
	readonly name: string;
	readonly start: number;
	readonly end: number;
}

export function functionSpans(code: string): FunctionSpan[] {
	const lines = code.split("\n");
	const offsets: number[] = [];
	let offset = 0;
	for (const line of lines) {
		offsets.push(offset);
		offset += line.length + 1;
	}
	const spans: FunctionSpan[] = [];
	lines.forEach((line, index) => {
		const match = line.match(FUNCTION_HEADER);
		const [, indent, name] = match ?? [];
		if (indent === undefined || name === undefined || NOT_FUNCTIONS.has(name)) return;
		const close = lines.findIndex((candidate, after) => after > index && candidate === `${indent}}`);
		spans.push({
			name,
			start: offsets[index] ?? 0,
			end: close === -1 ? code.length : (offsets[close] ?? code.length),
		});
	});
	return spans;
}

/** The text between `openParen` and its matching `)`; parentheses inside string literals do not count. */
export function callArguments(code: string, openParen: number): string {
	let depth = 0;
	for (let i = openParen; i < code.length; i++) {
		const char = code[i];
		if (char === '"' || char === "'" || char === "`") {
			for (i++; i < code.length && code[i] !== char; i += code[i] === "\\" ? 2 : 1);
		} else if (char === "(") depth++;
		else if (char === ")" && --depth === 0) return code.slice(openParen + 1, i);
	}
	return code.slice(openParen + 1);
}

export interface LockedWrite {
	readonly file: string;
	readonly fn: string;
	/** Source text that starts the write; each occurrence needs its own assertHeld() before it. */
	readonly op: string;
}

export interface LockSite {
	readonly reason: string;
	readonly writes: readonly LockedWrite[];
}

const ASSERT_HELD = /\bassertHeld(?:\?\.)?\(/g;

/**
 * Every lockWithLossHandling( call passes onLost, or its call site `<file>#<function>` is listed
 * (one unlisted call per listed site), and every listed write is preceded by its own assertHeld().
 */
export function lockSiteProblems(
	sources: ReadonlyMap<string, string>,
	sites: Readonly<Record<string, LockSite>>,
): string[] {
	const problems: string[] = [];
	const unlistedCalls = new Map<string, number>();
	for (const [file, source] of sources) {
		const code = withoutComments(source);
		const spans = functionSpans(code);
		for (const call of code.matchAll(/\blockWithLossHandling\s*\(/g)) {
			const at = call.index ?? 0;
			if (/\bonLost\b/.test(callArguments(code, at + call[0].length - 1))) continue;
			const enclosing = spans.filter((span) => span.start <= at && at < span.end).at(-1)?.name ?? "<module>";
			const site = `${file}#${enclosing}`;
			unlistedCalls.set(site, (unlistedCalls.get(site) ?? 0) + 1);
		}
	}
	for (const [site, count] of unlistedCalls) {
		if (!(site in sites)) problems.push(`${site}: lock call without onLost is not an allowlisted site`);
		else if (count > 1) problems.push(`${site}: ${count} lock calls without onLost share one allowlisted site`);
	}
	for (const [site, { writes }] of Object.entries(sites)) {
		if (!unlistedCalls.has(site)) problems.push(`${site}: allowlisted site has no lock call without onLost`);
		for (const write of writes) problems.push(...writeProblems(site, write, sources, writes));
	}
	return problems;
}

function writeProblems(
	site: string,
	write: LockedWrite,
	sources: ReadonlyMap<string, string>,
	siteWrites: readonly LockedWrite[],
): string[] {
	const label = `${site} -> ${write.file}#${write.fn} ${write.op}`;
	const source = sources.get(write.file);
	if (source === undefined) return [`${label}: file not found`];
	const code = withoutComments(source);
	const span = functionSpans(code).find((candidate) => candidate.name === write.fn);
	if (span === undefined) return [`${label}: function not found`];
	const body = code.slice(span.start, span.end);
	const sameFunctionOps = siteWrites.filter((other) => other.file === write.file && other.fn === write.fn);
	const tokens = [
		...[...body.matchAll(ASSERT_HELD)].map((match) => ({ at: match.index ?? 0, assert: true })),
		...sameFunctionOps.flatMap((other) =>
			[...body.matchAll(new RegExp(escapeRegExp(other.op), "g"))].map((match) => ({
				at: match.index ?? 0,
				assert: false,
			})),
		),
	].sort((a, b) => a.at - b.at);
	const occurrences = [...body.matchAll(new RegExp(escapeRegExp(write.op), "g"))].map((match) => match.index ?? 0);
	if (occurrences.length === 0) return [`${label}: write not found`];
	return occurrences
		.filter((at) => tokens.filter((token) => token.at < at).at(-1)?.assert !== true)
		.map(() => `${label}: write without its own assertHeld() before it`);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The modules a vendored file may import: the node built-ins it uses today plus proper-lockfile. A new
 * built-in is added here on purpose; `node:module` and `node:vm` stay out because they can load any file.
 */
const VENDORED_ALLOWED_MODULES = new Set([
	"node:crypto",
	"node:fs",
	"node:fs/promises",
	"node:os",
	"node:path",
	"node:timers/promises",
	"proper-lockfile",
]);
/** Ways to load a module without an import or require of a literal specifier. */
const MODULE_LOADER =
	/\b(?:createRequire|getBuiltinModule|dlopen)\b|\bprocess\s*\.\s*binding\b|\bmodule\s*\.\s*require\b/;
/** An `onCompromised` value that is a function or a named handler; `undefined` and `null` restore the throwing default. */
const OWN_ON_COMPROMISED =
	/\bonCompromised\s*:\s*(?!(?:undefined|null|void)\b)(?:\(|async\b|function\b|[A-Za-z_$][\w$]*\s*[,}\n])/;
const DEFAULT_LOCKFILE_IMPORT = /^\s*import\s+(\w+)\s+from\s+["']proper-lockfile["'];?\s*$/m;

/** A spread after `onCompromised` can replace it (later keys win); one before it, or `...` inside a string, cannot. */
function spreadsAfterOnCompromised(args: string): boolean {
	const code = args.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
	const handler = code.search(/\bonCompromised\s*:/);
	return handler !== -1 && code.slice(handler).includes("...");
}

/**
 * A file vendored byte-for-byte into another repository may import only node built-ins and proper-lockfile,
 * through exactly one plain default import, and may use that import only as `<binding>.lock(` calls that
 * each pass their own `onCompromised` (the default one throws from a heartbeat timer).
 */
export function vendoredSelfContainedViolations(source: string): string[] {
	const code = withoutComments(source);
	const problems: string[] = [];
	const specifiers = [
		...code.matchAll(/\b(?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["']/g),
		...code.matchAll(/\bimport\s*["']([^"']+)["']/g),
		...code.matchAll(/\b(?:require|import)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g),
	].map(([, specifier]) => specifier ?? "");
	for (const specifier of specifiers)
		if (!VENDORED_ALLOWED_MODULES.has(specifier)) problems.push(`imports ${specifier}`);
	if (/\b(?:require|import)\s*\(\s*(?:[^"'`\s)]|`[^`]*\$\{)/.test(code))
		problems.push("dynamic import or require of a computed module");
	const loader = code.match(MODULE_LOADER);
	if (loader) problems.push(`loads modules through ${loader[0].replace(/\s+/g, "")}`);
	const [importLine, binding] = code.match(DEFAULT_LOCKFILE_IMPORT) ?? [];
	const references = code.match(/["']proper-lockfile["']/g)?.length ?? 0;
	if (!importLine || !binding || references !== 1) {
		problems.push("needs exactly one plain default import of proper-lockfile");
		return problems;
	}
	const rest = code.replace(importLine, "");
	let lockCalls = 0;
	for (const use of rest.matchAll(new RegExp(`(?<![\\w.$])${binding}\\b(\\s*\\.\\s*(\\w+)\\s*\\()?`, "g"))) {
		const [whole, call, method] = use;
		if (!call || method !== "lock") {
			problems.push(`uses ${binding} other than as ${binding}.lock(: ${whole.trim()}`);
			continue;
		}
		lockCalls++;
		const args = callArguments(rest, (use.index ?? 0) + whole.length - 1);
		if (!OWN_ON_COMPROMISED.test(args)) problems.push(`${binding}.lock( without its own onCompromised`);
		else if (spreadsAfterOnCompromised(args))
			problems.push(`${binding}.lock( spreads options that can replace onCompromised`);
	}
	if (lockCalls === 0) problems.push(`no ${binding}.lock( call`);
	return problems;
}
