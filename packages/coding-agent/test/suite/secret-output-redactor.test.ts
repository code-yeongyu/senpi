import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { SecretOutputRedactor } from "../../src/core/tools/secret-output-redactor.ts";
import { secretOutputCases } from "./bash-redaction-fixtures.ts";

describe("streaming secret tokenizer", () => {
	it.each(["AWS", "Google", "JWT", "Bearer"])("withholds %s bodies across repeated idle pauses", (name) => {
		const fixture = secretOutputCases().find((entry) => entry.name === name);
		assert(fixture);
		const split = name === "JWT" ? fixture.input.lastIndexOf(".") : fixture.input.length - 1;
		const redactor = new SecretOutputRedactor();
		const visible = name === "Bearer" ? "Bearer " : "";
		expect(redactor.push(fixture.input.slice(0, split)) + redactor.flushIdle()).toBe(visible);
		expect(redactor.flushIdle()).toBe("");
		expect(redactor.push(fixture.input.slice(split)) + redactor.flushIdle()).toBe("");
		expect(visible + redactor.push(" done\n") + redactor.finish()).toBe(`${fixture.expected} done\n`);
	});
	it.each(["I", "e.g.", "git", "sk", "AI", "s", "g", "x", "A", "AK", "e"])(
		"releases ordinary idle fragment %s verbatim",
		(input) => {
			const redactor = new SecretOutputRedactor();
			expect(redactor.push(input) + redactor.flushIdle()).toBe(input);
			expect(redactor.finish()).toBe("");
		},
	);
	it.each([
		"AKIA",
		"AIza",
		"eyJ",
		"ghp_",
		"gho_",
		"ghs_",
		"ghu_",
		"ghr_",
		"github_pat_",
		"xoxb-",
		"sk-",
		"sk-ant-",
		"sk-proj-",
	])("sanitizes %s shapes at EOF without duplicating published prefixes", (prefix) => {
		for (const published of [0, prefix.startsWith("sk-") ? 2 : prefix.length - 1]) {
			const redactor = new SecretOutputRedactor();
			expect(redactor.push(prefix.slice(0, published)) + redactor.flushIdle()).toBe(prefix.slice(0, published));
			expect(redactor.push(prefix.slice(published) + "a".repeat(2)) + redactor.flushIdle()).toBe("");
			const incomplete = ["AKIA", "AIza", "eyJ"].includes(prefix);
			expect(redactor.finish()).toBe(`${incomplete ? prefix.slice(published) : ""}<redacted>`);
		}
	});
	it("withholds a short Bearer value until it completes", () => {
		const redactor = new SecretOutputRedactor();
		expect(redactor.push(["Bearer ", "abcdef"].join("")) + redactor.flushIdle()).toBe("Bearer ");
		expect(redactor.push("1-ghijklmnop") + redactor.flushIdle()).toBe("");
		expect(redactor.push("\n") + redactor.finish()).toBe("<redacted>\n");
	});
	it.each([
		"ghp_",
		"gho_",
		"ghs_",
		"ghu_",
		"ghr_",
		"github_pat_",
		"xoxa-",
		"xoxb-",
		"xoxp-",
		"xoxo-",
		"xoxr-",
		"xoxs-",
		"sk-",
		"sk-ant-",
		"sk-proj-",
		"AKIA",
		"AIza",
		"eyJ",
	])("sanitizes an unfinished public prefix %s at EOF", (prefix) => {
		const redactor = new SecretOutputRedactor();
		expect(redactor.push(prefix) + redactor.flushIdle()).toBe("");
		expect(redactor.finish()).toBe(`${prefix}<redacted>`);
	});
	it.each(["", "https://", "prefix.", "--flag="])(
		"withholds an ANSI-styled cloud key after %j and sanitizes EOF",
		(leading) => {
			const redactor = new SecretOutputRedactor();
			const input = `${leading}AK\x1b[31mIA${"A1".repeat(3)}`;
			expect(redactor.push(input) + redactor.flushIdle()).toBe(leading === "https://" ? "https:" : "");
			expect(redactor.finish()).toBe(`\x1b[31m${leading === "https://" ? "//" : leading}AKIA<redacted>`);
		},
	);
	it("releases non-secret Bearer prose at a delimiter, but masks an unfinished value at EOF", () => {
		const redactor = new SecretOutputRedactor();
		expect(redactor.push("Bearer ordinary") + redactor.flushIdle()).toBe("Bearer ");
		expect(redactor.push(" words\n")).toBe("ordinary words\n");
		expect(redactor.push("Bearer abc") + redactor.flushIdle()).toBe("Bearer ");
		expect(redactor.finish()).toBe("<redacted>");
	});
	it("releases an incomplete cloud shape verbatim at a delimiter", () => {
		const redactor = new SecretOutputRedactor();
		const input = ["AK", "IA", "AB"].join("");
		expect(redactor.push(input) + redactor.flushIdle()).toBe("");
		expect(redactor.push(" ") + redactor.finish()).toBe(`${input} `);
	});
	it("never publishes a secret assignment body at idle or EOF", () => {
		const redactor = new SecretOutputRedactor();
		expect(redactor.push("API_KEY") + redactor.flushIdle()).toBe("API_KEY");
		expect(redactor.push("=synthetic") + redactor.flushIdle()).toBe("=<redacted>");
		expect(redactor.push("-tail") + redactor.flushIdle() + redactor.finish()).toBe("");
	});
	it.each(["https://", "--github-token=", "/tmp/", "value=", "YWJj/", "prefix.", "prefix-", "prefix+", "prefix~"])(
		"redacts prefixed credentials embedded after %s at every split",
		(prefix) => {
			for (const { input } of secretOutputCases().filter(({ name }) => /^(prefix|AWS|Google)/.test(name))) {
				const text = `${prefix}${input}@host\n`;
				for (let split = 1; split < text.length; split++) {
					const redactor = new SecretOutputRedactor();
					const output =
						redactor.push(text.slice(0, split)) + redactor.push(text.slice(split)) + redactor.finish();
					expect(output).not.toContain(input);
					expect(output).toContain("<redacted>");
					expect(output).toContain("@host\n");
				}
			}
		},
	);
	it.each(["(", ")", "*", "+"])("consumes the full ESC %s charset designation", (designator) => {
		const fixture = secretOutputCases()[0];
		assert(fixture);
		const control = `\x1b${designator}B\x1b[m`;
		const input = `${control}${fixture.input}\n`;
		const redactor = new SecretOutputRedactor();
		expect([...input].map((c) => redactor.push(c)).join("") + redactor.finish()).toBe(`${control}<redacted>\n`);
	});
	it("does not classify author metadata as an AUTH key", () => {
		const redactor = new SecretOutputRedactor();
		const input = "GIT_AUTHOR_NAME=Jane Doe\nAUTH=private\nHTTP_AUTHORIZATION=private\n";
		expect(redactor.push(input) + redactor.finish()).toBe(
			"GIT_AUTHOR_NAME=Jane Doe\nAUTH=<redacted>\nHTTP_AUTHORIZATION=<redacted>\n",
		);
	});
	it("requires a token-shaped Bearer value rather than the next prose word", () => {
		const redactor = new SecretOutputRedactor();
		const input = "the bearer of this\nBearer ordinary words\n";
		expect(redactor.push(input) + redactor.finish()).toBe(input);
	});
	it.each(["'", '"'])("bounds an unclosed %s secret value at a newline", (quote) => {
		const redactor = new SecretOutputRedactor();
		const input = `PASSWORD=${quote}\nline2\nline3`;
		expect([...input].map((c) => redactor.push(c)).join("") + redactor.finish()).toBe(
			`PASSWORD=${quote}<redacted>\nline2\nline3`,
		);
	});
	it("redacts punctuation inside an unquoted secret assignment", () => {
		const redactor = new SecretOutputRedactor();
		const input = "PASSWORD=synthetic,comma;tail/path after";
		expect(redactor.push(input) + redactor.finish()).toBe("PASSWORD=<redacted> after");
	});
	it("recognizes tokens across ANSI styling and discards hidden OSC payloads", () => {
		const fixture = secretOutputCases()[0];
		assert(fixture);
		const token = fixture.input;
		const input = `${token.slice(0, 2)}\x1b[31m${token.slice(2)}\x1b[0m\n\x1b]0;${token}\x07done`;
		const redactor = new SecretOutputRedactor();
		const output = [...input].map((c) => redactor.push(c)).join("") + redactor.finish();
		expect(output.replace(/\x1b\[[0-9;]*m/g, "")).toBe("<redacted>\ndone");
	});
	it("keeps redacted output stable when it crosses a second boundary", () => {
		const input = secretOutputCases()
			.map(({ expected }) => expected)
			.join("\n");
		const redactor = new SecretOutputRedactor();
		expect(redactor.push(input) + redactor.finish()).toBe(input);
	});
	it("keeps ordinary text and Unicode unchanged", () => {
		const redactor = new SecretOutputRedactor();
		const input = "build v1.2.3 /tmp/out.txt COUNT=12\n\u65e5\u672c\u8a9e \u{1f431}\n";
		expect([...input].map((c) => redactor.push(c)).join("") + redactor.finish()).toBe(input);
	});

	it("redacts an arbitrarily large undecided token without releasing a suffix", () => {
		const redactor = new SecretOutputRedactor();
		let output = "";
		for (let i = 0; i < 100; i++) output += redactor.push("a".repeat(4096));
		output += redactor.push("\nend") + redactor.finish();
		expect(output).toBe("<redacted>\nend");
		expect(redactor.finish()).toBe("");
	});

	it("keeps a quoted assignment private across escaped quotes", () => {
		const input = 'MY_SECRET="one \\" two three" after';
		const redactor = new SecretOutputRedactor();
		expect([...input].map((c) => redactor.push(c)).join("") + redactor.finish()).toBe('MY_SECRET="<redacted>" after');
	});

	it("redacts an unterminated PEM block at EOF", () => {
		const fixture = secretOutputCases().find(({ name }) => name === "PEM");
		assert(fixture);
		const input = fixture.input.split("\n").slice(0, 2).join("\n");
		const redactor = new SecretOutputRedactor();
		expect(redactor.push(input) + redactor.finish()).toBe("<redacted>");
	});

	it("redacts padded Bearer credentials and JWT headers with whitespace", () => {
		const jwt = [Buffer.from('{ "alg": "HS256" }').toString("base64url"), "payload", "signature"].join(".");
		const input = `Bearer ${["abc", "=def=="].join("")}\n${jwt}\n`;
		const redactor = new SecretOutputRedactor();
		expect([...input].map((c) => redactor.push(c)).join("") + redactor.finish()).toBe(
			"Bearer <redacted>\n<redacted>\n",
		);
	});
});
