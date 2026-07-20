import { parse } from "@babel/parser";
import type { ImportDeclaration } from "@babel/types";

const DYNAMIC_IMPORT_CALLEE =
	'(typeof __senpi_import__ === "function" ? __senpi_import__ : (specifier, options) => import(specifier, options))';

type AstNode = {
	readonly type: string;
	readonly start: number;
	readonly end: number;
	readonly value: Readonly<Record<string, unknown>>;
};

type TextEdit = {
	readonly start: number;
	readonly end: number;
	readonly text: string;
};

class UnexpectedImportSpecifierError extends Error {
	readonly name = "UnexpectedImportSpecifierError";
}

function assertNever(_value: never): never {
	throw new UnexpectedImportSpecifierError("Unsupported import specifier");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nodeFrom(value: unknown): AstNode | undefined {
	if (!isRecord(value)) return undefined;
	const type = value.type;
	const start = value.start;
	const end = value.end;
	if (typeof type !== "string" || typeof start !== "number" || typeof end !== "number") return undefined;
	return { type, start, end, value };
}

function parseProgram(code: string): ReturnType<typeof parse> | undefined {
	try {
		return parse(code, {
			sourceType: "module",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
			allowImportExportEverywhere: true,
			allowNewTargetOutsideFunction: true,
			allowSuperOutsideMethod: true,
			allowUndeclaredExports: true,
			errorRecovery: true,
			plugins: ["typescript", "importAttributes"],
		});
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function walkNodes(root: unknown, visit: (node: AstNode) => void): void {
	const stack: unknown[] = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (Array.isArray(current)) {
			for (let index = current.length - 1; index >= 0; index -= 1) stack.push(current[index]);
			continue;
		}
		if (!isRecord(current)) continue;
		const node = nodeFrom(current);
		if (node) visit(node);
		for (const [key, value] of Object.entries(current)) {
			if (key === "loc" || key === "extra" || key === "range" || key.endsWith("Comments")) continue;
			if (value !== null && typeof value === "object") stack.push(value);
		}
	}
}

function importOptions(node: ImportDeclaration): string | undefined {
	if (!node.attributes || node.attributes.length === 0) return undefined;
	const pairs = node.attributes.map((attribute) => {
		const key = attribute.key.type === "Identifier" ? attribute.key.name : JSON.stringify(attribute.key.value);
		return `${key}: ${JSON.stringify(attribute.value.value)}`;
	});
	return `{ with: { ${pairs.join(", ")} } }`;
}

function importCall(source: string, options: string | undefined): string {
	const sourceLiteral = JSON.stringify(source);
	return options ? `__senpi_import__(${sourceLiteral}, ${options})` : `__senpi_import__(${sourceLiteral})`;
}

function rewriteImportDeclaration(node: ImportDeclaration): string {
	const call = importCall(node.source.value, importOptions(node));
	let defaultName: string | undefined;
	let namespaceName: string | undefined;
	const namedBindings: Array<readonly [imported: string, local: string]> = [];

	for (const specifier of node.specifiers) {
		switch (specifier.type) {
			case "ImportDefaultSpecifier":
				defaultName = specifier.local.name;
				break;
			case "ImportNamespaceSpecifier":
				namespaceName = specifier.local.name;
				break;
			case "ImportSpecifier": {
				const imported =
					specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
				namedBindings.push([imported, specifier.local.name]);
				break;
			}
			default:
				assertNever(specifier);
		}
	}

	if (namedBindings.length > 0) {
		const named = namedBindings
			.map(([imported, local]) => (imported === local ? imported : `${imported}: ${local}`))
			.join(", ");
		const bindings = defaultName ? `default: ${defaultName}, ${named}` : named;
		return `const { ${bindings} } = await ${call};`;
	}
	if (namespaceName && defaultName) {
		return `const ${namespaceName} = await ${call}; const ${defaultName} = ${namespaceName}.default;`;
	}
	if (namespaceName) return `const ${namespaceName} = await ${call};`;
	if (defaultName) return `const ${defaultName} = (await ${call}).default;`;
	return `await ${call};`;
}

function dynamicImportEdit(node: AstNode): TextEdit | undefined {
	if (node.type !== "CallExpression") return undefined;
	const callee = nodeFrom(node.value.callee);
	if (callee?.type !== "Import") return undefined;
	return { start: callee.start, end: callee.end, text: DYNAMIC_IMPORT_CALLEE };
}

function applyEdits(code: string, edits: readonly TextEdit[]): string {
	if (edits.length === 0) return code;
	const descending = edits.toSorted((left, right) => right.start - left.start);
	let output = code;
	for (const edit of descending) {
		output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
	}
	return output;
}

export function rewriteImports(code: string): string {
	if (!code.includes("import")) return code;
	const ast = parseProgram(code);
	if (!ast) return code;
	const edits: TextEdit[] = [];

	for (const node of ast.program.body) {
		if (node.type !== "ImportDeclaration" || typeof node.start !== "number" || typeof node.end !== "number") continue;
		edits.push({ start: node.start, end: node.end, text: rewriteImportDeclaration(node) });
	}
	walkNodes(ast.program, (node) => {
		const edit = dynamicImportEdit(node);
		if (edit) edits.push(edit);
	});
	return applyEdits(code, edits);
}
