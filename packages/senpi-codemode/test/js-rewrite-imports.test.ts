import { describe, expect, it } from "vitest";
import { rewriteImports } from "../src/kernels/js/rewrite-imports.ts";

const IMPORT = "import";
const dynamicImport = (rest: string): string => `${IMPORT}${rest}`;
const IMPORT_SHIM =
	'(typeof __senpi_import__ === "function" ? __senpi_import__ : (specifier, options) => import(specifier, options))';

describe("rewriteImports", () => {
	it("rewrites a top-level default import", () => {
		// Given a cell with a default ESM import
		const source = `${IMPORT} value from "package-name";\nconsole.log(value);`;

		// When imports are rewritten for script-mode evaluation
		const output = rewriteImports(source);

		// Then the binding is loaded through the session import helper
		expect(output).toContain('await __senpi_import__("package-name")');
		expect(output).not.toContain(`${IMPORT} value from "package-name"`);
	});

	it("rewrites named imports and aliases", () => {
		// Given named bindings with an alias
		const source = `${IMPORT} { value, other as renamed } from "package-name";`;

		// When the declaration is rewritten
		const output = rewriteImports(source);

		// Then both local binding names are preserved
		expect(output).toContain('await __senpi_import__("package-name")');
		expect(output).toContain("value");
		expect(output).toContain("other: renamed");
	});

	it("rewrites namespace and combined imports", () => {
		// Given namespace and default bindings
		const source = `${IMPORT} value, * as namespace from "package-name";`;

		// When the declaration is rewritten
		const output = rewriteImports(source);

		// Then both bindings share one module load
		expect(output).toContain('const namespace = await __senpi_import__("package-name")');
		expect(output).toContain("const value = namespace.default");
	});

	it("rewrites combined default and named imports", () => {
		// Given default and named bindings
		const source = `${IMPORT} value, { other as renamed } from "package-name";`;

		// When the declaration is rewritten
		const output = rewriteImports(source);

		// Then default and named properties are destructured together
		expect(output).toContain("default: value");
		expect(output).toContain("other: renamed");
	});

	it("rewrites side-effect imports", () => {
		// Given a side-effect-only import
		const source = `${IMPORT} "polyfill";`;

		// When the declaration is rewritten
		const output = rewriteImports(source);

		// Then the module is awaited without creating a binding
		expect(output).toContain('await __senpi_import__("polyfill")');
	});

	it("preserves import attributes", () => {
		// Given a JSON import with an attribute
		const source = `${IMPORT} data from "./data.json" with { type: "json" };`;

		// When the declaration is rewritten
		const output = rewriteImports(source);

		// Then the attribute becomes a dynamic-import options bag
		expect(output).toContain('await __senpi_import__("./data.json", { with: { type: "json" } })');
	});

	it("rewrites dynamic imports with their options", () => {
		// Given a dynamic import anywhere in an expression
		const source = `const module = await ${dynamicImport('("./data.json", { with: { type: "json" } })')};`;

		// When dynamic imports are rewritten
		const output = rewriteImports(source);

		// Then the guarded helper receives the original arguments
		expect(output).toContain(`${IMPORT_SHIM}("./data.json", { with: { type: "json" } })`);
	});

	it("rewrites nested dynamic imports", () => {
		// Given multiple imports nested in an expression
		const source = `Promise.all([${dynamicImport('("./a.mjs")')}, ${dynamicImport('("./b.mjs")')}]);`;

		// When the cell is rewritten
		const output = rewriteImports(source);

		// Then every real import call uses the guarded helper
		expect(output).toContain(`${IMPORT_SHIM}("./a.mjs")`);
		expect(output).toContain(`${IMPORT_SHIM}("./b.mjs")`);
	});

	it("leaves imports inside strings, templates, and comments untouched", () => {
		// Given look-alike import text in non-code syntax
		const source = [
			`const quoted = '${IMPORT} value from "quoted"';`,
			`const templated = \`${IMPORT} value from "templated"\`;`,
			`// ${IMPORT} value from "line-comment"`,
			`/* ${IMPORT} value from "block-comment" */`,
		].join("\n");

		// When the source is parsed and rewritten
		const output = rewriteImports(source);

		// Then no look-alike text becomes executable code
		expect(output).toBe(source);
	});

	it("rewrites real imports while preserving template look-alikes", () => {
		// Given real declarations around generated source text
		const source = [
			`${IMPORT} first from "first-package";`,
			`const generated = \`${IMPORT} hidden from "hidden-package"\`;`,
			`${IMPORT} second from "second-package";`,
		].join("\n");

		// When the source is rewritten
		const output = rewriteImports(source);

		// Then only AST import nodes are changed
		expect(output).toContain('await __senpi_import__("first-package")');
		expect(output).toContain('await __senpi_import__("second-package")');
		expect(output).toContain(`${IMPORT} hidden from "hidden-package"`);
	});

	it("returns import-free source unchanged", () => {
		// Given ordinary JavaScript without import syntax
		const source = "const value = 40 + 2;\nreturn value;";

		// When the rewriter runs
		const output = rewriteImports(source);

		// Then it performs no allocation-visible text change
		expect(output).toBe(source);
	});

	it("leaves malformed source for the runtime syntax error", () => {
		// Given source the parser cannot recover
		const source = `${IMPORT} { value from broken syntax 'unterminated`;

		// When the rewriter cannot build a trustworthy AST
		const output = rewriteImports(source);

		// Then the original source is preserved for the runtime error path
		expect(output).toBe(source);
	});
});
