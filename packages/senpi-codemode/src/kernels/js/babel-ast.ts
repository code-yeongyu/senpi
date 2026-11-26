import { parse } from "@babel/parser";

export type AstNode = {
	readonly type: string;
	readonly start: number;
	readonly end: number;
	readonly value: Readonly<Record<string, unknown>>;
};

export type ParsedProgram = ReturnType<typeof parse>;

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function nodeFrom(value: unknown): AstNode | undefined {
	if (!isRecord(value)) return undefined;
	const type = value.type;
	const start = value.start;
	const end = value.end;
	if (typeof type !== "string" || typeof start !== "number" || typeof end !== "number") return undefined;
	return { type, start, end, value };
}

/**
 * Parses a cell as a TypeScript module with the kernel's top-level allowances. `errorRecovery` keeps a best-effort
 * tree for the import rewrite; type erasure needs an exact parse and turns it off.
 */
export function parseCellProgram(code: string, errorRecovery = true): ParsedProgram | undefined {
	try {
		return parse(code, {
			sourceType: "module",
			allowAwaitOutsideFunction: true,
			allowReturnOutsideFunction: true,
			allowImportExportEverywhere: true,
			allowNewTargetOutsideFunction: true,
			allowSuperOutsideMethod: true,
			allowUndeclaredExports: true,
			errorRecovery,
			plugins: ["typescript"],
		});
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

export function walkNodes(root: unknown, visit: (node: AstNode) => void): void {
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
