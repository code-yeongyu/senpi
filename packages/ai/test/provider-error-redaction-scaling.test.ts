// The credential redactor runs synchronously on every provider error (the stream boundary) and every log line, so its
// work must grow linearly with the input (senpi#4283). Each shape stresses one path of the scanner; count character
// reads at 1x, 10x and 100x, independent of host load or GC.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { redactCredentialShapes, redactSecrets } from "../src/utils/provider-error.ts";
import { characterReads } from "./redaction-work.ts";

const fill = (unit: string, size: number): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

const SHAPES: readonly (readonly [label: string, make: (size: number) => string])[] = [
	["one huge token with no delimiter", (size) => "a".repeat(size)],
	["sk- near misses", (size) => fill("sk-abcd ", size)],
	["eyJ- runs", (size) => fill("eyJ-", size)],
	["eyJ_ runs", (size) => fill("eyJ_", size)],
	["1eyJ runs", (size) => fill("1eyJ", size)],
	["JWT-like tokens one segment short", (size) => fill("eyJaaaaaaaa.bbbbb ", size)],
	["one dotted token past three segments", (size) => `eyJ${fill("aaaaa.", size)}`],
	["AKIA near misses", (size) => fill("AKIA0123 ", size)],
	["a long run after a name separator", (size) => `api_key: ${"a".repeat(size)}`],
	["a deep name before a colon", (size) => `${"a".repeat(size)}: x`],
	["a deep separated name before =", (size) => `${fill("a_", size)}=x`],
	["a deep camelCase name", (size) => `${fill("aB", size)}: x`],
	["a keyword repeated", (size) => fill("aaaaakey", size)],
	["short credential values", (size) => fill("key: a ", size)],
	["separators", (size) => fill("a:", size)],
	["whitespace after a name", (size) => `key:${" ".repeat(size)}`],
	["cookie pairs", (size) => `Cookie: ${fill("a=1; ", size)}`],
	["cookie names", (size) => fill("Cookie: ", size)],
	["open credential objects", (size) => fill("api_key: {", size)],
	["XML credential tags", (size) => fill("<apiKey>", size)],
	["URL userinfo heads", (size) => fill("https://u:", size)],
	["bearer schemes", (size) => fill("bearer ", size)],
	["escaped quotes after a name", (size) => `key${fill('\\"', size)}`],
	["percent escapes", (size) => fill("%41", size)],
	["encoded / and near misses inside one token", (size) => fill("%2Fsk-abcd%2FeyJ", size)],
	["one arbitrarily deep encoded boundary", (size) => `x%${"25".repeat(size)}2Fsk-abcd`],
	["deep encoded delimiter", (size) => `api_key%${"25".repeat(size)}3Dx`],
	["repeated nested escapes", (size) => fill("%25252Fsk-abcd", size)],
	["independently encoded hex digits", (size) => fill("%25%32%46sk-abcd", size)],
	["mixed-depth encoded hex digits", (size) => fill("%2525%32Fsk-abcd", size)],
	["encoded JWT dots", (size) => fill("/eyJaaaaaaaa%25%32%45bbbbb%2Eccccc", size)],
	["unresolved percent window", (size) => `${"%".repeat(size)}32Fsk-abcd`],
	["deep encoded hex digit", (size) => `x%25%${"25".repeat(size)}32Fsk-abcd`],
	["HTML entities", (size) => fill("&quot;", size)],
	["130-character names", (size) => fill(`${"a".repeat(130)}_api_key: x `, size)],
	["model-not-found prose heads", (size) => fill("the model ", size)],
	// Round 8: shapes recognized anywhere a word starts inside one long token, and whole strict values.
	["sk- near misses inside one token", (size) => fill("/sk-abcd", size)],
	["ghp_ near misses inside one token", (size) => fill("/ghp_abc", size)],
	["AKIA near misses inside one token", (size) => fill("+AKIA0123", size)],
	["every prefix near miss inside one token", (size) => fill("/sk-a~gsk_a+xai-a/hf_a-xoxb-a/AIza.eyJ.", size)],
	["eyJ candidates after / inside one token", (size) => fill("/eyJaaaaaaaa.bbbbb", size)],
	["dotted eyJ segments after hyphens", (size) => fill("-eyJaaaaaaaa.", size)],
	["eyJ candidates in one dotless segment", (size) => fill("-eyJ", size)],
	["a long quoted strict value", (size) => `password: "${fill("ab c!", size)}"`],
	["a long unclosed quoted strict value", (size) => `password: "${fill("ab c!", size)}`],
	["a long bare strict value", (size) => `password=${fill("p@ss:", size)}`],
	["strict names opening quotes", (size) => fill('password: "', size)],
	["escaped quotes inside a strict value", (size) => `secret: "${fill('a\\"', size)}"`],
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

describe("redactSecrets grows linearly", () => {
	for (const [label, make] of SHAPES) {
		it(`on ${label}`, () => {
			for (const ratio of growth((text) => redactSecrets(text), make)) expect(ratio).toBeLessThan(MAX_GROWTH);
		});
		it(`in shapes mode on ${label}`, () => {
			for (const ratio of growth((text) => redactCredentialShapes(text), make))
				expect(ratio).toBeLessThan(MAX_GROWTH);
		});
	}

	it("at the stream boundary", () => {
		const push = (errorMessage: string): void => {
			const error: AssistantMessage = {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "faux",
				model: "faux-1",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage,
				timestamp: 0,
			};
			new AssistantMessageEventStream().push({ type: "error", reason: "error", error });
		};
		for (const ratio of growth(push, (size) => fill("eyJ-", size))) expect(ratio).toBeLessThan(MAX_GROWTH);
	});
});

// Every regular expression literal in a source file, read with a small lexer: a "/" that starts an expression (after an
// operator or opening bracket) up to its unescaped closing "/" outside a character class.
function regexLiterals(source: string): string[] {
	const found: string[] = [];
	let previous = "";
	for (let i = 0; i < source.length; i++) {
		const c = source[i] ?? "";
		const next = source[i + 1] ?? "";
		if (c === "/" && (next === "/" || next === "*")) {
			const close = next === "/" ? "\n" : "*/";
			i = source.indexOf(close, i + 2);
			if (i < 0) break;
			i += close.length - 1;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			for (i++; i < source.length && source[i] !== c; i++) if (source[i] === "\\") i++;
			previous = c;
			continue;
		}
		if (c === "/" && "(,=:[!&|?{};".includes(previous)) {
			let inClass = false;
			let j = i + 1;
			for (; j < source.length; j++) {
				const d = source[j];
				if (d === "\\") j++;
				else if (d === "[") inClass = true;
				else if (d === "]") inClass = false;
				else if (d === "/" && !inClass) break;
			}
			found.push(source.slice(i + 1, j));
			i = j;
			previous = "/";
			continue;
		}
		if (c.trim() !== "") previous = c;
	}
	return found;
}

const QUANTIFIER_START = new Set(["*", "+", "{"]);

/** True when a quantified group contains a quantifier: (a+)+, (?:x*y)*, (a{1,})+. */
function hasNestedQuantifier(pattern: string): boolean {
	const stack: boolean[] = [];
	let quantified = false;
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i] ?? "";
		if (c === "\\") {
			i++;
			continue;
		}
		if (c === "[") {
			for (i++; i < pattern.length && pattern[i] !== "]"; i++) if (pattern[i] === "\\") i++;
			continue;
		}
		if (c === "(") {
			stack.push(quantified);
			quantified = false;
		} else if (c === ")") {
			const inner = quantified;
			quantified = stack.pop() ?? false;
			if (inner && QUANTIFIER_START.has(pattern[i + 1] ?? "")) return true;
			if (inner) quantified = true;
		} else if (QUANTIFIER_START.has(c) || (c === "?" && pattern[i - 1] !== "(")) quantified = true;
	}
	return false;
}

