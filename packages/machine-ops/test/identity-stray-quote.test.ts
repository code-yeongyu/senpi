import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IdentityOutputStream, redactIdentityText } from "../src/index.ts";

// senpi#7528 review M3: no JSON or Python string literal holds a raw line break, so one stray
// quote ends at the next line and cannot hide a later record from the parser; a secret key the
// parser could not place has its value masked (fail-safe). Review L5: render() is bounded by
// what the window can close, so unclosed braces cost linear time.
const secret = randomBytes(36).toString("base64");
const record = `{"kind":"human","v":1,"secretKey":"${secret}","sealedKey":"${secret}"}\n`;
const pretty = `${JSON.stringify(JSON.parse(record), null, 2)}\n`;

function streamed(text: string, piece: number): string {
	const s = new IdentityOutputStream();
	let out = "";
	for (let i = 0; i < text.length; i += piece) out += s.push(text.slice(i, i + piece)) + s.flushIdle();
	return out + s.finish();
}

const strays: Record<string, string> = {
	"one double quote on its own line": '"\n',
	"three double quotes": '"\n"\n"\n',
	"prose with one quote": 'unexpected token " at line 3\n',
	"an inch mark and fifty lines": `27" wide\n${"ordinary line\n".repeat(50)}`,
	"one apostrophe-quoted word left open": "echo 'hi\n",
	"an unterminated JSON value": '{"note":"never closed\n',
	"a quote inside a shell heredoc": 'cat <<EOF\nHe said "hello\nEOF\n',
	"colour codes around a quote": '\u001b[31m"\u001b[0m\n',
	"a quote and then 70 KB of lines": `"\n${"x".repeat(99)}\n`.repeat(700),
};

describe("a stray quote does not hide a later human record", () => {
	it.each(Object.entries(strays))("%s", (_name, stray) => {
		for (const text of [stray + record, stray + pretty, record + stray + record]) {
			const whole = redactIdentityText(text);
			expect(whole.includes(secret.slice(0, 16))).toBe(false);
			for (const piece of [7, 64, 4096]) expect(streamed(text, piece) === whole).toBe(true);
		}
	});

	it("masks a secret key the parser could not place on the record's own line", () => {
		for (const text of [
			`it"s {"kind":"human","v":1,"secretKey":"${secret}"}\n`,
			`x' {"kind":"human","v":1,"secret\\u004bey":"${secret}"}\n`,
		]) {
			const whole = redactIdentityText(text);
			expect(whole.includes(secret.slice(0, 16))).toBe(false);
			for (const piece of [1, 9, 64]) expect(streamed(text, piece) === whole).toBe(true);
		}
	});

	it("masks a human record whose own line an earlier escape shifted", () => {
		const text = `{"a":"b\\{"note":"a \\" b","kind":"human","v":1,"secretKey":"${secret}"}\n`;
		const whole = redactIdentityText(text);
		expect(whole.includes(secret.slice(0, 16))).toBe(false);
		for (const piece of [1, 9, 64]) expect(streamed(text, piece) === whole).toBe(true);
	});

	it("masks a human value that never closes past the hold bound", () => {
		const s = new IdentityOutputStream();
		let out = s.push('{"kind":"human","v":1,"secretKey":"');
		for (let i = 0; i < 64; i++) out += s.push("x".repeat(4096));
		expect((out + s.finish()).includes("x")).toBe(false);
	});

	// Review M4 and the reviewer's same-line and multi-line rows: no escape crosses a line break,
	// a secret value in no known object is masked, and a string ended by a line break leaves a
	// doubt mark that masks secret values until an object opens and closes cleanly at depth zero.
	it.each([
		["a backslash at a line end, then a pretty record", `path "a\\\n${pretty}`],
		["a backslash at a CRLF line end, then a pretty record", `path "a\\\r\n${pretty.replaceAll("\n", "\r\n")}`],
		["a backslash at a line end, then a compact record", `echo "C:\\dir\\\n${record}`],
		[
			"an open string ending in a backslash, on the record's line",
			`{"a":"b\\${record.replace('"v":1,', '"v":1,"note":"a\\"b",')}`,
		],
		["an unterminated quote on the record's line", `say "hi ${record}`],
		["a quote before the brace, then a pretty record", `result=" ${pretty}`],
		["a quote at the start of the kind line", pretty.replace('  "kind"', '"  "kind"')],
		["a quote at the start of the v line", pretty.replace('  "v"', '"  "v"')],
	])("masks %s", (_name, text) => {
		const whole = redactIdentityText(text);
		expect(whole.includes(secret.slice(0, 16))).toBe(false);
		for (const piece of [1, 7, 64, 4096]) expect(streamed(text, piece) === whole).toBe(true);
	});

	it("keeps a version-0 human record and a record after a clean object visible", () => {
		const v0 = `{"kind":"human","v":0,"secretKey":"public-label"}\n`;
		for (const text of [v0, `"\n{"done":true}\n{"kind":"robot","v":1,"secretKey":"public-label"}\n`]) {
			expect(redactIdentityText(text)).toBe(text);
			expect(streamed(text, 5)).toBe(text);
		}
	});

	it("keeps paired quotes, escaped quotes and non-human records as they are", () => {
		const robot = `{"kind":"robot","v":1,"secretKey":"public-label"}\n`;
		for (const text of [`"a" "b"\n${robot}`, `{"s":"x \\" y"}\n${robot}`, `it's\n${robot}`]) {
			expect(redactIdentityText(text)).toBe(text);
			expect(streamed(text, 5)).toBe(text);
		}
	});
});

describe("unclosed braces cost linear time", () => {
	it("doubles the work for twice the braces at most 2.5 times the time", () => {
		const run = (braces: number) => {
			const started = performance.now();
			const s = new IdentityOutputStream();
			let shown = 0,
				sent = 0;
			for (let i = 0; i < braces; i += 4096) shown += s.push("{".repeat(4096)).length;
			for (let i = 0; i < 1000; i++) {
				const line = `line ${i}\n`;
				shown += s.push(line).length;
				sent += line.length;
			}
			expect(shown).toBe(braces + sent);
			return performance.now() - started;
		};
		const best = (n: number) => Math.min(run(n), run(n), run(n));
		expect(best(262144) / best(131072)).toBeLessThan(2.5);
	});
});
