import { describe, expect, it } from "vitest";
import { READ_FOLD_SETTINGS, selectedReadFolder } from "../../src/harness/utils/read-folders/index.ts";

const members = "\n  alpha: 1,\n  bravo: 2,\n  charlie: 3,\n  delta: 4,\n  echo: 5,\n";
const fold = (text: string) => selectedReadFolder.fold({ path: "context.ts", text, settings: READ_FOLD_SETTINGS });

describe("read-folder lexical contexts (#1639)", () => {
	it.each(["const result = factory(", "object.factory(", "return factory(", "await factory(", "new Factory("])(
		"folds object values in definite expression calls after %s",
		(prefix) => {
			// Given an object value in a call, not a parameter binding or declaration type.
			const text = `${prefix}{${members}});`;
			// When scanning; then only its five member lines are elided.
			expect(fold(text)).toEqual({ status: "parsed", text, ranges: [{ startLine: 2, endLine: 6, children: [] }] });
		},
	);
	it("folds returned object values in an untyped callback argument", () => {
		// Given a value callback in a proven call, with no return-type annotation.
		const text = `const values = Array.from([], (item) => ({${members}}));`;
		// When scanning; then the returned object's member lines are a value, not a signature.
		expect(fold(text)).toEqual({ status: "parsed", text, ranges: [{ startLine: 2, endLine: 6, children: [] }] });
	});
	it.each([
		["interface Factory extends Base {", "}"],
		["type Factory = {", "};"],
		["const values = Array.from([], (item): () => {", "} => value);"],
		["type Constructor = new ({", "}) => Value;"],
		["function factory({", "}) {}"],
		["const factory = function({", "}) {};"],
		["class Factory {\nmethod({", "}) {}\n}"],
		["interface Factory {\nmethod({", "}): void;\n}"],
		["function factory(value = object.call({", "})) {}"],
		["const factory = ({", "}) => {};"],
		["function factory(): () => {", "} { return value; }"],
	])("retains signature members after %s", (prefix, suffix) => {
		// Given ambiguous declaration/default/type syntax sharing the call's braces.
		const text = `${prefix}${members}${suffix}`;
		// When scanning; then the signature is protected (or classified raw), never partially folded.
		const parsed = fold(text);
		switch (parsed.status) {
			case "parsed": {
				const ranges = [...parsed.ranges];
				for (let i = 0; i < ranges.length; i++) ranges.push(...ranges[i].children);
				const firstMember = prefix.split("\n").length + 1;
				expect(ranges.filter((range) => range.startLine >= firstMember && range.endLine < firstMember + 5)).toEqual(
					[],
				);
				break;
			}
			case "parse_failure":
				break;
			case "unsupported":
				expect.fail("A .ts fixture must reach lexical classification");
				break;
			default:
				parsed satisfies never;
		}
	});
	it.each(["Promise<void>", 'Record<string, Array<"x" | "y">>', "Pick<Example, 'member'>"])(
		"retains brace-free type arguments %s without rejecting unrelated bodies",
		(type) => {
			// Given a simple type argument span followed by an independent implementation body.
			const text = `let value: ${type};\nfunction body() {${members}}`;
			// When scanning; then the independent body can fold, not the type arguments.
			expect(fold(text)).toEqual({ status: "parsed", text, ranges: [{ startLine: 3, endLine: 7, children: [] }] });
		},
	);
});
