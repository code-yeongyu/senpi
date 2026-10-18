import { applyEdits, childNodes, type Edit, type SourceNode, sourceNode } from "./display-js-ast.ts";

const LITERAL_TYPES = new Set([
	"StringLiteral",
	"NumericLiteral",
	"BigIntLiteral",
	"RegExpLiteral",
	"BooleanLiteral",
	"NullLiteral",
	"TemplateLiteral",
	"TaggedTemplateExpression",
	"DirectiveLiteral",
]);
// One placeholder per spelling, so `break outer` still resolves against `outer:` for Bun's parser.
const NAME_TYPES = new Set(["Identifier", "PrivateName"]);
// The grammar requires a string literal under these parents (module specifiers, attributes, and
// string export names), so the placeholder stays a string there.
const STRING_SLOT_PARENTS = new Set([
	"ImportDeclaration",
	"ExportAllDeclaration",
	"ExportNamedDeclaration",
	"ImportAttribute",
	"ImportSpecifier",
	"ExportSpecifier",
	"ExportNamespaceSpecifier",
	"ExportDefaultSpecifier",
]);
const STATEMENT_LISTS = new Set(["Program", "BlockStatement", "StaticBlock", "ClassBody", "SwitchCase"]);

type SourceComment = { readonly start: number; readonly end: number; readonly line: boolean };
type MaskedRange = SourceNode & { readonly stringSlot: boolean };
export type Placeholder = { readonly id: string; readonly raw: string; readonly expected: number };
export type CommentPlaceholder = Placeholder & { readonly trailing: boolean };
export type Mask = {
	readonly prefix: string;
	readonly masked: string;
	readonly values: ReadonlyMap<string, Placeholder>;
	readonly comments: readonly CommentPlaceholder[];
};

function fileComments(file: SourceNode): SourceComment[] | undefined {
	const comments = file.record.comments;
	if (!Array.isArray(comments)) return undefined;
	const parsed: SourceComment[] = [];
	for (const comment of comments) {
		const node = sourceNode(comment);
		if (node === undefined) return undefined;
		parsed.push({ start: node.start, end: node.end, line: node.type === "CommentLine" });
	}
	return parsed;
}

function innermostContainer(node: SourceNode, start: number, end: number): SourceNode {
	for (const child of childNodes(node)) {
		if (child.start <= start && end <= child.end) return innermostContainer(child, start, end);
	}
	return node;
}

function sitsInStatementList(code: string, program: SourceNode, comment: SourceComment): boolean {
	const container = innermostContainer(program, comment.start, comment.end);
	if (!STATEMENT_LISTS.has(container.type)) return false;
	if (container.type !== "SwitchCase") return true;
	const test = sourceNode(container.record.test);
	const colon = code.indexOf(":", test?.end ?? container.start);
	return colon >= 0 && colon < comment.start;
}

function followsCodeOnItsLine(code: string, comment: SourceComment, comments: readonly SourceComment[]): boolean {
	let index = comment.start - 1;
	while (index >= 0 && code[index] !== "\n") {
		const position = index;
		const covering = comments.find((other) => other.start <= position && position < other.end);
		if (covering !== undefined) {
			index = covering.start - 1;
			continue;
		}
		if (code[index] !== " " && code[index] !== "\t") return true;
		index -= 1;
	}
	return false;
}

function placeholderPrefix(code: string): string {
	let prefix = "$display";
	while (code.includes(prefix)) prefix = `${prefix}_`;
	return prefix;
}

function collectRanges(node: SourceNode, parent: SourceNode | undefined, ranges: Map<string, MaskedRange>): void {
	if (LITERAL_TYPES.has(node.type) || NAME_TYPES.has(node.type)) {
		const stringSlot = node.type === "StringLiteral" && parent !== undefined && STRING_SLOT_PARENTS.has(parent.type);
		const key = `${node.start}:${node.end}`;
		if (!ranges.has(key)) ranges.set(key, { ...node, stringSlot });
		return;
	}
	for (const child of childNodes(node)) collectRanges(child, node, ranges);
}

/**
 * Swaps every literal, name, and statement-level comment for an opaque placeholder so a printer
 * can only move them. Undefined when a comment sits where a placeholder statement cannot stand.
 */
export function maskSource(code: string, file: SourceNode): Mask | undefined {
	const program = sourceNode(file.record.program);
	const comments = fileComments(file);
	if (program === undefined || comments === undefined) return undefined;
	const ranges = new Map<string, MaskedRange>();
	collectRanges(program, undefined, ranges);
	const prefix = placeholderPrefix(code);
	const edits: Edit[] = [];
	const values = new Map<string, Placeholder>();
	const nameIds = new Map<string, string>();
	let counter = 0;
	for (const range of ranges.values()) {
		const raw = code.slice(range.start, range.end);
		const reused = NAME_TYPES.has(range.type) ? nameIds.get(raw) : undefined;
		const id = reused ?? `${prefix}${counter++}`;
		if (NAME_TYPES.has(range.type)) nameIds.set(raw, id);
		values.set(id, { id, raw, expected: (values.get(id)?.expected ?? 0) + 1 });
		edits.push({ start: range.start, end: range.end, text: range.stringSlot ? `"${id}"` : id });
	}
	const masked: CommentPlaceholder[] = [];
	for (const comment of comments) {
		if (!sitsInStatementList(code, program, comment)) return undefined;
		const id = `${prefix}${counter++}`;
		const trailing = comment.line && followsCodeOnItsLine(code, comment, comments);
		masked.push({ id, raw: code.slice(comment.start, comment.end), expected: 1, trailing });
		edits.push({ start: comment.start, end: comment.end, text: `\n${id};\n` });
	}
	return { prefix, masked: applyEdits(code, edits), values, comments: masked };
}

export function restoreComments(printed: string, comments: readonly CommentPlaceholder[]): string | undefined {
	const lines = printed.split("\n");
	for (const comment of comments) {
		const matches = lines.flatMap((line, index) => (line.trim() === `${comment.id};` ? [index] : []));
		const index = matches[0];
		if (matches.length !== 1 || index === undefined) return undefined;
		const line = lines[index] ?? "";
		let previous = index - 1;
		while (previous >= 0 && (lines[previous] ?? "").trim().length === 0) previous -= 1;
		const target = lines[previous];
		if (comment.trailing && target !== undefined && !target.includes("//")) {
			lines[previous] = `${target} ${comment.raw}`;
			lines.splice(index, 1);
			continue;
		}
		lines[index] = `${line.slice(0, line.length - line.trimStart().length)}${comment.raw}`;
	}
	return lines.join("\n");
}

function escapeRegExp(text: string): string {
	return text.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

export function restoreValues(printed: string, mask: Mask): string | undefined {
	const id = `${escapeRegExp(mask.prefix)}\\d+`;
	const pattern = new RegExp(`"(${id})"|'(${id})'|(?<![\\w$])(${id})(?![\\w$])`, "gu");
	const counts = new Map<string, number>();
	let unknown = false;
	const restored = printed.replace(pattern, (match, double: unknown, single: unknown, bare: unknown) => {
		const key = [double, single, bare].find((group): group is string => typeof group === "string") ?? "";
		const value = mask.values.get(key);
		if (value === undefined) {
			unknown = true;
			return match;
		}
		counts.set(key, (counts.get(key) ?? 0) + 1);
		return value.raw;
	});
	if (unknown) return undefined;
	for (const value of mask.values.values()) {
		if (counts.get(value.id) !== value.expected) return undefined;
	}
	return restored;
}
