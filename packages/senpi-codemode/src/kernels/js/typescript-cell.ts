import { eraseTypeScript } from "./erase-types.ts";
import { rewriteImports } from "./rewrite-imports.ts";

const AsyncFunction: FunctionConstructor = Object.getPrototypeOf(async () => {}).constructor;

function compilesAsJavaScript(code: string): boolean {
	try {
		// oxlint-disable-next-line eslint/no-new-func -- compile-only probe: the function is never called.
		new AsyncFunction(code);
		return true;
	} catch (error) {
		if (error instanceof SyntaxError) return false;
		throw error;
	}
}

const UNSUPPORTED_REMEDY =
	"eval only erases types, so write it as JavaScript (a const object for an enum, assigned fields for a parameter property) or import it from a checked .ts module";

/**
 * The cell text the JS kernel runs. With `typescript` on, a cell the engine rejects as JavaScript but Babel accepts as
 * TypeScript runs with its types erased in place; valid JavaScript is never reinterpreted (`a < b > (c)` stays a
 * comparison), and a cell that is neither keeps its source so the kernel reports the JavaScript syntax error.
 */
export function javaScriptCellSource(code: string, typescript: boolean): string {
	const rewritten = rewriteImports(code);
	if (!typescript || compilesAsJavaScript(rewritten)) return rewritten;
	const erasure = eraseTypeScript(code);
	switch (erasure.kind) {
		case "erased":
			return rewriteImports(erasure.code);
		case "invalid":
			return rewritten;
		case "unsupported": {
			const message = `TypeScript ${erasure.construct} at line ${erasure.line}, column ${erasure.column} generates runtime code; ${UNSUPPORTED_REMEDY}.`;
			return `throw new SyntaxError(${JSON.stringify(message)});`;
		}
	}
}
