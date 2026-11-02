import { describe, expect, it } from "vitest";
import { parseToolFunction } from "../src/kernels/js/kernel-tools-parse.js";
import { createKernelToolRegistry } from "../src/kernels/js/kernel-tools-registry.js";

function expectInvalid(fn) {
	try {
		parseToolFunction(fn);
		throw new Error("expected invalid_tool_definition");
	} catch (error) {
		expect(error).toMatchObject({ code: "invalid_tool_definition" });
	}
}

describe("production parser hostile definitions", () => {
	it("accepts named functions whose bodies contain arrows or the => glyph", () => {
		expect(
			parseToolFunction(function lookup(path) {
				return Promise.resolve(path).then((x) => x);
			}),
		).toMatchObject({ name: "lookup", params: ["path"] });
		expect(
			parseToolFunction(function arrowString(a) {
				return "=>";
			}),
		).toMatchObject({ name: "arrowString", params: ["a"] });
		expect(
			parseToolFunction(async function fetchText(url) {
				return url;
			}),
		).toMatchObject({ name: "fetchText", params: ["url"], async: true });
	});

	it("accepts unicode identifiers, comments, and line breaks in the parameter list", () => {
		expect(
			parseToolFunction(function 名前(値) {
				return 値;
			}),
		).toMatchObject({ name: "名前", params: ["値"] });
		expect(
			parseToolFunction(function café(path) {
				return path;
			}),
		).toMatchObject({ name: "café", params: ["path"] });
		expect(
			parseToolFunction(function cafe(café) {
				return café;
			}),
		).toMatchObject({ name: "cafe", params: ["café"] });
		expect(
			parseToolFunction(function f(a /* trailing */) {
				return a;
			}),
		).toMatchObject({ name: "f", params: ["a"] });
		expect(
			parseToolFunction(function f(a, b) {
				return [a, b];
			}),
		).toMatchObject({ name: "f", params: ["a", "b"] });
		function spaced(a, b) {
			return [a, b];
		}
		expect(parseToolFunction(spaced)).toMatchObject({ name: "spaced", params: ["a", "b"] });
	});

	it("rejects arrows, anonymous functions, generators, classes, and illegal parameter lists", () => {
		expectInvalid((a) => a);
		expectInvalid(function (a) {
			return a;
		});
		expectInvalid(function wrapped({ a }) {
			return a;
		});
		expectInvalid(function wrapped([a]) {
			return a;
		});
		expectInvalid(function fallback(a = 1) {
			return a;
		});
		expectInvalid(function nested(a = ")") {
			return a;
		});
		expectInvalid(function commented(a = /* , */ 1) {
			return a;
		});
		expectInvalid(function rest(...a) {
			return a;
		});
		expectInvalid(function trailing(a,) {
			return a;
		});
		expectInvalid(function* gen(a) {
			return a;
		});
		expectInvalid(async function* g(a) {
			return a;
		});
		expectInvalid(class C {});
		expectInvalid(function nestedParen(a = Math.max(1, 2)) {
			return a;
		});
	});

	it("rejects Function#toString variants the scanner must not guess", () => {
		expectInvalid(Math.abs);
		expectInvalid(
			function named(a) {
				return a;
			}.bind(null),
		);
		expectInvalid({
			lookup(path) {
				return path;
			},
		}.lookup);
		expectInvalid(Object.getOwnPropertyDescriptor({ get lookup() { return 1; } }, "lookup").get);
		class FieldArrow {
			lookup = (a) => a;
		}
		expectInvalid(new FieldArrow().lookup);
		const escaped = function toolProbe() {};
		escaped.toString = () => "function \\u0061(x) { return x; }";
		expectInvalid(escaped);
	});

	it("keeps representable names as written and rejects MCP mangling", () => {
		const tools = createKernelToolRegistry();
		expect(tools.define(function lookup(path) { return path; }).name).toBe("lookup");
		try {
			tools.define(function café(path) {
				return path;
			});
			throw new Error("expected invalid_tool_definition");
		} catch (error) {
			expect(error).toMatchObject({ code: "invalid_tool_definition" });
		}
	});
});
