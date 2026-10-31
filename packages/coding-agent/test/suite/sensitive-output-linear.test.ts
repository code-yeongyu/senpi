// Every sink of provider error text runs the session's redaction (sensitive-output.ts) synchronously, so its work
// must grow linearly with the input (senpi#4283). Count scanner character reads from 1x to 10x to 100x, not wall time.

import { describe, expect, it } from "vitest";
import { characterReads } from "../../../ai/test/redaction-work.ts";
import { redactSecrets, redactSensitiveOutput } from "../../src/core/sensitive-output.ts";

const fill = (unit: string, size: number): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

const SHAPES: readonly (readonly [label: string, make: (size: number) => string])[] = [
	["one environment-name run", (size) => "A".repeat(size)],
	["separated credential words", (size) => fill("A_TOKEN_", size)],
	["a keyword repeated", (size) => fill("TOKEN", size)],
	["environment assignments", (size) => fill("MY_TOKEN=", size)],
	["spaces after an Authorization header", (size) => `Authorization:${" ".repeat(size)}`],
	["spaces after Bearer", (size) => `Bearer${" ".repeat(size)}`],
	["a ghp_ run ending in a word character", (size) => `ghp_${"a".repeat(size)}_`],
	["eyJ- runs", (size) => fill("eyJ-", size)],
	["a deep name before a colon", (size) => `${"a".repeat(size)}: x`],
	["cookie pairs", (size) => `Cookie: ${fill("a=1; ", size)}`],
];

const BASE = 10_000;
// A linear pass grows about 10x per step; a quadratic one grows 100x.
const MAX_GROWTH = 30;

function growth(run: (text: string) => void, make: (size: number) => string): readonly number[] {
	const reads = [BASE, BASE * 10, BASE * 100].map((size) => {
		const text = make(size);
		return characterReads(() => run(text));
	});
	return [1, 2].map((step) => (reads[step] ?? 0) / Math.max(reads[step - 1] ?? 0, 1));
}

describe("the session redaction grows linearly", () => {
	for (const [label, make] of SHAPES) {
		it(`on ${label}`, () => {
			for (const run of [redactSensitiveOutput, redactSecrets]) {
				for (const ratio of growth((text) => run(text), make)) expect(ratio).toBeLessThan(MAX_GROWTH);
			}
		});
	}

	it("still redacts an environment assignment past the old 128-character name window", () => {
		const name = `${"A".repeat(130)}_TOKEN`;
		expect(redactSensitiveOutput(`${name}=short`)).toBe(`${name}=[REDACTED]`);
	});
});
