import { beforeEach, describe, expect, it, vi } from "vitest";

const parseCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@babel/parser", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@babel/parser")>();
	return {
		...actual,
		parse: (...args: Parameters<typeof actual.parse>) => {
			parseCalls.count += 1;
			return actual.parse(...args);
		},
	};
});

import { rewriteImports } from "../src/kernels/js/rewrite-imports.ts";

const IMPORT = "import";

// #3205: cells are prepared on the shared host loop, so text that only mentions the keyword must not be parsed.
describe("rewriteImports host cost", () => {
	beforeEach(() => {
		parseCalls.count = 0;
	});

	it("does not parse a cell whose only import text is inside data", () => {
		// Given a large cell whose strings mention the keyword but which has no import syntax
		const records = Array.from({ length: 2000 }, (_, index) => ({ id: index, name: `${IMPORT}-${index}` }));
		const source = `const rows = ${JSON.stringify(records)};\nprint(rows.length);`;

		// When the cell is prepared
		const output = rewriteImports(source);

		// Then it is returned unchanged without a Babel parse
		expect(output).toBe(source);
		expect(parseCalls.count).toBe(0);
	});

	it("still rewrites real static and dynamic imports", () => {
		// Given a cell with a static import and a dynamic import
		const source = `${IMPORT} value from "package-name";\nconst lazy = await ${IMPORT}("other");`;

		// When the cell is prepared
		const output = rewriteImports(source);

		// Then both are rewritten through the session import helper
		expect(output).toContain('await __senpi_import__("package-name")');
		expect(output).toContain("__senpi_import__ : (specifier, options)");
		expect(parseCalls.count).toBe(1);
	});

	// #3206 review: forms the plain-text gate must not skip; the old code rewrote every one.
	it.each([
		["a comment before a dynamic call", `const lazy = await ${IMPORT} /*x*/ ("x");`],
		["a block comment before named bindings", `${IMPORT} /*c*/ {a} from "a";`],
		["a line comment before a default binding", `${IMPORT} // c\nx from "a";`],
		["a non-ASCII binding", `${IMPORT} ünicode from "a";`],
	])("still rewrites %s", (_name, source) => {
		expect(rewriteImports(source)).toContain("__senpi_import__");
	});

	// #3206 delta review: a gate that scans comment bodies backtracked quadratically here (19.6 s at 1.36 MB on Node).
	it("prepares a large data cell full of comment-like import text in linear time", { timeout: 5000 }, () => {
		// Given valid JS whose strings repeat the keyword followed by comment markers
		const rows = Array.from({ length: 90_000 }, () => `${IMPORT} /* */ x`);
		const source = `const rows = ${JSON.stringify(rows)};`;

		// When the cell is prepared
		const output = rewriteImports(source);

		// Then nothing is rewritten and it finishes well inside the budget
		expect(output).toBe(source);
	});
});
