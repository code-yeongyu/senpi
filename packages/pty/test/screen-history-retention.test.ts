import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sanitizedTail, sanitizeString } from "../src/screen-text.ts";

// Retention contract (senpi#3170): every PTY chunk a terminal screen keeps for resize replay goes through
// sanitizeString, and a screen keeps up to 1,000,000 replay chars. A string built one character at a time
// stays a rope of per-character nodes (about 31 bytes per char under JSC and V8), so one busy terminal held
// tens of MB of history alone. A trimmed oversized chunk must not pin the chunk it was cut from either.
const screenTextUrl = new URL("../src/screen-text.ts", import.meta.url).href;
const screenUrl = new URL("../src/screen.ts", import.meta.url).href;

/** Runs `body` in a fresh process of the current runtime with a forced-GC heap probe; returns its last JSON line. */
function measure<T>(body: string): T {
	const prelude = `
const collect = typeof Bun !== "undefined" ? () => Bun.gc(true) : () => globalThis.gc();
const heapUsed = async () => { for (let i = 0; i < 3; i++) { await new Promise(setImmediate); collect(); } return process.memoryUsage().heapUsed; };
`;
	const args =
		process.versions.bun === undefined
			? ["--expose-gc", "--import", "tsx", "--input-type=module", "--eval", prelude + body]
			: ["--eval", prelude + body];
	const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 120_000 });
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
}

describe("sanitizeString", () => {
	it("returns valid text unchanged and replaces lone surrogates", () => {
		const text = "row 1 \u001b[31mred\u001b[0m 한글 😀\r\n";
		expect(sanitizeString(text)).toBe(text);
		expect(sanitizeString("a\ud800b\udc00c\ud83d")).toBe("a\uFFFDb\uFFFDc\uFFFD");
		expect(sanitizeString("")).toBe("");
		expect(sanitizedTail("abc\ud83d\ude00", 2)).toBe("\ud83d\ude00");
		expect(sanitizedTail("abc\ud83d\ude00", 1)).toBe("\uFFFD");
	});

	it("keeps retained replay chunks near one byte per char", () => {
		// Given: 200 flat PTY-sized chunks (~5k chars each), every tenth one carrying a lone surrogate.
		const result = measure<{ chars: number; repaired: number; bytesPerChar: number }>(`
const { sanitizeString } = await import(${JSON.stringify(screenTextUrl)});
const chunk = (k) => Array.from({ length: 64 }, (_, j) => "row " + k + "-" + j + " " + "z".repeat(60) + " fn" + j + "()\\r\\n").join("") + (k % 10 === 7 ? "\\ud800" : "");
const inputs = Array.from({ length: 200 }, (_, k) => JSON.parse(JSON.stringify(chunk(k))));
const before = await heapUsed();
// When: the sanitized chunks are kept, as the screen's replay history keeps them.
const kept = inputs.map((input) => sanitizeString(input));
inputs.length = 0;
const after = await heapUsed();
const chars = kept.reduce((total, text) => total + text.length, 0);
const repaired = kept.filter((text) => text.endsWith("\\uFFFD")).length;
console.log(JSON.stringify({ chars, repaired, bytesPerChar: (after - before) / chars }));
`);
		// Then: the kept text, repaired chunks included, costs what flat strings cost.
		expect(result.chars).toBeGreaterThan(900_000);
		expect(result.repaired).toBe(20);
		expect(result.bytesPerChar).toBeLessThan(4);
	});

	it("does not keep an oversized chunk alive after trimming it to the replay cap", () => {
		// Given: a small screen (4,096-char replay cap) fed one 4,000,000-char chunk.
		const result = measure<{ retainedBytes: number }>(`
const { TerminalScreen } = await import(${JSON.stringify(screenUrl)});
const screen = new TerminalScreen({ cols: 10, rows: 3, scrollback: 10 });
await screen.flush();
const before = await heapUsed();
// When: the chunk has been parsed and only the trimmed history still references it.
await screen.feed(JSON.parse(JSON.stringify("y".repeat(3_999_999) + "\\n")));
await screen.flush();
const after = await heapUsed();
console.log(JSON.stringify({ retainedBytes: after - before }));
screen.dispose();
`);
		// Then: the screen keeps about its cap, not the 4,000,000-char chunk (4-8 MB).
		expect(result.retainedBytes).toBeLessThan(1_000_000);
	});
});
