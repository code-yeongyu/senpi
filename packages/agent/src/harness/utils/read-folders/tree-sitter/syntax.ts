import type { ReadBraceScan, ReadFoldSettings, ReadLineRange } from "../types.ts";

/** Structural subset of a web-tree-sitter node: the fold rule stays pure and grammar-runtime free. */
export interface SyntaxNode {
	readonly id: number;
	readonly type: string;
	readonly text: string;
	readonly startPosition: { readonly row: number };
	readonly endPosition: { readonly row: number };
	readonly children: readonly (SyntaxNode | null)[];
	readonly hasError: boolean;
	readonly isMissing: boolean;
	childForFieldName(field: string): SyntaxNode | null;
}

export type TreeSitterLanguage = "ts" | "tsx" | "js";

/** Implementation/value containers, mirroring the compiler oracle's whitelist. Class bodies are excluded. */
const bodyKinds = new Set(["statement_block", "object", "array", "switch_body"]);
const functionKinds = new Set([
	"function_declaration",
	"function_expression",
	"function",
	"generator_function",
	"generator_function_declaration",
	"arrow_function",
	"method_definition",
	"function_signature",
	"method_signature",
	"abstract_method_signature",
]);
const classKinds = new Set(["class", "class_declaration", "abstract_class_declaration"]);
/** Header material: a fold overlapping any of these lines is rejected, exactly as the oracle rejects it. */
const opaqueKinds = new Set([
	"type_annotation",
	"type_arguments",
	"type_parameters",
	"type_alias_declaration",
	"interface_declaration",
	"type_predicate_annotation",
	"omitting_type_annotation",
	"opting_type_annotation",
	"asserts_annotation",
	"type_identifier",
	"predefined_type",
	"nested_type_identifier",
	"formal_parameters",
	"class_heritage",
	"extends_clause",
	"extends_type_clause",
	"implements_clause",
	"decorator",
	"import_statement",
	"object_pattern",
	"array_pattern",
	"computed_property_name",
	"ambient_declaration",
]);

function isOpaque(node: SyntaxNode): boolean {
	return opaqueKinds.has(node.type) || node.type.endsWith("_type") || node.type.endsWith("_type_annotation");
}

function childNodes(node: SyntaxNode): SyntaxNode[] {
	const children: SyntaxNode[] = [];
	for (const child of node.children) if (child) children.push(child);
	return children;
}

function openBrace(node: SyntaxNode): SyntaxNode | undefined {
	for (const child of childNodes(node)) if (child.type === "{" || child.type === "[") return child;
	return undefined;
}

function closeBrace(node: SyntaxNode): SyntaxNode | undefined {
	const children = childNodes(node);
	for (let index = children.length - 1; index >= 0; index--) {
		const child = children[index];
		if (child.type === "}" || child.type === "]") return child;
	}
	return undefined;
}

function exportsOnlyBindings(node: SyntaxNode): boolean {
	// `export { a } from "b"` / `export * from "b"` is a declaration header; `export const x = {}` is not.
	for (const child of childNodes(node))
		if (child.type === "export_clause" || child.type === "*" || child.type === "namespace_export") return true;
	return false;
}

/** `x as const` / `x satisfies T`: everything from the operator on is type material. */
function typeOperator(node: SyntaxNode): SyntaxNode | undefined {
	if (node.type !== "as_expression" && node.type !== "satisfies_expression") return undefined;
	return childNodes(node).find((child) => child.type === "as" || child.type === "satisfies");
}

function assignmentTarget(node: SyntaxNode): SyntaxNode | undefined {
	if (node.type !== "assignment_expression" && node.type !== "for_in_statement") return undefined;
	const left = node.childForFieldName("left");
	if (!left) return undefined;
	let target = left;
	while (target.type === "parenthesized_expression") {
		const inner = childNodes(target).find((child) => child.type !== "(" && child.type !== ")");
		if (!inner) break;
		target = inner;
	}
	return target.type === "object" || target.type === "array" ? left : undefined;
}

/**
 * Fold boundaries from a parsed syntax tree, produced under the same rules the compiler oracle
 * uses to annotate safe interiors: value containers only, never a line of a declaration header.
 */
export function foldRangesFromSyntax(root: SyntaxNode, settings: ReadFoldSettings): ReadBraceScan {
	if (root.hasError || root.isMissing) return { status: "parse_failure", reason: "tree_sitter_parse_error" };
	const candidates: ReadLineRange[] = [];
	const guarded: ReadLineRange[] = [];
	const protect = (startLine: number, endLine: number) => {
		if (endLine >= startLine) guarded.push({ startLine, endLine });
	};
	const line = (row: number) => row + 1;
	const visit = (node: SyntaxNode): void => {
		if (isOpaque(node) || (node.type === "export_statement" && exportsOnlyBindings(node))) {
			protect(line(node.startPosition.row), line(node.endPosition.row));
			return;
		}
		if (node.type === "comment") {
			const lines = node.endPosition.row - node.startPosition.row + 1;
			if (node.text.startsWith("/**") || node.text.startsWith("/*!"))
				protect(line(node.startPosition.row), line(node.endPosition.row));
			else if (lines >= settings.minCommentLines)
				candidates.push({ startLine: line(node.startPosition.row) + 1, endLine: line(node.endPosition.row) - 1 });
			return;
		}
		const operator = typeOperator(node);
		if (operator) {
			protect(line(operator.startPosition.row), line(node.endPosition.row));
			for (const child of childNodes(node)) {
				if (child.id === operator.id) break;
				visit(child);
			}
			return;
		}
		const target = assignmentTarget(node);
		if (target) {
			protect(line(target.startPosition.row), line(target.endPosition.row));
			for (const child of childNodes(node)) if (child.id !== target.id) visit(child);
			return;
		}
		if (functionKinds.has(node.type)) {
			const body = node.childForFieldName("body");
			if (!body) {
				protect(line(node.startPosition.row), line(node.endPosition.row));
				return;
			}
			// The header owns every line through the line that opens the body.
			protect(line(node.startPosition.row), line(body.startPosition.row));
			visit(body);
			return;
		}
		if (classKinds.has(node.type)) {
			const body = node.childForFieldName("body");
			const open = body ? openBrace(body) : undefined;
			if (!body || !open) {
				protect(line(node.startPosition.row), line(node.endPosition.row));
				return;
			}
			protect(line(node.startPosition.row), line(open.startPosition.row));
			for (const member of childNodes(body)) visit(member);
			return;
		}
		if (bodyKinds.has(node.type)) {
			const open = openBrace(node);
			const close = closeBrace(node);
			if (open && close) {
				const startLine = line(open.startPosition.row) + 1;
				const endLine = line(close.startPosition.row) - 1;
				if (endLine - startLine + 1 >= settings.minBodyLines) candidates.push({ startLine, endLine });
			}
		}
		for (const child of childNodes(node)) visit(child);
	};
	visit(root);
	const ranges = candidates.filter(
		(range) =>
			!guarded.some((header) => range.startLine <= header.endLine && range.endLine >= header.startLine) &&
			range.endLine >= range.startLine,
	);
	return { status: "parsed", ranges };
}
