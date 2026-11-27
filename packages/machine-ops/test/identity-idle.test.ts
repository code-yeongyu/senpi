import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IdentityOutputStream, redactIdentityText } from "../src/index.ts";

// senpi#7528: an idle flush shows a waiting prompt, but a human-record key stays held until its
// value is decided, whatever the gap, so a stream decides exactly what the whole text decides.
const IDLE = Symbol("idle");
type Part = string | typeof IDLE;
const secret = randomBytes(36).toString("base64");

function stream(parts: Part[]): string {
	const s = new IdentityOutputStream();
	let out = "";
	for (const part of parts) out += part === IDLE ? s.flushIdle() : s.push(part);
	return out + s.finish();
}
const whole = (parts: Part[]) => parts.filter((p): p is string => p !== IDLE).join("");

type Family = (gap: number, key: string, space: string) => Part[];
const header = '{"kind":"human","v":1,';
const families: Record<string, Family> = {
	"A filler, idle, key and value in one push": (g, k) => [
		`${header}"note":"${"x".repeat(g)}",`,
		IDLE,
		`"${k}":"${secret}"}\n`,
	],
	"B idle around filler and key": (g, k) => [
		header,
		IDLE,
		`"note":"${"x".repeat(g)}",`,
		IDLE,
		`"${k}":`,
		IDLE,
		`"${secret}"}\n`,
	],
	"C gap after the colon, idle, value": (g, k, sp) => [`${header}"${k}":${sp.repeat(g)}`, IDLE, `"${secret}"}\n`],
	"D value before the discriminators": (g, k) => [
		`{"note":"${"x".repeat(g)}","${k}":"`,
		IDLE,
		`${secret}",`,
		IDLE,
		`"kind":"human","v":1}\n`,
	],
	"E pretty-printed lines, idle, key line": (g, k) => [
		`{\n  "kind": "human",\n  "v": 1,\n${'  "f": 1,\n'.repeat(Math.ceil(g / 10))}`,
		IDLE,
		`  "${k}": "${secret}"\n}\n`,
	],
	"F key pushed one character per idle": (g, k) => [
		`${header}"note":"${"x".repeat(g)}",`,
		...[...`"${k}":"`].flatMap((c): Part[] => [c, IDLE]),
		`${secret}"}\n`,
	],
	"G value in 8-character pieces with idle between": (g, k) => [
		`${header}"note":"${"x".repeat(g)}","${k}":"`,
		...(secret.match(/.{1,8}/g) ?? []).flatMap((c): Part[] => [IDLE, c]),
		IDLE,
		'"}\n',
	],
	"H discriminators after the key, idle between": (g, k) => [
		`{"note":"${"x".repeat(g)}","${k}":`,
		IDLE,
		`"${secret}",`,
		IDLE,
		'"kind":"human",',
		IDLE,
		'"v":1}\n',
	],
	"I nested in an array in an object": (g, k) => [
		`{"list":[{"kind":"human","v":1,"note":"${"x".repeat(g)}","${k}":`,
		IDLE,
		`"${secret}"}]}\n`,
	],
	"J a second record after a first one": (g, k) => [
		`${header}"${k}":"${secret}"}\n${header}"note":"${"x".repeat(g)}","${k}":`,
		IDLE,
		`"${secret}"}\n`,
	],
};
const gaps = [0, 64, 120, 127, 128, 129, 140, 200, 400, 4000, 70000];
const keys = { secretKey: "secretKey", sealedKey: "sealedKey", "a unicode-escaped key": "secret\\u004bey" };
const spaces = { spaces: " ", "CR/LF": "\r\n", "LF and indentation": "\n  " };

