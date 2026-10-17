import { describe, expect, it } from "vitest";
import {
	redactShareText,
	type ShareRedactionContext,
	type ShareRedactionTally,
} from "../../../src/core/share/share-redaction.ts";
import { redactShareValue } from "../../../src/core/share/share-redaction-value.ts";

// senpi#3524: /share uploaded the session unredacted. Secrets are assembled at runtime so no
// credential-shaped literal sits in the repository.
const OPENAI_KEY = ["sk", "test", "0".repeat(24)].join("-");
const GITHUB_TOKEN = `${"ghp"}_${"a".repeat(36)}`;
const GITHUB_PAT = `${"github"}_pat_${"b".repeat(40)}`;
const SLACK_TOKEN = `${"xox"}b-${"1".repeat(12)}-abcdef`;
const AWS_KEY = `${"AKIA"}${"Q".repeat(16)}`;
const JWT = `${"eyJ"}${"h".repeat(12)}.${"p".repeat(12)}.${"s".repeat(12)}`;
const STRIPE_LIVE = ["sk", "live", "9".repeat(24)].join("_");
const STRIPE_TEST = ["rk", "test", "Ab1".repeat(8)].join("_");
const HUGGING_FACE = `${"hf"}_${"Qx7".repeat(12)}`;
const NPM_TOKEN = `${"npm"}_${"N4z".repeat(12)}`;
const GITLAB_TOKEN = `${"glpat"}-${"g5H".repeat(8)}`;
const HEX_40 = "0123456789abcdef".repeat(3).slice(0, 40);
const GENERATED = ["aB3dE5fG7h", "J9kL2mN4pQ", "6rS8tU0vW1", "xY"].join("");
const PEM_BEGIN = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
const PEM_END = ["-----END", "RSA PRIVATE KEY-----"].join(" ");

const context: ShareRedactionContext = {
	homeDirectory: "/Users/jane doe",
	userName: "janedoe",
	hostName: "janes-mbp.local",
};

function redact(text: string): { text: string; tally: ShareRedactionTally } {
	const tally: ShareRedactionTally = new Map();
	return { text: redactShareText(text, context, tally), tally };
}

