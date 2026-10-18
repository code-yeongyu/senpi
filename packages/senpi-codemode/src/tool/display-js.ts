import { isRecord, parseFile, type SourceNode } from "./display-js-ast.ts";
import { finishLayout } from "./display-js-layout.ts";
import { maskSource, restoreComments, restoreValues } from "./display-js-mask.ts";

// Bun.Transpiler is a transpiler, not a formatter: printed directly it rewrites literals ("a\nb"
// becomes a multi-line template, 0xff becomes 255, emoji become escapes), folds `typeof
// undefined`, and drops comments and directives. It only ever lays out a masked cell here, and the
// original text is substituted back; a cell that cannot be restored exactly is shown as sent.
const INDENT = "  ";

export type JsPrinter = (code: string) => string;

let bunPrinter: JsPrinter | null | undefined;

function resolveBunPrinter(): JsPrinter | null {
	if (typeof process.versions.bun !== "string") return null;
	const bun: unknown = Reflect.get(globalThis, "Bun");
	if (!isRecord(bun) || typeof bun.Transpiler !== "function") return null;
	const transpiler: unknown = Reflect.construct(bun.Transpiler, [
		{ loader: "js", trimUnusedImports: false, deadCodeElimination: false, inline: false },
	]);
	if (!isRecord(transpiler) || typeof transpiler.transformSync !== "function") return null;
	const transformSync = transpiler.transformSync;
	return (code) => {
		const output: unknown = Reflect.apply(transformSync, transpiler, [code]);
		if (typeof output !== "string") throw new TypeError("Bun.Transpiler.transformSync returned a non-string");
		return output;
	};
}

/** The built-in Bun printer when this renderer runs on Bun; null on Node. */
export function bunJsPrinter(): JsPrinter | null {
	if (bunPrinter === undefined) bunPrinter = resolveBunPrinter();
	return bunPrinter;
}

function layout(masked: string, prefix: string, print: JsPrinter): string | undefined {
	try {
		return print(masked).trim();
	} catch {
		// Module syntax only parses unwrapped; the kernel's top-level `return` only inside a function.
	}
	const header = `async function ${prefix}cell() {`;
	let lines: string[];
	try {
		lines = print(`${header}\n${masked}\n}`).trim().split("\n");
	} catch {
		return undefined;
	}
	if (lines[0] !== header || lines.at(-1) !== "}") return undefined;
	return lines
		.slice(1, -1)
		.map((line) => (line.startsWith(INDENT) ? line.slice(INDENT.length) : line))
		.join("\n");
}

function sameTokens(left: string, right: string): boolean {
	const strip = (text: string) => text.replace(/[\s;,()]/gu, "");
	return strip(left) === strip(right);
}

const POSITION_KEYS = new Set([
	"start",
	"end",
	"loc",
	"range",
	"extra",
	"leadingComments",
	"trailingComments",
	"innerComments",
]);

// Positions, raw spellings, and parenthesization flags aside, the preview must be the same program:
// the character guard alone cannot see a dropped `(`, which can change how an expression groups.
function programSignature(file: SourceNode): string {
	return JSON.stringify({ program: file.record.program, comments: file.record.comments }, (key, value: unknown) => {
		if (POSITION_KEYS.has(key)) return undefined;
		if (typeof value === "bigint") return `${value}n`;
		// A stray `;` in a statement list is a no-op the printer drops.
		return Array.isArray(value) ? value.filter((item) => !isRecord(item) || item.type !== "EmptyStatement") : value;
	});
}

function sameProgram(original: SourceNode, preview: string): boolean {
	const reparsed = parseFile(preview);
	return reparsed !== undefined && programSignature(reparsed) === programSignature(original);
}

/** The printer's layout of `code` with its literal, name, and comment text intact, or undefined. */
export function prettifyJs(code: string, print: JsPrinter): string | undefined {
	const file = parseFile(code);
	if (file === undefined) return undefined;
	const mask = maskSource(code, file);
	if (mask === undefined) return undefined;
	const printed = layout(mask.masked, mask.prefix, print);
	const withComments = printed === undefined ? undefined : restoreComments(printed, mask.comments);
	const restored = withComments === undefined ? undefined : restoreValues(withComments, mask);
	const finished = restored === undefined ? undefined : finishLayout(restored);
	return finished !== undefined && sameTokens(finished, code) && sameProgram(file, finished) ? finished : undefined;
}
