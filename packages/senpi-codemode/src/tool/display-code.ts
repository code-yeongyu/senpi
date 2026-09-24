import { parse } from "@babel/parser";
import type { EvalLanguage } from "./types.ts";

// Display-only: models often send a JS cell as one long line of joined statements. The preview
// breaks it at statement, block, and long-array boundaries and keeps every source token and
// comment verbatim. The tool arguments are never touched (senpi#1472).
const DENSE_LINE_LENGTH = 100;
const ARRAY_BREAK_LENGTH = 60;
const INDENT = "  ";
const CACHE_LIMIT = 64;

type SourceNode = { readonly type: string; readonly start: number; readonly end: number };

// A whitespace/comma/comment region between two tokens that becomes a line break.
type Gap = {
	readonly start: number;
	readonly end: number;
	readonly contentDepth: number;
	readonly nextDepth: number;
};

const cache = new Map<string, string>();

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourceNode(value: unknown): SourceNode | undefined {
	if (!isRecord(value)) return undefined;
	const { type, start, end } = value;
	if (typeof type !== "string" || typeof start !== "number" || typeof end !== "number") return undefined;
	return { type, start, end };
}

function sourceNodes(value: unknown): SourceNode[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => sourceNode(item) ?? []);
}

function isDense(code: string): boolean {
	return code.split("\n").some((line) => line.length > DENSE_LINE_LENGTH);
}

function parseProgram(code: string): unknown {
	try {
		return parse(code, {
			sourceType: "module",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
			allowImportExportEverywhere: true,
		}).program;
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function siblingGaps(children: readonly SourceNode[], depth: number): Gap[] {
	return children.slice(1).map((child, index) => ({
		start: children[index]?.end ?? child.start,
		end: child.start,
		contentDepth: depth,
		nextDepth: depth,
	}));
}

// Gaps for a bracketed container whose children move onto their own indented lines.
function containerGaps(container: SourceNode, children: readonly SourceNode[], depth: number): Gap[] {
	const first = children[0];
	const last = children.at(-1);
	if (first === undefined || last === undefined) return [];
	const inner = depth + 1;
	return [
		{ start: container.start + 1, end: first.start, contentDepth: inner, nextDepth: inner },
		...siblingGaps(children, inner),
		{ start: last.end, end: container.end - 1, contentDepth: inner, nextDepth: depth },
	];
}

function breakableChildren(node: SourceNode, record: Readonly<Record<string, unknown>>, code: string) {
	if (node.type === "BlockStatement" || node.type === "StaticBlock") return sourceNodes(record.body);
	if (node.type !== "ArrayExpression") return undefined;
	const elements = sourceNodes(record.elements);
	const text = code.slice(node.start, node.end);
	if (elements.length < 2 || text.length <= ARRAY_BREAK_LENGTH || text.includes("\n")) return undefined;
	return elements;
}

function collectGaps(value: unknown, depth: number, code: string, gaps: Gap[]): void {
	if (Array.isArray(value)) {
		for (const item of value) collectGaps(item, depth, code, gaps);
		return;
	}
	if (!isRecord(value)) return;
	const node = sourceNode(value);
	const children = node === undefined ? undefined : breakableChildren(node, value, code);
	const breaks = node !== undefined && children !== undefined && children.length > 0;
	if (breaks) gaps.push(...containerGaps(node, children, depth));
	for (const [key, child] of Object.entries(value)) {
		if (key === "loc" || key === "extra" || key.endsWith("Comments")) continue;
		if (child !== null && typeof child === "object") collectGaps(child, breaks ? depth + 1 : depth, code, gaps);
	}
}

function renderGap(text: string, gap: Gap): string {
	let rest = text.trim();
	let attached = "";
	if (rest.startsWith(",") || rest.startsWith(";")) {
		attached = rest.slice(0, 1);
		rest = rest.slice(1).trim();
	}
	const contentIndent = INDENT.repeat(gap.contentDepth);
	const content = rest
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => `\n${contentIndent}${line}`)
		.join("");
	return `${attached}${content}\n${INDENT.repeat(gap.nextDepth)}`;
}

function reformat(code: string): string {
	const program = parseProgram(code);
	if (!isRecord(program)) return code;
	const gaps = siblingGaps(sourceNodes(program.body), 0);
	collectGaps(program.body, 0, code, gaps);
	gaps.sort((left, right) => left.start - right.start);
	let output = "";
	let cursor = 0;
	for (const gap of gaps) {
		output += code.slice(cursor, gap.start) + renderGap(code.slice(gap.start, gap.end), gap);
		cursor = gap.end;
	}
	return (output + code.slice(cursor)).trim();
}

export function displayCode(code: string, language: EvalLanguage): string {
	if (language !== "js" || !isDense(code)) return code;
	const cached = cache.get(code);
	if (cached !== undefined) return cached;
	const formatted = reformat(code);
	if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value ?? "");
	cache.set(code, formatted);
	return formatted;
}