describe("share redaction (senpi#3524)", () => {
	it.each([
		["an env assignment", `OPENAI_API_KEY=${OPENAI_KEY}`, OPENAI_KEY],
		["a bare provider key", `use ${OPENAI_KEY} here`, OPENAI_KEY],
		["a GitHub token", `token ${GITHUB_TOKEN}`, GITHUB_TOKEN],
		["a GitHub fine-grained token", GITHUB_PAT, GITHUB_PAT],
		["a Slack token", SLACK_TOKEN, SLACK_TOKEN],
		["an AWS access key", `aws ${AWS_KEY}`, AWS_KEY],
		["a JWT", `jwt=${JWT}`, JWT],
		["an auth header", "Authorization: Bearer abcdefghijklmnop", "abcdefghijklmnop"],
		["a letters-only basic auth header", "Proxy-Authorization: Basic dXNlcnBhc3N3b3Jk", "dXNlcnBhc3N3b3Jk"],
		["a JSON authorization field", '{"authorization":"Token abcdefghijkl"}', "abcdefghijkl"],
		["a bare bearer token", "curl -H x Bearer abc123def456ghi", "abc123def456ghi"],
		["a JSON secret field", '{"client_secret": "s3cr3t-value"}', "s3cr3t-value"],
		["URL credentials", "https://bob:hunter22@example.com/x", "hunter22"],
		["a cookie header", "Cookie: sid=abc123def456", "abc123def456"],
		["an email", "mail jane.doe@example.org now", "jane.doe@example.org"],
		["a remote IPv4", "connect 10.1.2.3:22", "10.1.2.3"],
		["a Stripe live key", `stripe ${STRIPE_LIVE}`, STRIPE_LIVE],
		["a Stripe restricted test key", STRIPE_TEST, STRIPE_TEST],
		["a Hugging Face token", `HF ${HUGGING_FACE}`, HUGGING_FACE],
		["an npm token", `publish with ${NPM_TOKEN}`, NPM_TOKEN],
		["a GitLab token", `glab ${GITLAB_TOKEN}`, GITLAB_TOKEN],
		["an env KEY with a hex value", `DEEPSEEK_KEY=${HEX_40}`, HEX_40],
		["an env AUTH with a hex value", `export ANTHROPIC_AUTH="${HEX_40}"`, HEX_40],
		["an env PASS", "DB_PASS=correcthorse", "correcthorse"],
		["a generated high-entropy run in prose", `the value is ${GENERATED} ok`, GENERATED],
		["a JSON authorization array", '{"Authorization":["Bearer abcdefghijkl"]}', "abcdefghijkl"],
		["a URL-encoded email", "to=jane.doe%40example.org", "jane.doe"],
		["an inline data URI", `<img src="data:image/png;base64,${"iVBORw0KGgo".repeat(4)}">`, "iVBORw0KGgo"],
	])("removes %s", (_label, input, secret) => {
		const { text } = redact(input);
		expect(text).not.toContain(secret);
	});

	it("removes a complete private key block", () => {
		const { text, tally } = redact(`key:\n${PEM_BEGIN}\nMIIEabc\ndef\n${PEM_END}\nafter`);
		expect(text).toBe("key:\n<redacted private key>\nafter");
		expect(tally.get("private key")).toBe(1);
	});

	it("removes a truncated private key through the end of the input", () => {
		const { text } = redact(`${PEM_BEGIN}\nMIIEabc partial body trailing words`);
		expect(text).toBe("<redacted private key>");
	});

	it.each([
		["a POSIX path", "/Users/jane doe/src/app.ts", "~/src/app.ts"],
		["a JSON-escaped path", '"/Users/jane doe/.env"', '"~/.env"'],
		["a URL-encoded path", "file:///Users/jane%20doe/notes.md", "~/notes.md"],
		["the account name", "owner janedoe pushed", "owner <user> pushed"],
		["the account name inside a handle", "code-janedoe", "code-<user>"],
		["the host name", "ssh janes-mbp.local", "ssh <host>"],
		["the short host name", "on janes-mbp today", "on <host> today"],
		["another account's home", "/home/bob/project", "/home/<user>/project"],
	])("rewrites %s", (_label, input, expected) => {
		expect(redact(input).text).toBe(expected);
	});

	it("rewrites a Windows home in every separator spelling", () => {
		const windows: ShareRedactionContext = { ...context, homeDirectory: "C:\\Users\\Jane Doe" };
		for (const input of [
			"C:\\Users\\Jane Doe\\a.txt",
			"C:\\\\Users\\\\Jane Doe\\\\a.txt",
			"C:/Users/Jane Doe/a.txt",
		]) {
			expect(redactShareText(input, windows, new Map())).toMatch(/^~/);
		}
	});

	it.each([
		"Extract basic information from media files",
		"Basic setup takes a minute",
		"the Bearer of bad news",
		"Token counting is approximate",
	])("keeps prose that starts with an auth scheme word: %s", (input) => {
		expect(redact(input).text).toBe(input);
	});

	it.each([
		["a commit id", `fixed in ${HEX_40}`],
		["a sha256 digest", `sha256 ${"ab12".repeat(16)}`],
		["a UUID", "session 01a14a28-fad7-7ebc-91a2-e85da2aa8faa"],
		["a long camelCase identifier", "call handleShareCommandWithLoaderAndPreview2 now"],
		["a long kebab branch name", "fix/3524-share-redaction-preview-and-confirm"],
		["an env name that only contains KEY", "KEYBOARD_LAYOUT=us MONKEY_COUNT=3"],
	])("keeps %s", (_label, input) => {
		expect(redact(input).text).toBe(input);
	});

	it("keeps loopback addresses, ordinary words and code", () => {
		const input = "listen on 127.0.0.1:8080; const token = getToken(); user home admin";
		expect(redact(input).text).toBe(input.replace("getToken()", "<redacted>"));
	});

	it("is idempotent: a second pass changes and counts nothing", () => {
		const first = redact(`OPENAI_API_KEY=${OPENAI_KEY} at /Users/jane doe/x by janedoe@example.org`);
		const second = redact(first.text);
		expect(second.text).toBe(first.text);
		expect(second.tally.size).toBe(0);
	});

	it("counts each removal once", () => {
		const { tally } = redact(`Authorization: Bearer ${OPENAI_KEY}\nOPENAI_API_KEY=${OPENAI_KEY}`);
		expect(tally.get("credential")).toBe(2);
	});

	it("drops sensitive-named values, images and nested strings in structured data", () => {
		const tally: ShareRedactionTally = new Map();
		const value = redactShareValue(
			{
				arguments: { apiKey: "plain-looking-value", path: "/Users/jane doe/a" },
				content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
			},
			context,
			tally,
		);
		expect(value).toEqual({
			arguments: { apiKey: "<redacted>", path: "~/a" },
			content: [{ type: "text", text: "[image omitted from share]" }],
		});
		expect(tally.get("image")).toBe(1);
	});

	it("keeps the JSON shape of an authorization array while removing its token", () => {
		expect(redact('{"Authorization":["Bearer abcdefghijkl"]}').text).toBe('{"Authorization":["Bearer <redacted>"]}');
	});

	it("drops every string under a sensitive key, whatever the nesting", () => {
		const value = redactShareValue(
			{ headers: { Authorization: ["Bearer abcdefghijkl"], cookie: { sid: "abc" } } },
			context,
			new Map(),
		);
		expect(value).toEqual({ headers: { Authorization: ["<redacted>"], cookie: { sid: "<redacted>" } } });
	});

	it.each([
		["Anthropic", { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }],
		["OpenAI chat", { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
		["OpenAI responses", { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }],
	])("drops a %s image block", (_label, block) => {
		const tally: ShareRedactionTally = new Map();
		expect(redactShareValue({ details: [block] }, context, tally)).toEqual({
			details: [{ type: "text", text: "[image omitted from share]" }],
		});
		expect(tally.get("image")).toBe(1);
	});
});
