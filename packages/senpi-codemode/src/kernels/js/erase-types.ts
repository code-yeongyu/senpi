import { type AstNode, nodeFrom, parseCellProgram, walkNodes } from "./babel-ast.ts";

/**
 * The outcome of erasing TypeScript syntax from a cell. `erased` code has every type-only token replaced by spaces
 * (line breaks kept), so each remaining token sits at its original line and column and diagnostics point at the
 * submitted text. `unsupported` names a construct that generates runtime code (enum, namespace, parameter property,
 * `import =`, `export =`) and so cannot be erased.
 */
export type TypeErasure =
	| { readonly kind: "erased"; readonly code: string }
	| { readonly kind: "unsupported"; readonly construct: string; readonly line: number; readonly column: number }
	| { readonly kind: "invalid" };

type Range = { readonly start: number; readonly end: number; readonly statement: boolean };

const TYPE_ONLY_STATEMENTS = new Set(["TSTypeAliasDeclaration", "TSInterfaceDeclaration", "TSDeclareFunction"]);
const DECLARABLE = new Set([
	"VariableDeclaration",
	"ClassDeclaration",
	"TSEnumDeclaration",
	"TSModuleDeclaration",
	"FunctionDeclaration",
]);
const TYPE_SYNTAX = new Set(["TSTypeAnnotation", "TSTypeParameterDeclaration", "TSTypeParameterInstantiation"]);
const TYPE_SUFFIX_EXPRESSIONS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression"]);
const UNSUPPORTED: Readonly<Record<string, string>> = {
	TSEnumDeclaration: "enum",
	TSModuleDeclaration: "namespace",
	TSParameterProperty: "constructor parameter property",
	TSImportEqualsDeclaration: "import = require()",
	TSExportAssignment: "export =",
};
const MEMBER_MODIFIER_RE = /\b(?:public|private|protected|readonly|override)\b/gu;

export function eraseTypeScript(code: string): TypeErasure {
	const ast = parseCellProgram(code, false);
	if (ast === undefined) return { kind: "invalid" };
	const ranges: Range[] = [];
	let unsupported: { construct: string; at: AstNode } | undefined;
	const blank = (start: number, end: number, statement = false) => {
		if (end > start) ranges.push({ start, end, statement });
	};
	walkNodes(ast.program, (node) => {
		if (unsupported !== undefined) return;
		const value = node.value;
		if (value.declare === true && DECLARABLE.has(node.type)) return blank(node.start, node.end, true);
		const construct = UNSUPPORTED[node.type];
		if (construct !== undefined && !(node.type === "TSImportEqualsDeclaration" && value.importKind === "type")) {
			unsupported = { construct, at: node };
			return;
		}
		if (TYPE_ONLY_STATEMENTS.has(node.type) || node.type === "TSImportEqualsDeclaration") {
			return blank(node.start, node.end, true);
		}
		if (isTypeOnlyModuleStatement(node)) return blank(node.start, node.end, true);
		if (node.type === "ImportSpecifier" && value.importKind === "type")
			return blank(node.start, commaEnd(code, node.end));
		if (TYPE_SYNTAX.has(node.type)) return blank(node.start, node.end);
		if (TYPE_SUFFIX_EXPRESSIONS.has(node.type)) return blank(nodeFrom(value.expression)?.end ?? node.end, node.end);
		if (node.type === "TSTypeAssertion") return blank(node.start, nodeFrom(value.expression)?.start ?? node.start);
		eraseMarkers(code, node, blank);
	});
	if (unsupported !== undefined) {
		const position = lineColumn(code, unsupported.at.start);
		return { kind: "unsupported", construct: unsupported.construct, ...position };
	}
	return { kind: "erased", code: applyBlanks(code, ranges) };
}

function isTypeOnlyModuleStatement(node: AstNode): boolean {
	if (
		node.type === "ImportDeclaration" ||
		node.type === "ExportNamedDeclaration" ||
		node.type === "ExportAllDeclaration"
	) {
		return node.value.importKind === "type" || node.value.exportKind === "type";
	}
	return false;
}