describe("idle flushes never release a human-record key before its value", () => {
	const rows = Object.entries(families).flatMap(([family, build]) =>
		Object.entries(keys).flatMap(([keyName, key]) =>
			Object.entries(spaces).flatMap(([spaceName, space]) =>
				gaps.map((gap) => [`${family}, ${keyName}, ${spaceName}, gap ${gap}`, build(gap, key, space)] as const),
			),
		),
	);
	it.each(rows)("%s", (_name, parts) => {
		const out = stream(parts);
		expect(out.includes(secret.slice(0, 16))).toBe(false);
		expect(out === redactIdentityText(whole(parts))).toBe(true);
	});

	it("keeps a key with 150 spaces before its colon across idle flushes", () => {
		const parts: Part[] = [
			`${header}"note":"${"x".repeat(200)}","secretKey"`,
			IDLE,
			" ".repeat(150),
			IDLE,
			":",
			IDLE,
			` "${secret}"}\n`,
		];
		const out = stream(parts);
		expect(out.includes(secret.slice(0, 16))).toBe(false);
		expect(out === redactIdentityText(whole(parts))).toBe(true);
	});

	it("matches the whole text for 0 to 2,000 spaces before and after the colon", () => {
		let mismatches = 0;
		for (let gap = 0; gap <= 2000; gap++) {
			for (const parts of [
				[`${header}"secretKey"`, IDLE, " ".repeat(gap), IDLE, ":", IDLE, ` "${secret}"}\n`],
				[`${header}"secretKey":`, IDLE, " ".repeat(gap), IDLE, `"${secret}"}\n`],
				[`${header}"secretKey"${" ".repeat(gap)}:${" ".repeat(gap)}`, IDLE, `"${secret}"}\n`],
			] satisfies Part[][]) {
				const out = stream(parts);
				if (out.includes(secret.slice(0, 16)) || out !== redactIdentityText(whole(parts))) mismatches++;
			}
		}
		expect(mismatches).toBe(0);
	});

	it("decides two records back to back independently", () => {
		const parts: Part[] = [
			`${header}"secretKey":`,
			IDLE,
			`"${secret}"}\n{"kind":"machine","v":1,"secretKey":`,
			IDLE,
			'"public-label"}\n',
		];
		const out = stream(parts);
		expect(out).toBe(`${header}"secretKey":"[REDACTED]"}\n{"kind":"machine","v":1,"secretKey":"public-label"}\n`);
	});

	it("keeps a non-human record's key visible after a human record", () => {
		for (const gap of gaps) {
			const parts: Part[] = [
				`${header}"secretKey":"${secret}"}\n{"kind":"machine","v":1,"note":"${"x".repeat(gap)}","secretKey":`,
				IDLE,
				'"public-label"}\n',
			];
			const out = stream(parts);
			expect(out.includes("public-label") && !out.includes(secret.slice(0, 16))).toBe(true);
			expect(out === redactIdentityText(whole(parts))).toBe(true);
		}
	});

	// Past the 64 KiB context the window starts inside earlier output; it is parsed from the
	// recorded state there, not re-parsed from the cut.
	it.each([
		["a long quoted value", '"'],
		["a long apostrophe-quoted value", "'"],
	])("decides a record after %s that has left the context", (_name, quote) => {
		for (const size of [65536, 70000, 140000]) {
			const parts: Part[] = [
				`{"a":${quote}${'z\\"'.repeat(size / 3)}${quote}}{"kind":"human","v":1,"secretKey":`,
				IDLE,
				`"${secret}"}\n`,
			];
			const out = stream(parts);
			expect(out.includes(secret.slice(0, 16))).toBe(false);
			expect(out === redactIdentityText(whole(parts))).toBe(true);
		}
	});

	// Review M2: a whole key and its gap are public; they stream out while the record stays
	// awaiting its value, so a long gap costs linear time and holds nothing.
	it("streams a megabyte of whitespace after a key and still masks the value", () => {
		const line = `${" ".repeat(63)}\n`;
		const run = (lines: number) => {
			const s = new IdentityOutputStream();
			const started = performance.now();
			let shown = s.push(`${header}"secretKey":`);
			let sent = shown.length;
			for (let i = 0; i < lines; i++) {
				shown += s.push(line) + s.flushIdle();
				sent += line.length;
				if (s.holding || shown.length !== sent) throw new Error(`held output after line ${i}`);
			}
			shown += s.push(`"${secret}"}\n`) + s.finish();
			return { shown, ms: performance.now() - started };
		};
		const lines = 16384;
		const { shown } = run(lines);
		expect(shown).toBe(`${header}"secretKey":${line.repeat(lines)}"[REDACTED]"}\n`);
		const best = (n: number) => Math.min(...[0, 1, 2].map(() => run(n).ms));
		expect(best(lines) / best(lines / 2)).toBeLessThan(2.5);
	});

	it("ends the wait for a value when the record closes without one", () => {
		const parts: Part[] = [
			`${header}"secretKey":   `,
			IDLE,
			"}\n",
			IDLE,
			`"${secret}" is ordinary text\nREADY`,
			IDLE,
		];
		const s = new IdentityOutputStream();
		let shown = "";
		for (const part of parts) {
			shown += part === IDLE ? s.flushIdle() : s.push(part);
			if (part === IDLE) expect(s.holding).toBe(false);
		}
		expect(shown).toBe(whole(parts));
		expect(shown + s.finish()).toBe(redactIdentityText(whole(parts)));
	});

	it("shows a waiting prompt on idle and holds nothing after a closed record", () => {
		const s = new IdentityOutputStream();
		expect(s.push('{"secretKey":"public","kind":"machine"}\nEnter a value: ') + s.flushIdle()).toBe(
			'{"secretKey":"public","kind":"machine"}\nEnter a value: ',
		);
	});

	it("releases a held key and its gap at the end instead of dropping them", () => {
		const text = `${header}"secretKey":${" ".repeat(70000)}`;
		const s = new IdentityOutputStream();
		expect(s.push(text) + s.flushIdle() + s.finish()).toBe(text);
	});
});
