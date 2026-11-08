import { describe, expect, it } from "vitest";

// r11.1 R7/R8: the lint exempts a module-level literal only `as const`, and tsc is the reference analysis.
// Each line below is a write the type checker must refuse; if one ever compiles, the directive is unused and
// `bun run check` fails with TS2578.
const TABLE = { key: "value", list: ["a", "b"] } as const;
const KEYS = ["a", "b"] as const;

function mutableParameter(keys: string[]): number {
	return keys.length;
}

function readonlyParameter(keys: readonly string[]): number {
	return keys.length;
}

describe("as const tables are write-proof at the type level", () => {
	it("refuses a property write on an as const object", () => {
		const attempt = () => {
			// @ts-expect-error -- R7 mutant: a property write on an `as const` table must not type-check.
			TABLE.key = "changed";
		};
		expect(typeof attempt).toBe("function");
	});

	it("refuses push on an as const array", () => {
		// @ts-expect-error -- R7 mutant: push does not exist on a readonly tuple.
		const push = () => KEYS.push("c");
		expect(typeof push).toBe("function");
	});

	it("refuses an as const tuple passed to a mutable array parameter", () => {
		// @ts-expect-error -- R7 mutant: a readonly tuple is not assignable to `string[]`.
		const call = () => mutableParameter(KEYS);
		expect(typeof call).toBe("function");
		expect(readonlyParameter(KEYS)).toBe(2);
	});
});