function eraseMarkers(
	code: string,
	node: AstNode,
	blank: (start: number, end: number, statement?: boolean) => void,
): void {
	const value = node.value;
	if (node.type === "Identifier" && typeof value.name === "string") {
		const nameEnd = node.start + value.name.length;
		if (value.optional === true) blank(...charRange(code, "?", nameEnd, node.end));
		return;
	}
	if (node.type === "VariableDeclarator" && value.definite === true) {
		const id = nodeFrom(value.id);
		if (id !== undefined && typeof id.value.name === "string")
			blank(...charRange(code, "!", id.start + id.value.name.length, id.end));
		return;
	}
	if (isFunctionNode(node)) eraseThisParameter(code, value.params, blank);
	if (node.type === "ClassDeclaration" || node.type === "ClassExpression") return eraseClassHeader(code, node, blank);
	if (!isClassMember(node.type)) return;
	if (
		value.declare === true ||
		value.abstract === true ||
		node.type === "TSDeclareMethod" ||
		node.type === "TSIndexSignature"
	) {
		return blank(node.start, node.end, true);
	}
	const key = nodeFrom(value.key);
	if (key === undefined) return;
	for (const match of code.slice(node.start, key.start).matchAll(MEMBER_MODIFIER_RE)) {
		const at = node.start + match.index;
		blank(at, at + match[0].length);
	}
	const markerEnd = nodeFrom(value.typeAnnotation)?.start ?? nodeFrom(value.returnType)?.start ?? node.end;
	if (value.optional === true) blank(...charRange(code, "?", key.end, markerEnd));
	if (value.definite === true) blank(...charRange(code, "!", key.end, markerEnd));
}

function eraseClassHeader(code: string, node: AstNode, blank: (start: number, end: number) => void): void {
	if (node.value.abstract === true && code.startsWith("abstract", node.start))
		blank(node.start, node.start + "abstract".length);
	const clauses = node.value.implements;
	if (!Array.isArray(clauses) || clauses.length === 0) return;
	const first = nodeFrom(clauses[0]);
	const last = nodeFrom(clauses.at(-1));
	if (first === undefined || last === undefined) return;
	blank(code.lastIndexOf("implements", first.start), last.end);
}

function eraseThisParameter(code: string, params: unknown, blank: (start: number, end: number) => void): void {
	if (!Array.isArray(params)) return;
	const first = nodeFrom(params[0]);
	if (first?.type === "Identifier" && first.value.name === "this") blank(first.start, commaEnd(code, first.end));
}

function isFunctionNode(node: AstNode): boolean {
	return /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ClassMethod|ObjectMethod|TSDeclareMethod)$/u.test(
		node.type,
	);
}

function isClassMember(type: string): boolean {
	return /^(?:ClassProperty|ClassAccessorProperty|ClassMethod|ClassPrivateProperty|ClassPrivateMethod|TSDeclareMethod|TSIndexSignature)$/u.test(
		type,
	);
}

function charRange(code: string, char: string, from: number, to: number): [number, number] {
	const at = code.indexOf(char, from);
	return at >= 0 && at < to ? [at, at + 1] : [from, from];
}

function commaEnd(code: string, end: number): number {
	const match = /^\s*,/u.exec(code.slice(end));
	return match === null ? end : end + match[0].length;
}

/** Blanks every range with spaces, keeping line breaks; a whole statement starts with `;` so ASI cannot merge lines. */
function applyBlanks(code: string, ranges: readonly Range[]): string {
	const chars = code.split("");
	for (const range of ranges) {
		for (let index = range.start; index < range.end; index += 1) {
			if (!/[\n\r\u2028\u2029]/u.test(chars[index] ?? "")) chars[index] = " ";
		}
	}
	for (const range of ranges) if (range.statement) chars[range.start] = ";";
	return chars.join("");
}

function lineColumn(code: string, offset: number): { line: number; column: number } {
	const before = code.slice(0, offset).split(/\r\n|[\r\n\u2028\u2029]/u);
	return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
}