const REDACTOR_SOURCES = [
	"../src/utils/provider-error.ts",
	"../src/utils/secret-redaction.ts",
	"../src/utils/secret-lexer.ts",
	"../src/utils/secret-classifier.ts",
	"../../coding-agent/src/core/sensitive-output.ts",
];

// An architecture contract, not a behavior test: the redactor runs synchronously on every provider error and log line,
// so it must stay linear by construction (senpi#4283). The secret-* scanner modules hold no regular expression at all,
// and the remaining redactor sources hold none with a nested quantifier, the shape that backtracks. Work-count tests only
// sample shapes; this guard keeps a new pattern from reintroducing the class they cannot all cover.

describe("the redactor sources", () => {
	it("recognizes a nested quantifier", () => {
		expect([String.raw`(a+)+`, String.raw`(?:x*y)*`, String.raw`(a{1,})+`].map(hasNestedQuantifier)).toEqual([
			true,
			true,
			true,
		]);
		expect([String.raw`a+b*`, String.raw`(ab)+`, String.raw`[(+)]+`].map(hasNestedQuantifier)).toEqual([
			false,
			false,
			false,
		]);
	});

	for (const path of REDACTOR_SOURCES) {
		it(`${path} has no regular expression with a nested quantifier`, () => {
			const source = readFileSync(new URL(path, import.meta.url), "utf8");
			expect(source).not.toContain("new RegExp(");
			if (!path.includes("/secret-")) expect(regexLiterals(source).length).toBeGreaterThan(0);
			expect(regexLiterals(source).filter(hasNestedQuantifier)).toEqual([]);
		});
	}

	it("the token scanner uses no regular expression at all", () => {
		for (const path of REDACTOR_SOURCES.filter((name) => name.includes("/secret-"))) {
			expect({ path, literals: regexLiterals(readFileSync(new URL(path, import.meta.url), "utf8")) }).toEqual({
				path,
				literals: [],
			});
		}
	});
});
