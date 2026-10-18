import * as ts from "@typescript/typescript6";
import { type Fold, overlaps } from "./scorer.ts";

/** Compiler AST authority, deliberately independent of the dependency-free candidate lexer. */
export function typescriptOracle(source: string, language: string) {
	const kind =
		language === "tsx"
			? ts.ScriptKind.TSX
			: language === "js"
				? ts.ScriptKind.JS
				: language === "json"
					? ts.ScriptKind.JSON
					: ts.ScriptKind.TS;
	const file = ts.createSourceFile(`input.${language}`, source, ts.ScriptTarget.Latest, true, kind);
	const line = (pos: number) => file.getLineAndCharacterOfPosition(pos).line + 1;
	const protectedRanges: Fold[] = [];
	const bindingPattern = (node: ts.Node): node is ts.BindingPattern =>
		ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node);
	// A destructuring assignment target is expression-shaped, unlike a declaration/parameter binding.
	const targetPattern = (node: ts.Node): boolean =>
		ts.isParenthesizedExpression(node)
			? targetPattern(node.expression)
			: ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node);
	const assignmentTarget = (node: ts.Node): ts.Node | undefined => {
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
			return targetPattern(node.left) ? node.left : undefined;
		if (ts.isForInStatement(node) || ts.isForOfStatement(node))
			return targetPattern(node.initializer) ? node.initializer : undefined;
		return undefined;
	};
	const candidates: (Fold & { kind: string })[] = [];
	const protect = (node: ts.Node, end = node.end) =>
		protectedRanges.push({
			start: line(node.getStart(file)),
			end: line(Math.max(node.getStart(file), end - 1)),
		});
	const visit = (node: ts.Node) => {
		// Do not visit descendants of these nodes: even executable expressions in a
		// parameter initializer, decorator or heritage clause belong to the header.
		if (
			ts.isTypeNode(node) ||
			bindingPattern(node) ||
			ts.isParameter(node) ||
			ts.isHeritageClause(node) ||
			ts.isDecorator(node) ||
			ts.isImportDeclaration(node) ||
			ts.isExportDeclaration(node)
		) {
			protect(node);
			return;
		}
		// Protect the complete target subtree: its defaults and nested patterns are never values.
		const target = assignmentTarget(node);
		if (target) {
			protect(target);
			node.forEachChild((child) => {
				if (child !== target) visit(child);
			});
			return;
		}
		// A computed member name can hold an executable expression before its value or body.
		if (ts.isComputedPropertyName(node)) {
			protect(node);
			return;
		}
		if (ts.isFunctionLike(node)) {
			const body = "body" in node ? node.body : undefined;
			if (!body) {
				protect(node);
				return;
			}
			protect(node, body.getStart(file) + 1);
			visit(body);
			return;
		}
		if (ts.isClassLike(node)) {
			const open = node.getChildren(file).find((c) => c.kind === ts.SyntaxKind.OpenBraceToken);
			if (!open) {
				protect(node);
				return;
			}
			protect(node, open.end);
			for (const member of node.members) visit(member);
			return;
		}
		if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) {
			if (bindingPattern(node.name) || ts.isComputedPropertyName(node.name)) protect(node.name);
			if (node.type) protect(node.type);
			if (ts.canHaveDecorators(node)) for (const decorator of ts.getDecorators(node) ?? []) protect(decorator);
		}
		// A whitelist of actual implementation/value containers, never arbitrary braces.
		if (
			ts.isBlock(node) ||
			ts.isModuleBlock(node) ||
			ts.isCaseBlock(node) ||
			ts.isObjectLiteralExpression(node) ||
			ts.isArrayLiteralExpression(node)
		) {
			const children = node.getChildren(file);
			const open = children.find(
				(c) => c.kind === ts.SyntaxKind.OpenBraceToken || c.kind === ts.SyntaxKind.OpenBracketToken,
			);
			const close = children.findLast(
				(c) => c.kind === ts.SyntaxKind.CloseBraceToken || c.kind === ts.SyntaxKind.CloseBracketToken,
			);
			if (open && close)
				candidates.push({
					start: line(open.getStart(file)) + 1,
					end: line(close.getStart(file)) - 1,
					kind: "body",
				});
		}
		node.forEachChild(visit);
	};
	visit(file);
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
	for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
		if (token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
		const start = line(scanner.getTokenPos());
		const end = line(scanner.getTextPos() - 1);
		if (/^\/\*[*!]/.test(scanner.getTokenText())) protectedRanges.push({ start, end });
		else candidates.push({ start: start + 1, end: end - 1, kind: "comment" });
	}
	return {
		protected: protectedRanges,
		allowed: candidates.filter(
			(range) => range.end >= range.start && !protectedRanges.some((header) => overlaps(range, header)),
		),
	};
}
